//! Connectors — the universal payment receiver.
//!
//! A connector is a pair of credentials (`cn_…` client ID + `cs_…` client
//! secret, shown once) plus a per-asset auto-route table. Any platform that
//! holds the credentials — PayPal PYUSD off-ramps, Payoneer/Grey bridge
//! flows, a SaaS backend, a spreadsheet bot — mints payment requests with
//! `POST /v1/connect/payments {asset, amount_usd_cents, reference}` and the
//! engine resolves WHERE the money lands from the route table the owner
//! configured: USDC → Base wallet, ETH → Ethereum wallet, PYUSD → Ethereum
//! wallet, `*` → default wallet. Funds move address-to-address on-chain —
//! the engine never custodies them, exactly like invoices.
//!
//! Trust model (honest):
//! - The secret is stored ONLY as `HMAC-SHA256(master_key, "cs|{id}|{secret}")`
//!   — a database leak cannot mint payments.
//! - The route table decides the destination, so only the connector owner
//!   (who holds the secret) can change where money lands.
//! - `resolve_route` is deterministic and tested: exact asset beats
//!   wildcard, an explicit route network pins the venue, an empty network
//!   honors the caller's hint, else the asset catalog default applies.
//!
//! Records live in per-process memory (like Guardian recovery): a restart
//! forgets connectors and owners re-create them — a documented v1 trade-off;
//! persistence is the first R&D follow-up.

use crate::chains::{registry, ChainKind};
use crate::error::{ApiResult, AppError};
use crate::invoice::{resolve_status, Invoice, InvoiceStatus};
use crate::keys::{MerchantContext, Tier};
use crate::routes::{
    guard, ok, ok_created, parse_body, build_invoice_payload, AppState, Ctx,
};
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::Response;
use axum::routing::{get, post};
use axum::Router;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Sha256;
use std::sync::{Arc, MutexGuard};

/// Hard cap — connectors are memory-resident; this bounds worst-case memory.
const MAX_CONNECTORS: usize = 50_000;
/// Newest-first payment log kept per connector.
const MAX_PAYMENTS_PER_CONNECTOR: usize = 50;

// ----------------------------------------------------------------- records ---

/// One auto-route row: `asset` (uppercase symbol, or `*` wildcard) settles on
/// `chain`/`network` (network empty = the chain's asset-catalog default) into
/// `wallet` (owner-chosen — "where I want that money to sit").
#[derive(Clone, Serialize)]
pub struct ConnectorRoute {
    pub asset: String,
    pub chain: String,
    pub network: String,
    pub wallet: String,
}

/// A minted payment request. The full [`Invoice`] is kept so the status
/// endpoint can re-observe the chain exactly like `GET /v1/invoices/:id`.
#[derive(Clone, Serialize)]
pub struct ConnectorPayment {
    pub payment_id: String,
    pub asset: String,
    pub chain: String,
    pub network: String,
    pub amount_usd_cents: u64,
    pub reference: String,
    pub destination: String,
    pub invoice: Invoice,
    pub last_status: String,
    pub created_at: u64,
}

/// The stored connector. The client secret is NEVER here — only its
/// master-keyed HMAC.
#[derive(Clone)]
pub struct ConnectorRecord {
    pub client_id: String,
    pub secret_hash: String,
    pub label: String,
    pub routes: Vec<ConnectorRoute>,
    pub webhook_url: String,
    pub created_at: u64,
    pub payments: Vec<ConnectorPayment>,
}

// ----------------------------------------------------------------- helpers ---

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

