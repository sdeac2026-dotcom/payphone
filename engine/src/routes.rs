//! HTTP API surface (v1).
//!
//! Every response is wrapped as `{ "data": … }` or `{ "error": { … } }`.
//! Authenticated routes use the request-signing protocol from [`crate::keys`].

use crate::chains::registry;
use crate::chains::ChainKind;
use crate::config::Config;
use crate::error::{ApiResult, AppError};
use crate::fees;
use crate::invoice::{
    self, asset_amount_string, fee_breakdown, resolve_status, sign_token, verify_token, Invoice,
    InvoiceWithStatus, InvoiceStatus,
};
use crate::keys::{self, MerchantContext, Tier};
use crate::oracle::{Oracle, SUPPORTED_ASSETS};
use crate::phone;
use crate::ratelimit::RateLimiter;
use crate::webhooks;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

/// Shared application state.
pub struct AppState {
    pub config: Config,
    pub oracle: Oracle,
    pub simnet: Option<Arc<crate::chains::simnet::SimNet>>,
    pub evm: Option<crate::chains::evm::EvmAdapter>,
    pub bitcoin: Option<crate::chains::bitcoin::BitcoinAdapter>,
    pub solana: Option<crate::chains::solana::SolanaAdapter>,
    pub tron: Option<crate::chains::tron::TronAdapter>,
    pub coordinator: crate::chains::Coordinator,
    pub limiter: RateLimiter,
    pub started: Instant,
    /// Cached live RPC probes for `/v1/chains` (network → (payload, ts)).
    pub chain_probe: std::sync::Mutex<std::collections::HashMap<String, (serde_json::Value, u64)>>,
}

pub type Ctx = State<Arc<AppState>>;

// ------------------------------------------------------------- helpers ----

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()
}

