//! Databaseless merchant API keys.
//!
//! Traditional gateways store API keys in a database. PayPhone derives them:
//!
//! ```text
//! public key   pk_{tier}_{key_id}
//! secret key   sk_{tier}_{key_id}_{hex(HMAC-SHA256(master_key, pk))}
//! ```
//!
//! The engine never stores a key. When a signed request arrives it re-derives
//! the expected secret from the public key in the header and verifies the
//! HMAC in constant time. Consequences:
//!
//! - Zero credential storage → nothing to leak, nothing to migrate.
//! - Rotation = issue a new `key_id` and discard the old one.
//! - Revocation = a config-level denylist of `key_id`s (env: `PAYPHONE_REVOKED_KEYS`).
//! - The master key must live in a KMS/HSM in production.
//!
//! ## Request signing protocol (v1)
//!
//! ```text
//! canonical  = "{timestamp}.{METHOD}.{path}.{sha256_hex(raw_body)}"
//! signature  = hex(HMAC-SHA256(secret_bytes, canonical))
//! ```
//!
//! Headers: `X-PayPhone-Key`, `X-PayPhone-Timestamp`, `X-PayPhone-Signature`.
//! The timestamp must be within `replay_window_secs` of server time — this
//! blocks replay attacks without any nonce storage.

use crate::config::Config;
use crate::error::{ApiResult, AppError};
use hmac::{Hmac, Mac};
use rand::RngCore;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};

/// Merchant pricing tier — parsed straight out of the public key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Tier {
    Free,
    Starter,
    Growth,
    Scale,
    Enterprise,
}

impl Tier {
    pub fn parse(s: &str) -> ApiResult<Tier> {
        match s {
            "free" => Ok(Tier::Free),
            "starter" => Ok(Tier::Starter),
            "growth" => Ok(Tier::Growth),
            "scale" => Ok(Tier::Scale),
            "enterprise" => Ok(Tier::Enterprise),
            other => Err(AppError::bad_request(format!(
                "unknown tier '{other}' (valid: free, starter, growth, scale, enterprise)"
            ))),
        }
    }
    pub fn as_str(&self) -> &'static str {
        match self {
            Tier::Free => "free",
            Tier::Starter => "starter",
            Tier::Growth => "growth",
            Tier::Scale => "scale",
            Tier::Enterprise => "enterprise",
        }
    }
}

/// The authenticated caller, extracted from signed headers.
#[derive(Debug, Clone)]
pub struct MerchantContext {
    /// Full public key, e.g. `pk_growth_4f9c2ab17d03`.
    pub public_key: String,
    /// Merchant tier (pricing + limits).
    pub tier: Tier,
    /// Stable identity inside the tier, e.g. `4f9c2ab17d03`.
    pub key_id: String,
}

/// Parse a public key of the form `pk_{tier}_{key_id}`.
pub fn parse_public_key(pk: &str) -> ApiResult<MerchantContext> {
    let rest = pk
        .strip_prefix("pk_")
        .ok_or_else(|| AppError::bad_request("public key must start with 'pk_'"))?;
    let (tier_s, key_id) = rest
        .split_once('_')
        .ok_or_else(|| AppError::bad_request("malformed public key"))?;
    if key_id.len() < 6 || !key_id.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(AppError::bad_request("malformed key_id"));
    }
    Ok(MerchantContext {
        public_key: pk.to_string(),
        tier: Tier::parse(tier_s)?,
        key_id: key_id.to_lowercase(),
    })
}

/// Derive the secret key material for a public key: the literal `sk_…`
/// string the merchant holds. Pure function — no storage. The engine and
/// every SDK HMAC with these exact bytes.
fn derive_secret_bytes(master: &str, pk: &str) -> Vec<u8> {
    render_secret_key(master, pk).into_bytes()
}

/// Render the one-time secret a merchant sees at onboarding.
pub fn render_secret_key(master: &str, pk: &str) -> String {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(master.as_bytes())
        .expect("HMAC accepts any key length");
    mac.update(format!("sk|{pk}").as_bytes());
    let secret_hex = hex::encode(mac.finalize().into_bytes());
    // pk = "pk_{tier}_{key_id}" → sk mirrors it.
    format!("sk_{}_{secret_hex}", &pk[3..])
}

/// Issue a brand-new merchant credential. The secret is returned exactly once —
/// the engine itself can only re-derive it, never recall it.
pub fn issue_key(master: &str, tier: Tier) -> (String, String) {
    let mut buf = [0u8; 6];
    rand::thread_rng().fill_bytes(&mut buf);
    let key_id = hex::encode(buf);
    let pk = format!("pk_{}_{}", tier.as_str(), key_id);
    let sk = render_secret_key(master, &pk);
    (pk, sk)
}

