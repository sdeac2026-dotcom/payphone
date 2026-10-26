//! Tron adapter — watch-only observation over TronGrid (default:
//! `api.trongrid.io`).
//!
//! Design (non-custodial, stateless):
//! - The engine never holds keys; invoices reference a merchant-owned base58
//!   TRON address (`T…`).
//! - **TRC-20 (the primary payments asset on TRON — USDT)**: sum of confirmed
//!   `Transfer` events to the invoice address, fetched from
//!   `GET /v1/accounts/{a}/transactions/trc20?only_confirmed=true` with the
//!   asset's contract pinned. `only_confirmed=true` enforces the
//!   confirmation policy at the source. Receipts carry real tx ids, values
//!   and timestamps.
//! - **Native TRX**: balance-delta — the SUN balance at creation is sealed
//!   as `base_qty`; observed = current − base. (Balance-delta caveat: an
//!   unrelated deposit to the same address counts toward any open invoice —
//!   use one address per invoice in production sweeps.)
//!
//! API surface used (all public, no key, ~free tier):
//! - `GET /v1/accounts/{a}`                          → native balance
//! - `GET /v1/accounts/{a}/transactions/trc20?…`     → TRC-20 transfers
//!
//! Override with `TRON_API_BASE`.

use crate::error::{AppError, ApiResult};
use crate::invoice::Invoice;
use serde_json::json;
use std::time::Duration;

/// TRC-20 history window (pages of 200 confirmed transfers) used by BOTH
/// the creation-time baseline and later observations — deltas stay
/// consistent because both sides see the same window. TronGrid's free tier
/// throttles deeper pagination (429 beyond offset 200-400); a dedicated
/// `TRON_API_BASE` (TronPro) lifts this for production volume.
const TRC20_PAGES: u8 = 2;

#[derive(Clone)]
pub struct TronAdapter {
    api_base: String,
    http: reqwest::Client,
}

