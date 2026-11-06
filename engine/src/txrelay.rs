//! TxRelay — preparation and broadcast for transactions the WALLET signs.
//!
//! The earn buttons (and the send flow's fallback) used to make four
//! browser-side RPC round-trips through public gateways before a single
//! signature existed — fees, gas, nonce, balance — and then broadcast
//! through the same gateway. One throttled or CORS-blocked gateway
//! (1rpc.io, in the field report: "Failed to fetch … 1rpc.io/eth") turned
//! "stake" into an error toast. This module moves the network work to the
//! engine's RPC mesh, the same fix that already rescued balance reads.
//!
//! The non-custodial boundary is the design:
//! - `POST /v1/tx/prepare` — read-only numbers (chain id, pending nonce,
//!   gas estimate for the exact calldata, EIP-1559 fees) from the mesh.
//! - `POST /v1/tx/broadcast` — relays an ALREADY-SIGNED raw RLP blob. The
//!   engine cannot create, modify, or sign anything; it forwards bytes.
//!   The signature — the only thing that can move funds — is made in the
//!   wallet's keystore, exactly as before.

use crate::error::{ApiResult, AppError};
use crate::routes::{guard, ok, parse_body, AppState, Ctx};
use axum::extract::State;
use axum::response::Response;
use axum::routing::post;
use axum::{Router, Json};
use serde::Deserialize;
use serde_json::{json, Value};

pub fn router() -> Router<std::sync::Arc<AppState>> {
    Router::new()
        .route("/v1/tx/prepare", post(tx_prepare))
        .route("/v1/tx/broadcast", post(tx_broadcast))
}

#[derive(Deserialize)]
struct PrepareReq {
    network: String,
    from: String,
    to: String,
    #[serde(default)]
    data: Option<String>,
    #[serde(default)]
    value: Option<String>,
}

#[derive(Deserialize)]
struct BroadcastReq {
    network: String,
    raw_tx: String,
}

/// Signed-transaction shape check. A realistic signed EIP-155/1559 tx is at
/// least ~40 bytes of RLP; anything shorter is not a transaction, and the
/// cap mirrors the 128 KiB mempool ceiling most chains enforce.
fn validate_raw(raw: &str) -> Result<(), String> {
    let Some(hex) = raw.strip_prefix("0x") else {
        return Err("raw_tx must start with 0x".to_string());
    };
    if hex.is_empty() || hex.len() % 2 != 0 {
        return Err("raw_tx must be even-length hex".to_string());
    }
    if hex.len() < 80 {
        return Err("raw_tx is too short to be a signed transaction".to_string());
    }
    if hex.len() > 262_144 {
        return Err("raw_tx exceeds the 128 KiB RLP limit".to_string());
    }
    if !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("raw_tx must contain only hex digits after 0x".to_string());
    }
    Ok(())
}

/// The mesh separates transport failures ("rpc … failed via host",
/// "rpc … HTTP 429 …" → gateway trouble, engine maps to 5xx) from CHAIN
/// verdicts ("rpc error: <the node's own answer>" → currently 502).
/// A chain verdict — insufficient funds, nonce too low, execution
/// reverted — is a real ANSWER about this exact transaction, not an
/// outage. Map it to 4xx so the console surfaces it honestly instead of
/// retrying the whole flow through browser gateways.
fn surface_chain_verdict(e: AppError) -> AppError {
    match e.message.strip_prefix("rpc error: ") {
        Some(verdict) => AppError::bad_request(format!("the chain rejected the transaction: {verdict}")),
        None => e,
    }
}

async fn tx_prepare(State(state): Ctx, body: axum::body::Bytes) -> ApiResult<Response> {
    guard(&state, "tx-prepare")?;
    let req: PrepareReq = parse_body(&body)?;
    let evm = state
        .evm
        .as_ref()
        .ok_or_else(|| AppError::unavailable("no EVM RPC configured"))?;
    let mut payload = evm
        .tx_prepare(&req.network, &req.from, &req.to, req.data.as_deref(), req.value.as_deref())
        .await
        .map_err(surface_chain_verdict)?;
    if let Some(obj) = payload.as_object_mut() {
        obj.insert(
            "note".to_string(),
            json!("read-only preparation numbers from the engine's RPC mesh; the transaction is signed in YOUR wallet — the engine never sees a key"),
        );
    }
    Ok(ok(payload))
}

async fn tx_broadcast(State(state): Ctx, body: axum::body::Bytes) -> ApiResult<Response> {
    guard(&state, "tx-broadcast")?;
    let req: BroadcastReq = parse_body(&body)?;
    validate_raw(&req.raw_tx).map_err(AppError::bad_request)?;
    let evm = state
        .evm
        .as_ref()
        .ok_or_else(|| AppError::unavailable("no EVM RPC configured"))?;
    let hash = evm
        .tx_broadcast_raw(&req.network, &req.raw_tx)
        .await
        .map_err(surface_chain_verdict)?;
    Ok(ok(json!({
        "hash": hash,
        "network": req.network,
        "explorer_hint": "track the hash on the network's block explorer; the wallet links it per chain",
        "non_custodial": "relayed an already-signed blob — the engine cannot alter or forge it",
    })))
}

// ------------------------------------------------------------------ tests ---

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_raw_accepts_a_realistic_signed_blob() {
        // 64 hex chars of plausible signature-bearing RLP payload.
        let ok_tx = "0x".to_string() + &"a9".repeat(48);
        assert!(validate_raw(&ok_tx).is_ok());
    }

    #[test]
    fn chain_verdicts_become_honest_4xx() {
        let funds = AppError::upstream(
            "rpc error: Insufficient funds for gas * price + value: have 0 want 5909417430001",
        );
        let mapped = surface_chain_verdict(funds);
        assert_eq!(mapped.status, axum::http::StatusCode::BAD_REQUEST);
        assert!(mapped.message.contains("Insufficient funds"));

        let reverted = surface_chain_verdict(AppError::upstream(
            "rpc error: execution reverted: not enough stETH",
        ));
        assert_eq!(reverted.status, axum::http::StatusCode::BAD_REQUEST);

        // Transport trouble stays a 5xx — the console's signal to fall back.
        let transport = surface_chain_verdict(AppError::upstream(
            "rpc eth_sendRawTransaction failed via some-gateway: connection reset",
        ));
        assert_eq!(transport.status, axum::http::StatusCode::BAD_GATEWAY);
    }

    #[test]
    fn validate_raw_rejects_garbage() {
        assert!(validate_raw("no-prefix").is_err(), "missing 0x");
        assert!(validate_raw("0xabc").is_err(), "odd length");
        assert!(validate_raw("0x").is_err(), "empty");
        assert!(validate_raw(&format!("0x{}", "ff".repeat(10))).is_err(), "too short");
        assert!(validate_raw(&format!("0x{}", "ff".repeat(200_000))).is_err(), "too long");
        assert!(validate_raw(&format!("0x{}zz", "ff".repeat(60))).is_err(), "non-hex tail");
    }
}
