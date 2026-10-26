//! Solana adapter — watch-only observation over the Solana JSON-RPC
//! (default: `api.mainnet-beta.solana.com`).
//!
//! Design (non-custodial, stateless):
//! - The engine never holds keys; invoices reference a merchant-owned owner
//!   address (wallet pubkey).
//! - **Balance-delta observation**: at creation the account's balance (native
//!   lamports, or the summed SPL token-account balance for the asset's mint)
//!   is sealed in the signed invoice as `base_qty`; observed payment =
//!   current − base. Two cheap RPCs per status check, no indexer needed.
//! - SPL tokens are found via `getTokenAccountsByOwner(mint=…)` — every
//!   associated/auxiliary token account is summed, so payments to either the
//!   ATA or any aux account of the same owner count.
//!
//! RPC economics: the public endpoint rate-limits aggressively; status polls
//! cost one `getBalance`-class call each. Override with `SOL_RPC_URL` for
//! production (Helius, QuickNode, Triton…).

use crate::error::{AppError, ApiResult};
use crate::invoice::Invoice;
use serde_json::json;
use std::time::Duration;

#[derive(Clone)]
pub struct SolanaAdapter {
    /// JSON-RPC endpoint.
    rpc_url: String,
    http: reqwest::Client,
}

impl SolanaAdapter {
    pub fn new(rpc_url: Option<String>) -> Option<SolanaAdapter> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(12))
            .user_agent(concat!("PayPhone-Engine/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("reqwest client");
        Some(SolanaAdapter {
            rpc_url: rpc_url
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "https://api.mainnet-beta.solana.com".to_string()),
            http,
        })
    }

    async fn rpc(&self, method: &str, params: serde_json::Value) -> ApiResult<serde_json::Value> {
        let payload = json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params });
        let mut last = String::new();
        // 3 attempts with growing backoff — public free APIs throttle
        // per-second bursts, so patience beats hammering.
        for attempt in 0..3 {
            if attempt > 0 {
                tokio::time::sleep(Duration::from_millis(if attempt == 1 { 900 } else { 2_200 })).await;
            }
            let resp = match self.http.post(&self.rpc_url).json(&payload).send().await {
                Ok(r) => r,
                Err(e) => {
                    last = format!("solana rpc {method}: {e}");
                    continue;
                }
            };
            if !resp.status().is_success() {
                last = format!(
                    "solana rpc {method} HTTP {} — set SOL_RPC_URL to a dedicated provider",
                    resp.status()
                );
                continue;
            }
            let body: serde_json::Value = resp
                .json()
                .await
                .map_err(|e| AppError::upstream(format!("solana rpc decode {method}: {e}")))?;
            if let Some(err) = body["error"].as_object() {
                return Err(AppError::upstream(format!(
                    "solana rpc error: {}",
                    err["message"].as_str().unwrap_or("unknown")
                )));
            }
            return Ok(body["result"].clone());
        }
        Err(AppError::upstream(last))
    }

    /// Native SOL balance in lamports.
    pub async fn balance_lamports(&self, owner: &str) -> ApiResult<u128> {
        let r = self.rpc("getBalance", json!([owner])).await?;
        r["value"]
            .as_u64()
            .map(|v| v as u128)
            .ok_or_else(|| AppError::upstream("solana getBalance: unexpected shape"))
    }

    /// SPL token balance (base units) summed over every token account of
    /// `owner` for `mint`.
    pub async fn balance_spl(&self, owner: &str, mint: &str) -> ApiResult<u128> {
        let r = self
            .rpc(
                "getTokenAccountsByOwner",
                json!([owner, { "mint": mint }, { "encoding": "jsonParsed" }]),
            )
            .await?;
        let mut total: u128 = 0;
        if let Some(accounts) = r["value"].as_array() {
            for acc in accounts {
                let amount = acc["account"]["data"]["parsed"]["info"]["tokenAmount"]["amount"]
                    .as_str()
                    .unwrap_or("0");
                total = total.saturating_add(amount.parse::<u128>().unwrap_or(0));
            }
        }
        Ok(total)
    }

    /// Current slot — cheap liveness marker for diagnostics.
    pub async fn slot(&self) -> ApiResult<u64> {
        let r = self.rpc("getSlot", json!([])).await?;
        r.as_u64()
            .ok_or_else(|| AppError::upstream("solana getSlot: unexpected shape"))
    }

    /// Observe a Solana invoice: native or SPL balance delta.
    pub async fn observe_invoice(&self, invoice: &Invoice) -> ApiResult<crate::chains::Observation> {
        let current = if invoice.token_address.is_empty() {
            self.balance_lamports(&invoice.address).await?
        } else {
            self.balance_spl(&invoice.address, &invoice.token_address).await?
        };
        let observed = current.saturating_sub(invoice.base_qty);
        // Balance-delta model: no per-tx receipts (same caveat as EVM native).
        Ok(crate::chains::Observation { observed_qty: observed, receipts: vec![] })
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
            asset: if token.is_empty() { "SOL" } else { "USDC" }.into(),
            chain: "solana".into(),
            network: "mainnet".into(),
            address: "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9".into(),
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
    async fn observes_real_solana_accounts() {
        let a = SolanaAdapter::new(None).unwrap();
        assert!(a.slot().await.unwrap() > 200_000_000);
        let sol = a.observe_invoice(&inv("")).await.unwrap();
        assert!(sol.observed_qty > 0, "Binance wallet holds native SOL");
        let usdc = a.observe_invoice(&inv("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"))
            .await
            .unwrap();
        assert!(usdc.observed_qty > 0, "Binance wallet holds USDC");
    }
}