impl TronAdapter {
    pub fn new(api_base: Option<String>) -> Option<TronAdapter> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(12))
            .user_agent(concat!("PayPhone-Engine/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("reqwest client");
        Some(TronAdapter {
            api_base: api_base
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "https://api.trongrid.io".to_string()),
            http,
        })
    }

    async fn get(&self, path: &str) -> ApiResult<serde_json::Value> {
        let url = format!("{}{}", self.api_base, path);
        let mut last = String::new();
        // 3 attempts with growing backoff — public free APIs throttle
        // per-second bursts, so patience beats hammering.
        for attempt in 0..3 {
            if attempt > 0 {
                tokio::time::sleep(Duration::from_millis(if attempt == 1 { 900 } else { 2_200 })).await;
            }
            let resp = match self.http.get(&url).send().await {
                Ok(r) => r,
                Err(e) => {
                    last = format!("tron api {path}: {e}");
                    continue;
                }
            };
            if !resp.status().is_success() {
                last = format!(
                    "tron api {path} HTTP {} — set TRON_API_BASE to a dedicated TronGrid/TronPro endpoint",
                    resp.status()
                );
                continue;
            }
            return resp
                .json::<serde_json::Value>()
                .await
                .map_err(|e| AppError::upstream(format!("tron api decode {path}: {e}")));
        }
        Err(AppError::upstream(last))
    }

    /// Native TRX balance in SUN (0 for unactivated accounts).
    pub async fn balance_sun(&self, address: &str) -> ApiResult<u128> {
        let r = self.get(&format!("/v1/accounts/{address}")).await?;
        let data = r["data"].as_array().cloned().unwrap_or_default();
        Ok(data
            .first()
            .and_then(|acc| acc["balance"].as_u64())
            .unwrap_or(0) as u128)
    }

    /// Latest reference block via TronGrid's eth-compatible JSON-RPC
    /// (liveness probe for /v1/chains).
    pub async fn block_number(&self) -> ApiResult<u64> {
        let url = format!("{}/jsonrpc", self.api_base);
        let payload = json!({ "jsonrpc": "2.0", "id": 1, "method": "eth_blockNumber", "params": [] });
        let resp = self
            .http
            .post(&url)
            .json(&payload)
            .send()
            .await
            .map_err(|e| AppError::upstream(format!("tron jsonrpc: {e}")))?;
        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| AppError::upstream(format!("tron jsonrpc decode: {e}")))?;
        body["result"]
            .as_str()
            .and_then(|s| u64::from_str_radix(s.trim_start_matches("0x"), 16).ok())
            .ok_or_else(|| AppError::upstream("tron blockNumber unparseable"))
    }

    /// Sum of confirmed TRC-20 transfers **to** `address` for `contract`,
    /// with per-tx receipts. Walks up to `pages` pages of 200 entries.
    pub async fn confirmed_transfers_to(
        &self,
        address: &str,
        contract: &str,
        pages: u8,
    ) -> ApiResult<(u128, Vec<serde_json::Value>)> {
        let mut total: u128 = 0;
        let mut receipts = Vec::new();
        for page in 0..u32::from(pages) {
            let path = format!(
                "/v1/accounts/{address}/transactions/trc20?only_confirmed=true&contract_address={contract}&limit=200&offset={}",
                page * 200
            );
            let r = self.get(&path).await?;
            let batch = r["data"].as_array().cloned().unwrap_or_default();
            let batch_len = batch.len();
            for t in batch {
                if t["to"].as_str() != Some(address) || t["type"].as_str() != Some("Transfer") {
                    continue;
                }
                let qty: u128 = t["value"]
                    .as_str()
                    .and_then(|v| v.parse().ok())
                    .or_else(|| t["value"].as_u64().map(|v| v as u128))
                    .unwrap_or(0);
                total = total.saturating_add(qty);
                let ts = t["block_timestamp"].as_u64().unwrap_or(0) / 1000;
                receipts.push(json!({
                    "tx_hash": t["transaction_id"].as_str().unwrap_or_default(),
                    "qty": qty.to_string(),
                    "asset": t["token_info"]["symbol"].as_str().unwrap_or(""),
                    "confirmed": true,
                    "timestamp": ts,
                    "source": "mainnet",
                }));
            }
            if batch_len < 200 {
                break;
            }
        }
        Ok((total, receipts))
    }

    /// Observe a Tron invoice: TRC-20 event-sum or native balance delta.
    pub async fn observe_invoice(&self, invoice: &Invoice) -> ApiResult<crate::chains::Observation> {
        if invoice.token_address.is_empty() {
            // Native TRX — balance delta.
            let current = self.balance_sun(&invoice.address).await?;
            let observed = current.saturating_sub(invoice.base_qty);
            return Ok(crate::chains::Observation { observed_qty: observed, receipts: vec![] });
        }
        // TRC-20 — confirmed event sum minus the pre-creation baseline.
        let (total, mut receipts) = self
            .confirmed_transfers_to(&invoice.address, &invoice.token_address, TRC20_PAGES)
            .await?;
        let observed = total.saturating_sub(invoice.base_qty);
        receipts.reverse(); // newest first for display
        Ok(crate::chains::Observation { observed_qty: observed, receipts })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inv(token: &str) -> Invoice {
        Invoice {
            v: 1,
            id: "inv_x".into(),
            mid: "pk_test".into(),
            tier: "growth".into(),
            amount_minor: 1000,
            currency: "USD".into(),
            asset: if token.is_empty() { "TRX" } else { "USDT" }.into(),
            chain: "tron".into(),
            network: "mainnet".into(),
            address: "TV6MuMXfmLbBqPZvBHdwFsDnQeVfnmiuSi".into(),
            token_address: token.into(),
            description_hash: String::new(),
            fee_bps: 70,
            base_qty: 0,
            qte: 1_000_000,
            iat: 0,
            exp: 1,
            nce: "n".into(),
            whu: String::new(),
            birth_block: 0,
        }
    }

    #[tokio::test]
    #[ignore = "live-network test — run explicitly: cargo test -- --ignored"]
    async fn observes_real_tron_accounts() {
        let a = TronAdapter::new(None).unwrap();
        // The Binance hot wallet has both native TRX and USDT history.
        let native = a.balance_sun("TV6MuMXfmLbBqPZvBHdwFsDnQeVfnmiuSi").await.unwrap();
        assert!(native > 0);
        let (total, receipts) = a
            .confirmed_transfers_to("TV6MuMXfmLbBqPZvBHdwFsDnQeVfnmiuSi", "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", 1)
            .await
            .unwrap();
        assert!(total > 0, "expected USDT history");
        assert!(!receipts.is_empty());
        assert!(receipts[0]["tx_hash"].as_str().unwrap().len() == 64);
    }
}
