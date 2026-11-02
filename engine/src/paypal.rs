//! PayPal bridge — the owner's own PayPal account, verified live.
//!
//! Users paste their OWN PayPal REST credentials (Client ID + Secret from
//! developer.paypal.com) and the engine verifies them against PayPal's real
//! OAuth2 endpoint and reads what PayPal exposes (account balances). This is
//! the foundation of the USD → PYUSD → wallet bridge: PayPal's own stablecoin
//! (PYUSD) can be bought with a PayPal USD balance in the PayPal app and sent
//! on-chain to the destination wallet the owner configured — where the
//! connector/invoice machinery observes it like any other asset.
//!
//! Trust model (honest, and load-bearing):
//! - PayPal credentials are PASS-THROUGH: used for one upstream call over
//!   TLS, then dropped. The engine NEVER stores, logs or echoes them — same
//!   zero-custody posture as private keys.
//! - Responses surface PayPal's own errors verbatim (truncated) so users see
//!   WHY a credential failed instead of a generic 500.
//! - Endpoints are open but rate-limited under one shared `paypal` budget —
//!   a credential-stuffing oracle is exactly what this must NOT become, and
//!   a small global budget plus PayPal's own account lockouts keep it that
//!   way.
//!
//! PayPal endpoints used (public REST API v1/v2):
//!   POST {base}/v1/oauth2/token       (client-credentials grant)
//!   GET  {base}/v1/reporting/balances (account balances; permission-gated
//!                                      by PayPal per app/account)
//! where {base} = https://api-m.sandbox.paypal.com | https://api-m.paypal.com

use crate::error::{ApiResult, AppError};
use crate::routes::{guard, ok, parse_body, AppState, Ctx};
use axum::extract::State;
use axum::response::Response;
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

/// Per-call upstream timeout — PayPal answers in well under a second; if it
/// doesn't, the caller should hear about it fast.
const UPSTREAM_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Deserialize)]
struct PayPalCredsReq {
    client_id: String,
    client_secret: String,
    /// `sandbox` (default — free test keys from developer.paypal.com) | `live`.
    #[serde(default = "default_environment")]
    environment: String,
}

fn default_environment() -> String {
    "sandbox".to_string()
}

/// PayPal REST base for an environment. Tested (see unit tests).
fn base_url_for(environment: &str) -> Result<&'static str, AppError> {
    match environment.trim().to_lowercase().as_str() {
        "sandbox" => Ok("https://api-m.sandbox.paypal.com"),
        "live" | "production" => Ok("https://api-m.paypal.com"),
        other => Err(AppError::bad_request(format!(
            "environment must be 'sandbox' or 'live' (got '{other}')"
        ))),
    }
}

/// Trim a debug body so upstream error text is shown but never floods logs
/// or responses.
fn clip(s: &str, max: usize) -> String {
    let s = s.trim();
    if s.len() <= max {
        s.to_string()
    } else {
        let mut cut = max;
        while cut > 0 && !s.is_char_boundary(cut) {
            cut -= 1;
        }
        format!("{}…", &s[..cut])
    }
}

