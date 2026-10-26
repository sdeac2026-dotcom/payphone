//! Bitcoin adapter — watch-only settlement observation over the Esplora
//! HTTP API (default: blockstream.info).
//!
//! Design (non-custodial, stateless):
//! - The engine **never holds keys**. Invoices reference a merchant-owned
//!   BTC address; PayPhone only watches.
//! - **Confirmed balance delta**: at creation the address's *confirmed*
//!   balance in satoshis (funded − spent, from `chain_stats`) is sealed in
//!   the signed invoice as `base_qty`. Status = current confirmed balance −
//!   `base_qty`. Using `chain_stats` (not `mempool_stats`) means only
//!   block-confirmed coins can ever count — the confirmation policy is
//!   enforced by the data source itself.
//! - Receipts are best-effort pointers: recent confirmed txs that paid the
//!   address since the invoice birth height, each linking to the explorer.
//!   The authoritative state stays the balance delta.
//!
//! API surface used (all public, no key):
//! - `GET /address/{a}`            → chain_stats / mempool_stats
//! - `GET /address/{a}/txs`        → last ~25 txs with vouts
//! - `GET /blocks/tip/height`      → birth block at creation
//!
//! Override the endpoint with `BTC_API_BASE` (self-hosted Esplora, mempool.space
//! mirror, etc. — any Esplora-compatible host works).

use crate::error::{AppError, ApiResult};
use crate::invoice::Invoice;
use serde_json::json;
use std::time::Duration;

/// Block explorer link prefix for receipts.
const EXPLORER_TX: &str = "https://blockstream.info/tx/";

#[derive(Clone)]
pub struct BitcoinAdapter {
    /// Esplora API base (no trailing slash).
    api_base: String,
    http: reqwest::Client,
}

impl BitcoinAdapter {
    pub fn new(api_base: Option<String>) -> Option<BitcoinAdapter> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(12))
            .user_agent(concat!("PayPhone-Engine/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("reqwest client");
        Some(BitcoinAdapter {
            api_base: api_base
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "https://blockstream.info/api".to_string()),
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
                    last = format!("bitcoin api {path}: {e}");
                    continue;
                }
            };
            if !resp.status().is_success() {
                last = format!(
                    "bitcoin api {path} HTTP {} — set BTC_API_BASE to a dedicated Esplora endpoint",
                    resp.status()
                );
                continue;
            }
            return resp
                .json::<serde_json::Value>()
                .await
                .map_err(|e| AppError::upstream(format!("bitcoin api decode {path}: {e}")));
        }
        Err(AppError::upstream(last))
    }

    /// Confirmed balance of an address in satoshis.
    pub async fn confirmed_balance(&self, address: &str) -> ApiResult<u128> {
        let stats = self.get(&format!("/address/{address}")).await?;
        let funded = stats["chain_stats"]["funded_txo_sum"].as_u64().unwrap_or(0) as u128;
        let spent = stats["chain_stats"]["spent_txo_sum"].as_u64().unwrap_or(0) as u128;
        Ok(funded.saturating_sub(spent))
    }

    /// Current chain tip height.
    pub async fn tip_height(&self) -> ApiResult<u64> {
        let raw = self.get("/blocks/tip/height").await?;
        raw.as_u64()
            .or_else(|| raw.as_str().and_then(|s| s.parse().ok()))
            .ok_or_else(|| AppError::upstream("bitcoin tip height unparseable"))
    }

    /// Observe a bitcoin invoice: confirmed-balance delta + best-effort
    /// per-tx receipts since the birth height.
    pub async fn observe_invoice(&self, invoice: &Invoice) -> ApiResult<crate::chains::Observation> {
        let current = self.confirmed_balance(&invoice.address).await?;
        let observed = current.saturating_sub(invoice.base_qty);

        // Best-effort receipts (the authoritative state is the delta above).
        let mut receipts = Vec::new();
        if let Ok(txs) = self
            .get(&format!("/address/{}/txs", invoice.address))
            .await
        {
            if let Some(list) = txs.as_array() {
                for tx in list.iter().take(25) {
                    let confirmed = tx["status"]["confirmed"].as_bool().unwrap_or(false);
                    let height = tx["status"]["block_height"].as_u64().unwrap_or(0);
                    if !confirmed || height < invoice.birth_block {
                        continue;
                    }
                    // Sum this tx's confirmed outputs paid to the invoice address.
                    let paid: u64 = tx["vout"]
                        .as_array()
                        .map(|vouts| {
                            vouts
                                .iter()
                                .filter(|v| {
                                    v["scriptpubkey_address"].as_str()
                                        == Some(invoice.address.as_str())
                                })
                                .filter_map(|v| v["value"].as_u64())
                                .sum()
                        })
                        .unwrap_or(0);
                    if paid == 0 {
                        continue;
                    }
                    let txid = tx["txid"].as_str().unwrap_or_default().to_string();
                    receipts.push(json!({
                        "tx_hash": txid,
                        "block": height,
                        "qty": paid.to_string(),
                        "asset": invoice.asset,
                        "confirmed": true,
                        "explorer_url": format!("{EXPLORER_TX}{txid}"),
                        "source": "mainnet",
                    }));
                }
            }
        }
        receipts.sort_by_key(|r| r["block"].as_u64().unwrap_or(0));
        Ok(crate::chains::Observation { observed_qty: observed, receipts })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inv() -> Invoice {
        Invoice {
            v: 1,
            id: "inv_x".into(),
            mid: "pk_test".into(),
            tier: "growth".into(),
            amount_minor: 1000,
            currency: "USD".into(),
            asset: "BTC".into(),
            chain: "bitcoin".into(),
            network: "mainnet".into(),
            address: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa".into(),
            token_address: String::new(),
            description_hash: String::new(),
            fee_bps: 70,
            base_qty: 0,
            qte: 1000,
            iat: 0,
            exp: 1,
            nce: "n".into(),
            whu: String::new(),
            birth_block: 0,
        }
    }

    #[tokio::test]
    #[ignore = "live-network test — run explicitly: cargo test -- --ignored"]
    async fn observes_real_genesis_address() {
        let a = BitcoinAdapter::new(None).unwrap();
        let tip = a.tip_height().await.unwrap();
        assert!(tip > 800_000);
        let bal = a.confirmed_balance("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa").await.unwrap();
        // The genesis address has never spent — balance equals total funded.
        assert!(bal > 3_000_000_000);
        let obs = a.observe_invoice(&inv()).await.unwrap();
        assert_eq!(obs.observed_qty, bal);
        assert!(!obs.receipts.is_empty(), "genesis address has confirmed history");
        let r = &obs.receipts[0];
        assert!(r["explorer_url"].as_str().unwrap().starts_with("https://blockstream.info/tx/"));
    }
}