fn rand_hex(n_bytes: usize) -> String {
    use rand::RngCore;
    let mut buf = vec![0u8; n_bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    hex::encode(buf)
}

fn ok(data: Value) -> Response {
    (StatusCode::OK, Json(json!({ "data": data }))).into_response()
}

fn ok_created(data: Value) -> Response {
    (StatusCode::CREATED, Json(json!({ "data": data }))).into_response()
}

/// Enforce the per-key rate limit.
fn guard(state: &AppState, key: &str) -> ApiResult<()> {
    if state.limiter.check(key) {
        Ok(())
    } else {
        Err(AppError::rate_limited())
    }
}

/// Extract and verify merchant credentials from signed headers.
fn require_auth(
    state: &AppState,
    headers: &HeaderMap,
    method: &str,
    path: &str,
    body: &[u8],
) -> ApiResult<MerchantContext> {
    let h = |name: &str| {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
    };
    let pk = h("x-payphone-key").ok_or(AppError::missing_auth())?;
    let ts = h("x-payphone-timestamp").ok_or(AppError::missing_auth())?;
    let sig = h("x-payphone-signature").ok_or(AppError::missing_auth())?;
    keys::verify_signed_request(&state.config, &pk, &ts, method, path, body, &sig)
}

/// Parse a JSON body with a friendly error.
fn parse_body<T: for<'de> Deserialize<'de>>(raw: &[u8]) -> ApiResult<T> {
    serde_json::from_slice(raw).map_err(|e| AppError::bad_request(format!("invalid JSON body: {e}")))
}

/// Public base URL for payment links: env override, else the forwarded
/// origin (`X-Forwarded-Host`/`X-Forwarded-Proto` from the edge), else Host.
fn checkout_base(_state: &AppState, headers: &HeaderMap) -> String {
    if let Some(url) = std::env::var("PAYPHONE_CHECKOUT_URL").ok().filter(|s| !s.is_empty()) {
        return url.trim_end_matches('/').to_string();
    }
    let fwd_host = headers.get("x-forwarded-host").and_then(|v| v.to_str().ok());
    let host = fwd_host
        .or_else(|| headers.get("host").and_then(|v| v.to_str().ok()))
        .unwrap_or("localhost:3000");
    let proto = headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .unwrap_or(if host.contains("localhost") || host.contains("127.0.0.1") { "http" } else { "https" });
    format!("{proto}://{host}")
}

// ---------------------------------------------------------------- health ---

/// `GET /health` — liveness + capability discovery.
async fn health(State(state): Ctx) -> ApiResult<Response> {
    let simnet_stats = match &state.simnet {
        Some(s) => s.stats(),
        None => json!(null),
    };
    Ok(ok(json!({
        "status": "ok",
        "service": "payphone-engine",
        "version": env!("CARGO_PKG_VERSION"),
        "uptime_secs": state.started.elapsed().as_secs(),
        "demo_mode": state.config.demo_mode,
        "simnet_enabled": state.config.simnet_enabled,
        "simnet": simnet_stats,
        "chains": {
            "simnet": state.config.simnet_enabled,
            "evm_networks": registry::NETWORKS.iter().map(|n| n.name).collect::<Vec<_>>(),
            "bitcoin": state.bitcoin.is_some(),
            "solana": state.solana.is_some(),
            "tron": state.tron.is_some(),
        },
        "oracle_source": state.oracle.source_health().await,
        "supported_assets": SUPPORTED_ASSETS,
        "asset_count": SUPPORTED_ASSETS.len(),
        "rate_limit_per_min": state.config.rate_limit_per_min,
    })))
}

// ------------------------------------------------------------------- keys --

#[derive(Deserialize)]
struct IssueKeyReq {
    tier: String,
}

/// `POST /v1/keys` — issue a merchant credential. The secret is shown ONCE.
/// In production, gate with `X-Admin-Token` (set `PAYPHONE_ADMIN_TOKEN`).
async fn issue_key(State(state): Ctx, headers: HeaderMap, body: axum::body::Bytes) -> ApiResult<Response> {
    guard(&state, "keys")?;
    // Optional admin gate.
    if let Ok(admin) = std::env::var("PAYPHONE_ADMIN_TOKEN") {
        let provided = headers
            .get("x-admin-token")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        if provided != admin {
            return Err(AppError::forbidden("admin token required to issue keys"));
        }
    }
    let req: IssueKeyReq = parse_body(&body)?;
    let tier = Tier::parse(&req.tier)?;
    let (pk, sk) = keys::issue_key(&state.config.master_key, tier);
    let fee = fees::for_tier(tier.as_str());
    Ok(ok_created(json!({
        "public_key": pk,
        "secret_key": sk,
        "tier": tier.as_str(),
        "fee_bps": fee.map(|f| f.bps).unwrap_or(150),
        "warning": "store this secret in your vault now — it cannot be retrieved again",
    })))
}

// --------------------------------------------------------------- invoices --

#[derive(Deserialize)]
struct CreateInvoiceReq {
    /// Amount in USD cents (integer minor units — floats are forbidden).
    amount_usd_cents: u64,
    /// Asset the payer sends, e.g. USDC, ETH, BTC, SOL, TRX.
    #[serde(default = "default_asset")]
    asset: String,
    /// `simnet` (demo) | `evm` | `bitcoin` | `solana` | `tron`.
    /// EMPTY = auto-route: the asset catalog picks the default settlement
    /// venue (BTC→bitcoin, SOL→solana, USDC→evm/base, …).
    #[serde(default)]
    chain: String,
    /// Network within the chain (`base`, `ethereum`, `mainnet`, …).
    /// EMPTY = the venue's default.
    #[serde(default)]
    network: String,
    /// Merchant-owned receiving address (non-custodial).
    wallet: String,
    /// ERC-20/SPL/TRC-20 contract override (empty = registry-resolved).
    #[serde(default)]
    token_address: String,
    /// Free-text description (hashed into the token, never stored raw).
    #[serde(default)]
    description: String,
    /// Invoice TTL override.
    ttl_secs: Option<u64>,
    /// Merchant webhook endpoint for this invoice's events.
    #[serde(default)]
    webhook_url: String,
}

fn default_asset() -> String { "USDC".into() }

/// `POST /v1/invoices` — create a stateless invoice.
///
/// The merchant names **what** (asset + amount + wallet); the engine decides
/// **where**: an omitted `chain`/`network` auto-routes through the asset
/// catalog (`BTC` → bitcoin/mainnet, `SOL` → solana/mainnet, `USDC` →
/// evm/base, `ARB` → evm/arbitrum, …). Every asset resolution below is
/// registry-driven and verified at registry build time.
async fn create_invoice(
    State(state): Ctx,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> ApiResult<Response> {
    let ctx = require_auth(&state, &headers, "POST", "/v1/invoices", &body)?;
    guard(&state, &ctx.public_key)?;
    let req: CreateInvoiceReq = parse_body(&body)?;

    // ---- validation ------------------------------------------------------
    if req.amount_usd_cents == 0 || req.amount_usd_cents > 1_000_000_000_00 {
        return Err(AppError::bad_request("amount_usd_cents must be 1..=100,000,000,000"));
    }
    let asset = req.asset.trim().to_uppercase();
    let asset = if asset.is_empty() { "USDC".to_string() } else { asset };

    // ---- chain & network routing (asset catalog drives the default) -------
    let (chain_name, network) = if req.chain.trim().is_empty() {
        let spec = registry::find_asset(&asset).ok_or_else(|| AppError::bad_request(format!(
            "unknown asset '{asset}' — the full catalog is at GET /v1/assets"
        )))?;
        if spec.default_chain == "none" {
            return Err(AppError::bad_request(format!(
                "asset '{asset}' is priced for quotes but not yet settleable — \n                 settleable alternatives are listed in GET /v1/assets"
            )));
        }
        (spec.default_chain.to_string(), spec.default_network.to_string())
    } else {
        let network = req.network.trim().to_string();
        // Default network per chain kind when omitted.
        let net = if network.is_empty() {
            match ChainKind::parse(&req.chain)? {
                ChainKind::Simnet => "simnet".to_string(),
                ChainKind::Evm => registry::find_asset(&asset)
                    .filter(|a| a.default_chain == "evm")
                    .map(|a| a.default_network.to_string())
                    .filter(|n| !n.is_empty())
                    .unwrap_or_else(|| "base".to_string()),
                ChainKind::Bitcoin | ChainKind::Solana | ChainKind::Tron => "mainnet".to_string(),
            }
        } else {
            network
        };
        (req.chain.trim().to_string(), net)
    };
    let kind = ChainKind::parse(&chain_name)?;
    let network = if network.eq_ignore_ascii_case("mainnet") && kind == ChainKind::Evm {
        // Legacy alias: "mainnet" means Ethereum canonical on EVM chains.
        "ethereum".to_string()
    } else {
        network
    };
    state.coordinator.ensure_chain_available(kind, &network, state.config.simnet_enabled)?;
    phone::validate_wallet(kind.as_str(), &req.wallet)?;

    // ---- asset settlement resolution (per chain kind) ----------------------
    // Answers: which contract watches the money, and what precision counts it?
    let (token_address, decimals): (String, u8) = match kind {
        ChainKind::Simnet => (String::new(), crate::oracle::decimals(&asset)),
        ChainKind::Evm => {
            let mut token_address = req.token_address.clone();
            if token_address.is_empty() {
                match registry::resolve_token(&network, &asset) {
                    Some(t) => token_address = t.address.to_string(),
                    None => {
                        let is_native = registry::find(&network)
                            .map(|n| n.native.eq_ignore_ascii_case(&asset))
                            .unwrap_or(false);
                        if !is_native {
                            let opts = registry::settleable_networks(&asset)
                                .iter()
                                .map(|(_, n)| *n)
                                .collect::<Vec<_>>()
                                .join(", ");
                            return Err(AppError::bad_request(format!(
                                "asset '{asset}' is not settleable on network '{network}' — try: {opts} (see GET /v1/assets)"
                            )));
                        }
                    }
                }
            }
            let dp = if token_address.is_empty() {
                registry::native_decimals(&network)
            } else {
                registry::token_by_address(&network, &token_address)
                    .or_else(|| registry::resolve_token(&network, &asset))
                    .map(|t| t.decimals)
                    .ok_or_else(|| AppError::bad_request(
                        "unknown ERC-20 decimals for the supplied token_address — register it in the chain registry",
                    ))?
            };
            (token_address, dp)
        }
        ChainKind::Bitcoin => {
            if asset != "BTC" {
                return Err(AppError::bad_request(format!(
                    "bitcoin settles in native 'BTC' only — '{asset}' is not settleable there"
                )));
            }
            (String::new(), 8)
        }
        ChainKind::Solana => {
            let mint = registry::resolve_offchain_token("solana", &asset);
            match (asset.as_str(), mint, req.token_address.is_empty()) {
                (_, Some(t), true) => (t.address.to_string(), t.decimals),
                (_, None, true) if asset == "SOL" => (String::new(), 9),
                (_, None, true) => return Err(AppError::bad_request(format!(
                    "asset '{asset}' is not settleable on solana — settleable: SOL, USDC"
                ))),
                _ => (req.token_address.clone(), 6), // custom SPL mint override
            }
        }
        ChainKind::Tron => {
            let contract = registry::resolve_offchain_token("tron", &asset);
            match (asset.as_str(), contract, req.token_address.is_empty()) {
                (_, Some(t), true) => (t.address.to_string(), t.decimals),
                (_, None, true) if asset == "TRX" => (String::new(), 6),
                (_, None, true) => return Err(AppError::bad_request(format!(
                    "asset '{asset}' is not settleable on tron — settleable: TRX, USDT"
                ))),
                _ => (req.token_address.clone(), 6), // custom TRC-20 override
            }
        }
    };

    // ---- fee & address ----------------------------------------------------
    let bps = fees::for_tier(ctx.tier.as_str()).map(|t| t.bps).unwrap_or(150);
    let address = match kind {
        ChainKind::Simnet => phone::simnet_invoice_address(
            &format!("{}|{}", ctx.public_key, rand_hex(6)), &state.config.signing_key),
        // Real chains: the merchant's own receiving address, non-custodial.
        _ => req.wallet.clone(),
    };

    // ---- baseline balance + observation window (stateless matching) -------
    let (base_qty, birth_block) = match kind {
        ChainKind::Simnet => (0u128, 0u64), // unique address per invoice
        ChainKind::Evm => {
            let evm = state.evm.as_ref()
                .ok_or_else(|| AppError::unavailable("no EVM RPC configured"))?;
            let token = if token_address.is_empty() {
                None
            } else {
                Some(crate::chains::evm::Erc20 {
                    address: token_address.clone(),
                    decimals,
                })
            };
            // One round-trip each: tip marks the observation window start,
            // the balance snapshot powers native-asset delta matching.
            let tip = evm.block_number(&network).await?;
            let bal = evm.balance(&network, &req.wallet, token.as_ref()).await?;
            (bal, tip)
        }
        ChainKind::Bitcoin => {
            let btc = state.bitcoin.as_ref()
                .ok_or_else(|| AppError::unavailable("no Bitcoin API configured"))?;
            // Confirmed-balance baseline + birth height for the receipt window.
            let bal = btc.confirmed_balance(&req.wallet).await?;
            let tip = btc.tip_height().await?;
            (bal, tip)
        }
        ChainKind::Solana => {
            let sol = state.solana.as_ref()
                .ok_or_else(|| AppError::unavailable("no Solana RPC configured"))?;
            let bal = if token_address.is_empty() {
                sol.balance_lamports(&req.wallet).await?
            } else {
                sol.balance_spl(&req.wallet, &token_address).await?
            };
            (bal, 0) // balance-delta needs no birth marker
        }
        ChainKind::Tron => {
            let tron = state.tron.as_ref()
                .ok_or_else(|| AppError::unavailable("no Tron API configured"))?;
            if token_address.is_empty() {
                let bal = tron.balance_sun(&req.wallet).await?;
                (bal, 0)
            } else {
                // Event-sum model: baseline = confirmed transfers already on
                // the address, so only *new* payments count as observed.
                let (baseline, _) = tron
                    .confirmed_transfers_to(&req.wallet, &token_address, 2)
                    .await?;
                (baseline, 0)
            }
        }
    };

    // ---- pricing (rate-locked at the chain's own precision) ----------------
    let rate = state.oracle.rate(&asset).await?;
    let qte = invoice::expected_qty_dp(req.amount_usd_cents, rate.usd, decimals);
    let asset_amount = crate::chains::evm::base_units_to_decimal(qte, decimals);

    let ttl = req.ttl_secs.unwrap_or(state.config.invoice_ttl_secs).clamp(60, 86_400);
    let invoice = Invoice {
        v: 1,
        id: format!("inv_{}", rand_hex(8)),
        mid: ctx.public_key.clone(),
        tier: ctx.tier.as_str().to_string(),
        amount_minor: req.amount_usd_cents,
        currency: "USD".into(),
        asset,
        chain: kind.as_str().to_string(),
        network: network.clone(),
        address,
        token_address,
        description_hash: invoice::hash_description(&req.description),
        fee_bps: bps,
        base_qty,
        qte,
        iat: now_secs(),
        exp: now_secs() + ttl,
        nce: rand_hex(6),
        whu: req.webhook_url.clone(),
        birth_block,
    };
    let token = sign_token(&state.config.signing_key, &invoice)?;
    let base = checkout_base(&state, &headers);
    let payment_url = format!("{base}/#/pay/{}?t={token}", invoice.id);

    let fb = fee_breakdown(&invoice);
    // Revenue engine, made concrete: when the operator configured a treasury
    // (`PAYPHONE_TREASURY_ADDRESS`), every invoice names the fee recipient and
    // the exact fee quantity — priced at the rate locked into this invoice —
    // so the fee line can be settled as transparently as the payment itself.
    let fee_recipient = state.config.treasury.as_ref().map(|addr| {
        let fee_qty = invoice::fee_qty_for(&invoice);
        json!({
            "address": addr,
            "asset": invoice.asset,
            "network": invoice.network,
            "fee_qty": fee_qty.to_string(),
            "fee_amount_decimal": crate::chains::evm::base_units_to_decimal(fee_qty, decimals),
        })
    });
    Ok(ok_created(json!({
        "invoice": invoice,
        "token": token,
        "payment_url": payment_url,
        "checkout_path": format!("/#/pay/{}?t={token}", invoice.id),
        "rate": rate,
        "asset_amount": asset_amount,
        "fee": fb,
        "fee_recipient": fee_recipient,
        "ttl_secs": ttl,
    })))
}

/// `GET /v1/invoices/:id?token=…` — live status, observed straight from the chain.
async fn get_invoice(
    State(state): Ctx,
    Path(id): Path<String>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> ApiResult<Response> {
    let token = q.get("token").ok_or_else(|| AppError::bad_request("token query parameter required"))?;
    let inv = verify_token(&state.config.signing_key, token)?;
    if inv.id != id {
        return Err(AppError::bad_request("token does not belong to this invoice id"));
    }
    guard(&state, &format!("inv:{}", inv.mid))?;

    let observation = state.coordinator.observe(&inv).await?;
    let now = now_secs();
    let status = resolve_status(&inv, observation.observed_qty, now);

    // Poll-driven event emission (v1): fire webhook on transitions.
    if status != InvoiceStatus::Pending {
        let event = match status {
            InvoiceStatus::Paid => "invoice.paid",
            InvoiceStatus::Underpaid => "invoice.underpaid",
            InvoiceStatus::Expired => "invoice.expired",
            InvoiceStatus::Pending => unreachable!(),
        };
        webhooks::spawn_emit(
            &state.config,
            Some(&inv.whu),
            event,
            &inv.id,
            json!({
                "status": status.as_str(),
                "observed_qty": observation.observed_qty.to_string(),
                "chain": inv.chain,
                "asset": inv.asset,
            }),
        );
    }

    let rate = state.oracle.rate(&inv.asset).await.ok();
    // Fee destination for this invoice (display decimals mirror the
    // settlement resolution used at creation; `fee_qty` is the exact,
    // rate-locked quantity — the settlement truth in base units).
    let fee_decimals: u8 = if inv.token_address.is_empty() {
        match inv.chain.as_str() {
            "bitcoin" => 8,
            "solana" => 9,
            "tron" => 6,
            "simnet" => crate::oracle::decimals(&inv.asset),
            _ => registry::native_decimals(&inv.network),
        }
    } else if inv.chain == "solana" || inv.chain == "tron" {
        registry::resolve_offchain_token(&inv.chain, &inv.asset)
            .map(|t| t.decimals)
            .unwrap_or(6)
    } else {
        registry::resolve_token(&inv.network, &inv.asset)
            .map(|t| t.decimals)
            .unwrap_or(18)
    };
    let fee_recipient = state.config.treasury.as_ref().map(|addr| {
        let fee_qty = invoice::fee_qty_for(&inv);
        json!({
            "address": addr,
            "asset": inv.asset,
            "network": inv.network,
            "fee_qty": fee_qty.to_string(),
            "fee_amount_decimal": crate::chains::evm::base_units_to_decimal(fee_qty, fee_decimals),
        })
    });
    let with_status = InvoiceWithStatus {
        invoice: inv.clone(),
        status: status.clone(),
        observed_qty: observation.observed_qty,
        seconds_left: inv.seconds_left(now),
    };
    Ok(ok(json!({
        "invoice": with_status,
        "fee": fee_breakdown(&inv),
        "fee_recipient": fee_recipient,
        "rate": rate,
        "asset_amount": rate.as_ref().map(|r| asset_amount_string(inv.amount_minor, r.usd)).unwrap_or_default(),
        "receipts": observation.receipts,
        "remaining_qty": inv.remaining_qty(observation.observed_qty).to_string(),
        "demo_mode": state.config.demo_mode,
    })))
}

// ----------------------------------------------------------------- chains --

/// `GET /v1/chains` — the live multi-network capability sheet.
///
/// Every registered mainnet with its verified chain id, settleable tokens,
/// confirmation policy, explorer and a cached RPC liveness probe. This is
/// both operator diagnostics and the public "what can I settle in" answer.
async fn list_chains(State(state): Ctx) -> ApiResult<Response> {
    const PROBE_TTL_SECS: u64 = 60;
    let now = now_secs();
    let mut networks = Vec::new();

    for net in crate::chains::registry::NETWORKS {
        // Probe from cache; on miss, ask the chain for its real chain id.
        let cached = {
            let cache = state.chain_probe.lock().unwrap();
            cache.get(net.name).and_then(|(v, at)| {
                if now.saturating_sub(*at) < PROBE_TTL_SECS {
                    Some(v.clone())
                } else {
                    None
                }
            })
        };
        let probe = match cached {
            Some(p) => p,
            None => {
                let p = match state.evm.as_ref() {
                    Some(evm) => match evm.chain_id(net.name).await {
                        Ok(id) => json!({
                            "rpc_live": true,
                            "chain_id_reported": id,
                            "chain_id_matches": id == net.chain_id,
                        }),
                        Err(e) => json!({ "rpc_live": false, "error": e.to_string() }),
                    },
                    None => json!({ "rpc_live": false, "error": "evm adapter unavailable" }),
                };
                state
                    .chain_probe
                    .lock()
                    .unwrap()
                    .insert(net.name.to_string(), (p.clone(), now));
                p
            }
        };

        let rpc_source = state
            .config
            .evm_rpcs
            .iter()
            .find(|(n, _url)| n == net.name)
            .map(|(_, url)| {
                if url == net.public_rpc {
                    "default-public"
                } else {
                    "custom"
                }
            })
            .unwrap_or("unconfigured");

        networks.push(json!({
            "name": net.name,
            "kind": "evm",
            "chain_id": net.chain_id,
            "native_asset": net.native,
            "settleable_tokens": net.tokens.iter().map(|t| json!({
                "symbol": t.symbol,
                "address": t.address,
                "decimals": t.decimals,
            })).collect::<Vec<_>>(),
            "confirmations_required": net.confirmations,
            "explorer_tx": net.explorer_tx,
            "rpc_source": rpc_source,
            "probe": probe,
        }));
    }

    // ---- non-EVM watch-only mainnets ---------------------------------------
    for c in registry::OFFCHAIN_CHAINS {
        let probe = {
            let cached = {
                let cache = state.chain_probe.lock().unwrap();
                cache.get(c.chain).and_then(|(v, at)| {
                    if now.saturating_sub(*at) < PROBE_TTL_SECS {
                        Some(v.clone())
                    } else {
                        None
                    }
                })
            };
            match cached {
                Some(p) => p,
                None => {
                    let p = match c.chain {
                        "bitcoin" => match state.bitcoin.as_ref() {
                            Some(b) => match b.tip_height().await {
                                Ok(h) => json!({ "rpc_live": true, "tip_height": h }),
                                Err(e) => json!({ "rpc_live": false, "error": e.to_string() }),
                            },
                            None => json!({ "rpc_live": false, "error": "bitcoin adapter unavailable" }),
                        },
                        "solana" => match state.solana.as_ref() {
                            Some(s) => match s.slot().await {
                                Ok(slot) => json!({ "rpc_live": true, "slot": slot }),
                                Err(e) => json!({ "rpc_live": false, "error": e.to_string() }),
                            },
                            None => json!({ "rpc_live": false, "error": "solana adapter unavailable" }),
                        },
                        "tron" => match state.tron.as_ref() {
                            Some(t) => match t.block_number().await {
                                Ok(b) => json!({ "rpc_live": true, "block": b }),
                                Err(e) => json!({ "rpc_live": false, "error": e.to_string() }),
                            },
                            None => json!({ "rpc_live": false, "error": "tron adapter unavailable" }),
                        },
                        _ => json!({ "rpc_live": false, "error": "unknown chain" }),
                    };
                    state
                        .chain_probe
                        .lock()
                        .unwrap()
                        .insert(c.chain.to_string(), (p.clone(), now));
                    p
                }
            }
        };
        networks.push(json!({
            "name": c.name,
            "kind": c.chain,
            "chain_id": null,
            "native_asset": c.native,
            "settleable_tokens": c.tokens.iter().map(|t| json!({
                "symbol": t.symbol,
                "address": t.address,
                "decimals": t.decimals,
            })).collect::<Vec<_>>(),
            "confirmations_required": c.confirmations,
            "explorer_tx": match c.chain {
                "bitcoin" => "https://blockstream.info/tx/",
                "solana" => "https://solscan.io/tx/",
                _ => "https://tronscan.org/#/transaction/",
            },
            "rpc_source": "default-public",
            "probe": probe,
        }));
    }

    // Demo chain, kept last for clarity.
    if state.config.simnet_enabled {
        networks.push(json!({
            "name": "simnet",
            "kind": "simnet",
            "chain_id": null,
            "native_asset": "SIM",
            "settleable_tokens": [{ "symbol": "USDC", "address": "simnet-native", "decimals": 6 }],
            "confirmations_required": 0,
            "explorer_tx": null,
            "rpc_source": "built-in",
            "probe": { "rpc_live": true, "note": "built-in demo chain — no real funds" },
        }));
    }

    Ok(ok(json!({
        "networks": networks,
        "count": networks.len(),
        "note": "all networks except simnet are real mainnets; payments settle to merchant-owned wallets (non-custodial)",
    })))
}

// ----------------------------------------------------------------- assets --

/// `GET /v1/assets` — the full invoice-able asset catalog.
///
/// This is the machine-readable answer to "which crypto can I bill in?":
/// each row names the asset, its default settlement venue (used when an
/// invoice request omits `chain`/`network`) and every network where it can
/// actually settle. Quote-only majors are listed with `settleable: false`
/// so integrations can render them (and their roadmap status) honestly.
async fn list_assets(State(state): Ctx) -> ApiResult<Response> {
    guard(&state, "assets")?;
    let assets: Vec<Value> = registry::ASSET_CATALOG
        .iter()
        .map(|a| {
            let settle = registry::settleable_networks(a.symbol);
            json!({
                "symbol": a.symbol,
                "name": a.name,
                "decimals": a.decimals,
                "default_chain": a.default_chain,
                "default_network": a.default_network,
                "settleable": !settle.is_empty(),
                "settleable_networks": settle
                    .iter()
                    .map(|(c, n)| json!({ "chain": c, "network": n }))
                    .collect::<Vec<_>>(),
            })
        })
        .collect();
    let settleable_count = assets
        .iter()
        .filter(|a| a["settleable"].as_bool().unwrap_or(false))
        .count();
    Ok(ok(json!({
        "assets": assets,
        "count": assets.len(),
        "settleable_count": settleable_count,
        "note": "invoice creation auto-routes to default_chain/default_network when 'chain' is omitted; quote-only assets settle nowhere yet",
    })))
}

// ------------------------------------------------------------------ rates --

/// `GET /v1/rates?assets=BTC,ETH,USDC`
async fn get_rates(
    State(state): Ctx,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> ApiResult<Response> {
    let assets = q.get("assets").cloned().unwrap_or_else(|| "BTC,ETH,USDC".into());
    guard(&state, "rates")?;
    let rates = state.oracle.rates(&assets).await?;
    Ok(ok(json!({ "rates": rates })))
}

/// `GET /v1/quote?amount_usd_cents=2500&asset=USDC` — conversion quote with
/// the conversion spread (a PayPhone revenue line, shown transparently).
async fn get_quote(
    State(state): Ctx,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> ApiResult<Response> {
    guard(&state, "quote")?;
    let amount: u64 = q
        .get("amount_usd_cents")
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| AppError::bad_request("amount_usd_cents required"))?;
    let asset = q.get("asset").cloned().unwrap_or_else(|| "USDC".into()).to_uppercase();
    let spread_bps: u64 = q.get("spread_bps").and_then(|s| s.parse().ok()).unwrap_or(40).clamp(0, 500);

    let rate = state.oracle.rate(&asset).await?;
    let usd = amount as f64 / 100.0;
    let gross_qty = usd / rate.usd;
    let net_qty = gross_qty * (1.0 - spread_bps as f64 / 10_000.0);
    Ok(ok(json!({
        "amount_usd_cents": amount,
        "asset": asset,
        "rate_usd": rate.usd,
        "rate_source": rate.source,
        "spread_bps": spread_bps,
        "gross_qty": format!("{gross_qty:.6}"),
        "quoted_qty": format!("{net_qty:.6}"),
        "spread_cost_usd_cents": (amount as f64 * spread_bps as f64 / 10_000.0) as u64,
        "note": "spread funds instant-conversion liquidity operations",
    })))
}

// ------------------------------------------------------------------- fees --

/// `GET /v1/fees/schedule` — the public revenue model, full transparency.
/// Also names the live treasury (protocol fee recipient) when configured.
async fn fee_schedule(State(state): Ctx) -> ApiResult<Response> {
    guard(&state, "fees")?;
    Ok(ok(json!({
        "schedule": fees::SCHEDULE,
        "split": { "protocol_pct": fees::SPLIT.0, "referrer_pct": fees::SPLIT.1, "operations_pct": fees::SPLIT.2 },
        "treasury": state.config.treasury,
    })))
}

/// `GET /v1/fees/quote?amount_usd_cents=10000&tier=growth`
async fn fee_quote(
    State(state): Ctx,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> ApiResult<Response> {
    guard(&state, "fees")?;
    let amount: u64 = q
        .get("amount_usd_cents")
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| AppError::bad_request("amount_usd_cents required"))?;
    let tier = q.get("tier").cloned().unwrap_or_else(|| "growth".into());
    let bps = fees::for_tier(&tier).map(|t| t.bps).ok_or_else(|| AppError::bad_request("unknown tier"))?;
    Ok(ok(json!({ "fee": fees::compute(amount, bps, &tier) })))
}

// --------------------------------------------------------------- identity --

#[derive(Deserialize)]
struct PhoneReq {
    phone: String,
    #[serde(default)]
    default_country: Option<String>,
}

/// `POST /v1/identity/resolve` — phone number → chain identity.
async fn resolve_phone(
    State(state): Ctx,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> ApiResult<Response> {
    let ctx = require_auth(&state, &headers, "POST", "/v1/identity/resolve", &body)?;
    guard(&state, &ctx.public_key)?;
    let req: PhoneReq = parse_body(&body)?;
    let e164 = phone::normalize_e164(&req.phone, req.default_country.as_deref())?;
    let hash = phone::phone_hash(&e164, &state.config.phone_pepper);
    let pid = phone::payphone_id(&hash);
    let sim_addr = phone::simnet_address(&hash, &state.config.signing_key);

    let registered = state.simnet.as_ref().and_then(|s| s.resolve(&hash));
    Ok(ok(json!({
        "payphone_id": pid,
        "phone_hash": hash,
        "masked_phone": mask_phone(&e164),
        "simnet_address": sim_addr,
        "registered": registered.is_some(),
        "wallet": registered.as_ref().map(|r| r.wallet.clone()),
        "registered_at": registered.as_ref().map(|r| r.registered_at),
        "privacy": "raw phone numbers are never logged or persisted — only this salted hash",
    })))
}

/// `POST /v1/identity/lookup` — PUBLIC, rate-limited phone → payment address
/// resolution for the PayPhone Wallet and third-party clients. Deliberately
/// narrower than `/v1/identity/resolve`: returns only what a payer needs to
/// pay — the derived PayPhone ID / deterministic simnet address and, when the
/// recipient registered one, their real payout wallet. No merchant auth
/// required (a consumer wallet holds no API keys); rate-limited per looked-up
/// number and the response carries no hash material.
#[derive(Deserialize)]
struct LookupReq {
    phone: String,
    #[serde(default)]
    default_country: Option<String>,
}

async fn lookup_phone(State(state): Ctx, body: axum::body::Bytes) -> ApiResult<Response> {
    let req: LookupReq = parse_body(&body)?;
    let e164 = phone::normalize_e164(&req.phone, req.default_country.as_deref())?;
    let hash = phone::phone_hash(&e164, &state.config.phone_pepper);
    // Per-number rate limit — cheap ops, and probing the same number in a
    // loop is throttled by the shared limiter budget.
    guard(&state, &format!("lookup:{}", hash))?;
    let pid = phone::payphone_id(&hash);
    let sim_addr = phone::simnet_address(&hash, &state.config.signing_key);
    let registered = state.simnet.as_ref().and_then(|s| s.resolve(&hash));
    Ok(ok(json!({
        "payphone_id": pid,
        "masked_phone": mask_phone(&e164),
        "simnet_address": sim_addr,
        "registered": registered.is_some(),
        "wallet": registered.as_ref().map(|r| r.wallet.clone()),
        "privacy": "raw phone numbers are never logged or persisted — only this salted hash",
    })))
}

#[derive(Deserialize)]
struct RegisterReq {
    phone: String,
    wallet: String,
    #[serde(default)]
    default_country: Option<String>,
}

/// `POST /v1/identity/register` — bind a phone hash to a payout wallet.
async fn register_phone(
    State(state): Ctx,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> ApiResult<Response> {
    let ctx = require_auth(&state, &headers, "POST", "/v1/identity/register", &body)?;
    guard(&state, &ctx.public_key)?;
    let req: RegisterReq = parse_body(&body)?;
    let e164 = phone::normalize_e164(&req.phone, req.default_country.as_deref())?;
    let hash = phone::phone_hash(&e164, &state.config.phone_pepper);
    let pid = phone::payphone_id(&hash);
    phone::validate_wallet("simnet", &req.wallet)?;

    let sim = state.simnet.as_ref().ok_or_else(|| AppError::unavailable("simnet disabled"))?;
    let block = sim.register(&hash, &req.wallet, &pid)?;
    Ok(ok_created(json!({
        "payphone_id": pid,
        "wallet": req.wallet,
        "tx": { "height": block.height, "hash": block.hash },
        "next": "payments to this PayPhone ID now route to the registered wallet",
    })))
}

#[derive(Deserialize)]
struct EscrowReq {
    phone: String,
    #[serde(default = "default_asset")]
    asset: String,
    amount_usd_cents: u64,
    #[serde(default)]
    default_country: Option<String>,
}

/// `POST /v1/identity/escrow` — pay a phone number that isn't registered yet.
/// Funds lock behind a claim code (delivered by SMS in production; returned
/// in the API response only in demo mode).
async fn create_escrow(
    State(state): Ctx,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> ApiResult<Response> {
    let ctx = require_auth(&state, &headers, "POST", "/v1/identity/escrow", &body)?;
    guard(&state, &ctx.public_key)?;
    let req: EscrowReq = parse_body(&body)?;
    if req.amount_usd_cents == 0 || req.amount_usd_cents > 100_000_000_00 {
        return Err(AppError::bad_request("amount_usd_cents out of range"));
    }
    let e164 = phone::normalize_e164(&req.phone, req.default_country.as_deref())?;
    let hash = phone::phone_hash(&e164, &state.config.phone_pepper);
    let pid = phone::payphone_id(&hash);

    // 6-digit claim code. Journal stores only its hash.
    let code = format!("{:06}", rand::random::<u32>() % 1_000_000);
    let code_hash = hex::encode(Sha256::digest(code.as_bytes()));

    let sim = state.simnet.as_ref().ok_or_else(|| AppError::unavailable("simnet disabled"))?;
    let (escrow_id, block) = sim.escrow(&hash, &req.asset.to_uppercase(), req.amount_usd_cents, &code_hash, "payer")?;

    Ok(ok_created(json!({
        "escrow_id": escrow_id,
        "payphone_id": pid,
        "asset": req.asset.to_uppercase(),
        "amount_usd_cents": req.amount_usd_cents,
        "tx": { "height": block.height, "hash": block.hash },
        "claim_code": code,
        "claim_code_delivery": if state.config.demo_mode {
            "DEMO: returned inline. Production delivers via SMS to the phone number."
        } else {
            "Delivered via SMS to the recipient."
        },
        "next": "recipient registers a wallet and claims with this code",
    })))
}

#[derive(Deserialize)]
struct ClaimReq {
    escrow_id: String,
    phone: String,
    code: String,
    #[serde(default)]
    default_country: Option<String>,
}

/// `POST /v1/identity/claim` — recipient proves phone ownership and receives
/// the escrowed funds into their registered wallet.
async fn claim_escrow(
    State(state): Ctx,
    body: axum::body::Bytes,
) -> ApiResult<Response> {
    guard(&state, "claim")?;
    let req: ClaimReq = parse_body(&body)?;
    let e164 = phone::normalize_e164(&req.phone, req.default_country.as_deref())?;
    let hash = phone::phone_hash(&e164, &state.config.phone_pepper);

    let sim = state.simnet.as_ref().ok_or_else(|| AppError::unavailable("simnet disabled"))?;
    let (amount, wallet, block) = sim.claim(&req.escrow_id, &req.code, &hash)?;
    Ok(ok(json!({
        "escrow_id": req.escrow_id,
        "released_amount_usd_cents": amount,
        "wallet": wallet,
        "tx": { "height": block.height, "hash": block.hash },
    })))
}

fn mask_phone(e164: &str) -> String {
    let digits = &e164[1..];
    if digits.len() <= 4 {
        return format!("+••••{digits}");
    }
    format!("+••• {}", &digits[digits.len() - 4..])
}

// --------------------------------------------------------------- webhooks --

#[derive(Deserialize)]
struct TestWebhookReq {
    url: String,
    #[serde(default)]
    event: Option<String>,
}

/// `POST /v1/webhooks/test` — send a signed test event to your endpoint.
async fn test_webhook(
    State(state): Ctx,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> ApiResult<Response> {
    let ctx = require_auth(&state, &headers, "POST", "/v1/webhooks/test", &body)?;
    guard(&state, &ctx.public_key)?;
    let req: TestWebhookReq = parse_body(&body)?;
    if !req.url.starts_with("http://") && !req.url.starts_with("https://") {
        return Err(AppError::bad_request("webhook url must be http(s)"));
    }
    let event = req.event.unwrap_or_else(|| "invoice.paid".into());
    let payload = webhooks::build_event(&event, "inv_test_0000", json!({ "status": "paid", "test": true }));
    let ts = now_secs();
    let body_str = serde_json::to_string(&payload).unwrap();
    let sig = keys::compute_event_signature(&state.config.signing_key, ts, &body_str);
    let delivery = webhooks::deliver(&req.url, &state.config.signing_key, &event, &payload).await;

    Ok(ok(json!({
        "event": event,
        "payload": payload,
        "headers": {
            "X-PayPhone-Event": event,
            "X-PayPhone-Timestamp": ts.to_string(),
            "X-PayPhone-Signature": sig,
        },
        "delivery": match &delivery {
            Ok((attempts, status)) => json!({ "delivered": true, "attempts": attempts, "status": status }),
            Err(e) => json!({ "delivered": false, "error": e }),
        },
        "verify_hint": "signature = hex(HMAC_SHA256(webhook_secret, \"{timestamp}.{raw_body}\"))",
    })))
}

#[derive(Deserialize)]
struct VerifyWebhookReq {
    secret: String,
    timestamp: String,
    signature: String,
    payload: String,
}

/// `POST /v1/webhooks/verify` — teach-by-doing endpoint: verify a signature
/// exactly the way the SDKs do.
async fn verify_webhook(State(state): Ctx, body: axum::body::Bytes) -> ApiResult<Response> {
    guard(&state, "verify")?;
    let req: VerifyWebhookReq = parse_body(&body)?;
    let ts: u64 = req.timestamp.parse().map_err(|_| AppError::bad_request("timestamp must be unix seconds"))?;
    let expected = keys::compute_event_signature(&state.config.signing_key, ts, &req.payload);
    let valid = expected == req.signature.trim().to_lowercase();
    Ok(ok(json!({
        "valid": valid,
        "expected_signature": expected,
        "algorithm": "hex(HMAC_SHA256(secret, \"{timestamp}.{payload}\"))",
    })))
}

// ----------------------------------------------------------------- simnet --

/// `GET /v1/simnet/blocks?limit=25` — the chain explorer feed.
async fn simnet_blocks(
    State(state): Ctx,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> ApiResult<Response> {
    let sim = state.simnet.as_ref().ok_or_else(|| AppError::unavailable("simnet disabled"))?;
    guard(&state, "simnet")?;
    let limit: usize = q.get("limit").and_then(|s| s.parse().ok()).unwrap_or(25).min(200);
    Ok(ok(json!({ "blocks": sim.recent_blocks(limit), "stats": sim.stats() })))
}

#[derive(Deserialize)]
struct SimPayReq {
    to: String,
    #[serde(default = "default_asset")]
    asset: String,
    amount_minor: u64,
    #[serde(default)]
    invoice_id: Option<String>,
    #[serde(default)]
    from: Option<String>,
    /// Invoice token: lets the engine settle the protocol fee alongside the
    /// payment (fee priced from the signed object, not the client).
    #[serde(default)]
    token: Option<String>,
}

/// `POST /v1/simnet/pay` — the demo wallet: inject a payment into SimNet.
/// Disabled entirely when `PAYPHONE_SIMNET=0`.
async fn simnet_pay(State(state): Ctx, body: axum::body::Bytes) -> ApiResult<Response> {
    let sim = state.simnet.as_ref().ok_or_else(|| AppError::unavailable("simnet disabled"))?;
    guard(&state, "simnet")?;
    let req: SimPayReq = parse_body(&body)?;
    phone::validate_wallet("simnet", &req.to)?;
    if req.amount_minor == 0 || req.amount_minor > 1_000_000_000_000 {
        return Err(AppError::bad_request("amount_minor out of range"));
    }
    let block = sim.pay(
        &req.to,
        &req.asset.to_uppercase(),
        req.amount_minor as u128,
        req.invoice_id.as_deref(),
        req.from.as_deref().unwrap_or("simnet-wallet"),
    )?;
    // Revenue engine, made observable: with a treasury configured, the fee
    // travels WITH the payment — a second SimNet transaction payer →
    // treasury, priced from the signed invoice token at the locked rate.
    let mut fee_tx = None;
    if let (Some(treasury), Some(tok)) = (state.config.treasury.as_ref(), req.token.as_deref()) {
        if let Ok(inv) = invoice::verify_token(&state.config.signing_key, tok) {
            let id_matches = req.invoice_id.as_deref().map_or(true, |id| id == inv.id);
            if id_matches && inv.chain == "simnet" {
                let fee_qty = invoice::fee_qty_for(&inv);
                if fee_qty > 0 {
                    let fee_block = sim.pay(
                        treasury,
                        &inv.asset.to_uppercase(),
                        fee_qty,
                        Some(&format!("fee:{}", inv.id)),
                        req.from.as_deref().unwrap_or("simnet-wallet"),
                    )?;
                    fee_tx = Some(json!({
                        "height": fee_block.height,
                        "hash": fee_block.hash,
                        "ts": fee_block.ts,
                        "to": treasury,
                        "asset": inv.asset.to_uppercase(),
                        "qty": fee_qty.to_string(),
                    }));
                }
            }
        }
    }
    Ok(ok_created(json!({
        "tx": { "height": block.height, "hash": block.hash, "ts": block.ts },
        "fee_tx": fee_tx,
        "to": req.to,
        "amount_minor": req.amount_minor.to_string(),
        "balance_after": sim.balance(&req.to).to_string(),
        "demo": true,
    })))
}

/// `GET /v1/simnet/balance/:address`
async fn simnet_balance(State(state): Ctx, Path(address): Path<String>) -> ApiResult<Response> {
    let sim = state.simnet.as_ref().ok_or_else(|| AppError::unavailable("simnet disabled"))?;
    guard(&state, "simnet")?;
    Ok(ok(json!({
        "address": address,
        "balance_minor": sim.balance(&address).to_string(),
    })))
}

// ----------------------------------------------------------------- router --

/// Build the full v1 router.
pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/v1/health", get(health))
        .route("/v1/chains", get(list_chains))
        .route("/v1/assets", get(list_assets))
        .route("/v1/keys", post(issue_key))
        .route("/v1/invoices", post(create_invoice))
        .route("/v1/invoices/:id", get(get_invoice))
        .route("/v1/rates", get(get_rates))
        .route("/v1/quote", get(get_quote))
        .route("/v1/fees/schedule", get(fee_schedule))
        .route("/v1/fees/quote", get(fee_quote))
        .route("/v1/identity/resolve", post(resolve_phone))
        .route("/v1/identity/lookup", post(lookup_phone))
        .route("/v1/identity/register", post(register_phone))
        .route("/v1/identity/escrow", post(create_escrow))
        .route("/v1/identity/claim", post(claim_escrow))
        .route("/v1/webhooks/test", post(test_webhook))
        .route("/v1/webhooks/verify", post(verify_webhook))
        .route("/v1/simnet/blocks", get(simnet_blocks))
        .route("/v1/simnet/pay", post(simnet_pay))
        .route("/v1/simnet/balance/:address", get(simnet_balance))
        .fallback(not_found)
        .with_state(state)
}

async fn not_found() -> Response {
    AppError::not_found("route not found — see docs/API.md").into_response()
}