/// HTTP client with the upstream timeout baked in.
fn http_client() -> ApiResult<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(UPSTREAM_TIMEOUT)
        .user_agent(concat!("payphone-engine/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| AppError::internal(format!("http client: {e}")))
}

/// The client-credentials OAuth2 call — the ONE place credentials touch the
/// wire. Returns the raw token payload (access_token, app_id, scope, …).
async fn oauth_token(
    client: &reqwest::Client,
    base: &str,
    client_id: &str,
    client_secret: &str,
) -> ApiResult<Value> {
    let resp = client
        .post(format!("{base}/v1/oauth2/token"))
        .basic_auth(client_id, Some(client_secret))
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body("grant_type=client_credentials")
        .send()
        .await
        .map_err(|e| {
            AppError::upstream(format!(
                "PayPal unreachable from this node ({}). Check egress and try again.",
                clip(&e.to_string(), 120)
            ))
        })?;

    let status = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();
    if status == 200 {
        return serde_json::from_str(&body).map_err(|e| {
            AppError::upstream(format!("PayPal returned an unreadable token payload: {e}"))
        });
    }
    // PayPal's own error JSON carries the truth — pass the reason through.
    let detail = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|v| {
            v.get("error_description")
                .and_then(|d| d.as_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| clip(&body, 160));
    if status == 401 {
        return Err(AppError::new(
            axum::http::StatusCode::UNAUTHORIZED,
            "paypal_rejected",
            format!(
                "PayPal rejected these credentials (invalid_client): {detail}. Check the Client ID/Secret pair and that the environment matches where you created the app."
            ),
        ));
    }
    Err(AppError::upstream(format!(
        "PayPal returned HTTP {status}: {detail}"
    )))
}

/// `POST /v1/paypal/verify` — prove the credentials work and show what they
/// can do. The response contains NO secret; the app_id + scopes come from
/// PayPal itself.
async fn verify(State(state): Ctx, body: axum::body::Bytes) -> ApiResult<Response> {
    guard(&state, "paypal")?;
    let req: PayPalCredsReq = parse_body(&body)?;
    if req.client_id.trim().is_empty() || req.client_secret.trim().is_empty() {
        return Err(AppError::bad_request(
            "client_id and client_secret are required (developer.paypal.com → Apps & Credentials)",
        ));
    }
    let base = base_url_for(&req.environment)?;
    let client = http_client()?;
    let token = oauth_token(&client, base, req.client_id.trim(), req.client_secret.trim()).await?;

    let scopes: Vec<&str> = token
        .get("scope")
        .and_then(|s| s.as_str())
        .map(|s| {
            s.split([',', ' '])
                .map(str::trim)
                .filter(|p| !p.is_empty())
                .collect()
        })
        .unwrap_or_default();
    Ok(ok(json!({
        "connected": true,
        "environment": req.environment.trim().to_lowercase(),
        "app_id": token.get("app_id").cloned().unwrap_or(Value::Null),
        "token_type": token.get("token_type").cloned().unwrap_or(json!("Bearer")),
        "expires_in": token.get("expires_in").cloned().unwrap_or(Value::Null),
        "scopes": scopes,
        "credentials_stored": false,
        "note": "verified live against PayPal — the engine used the credentials for this one call and discarded them",
    })))
}

/// `POST /v1/paypal/balance` — read-only look at the account's USD balance.
/// Requires the PayPal app/account to have balances-reporting permission;
/// PayPal says no honestly if it doesn't (the console explains the fallback).
async fn balance(State(state): Ctx, body: axum::body::Bytes) -> ApiResult<Response> {
    guard(&state, "paypal")?;
    let req: PayPalCredsReq = parse_body(&body)?;
    if req.client_id.trim().is_empty() || req.client_secret.trim().is_empty() {
        return Err(AppError::bad_request("client_id and client_secret are required"));
    }
    let base = base_url_for(&req.environment)?;
    let client = http_client()?;
    let token = oauth_token(&client, base, req.client_id.trim(), req.client_secret.trim()).await?;
    let access = token
        .get("access_token")
        .and_then(|t| t.as_str())
        .ok_or_else(|| AppError::upstream("PayPal token payload had no access_token"))?;

    let resp = client
        .get(format!("{base}/v1/reporting/balances"))
        .query(&[("currency_code", "USD")])
        .bearer_auth(access)
        .send()
        .await
        .map_err(|e| {
            AppError::upstream(format!(
                "PayPal unreachable from this node ({}).",
                clip(&e.to_string(), 120)
            ))
        })?;
    let status = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();
    if status != 200 {
        let detail = serde_json::from_str::<Value>(&body)
            .ok()
            .and_then(|v| {
                v.get("message")
                    .and_then(|m| m.as_str())
                    .map(str::to_string)
            })
            .unwrap_or_else(|| clip(&body, 160));
        return Err(AppError::upstream(format!(
            "PayPal balances API returned HTTP {status}: {detail} — your PayPal app may not have balances-reporting permission; the USD→PYUSD bridge does not need it"
        )));
    }
    let data: Value = serde_json::from_str(&body)
        .map_err(|e| AppError::upstream(format!("unreadable balances payload: {e}")))?;
    Ok(ok(json!({
        "environment": req.environment.trim().to_lowercase(),
        "balances": data.get("balances").cloned().unwrap_or(json!([])),
        "as_of_time": data.get("as_of_time").cloned().unwrap_or(Value::Null),
        "last_refresh_time": data.get("last_refresh_time").cloned().unwrap_or(Value::Null),
    })))
}

/// PayPal routes, merged into the v1 router.
pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/v1/paypal/verify", post(verify))
        .route("/v1/paypal/balance", post(balance))
}

// ------------------------------------------------------------------- tests ---

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn environments_map_to_real_bases() {
        assert_eq!(base_url_for("sandbox").unwrap(), "https://api-m.sandbox.paypal.com");
        assert_eq!(base_url_for("live").unwrap(), "https://api-m.paypal.com");
        assert_eq!(base_url_for("PRODUCTION").unwrap(), "https://api-m.paypal.com");
        assert_eq!(base_url_for(" sandbox ").unwrap(), "https://api-m.sandbox.paypal.com");
        assert!(base_url_for("staging").is_err());
        assert!(base_url_for("").is_err());
    }

    #[test]
    fn clip_truncates_on_char_boundaries() {
        assert_eq!(clip("short", 10), "short");
        assert_eq!(clip("abcdefghij", 4), "abcd…");
        // Multi-byte safety: max=5 lands mid-char (é spans bytes 4..6), so the
        // walk-back must settle on byte 4 → "éé…".
        let clipped = clip("ééééé", 5);
        assert_eq!(clipped.chars().count(), 3);
        assert!(clipped.ends_with('…'));
    }

    #[test]
    fn scope_parsing_shape() {
        // The verify handler splits on both commas and spaces — exercise that
        // logic directly to keep the contract pinned.
        let raw = "https://uri.paypal.com/services/invoicing, openid https://uri.paypal.com/services/reporting/balances/read";
        let scopes: Vec<&str> = raw
            .split([',', ' '])
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .collect();
        assert_eq!(scopes.len(), 3);
        assert!(scopes.iter().any(|s| s.ends_with("balances/read")));
    }
}