/// Verify a signed request against the derived secret.
pub fn verify_signed_request(
    config: &Config,
    pk: &str,
    timestamp: &str,
    method: &str,
    path: &str,
    raw_body: &[u8],
    signature_hex: &str,
) -> ApiResult<MerchantContext> {
    let ctx = parse_public_key(pk)?;

    // Config-level revocation: a leaked secret is dead the moment its
    // key_id lands in PAYPHONE_REVOKED_KEYS (checked before any crypto).
    if config.revoked_keys.iter().any(|k| k == &ctx.key_id) {
        return Err(AppError::forbidden(
            "this API key has been revoked — contact the platform operator",
        ));
    }

    // Replay window.
    let ts: u64 = timestamp
        .parse()
        .map_err(|_| AppError::unauthorized("timestamp must be unix seconds"))?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
    if ts.abs_diff(now) > config.replay_window_secs {
        return Err(AppError::unauthorized("timestamp outside replay window"));
    }

    // canonical = "{ts}.{METHOD}.{path}.{sha256(body)}"
    let body_hash = hex::encode(Sha256::digest(raw_body));
    let canonical = format!("{ts}.{}.{}.{body_hash}", method.to_uppercase(), path);

    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&derive_secret_bytes(&config.master_key, pk))
        .expect("HMAC accepts any key length");
    mac.update(canonical.as_bytes());

    let provided = hex::decode(signature_hex.trim().to_lowercase())
        .map_err(|_| AppError::unauthorized("signature must be hex"))?;
    // `verify_slice` compares in constant time.
    if mac.verify_slice(&provided).is_err() {
        return Err(AppError::unauthorized("signature does not match request"));
    }
    Ok(ctx)
}

/// Verify an incoming webhook-test / event signature produced by the engine
/// (exposed as a library function so SDKs can mirror it exactly).
pub fn compute_event_signature(signing_key: &str, timestamp: u64, payload: &str) -> String {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(signing_key.as_bytes())
        .expect("HMAC accepts any key length");
    mac.update(format!("{timestamp}.{payload}").as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_roundtrip() {
        let (pk, sk) = issue_key("test-master", Tier::Growth);
        assert!(pk.starts_with("pk_growth_"));
        assert!(sk.starts_with("sk_growth_"));
        let ctx = parse_public_key(&pk).unwrap();
        assert_eq!(ctx.tier, Tier::Growth);
        // Derivation is deterministic.
        assert_eq!(render_secret_key("test-master", &pk), sk);
    }

    #[test]
    fn signature_verifies_and_rejects_tampering() {
        let config = Config {
            port: 0,
            master_key: "test-master".into(),
            signing_key: "s".into(),
            phone_pepper: "p".into(),
            simnet_enabled: true,
            simnet_data_dir: "/tmp".into(),
            oracle_url: None,
            evm_rpcs: vec![],
            btc_api_base: None,
            sol_rpc_url: None,
            tron_api_base: None,
            cors_origins: vec!["*".into()],
            rate_limit_per_min: 10,
            replay_window_secs: 300,
            invoice_ttl_secs: 900,
            demo_mode: true,
            production: false,
            revoked_keys: vec![],
            treasury: None,
            tier_prices: vec![],
        };
        let (pk, sk) = issue_key("test-master", Tier::Free);
        let ts = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
        let body = br#"{"amount":"10.00"}"#;
        let body_hash = hex::encode(Sha256::digest(body));
        let canonical = format!("{ts}.POST./v1/invoices.{body_hash}");
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(sk.as_bytes()).unwrap();
        mac.update(canonical.as_bytes());
        let sig = hex::encode(mac.finalize().into_bytes());

        assert!(verify_signed_request(&config, &pk, &ts.to_string(), "POST", "/v1/invoices", body, &sig).is_ok());
        assert!(verify_signed_request(&config, &pk, &ts.to_string(), "POST", "/v1/invoices", br#"{"amount":"11.00"}"#, &sig).is_err());
        assert!(verify_signed_request(&config, &pk, &(ts - 9999).to_string(), "POST", "/v1/invoices", body, &sig).is_err());
    }

    #[test]
    fn revoked_key_is_rejected_before_anything_else() {
        let mut config = Config {
            port: 0,
            master_key: "test-master".into(),
            signing_key: "s".into(),
            phone_pepper: "p".into(),
            simnet_enabled: false,
            simnet_data_dir: "/tmp".into(),
            oracle_url: None,
            evm_rpcs: vec![],
            btc_api_base: None,
            sol_rpc_url: None,
            tron_api_base: None,
            cors_origins: vec!["*".into()],
            rate_limit_per_min: 10,
            replay_window_secs: 300,
            invoice_ttl_secs: 900,
            demo_mode: false,
            production: true,
            revoked_keys: vec![],
            treasury: None,
            tier_prices: vec![],
        };
        let (pk, sk) = issue_key("test-master", Tier::Growth);
        let key_id = parse_public_key(&pk).unwrap().key_id;
        let ts = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
        let body = br#"{}"#;
        let body_hash = hex::encode(Sha256::digest(body));
        let canonical = format!("{ts}.POST./v1/invoices.{body_hash}");
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(sk.as_bytes()).unwrap();
        mac.update(canonical.as_bytes());
        let sig = hex::encode(mac.finalize().into_bytes());

        // Valid signature — accepted while not revoked.
        assert!(verify_signed_request(&config, &pk, &ts.to_string(), "POST", "/v1/invoices", body, &sig).is_ok());

        // Revoke → same perfectly-signed request is now refused.
        config.revoked_keys = vec![key_id];
        let err = verify_signed_request(&config, &pk, &ts.to_string(), "POST", "/v1/invoices", body, &sig).unwrap_err();
        assert_eq!(err.status.as_u16(), 403);
    }
}