fn rand_hex(n_bytes: usize) -> String {
    use rand::RngCore;
    let mut buf = vec![0u8; n_bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    hex::encode(buf)
}

/// `HMAC-SHA256(master_key, "cs|{client_id}|{secret}")` — hex. The only form
/// of the secret the engine keeps.
pub fn secret_hash(master: &str, client_id: &str, secret: &str) -> String {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(master.as_bytes())
        .expect("HMAC accepts any key length");
    mac.update(format!("cs|{client_id}|{secret}").as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

/// Constant-time secret check: recompute the HMAC and compare hex strings
/// byte-wise without early exit (`constant_time_eq`).
pub fn verify_secret(master: &str, client_id: &str, secret: &str, stored_hash: &str) -> bool {
    let expected = secret_hash(master, client_id, secret);
    constant_time_eq(expected.as_bytes(), stored_hash.trim().as_bytes())
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Infer the chain kind from a wallet address shape. Powers the
/// "one default wallet" creation shortcut: paste a 0x… address and the
/// wildcard route is an EVM route; a bc1… address and it is Bitcoin.
pub fn infer_chain_from_wallet(wallet: &str) -> Option<&'static str> {
    let w = wallet.trim();
    if w.len() == 42 && w.starts_with("0x") && w[2..].chars().all(|c| c.is_ascii_hexdigit()) {
        return Some("evm");
    }
    if (w.starts_with('1') || w.starts_with('3') || w.starts_with("bc1")) && w.len() >= 14 && w.len() <= 90 {
        return Some("bitcoin");
    }
    if w.len() == 34 && w.starts_with('T') {
        return Some("tron");
    }
    if w.len() == 42 && w.starts_with("PP") {
        return Some("simnet");
    }
    if w.len() >= 32 && w.len() <= 44 {
        return Some("solana");
    }
    None
}

/// Deterministic route resolution — the heart of auto-routing.
///
/// 1. Exact-asset rows win over the `*` wildcard.
/// 2. Within the winner group: an explicit network match (when the caller
///    hinted one) first, then a network-agnostic row, then the first row.
/// 3. The route's own network, when set, PINS the venue (owner's choice);
///    an empty network defers to the caller's hint, else the catalog default.
pub fn resolve_route<'a>(
    routes: &'a [ConnectorRoute],
    asset: &str,
    network_hint: &str,
) -> Result<(&'a ConnectorRoute, String), String> {
    if routes.is_empty() {
        return Err("this connector has no routes configured — add at least one destination (POST /v1/connectors/:client_id/config)".into());
    }
    let asset_u = asset.trim().to_uppercase();
    let hint = network_hint.trim().to_lowercase();
    let mut group: Vec<&ConnectorRoute> = routes
        .iter()
        .filter(|r| r.asset.eq_ignore_ascii_case(&asset_u))
        .collect();
    if group.is_empty() {
        group = routes.iter().filter(|r| r.asset == "*").collect();
    }
    if group.is_empty() {
        return Err(format!(
            "no auto-route configured for asset '{asset_u}' on this connector — add a route (asset → wallet) via POST /v1/connectors/:client_id/config"
        ));
    }
    let picked = if !hint.is_empty() {
        group
            .iter()
            .find(|r| r.network.eq_ignore_ascii_case(&hint))
            .or_else(|| group.iter().find(|r| r.network.is_empty()))
            .or_else(|| group.first())
            .copied()
            .expect("group non-empty")
    } else {
        group
            .iter()
            .find(|r| r.network.is_empty())
            .or_else(|| group.first())
            .copied()
            .expect("group non-empty")
    };
    let network = if picked.network.is_empty() {
        hint
    } else {
        picked.network.clone()
    };
    Ok((picked, network))
}

/// Validate a route set at create/config time: chain kind parseable, EVM
/// networks real, wallet shape right for the chain. Failing here means a
/// payment can never fail with a confusing address error later.
fn validate_routes(routes: &[ConnectorRoute]) -> ApiResult<()> {
    if routes.is_empty() {
        return Err(AppError::bad_request(
            "a connector needs at least one route — {asset → wallet} rows, or a default_wallet",
        ));
    }
    if routes.len() > 64 {
        return Err(AppError::bad_request("a connector holds at most 64 routes"));
    }
    for r in routes {
        let kind = ChainKind::parse(&r.chain).map_err(|_| {
            AppError::bad_request(format!(
                "route for '{}': unknown chain '{}' (valid: evm, bitcoin, solana, tron, simnet)",
                r.asset, r.chain
            ))
        })?;
        if kind == ChainKind::Evm && !r.network.is_empty() && registry::find(&r.network).is_none() {
            return Err(AppError::bad_request(format!(
                "route for '{}': unknown EVM network '{}' — see GET /v1/chains",
                r.asset, r.network
            )));
        }
        crate::phone::validate_wallet(kind.as_str(), &r.wallet).map_err(|e| {
            AppError::bad_request(format!(
                "route for '{}' asset: wallet '{}' is not a valid {} address — {}",
                r.asset,
                r.wallet,
                kind.as_str(),
                e
            ))
        })?;
    }
    Ok(())
}

/// Accept flexible route input: `chain` may be omitted and is inferred from
/// the network (EVM names) or the asset catalog default.
#[derive(Clone, Deserialize)]
struct RouteInput {
    asset: String,
    #[serde(default)]
    chain: String,
    #[serde(default)]
    network: String,
    wallet: String,
}

fn materialize_route(input: RouteInput) -> ApiResult<ConnectorRoute> {
    let asset = input.asset.trim().to_uppercase();
    let network = input.network.trim().to_lowercase();
    let chain = if !input.chain.trim().is_empty() {
        input.chain.trim().to_lowercase()
    } else if !network.is_empty() && registry::find(&network).is_some() {
        "evm".to_string()
    } else if asset != "*" {
        registry::find_asset(&asset)
            .map(|a| a.default_chain.to_string())
            .ok_or_else(|| {
                AppError::bad_request(format!(
                    "route '{}': cannot infer the chain — specify it explicitly (evm, bitcoin, solana, tron)",
                    asset
                ))
            })?
    } else {
        // Wildcard without a chain: infer from the wallet shape.
        infer_chain_from_wallet(&input.wallet)
            .ok_or_else(|| {
                AppError::bad_request(
                    "wildcard route: unrecognized wallet shape — set 'chain' explicitly (evm, bitcoin, solana, tron)",
                )
            })?
            .to_string()
    };
    Ok(ConnectorRoute {
        asset,
        chain,
        network,
        wallet: input.wallet.trim().to_string(),
    })
}

/// Extract + verify connector credentials from headers. Also enforces the
/// per-connector rate budget.
fn require_connector(
    state: &AppState,
    client_id: &str,
    headers: &HeaderMap,
) -> ApiResult<ConnectorRecord> {
    let secret = headers
        .get("x-payphone-secret")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            AppError::missing_auth()
        })?;
    guard(state, &format!("conn:{client_id}"))?;
    let record = {
        let map = state.connectors.lock().unwrap();
        map.get(client_id).cloned()
    }
    .ok_or_else(|| {
        AppError::not_found("unknown client_id — create a connector first (POST /v1/connectors)")
    })?;
    if !verify_secret(
        &state.config.master_key,
        &record.client_id,
        secret,
        &record.secret_hash,
    ) {
        return Err(AppError::unauthorized(
            "client secret does not match this client_id",
        ));
    }
    Ok(record)
}

fn lock_connectors(state: &AppState) -> MutexGuard<'_, std::collections::HashMap<String, ConnectorRecord>> {
    state.connectors.lock().unwrap()
}

fn route_json(routes: &[ConnectorRoute]) -> Value {
    json!(routes
        .iter()
        .map(|r| json!({
            "asset": r.asset,
            "chain": r.chain,
            "network": r.network,
            "wallet": r.wallet,
        }))
        .collect::<Vec<_>>())
}

fn payment_summary(p: &ConnectorPayment) -> Value {
    json!({
        "payment_id": p.payment_id,
        "asset": p.asset,
        "chain": p.chain,
        "network": p.network,
        "amount_usd_cents": p.amount_usd_cents,
        "reference": p.reference,
        "destination": p.destination,
        "status": p.last_status,
        "created_at": p.created_at,
        "checkout_url_path": format!("/#/pay/{}", p.payment_id),
    })
}

// ---------------------------------------------------------------- handlers ---

#[derive(Deserialize)]
struct CreateConnectorReq {
    #[serde(default)]
    label: String,
    /// One wallet for every asset the route table doesn't name explicitly.
    /// The chain kind is inferred from the address shape.
    #[serde(default)]
    default_wallet: String,
    /// Explicit per-asset routes (win over the default wallet).
    #[serde(default)]
    routes: Vec<RouteInput>,
    #[serde(default)]
    webhook_url: String,
}

/// `POST /v1/connectors` — mint a universal receiver. Open self-service,
/// rate-limited; the client secret is shown exactly once.
async fn create_connector(State(state): Ctx, body: axum::body::Bytes) -> ApiResult<Response> {
    guard(&state, "connectors")?;
    let req: CreateConnectorReq = parse_body(&body)?;

    let mut routes: Vec<ConnectorRoute> = Vec::new();
    for input in &req.routes {
        routes.push(materialize_route(input.clone())?);
    }
    if routes.is_empty() {
        let wallet = req.default_wallet.trim().to_string();
        if wallet.is_empty() {
            return Err(AppError::bad_request(
                "give the connector a destination: pass routes[] (asset → wallet rows) or a default_wallet",
            ));
        }
        let chain = infer_chain_from_wallet(&wallet).ok_or_else(|| {
            AppError::bad_request(format!(
                "default_wallet '{wallet}' is not a recognizable address (0x…, bc1…, T…, base58, PP…) — or pass explicit routes[]"
            ))
        })?;
        routes.push(ConnectorRoute {
            asset: "*".into(),
            chain: chain.into(),
            network: String::new(),
            wallet,
        });
    }
    validate_routes(&routes)?;

    let webhook_url = req.webhook_url.trim().to_string();
    if !webhook_url.is_empty()
        && !webhook_url.starts_with("http://")
        && !webhook_url.starts_with("https://")
    {
        return Err(AppError::bad_request("webhook_url must be http(s)"));
    }

    let client_id = format!("cn_{}", rand_hex(6));
    let client_secret = format!("cs_{}", rand_hex(32));
    let record = ConnectorRecord {
        client_id: client_id.clone(),
        secret_hash: secret_hash(&state.config.master_key, &client_id, &client_secret),
        label: req.label.trim().chars().take(80).collect(),
        routes,
        webhook_url,
        created_at: now_secs(),
        payments: Vec::new(),
    };
    {
        let mut map = lock_connectors(&state);
        if map.len() >= MAX_CONNECTORS {
            return Err(AppError::unavailable(
                "this node has reached its connector capacity — contact the operator",
            ));
        }
        map.insert(client_id.clone(), record.clone());
    }
    let routes = record.routes.clone();
    Ok(ok_created(json!({
        "client_id": client_id,
        "client_secret": client_secret,
        "label": record.label,
        "routes": route_json(&routes),
        "webhook_url": record.webhook_url,
        "warning": "store the client secret in your vault now — it cannot be retrieved again",
        "universal_receiver": {
            "how": "hand the client_id + client_secret to any platform integration; it mints payment requests with POST /v1/connect/payments {asset, amount_usd_cents, reference} and the engine auto-routes the money to the wallet YOU picked for that asset — address-to-address on-chain, never custodied",
            "status": "GET /v1/connect/payments/{payment_id} with the same credentials (or webhooks: invoice.paid / invoice.underpaid / invoice.expired)",
            "fee": "1.00% per settled payment (starter schedule)",
        },
        "next": "configure more per-asset routes via POST /v1/connectors/:client_id/config",
    })))
}

/// `GET /v1/connectors/:client_id` — the connector's own view of itself
/// (secret auth): routes, webhook, recent payments.
async fn get_connector(
    State(state): Ctx,
    Path(client_id): Path<String>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let record = require_connector(&state, &client_id, &headers)?;
    Ok(ok(json!({
        "client_id": record.client_id,
        "label": record.label,
        "routes": route_json(&record.routes),
        "webhook_url": record.webhook_url,
        "created_at": record.created_at,
        "payments": record.payments.iter().take(MAX_PAYMENTS_PER_CONNECTOR).map(payment_summary).collect::<Vec<_>>(),
        "payment_count": record.payments.len(),
        "note": "the client secret is verify-only — rotate it via POST /v1/connectors/:client_id/rotate",
    })))
}

#[derive(Deserialize)]
struct ConnectorConfigReq {
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    routes: Option<Vec<RouteInput>>,
    #[serde(default)]
    webhook_url: Option<String>,
}

/// `POST /v1/connectors/:client_id/config` — update label, the WHOLE route
/// table (replace semantics: the owner's routing truth is one consistent
/// list, not a patchwork) and the webhook endpoint. Secret auth.
async fn update_connector(
    State(state): Ctx,
    Path(client_id): Path<String>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> ApiResult<Response> {
    let record = require_connector(&state, &client_id, &headers)?;
    let req: ConnectorConfigReq = parse_body(&body)?;

    let mut label = record.label.clone();
    if let Some(l) = &req.label {
        label = l.trim().chars().take(80).collect();
    }
    let mut webhook_url = record.webhook_url.clone();
    if let Some(w) = &req.webhook_url {
        let w = w.trim().to_string();
        if !w.is_empty() && !w.starts_with("http://") && !w.starts_with("https://") {
            return Err(AppError::bad_request("webhook_url must be http(s)"));
        }
        webhook_url = w;
    }
    let routes = if let Some(inputs) = &req.routes {
        let mut rs = Vec::new();
        for input in inputs {
            rs.push(materialize_route(input.clone())?);
        }
        validate_routes(&rs)?;
        rs
    } else {
        record.routes.clone()
    };

    let updated = {
        let mut map = lock_connectors(&state);
        match map.get_mut(&client_id) {
            Some(rec) => {
                rec.label = label.clone();
                rec.routes = routes.clone();
                rec.webhook_url = webhook_url.clone();
                rec.clone()
            }
            None => return Err(AppError::not_found("connector vanished — re-create it")),
        }
    };
    Ok(ok(json!({
        "client_id": updated.client_id,
        "label": updated.label,
        "routes": route_json(&updated.routes),
        "webhook_url": updated.webhook_url,
        "updated": true,
    })))
}

/// `POST /v1/connectors/:client_id/rotate` — kill the old secret, get a new
/// one (shown once). Secret auth (the outgoing secret performs its own
/// funeral).
async fn rotate_connector(
    State(state): Ctx,
    Path(client_id): Path<String>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let record = require_connector(&state, &client_id, &headers)?;
    let _ = record;
    let client_secret = format!("cs_{}", rand_hex(32));
    {
        let mut map = lock_connectors(&state);
        match map.get_mut(&client_id) {
            Some(rec) => {
                rec.secret_hash = secret_hash(&state.config.master_key, &client_id, &client_secret);
            }
            None => return Err(AppError::not_found("connector vanished — re-create it")),
        }
    }
    Ok(ok(json!({
        "client_id": client_id,
        "client_secret": client_secret,
        "warning": "the previous secret is dead as of this response — store the new one now",
    })))
}

#[derive(Deserialize)]
struct ConnectPaymentReq {
    asset: String,
    amount_usd_cents: u64,
    /// Optional venue hint — honored when the matched route has no explicit
    /// network; a pinned route network always wins (the owner decided).
    #[serde(default)]
    network: String,
    /// Your platform's own id (order id, invoice number, user id) — echoed
    /// on every status response and webhook payload.
    #[serde(default)]
    reference: String,
    #[serde(default)]
    description: String,
    /// Per-payment webhook override (else the connector-level one applies).
    #[serde(default)]
    webhook_url: String,
    ttl_secs: Option<u64>,
}

/// `POST /v1/connect/payments` — THE universal receiver call. Any platform
/// holding the connector credentials mints a payment request in any of the
/// settleable assets; the engine resolves the destination from the route
/// table and returns everything a payer needs (address, exact asset amount
/// at the live rate, hosted checkout URL). Funds land in the owner's wallet
/// address-to-address; the engine verifies the transfer on-chain and marks
/// the payment paid after the network's confirmation depth.
async fn create_connect_payment(
    State(state): Ctx,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> ApiResult<Response> {
    let client_id = headers
        .get("x-payphone-client")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or(AppError::missing_auth())?
        .to_string();
    let record = require_connector(&state, &client_id, &headers)?;
    let req: ConnectPaymentReq = parse_body(&body)?;
    if req.amount_usd_cents == 0 || req.amount_usd_cents > 1_000_000_000_00 {
        return Err(AppError::bad_request("amount_usd_cents must be 1..=100,000,000,000"));
    }
    let asset = req.asset.trim().to_uppercase();
    if asset.is_empty() {
        return Err(AppError::bad_request("asset is required (e.g. USDC, ETH, PYUSD, BTC, SOL)"));
    }

    let (route, network) = resolve_route(&record.routes, &asset, &req.network)
        .map_err(AppError::bad_request)?;
    let route = route.clone();

    // The connector pays the starter schedule (1.00%) — the same open tier
    // any self-served merchant key would pay.
    let ctx = MerchantContext {
        public_key: client_id.clone(),
        tier: Tier::Starter,
        key_id: "connector".into(),
    };
    let invoice_req = crate::routes::CreateInvoiceReq {
        amount_usd_cents: req.amount_usd_cents,
        asset: asset.clone(),
        chain: route.chain.clone(),
        network,
        wallet: route.wallet.clone(),
        token_address: String::new(),
        description: req.description.clone(),
        ttl_secs: req.ttl_secs,
        webhook_url: if req.webhook_url.trim().is_empty() {
            record.webhook_url.clone()
        } else {
            req.webhook_url.trim().to_string()
        },
    };
    let payload = build_invoice_payload(&state, &ctx, invoice_req, &headers).await?;
    let invoice: Invoice = serde_json::from_value(payload["invoice"].clone()).map_err(|e| {
        AppError::internal(format!("invoice payload deserialization failed: {e}"))
    })?;

    let payment = ConnectorPayment {
        payment_id: invoice.id.clone(),
        asset: invoice.asset.clone(),
        chain: invoice.chain.clone(),
        network: invoice.network.clone(),
        amount_usd_cents: req.amount_usd_cents,
        reference: req.reference.trim().chars().take(140).collect(),
        destination: invoice.address.clone(),
        invoice,
        last_status: "pending".into(),
        created_at: now_secs(),
    };
    {
        let mut map = lock_connectors(&state);
        if let Some(rec) = map.get_mut(&client_id) {
            rec.payments.insert(0, payment.clone());
            rec.payments.truncate(MAX_PAYMENTS_PER_CONNECTOR);
        }
    }

    Ok(ok_created(json!({
        "payment_id": payment.payment_id,
        "connector": client_id,
        "status": "awaiting_payment",
        "asset": payment.asset,
        "chain": payment.chain,
        "network": payment.network,
        "destination_wallet": payment.destination,
        "amount_usd_cents": payment.amount_usd_cents,
        "asset_amount": payload["asset_amount"],
        "rate": payload["rate"],
        "fee": payload["fee"],
        "payment_url": payload["payment_url"],
        "checkout_path": payload["checkout_path"],
        "expires_at": payment.invoice.exp,
        "reference": payment.reference,
        "status_url": format!("/v1/connect/payments/{}", payment.payment_id),
        "non_custodial": "funds move address-to-address to the route wallet; PayPhone never holds them",
    })))
}

/// `GET /v1/connect/payments/:id` — live status, observed straight from the
/// chain (same observation path as merchant invoices). Fires the webhook on
/// transitions.
async fn get_connect_payment(
    State(state): Ctx,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let client_id = headers
        .get("x-payphone-client")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or(AppError::missing_auth())?
        .to_string();
    let record = require_connector(&state, &client_id, &headers)?;
    let mut payment = record
        .payments
        .iter()
        .find(|p| p.payment_id == id)
        .cloned()
        .ok_or_else(|| {
            AppError::not_found("no such payment on this connector — payment ids are per-connector")
        })?;

    let observation = state.coordinator.observe(&payment.invoice).await?;
    let now = now_secs();
    let status = resolve_status(&payment.invoice, observation.observed_qty, now);
    if status.as_str() != payment.last_status {
        let event = match status {
            InvoiceStatus::Paid => "invoice.paid",
            InvoiceStatus::Underpaid => "invoice.underpaid",
            InvoiceStatus::Expired => "invoice.expired",
            InvoiceStatus::Pending => "invoice.pending",
        };
        crate::webhooks::spawn_emit(
            &state.config,
            Some(&payment.invoice.whu),
            event,
            &payment.payment_id,
            json!({
                "status": status.as_str(),
                "connector": client_id,
                "reference": payment.reference,
                "asset": payment.asset,
                "chain": payment.chain,
                "network": payment.network,
                "observed_qty": observation.observed_qty.to_string(),
                "destination": payment.destination,
            }),
        );
        payment.last_status = status.as_str().to_string();
        let mut map = lock_connectors(&state);
        if let Some(rec) = map.get_mut(&client_id) {
            if let Some(stored) = rec.payments.iter_mut().find(|p| p.payment_id == id) {
                stored.last_status = payment.last_status.clone();
            }
        }
    }

    Ok(ok(json!({
        "payment": {
            "payment_id": payment.payment_id,
            "connector": client_id,
            "asset": payment.asset,
            "chain": payment.chain,
            "network": payment.network,
            "amount_usd_cents": payment.amount_usd_cents,
            "reference": payment.reference,
            "destination": payment.destination,
            "status": payment.last_status,
            "observed_qty": observation.observed_qty.to_string(),
            "seconds_left": payment.invoice.seconds_left(now),
            "created_at": payment.created_at,
        },
        "receipts": observation.receipts,
        "remaining_qty": payment.invoice.remaining_qty(observation.observed_qty).to_string(),
    })))
}

/// `GET /v1/connect/payments` — the connector's payment log (newest first).
async fn list_connect_payments(State(state): Ctx, headers: HeaderMap) -> ApiResult<Response> {
    let client_id = headers
        .get("x-payphone-client")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or(AppError::missing_auth())?
        .to_string();
    let record = require_connector(&state, &client_id, &headers)?;
    let rows: Vec<Value> = record.payments.iter().map(payment_summary).collect();
    Ok(ok(json!({
        "client_id": client_id,
        "count": rows.len(),
        "payments": rows,
    })))
}

// ------------------------------------------------------------------ router ---

/// Connector routes, merged into the v1 router.
pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/v1/connectors", post(create_connector))
        .route("/v1/connectors/:client_id", get(get_connector))
        .route("/v1/connectors/:client_id/config", post(update_connector))
        .route("/v1/connectors/:client_id/rotate", post(rotate_connector))
        .route(
            "/v1/connect/payments",
            post(create_connect_payment).get(list_connect_payments),
        )
        .route("/v1/connect/payments/:id", get(get_connect_payment))
}

// ------------------------------------------------------------------- tests ---

#[cfg(test)]
mod tests {
    use super::*;

    fn route(asset: &str, chain: &str, network: &str, wallet: &str) -> ConnectorRoute {
        ConnectorRoute {
            asset: asset.into(),
            chain: chain.into(),
            network: network.into(),
            wallet: wallet.into(),
        }
    }

    #[test]
    fn secret_hash_is_deterministic_and_secret_check_is_exact() {
        let h = secret_hash("master", "cn_abc", "cs_xyz");
        assert_eq!(h, secret_hash("master", "cn_abc", "cs_xyz"));
        assert!(verify_secret("master", "cn_abc", "cs_xyz", &h));
        assert!(!verify_secret("master", "cn_abc", "cs_other", &h));
        assert!(!verify_secret("other-master", "cn_abc", "cs_xyz", &h));
        assert!(!verify_secret("master", "cn_abd", "cs_xyz", &h));
        // Garbage stored hash must not panic, must not verify.
        assert!(!verify_secret("master", "cn_abc", "cs_xyz", "not-hex"));
    }

    #[test]
    fn exact_asset_beats_wildcard() {
        let routes = vec![
            route("*", "evm", "base", "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
            route("USDC", "evm", "ethereum", "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
        ];
        let (picked, network) = resolve_route(&routes, "usdc", "").unwrap();
        assert_eq!(picked.wallet, "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
        assert_eq!(network, "ethereum");
        // Unknown asset falls through to the wildcard.
        let (picked, network) = resolve_route(&routes, "ETH", "").unwrap();
        assert_eq!(picked.asset, "*");
        assert_eq!(network, "base");
    }

    #[test]
    fn explicit_route_network_pins_the_venue() {
        let routes = vec![route("USDC", "evm", "polygon", "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")];
        // A caller asking for base still lands on the owner's pinned venue.
        let (picked, network) = resolve_route(&routes, "USDC", "base").unwrap();
        assert_eq!(network, "polygon");
        assert_eq!(picked.wallet, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    }

    #[test]
    fn empty_route_network_honors_the_caller_hint() {
        let routes = vec![route("USDC", "evm", "", "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")];
        let (_, network) = resolve_route(&routes, "USDC", "arbitrum").unwrap();
        assert_eq!(network, "arbitrum");
        let (_, network) = resolve_route(&routes, "USDC", "").unwrap();
        assert_eq!(network, "");
    }

    #[test]
    fn missing_route_is_a_helpful_error() {
        let routes = vec![route("USDC", "evm", "base", "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")];
        assert!(resolve_route(&routes, "BTC", "").is_err());
        assert!(resolve_route(&[], "USDC", "").is_err());
    }

    #[test]
    fn wallet_shape_inference() {
        assert_eq!(infer_chain_from_wallet("0x6c3eA90364068520032917BaeA2B6b7dD45a1C53"), Some("evm"));
        assert_eq!(infer_chain_from_wallet("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"), Some("bitcoin"));
        assert_eq!(infer_chain_from_wallet("1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2"), Some("bitcoin"));
        assert_eq!(infer_chain_from_wallet("TJCnKsPa7y5okkXvQAidZBzqx3QyQ6sxMW"), Some("tron"));
        // 44-char base58 Solana pubkey (the PYUSD mint on Solana).
        assert_eq!(infer_chain_from_wallet("2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo"), Some("solana"));
        assert_eq!(infer_chain_from_wallet("not a wallet"), None);
    }
}
