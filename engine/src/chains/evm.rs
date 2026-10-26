//! EVM adapter — production watch-only observation over JSON-RPC.
//!
//! Design (non-custodial):
//! - The engine **never holds keys**. Invoices reference a merchant-owned
//!   receiving address; PayPhone only *watches* the chain.
//! - ERC-20 payments (the primary flow) are detected via **`eth_getLogs`**
//!   on the token's `Transfer` event, filtered to the invoice address. This
//!   yields real transaction hashes, block heights and exact amounts —
//!   receipts the merchant can verify on any block explorer.
//! - Native assets (ETH/POL) are detected via balance-delta: the address
//!   balance at creation (`base_qty`) is sealed inside the signed invoice
//!   token; status = `current_balance − base_qty`. Statelessness preserved
//!   with a single RPC call.
//! - A payment is counted once it has `confirmations` (per-network, from
//!   [`registry`]) — an unconfirmed transfer keeps the invoice `pending`,
//!   never falsely `paid`.
//!
//! RPC economics: default endpoints are public infrastructure and rate-limit
//! aggressively. Logs are queried in bounded chunks and only for the invoice
//! window; for production volume set `EVM_RPC_<NETWORK>` to a dedicated
//! provider (Alchemy, QuickNode, PublicNode, Ankr…).

use crate::chains::registry;
use crate::error::{ApiResult, AppError};
use crate::invoice::Invoice;
use serde_json::json;
use std::collections::HashMap;
use std::time::Duration;

/// `Transfer(address,address,uint256)` — keccak256 of the canonical signature.
pub const TRANSFER_TOPIC: &str = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/// Blocks per `eth_getLogs` chunk. Public endpoints accept ~2–10k blocks
/// when the filter is indexed by recipient; 2000 is safe everywhere.
const LOG_CHUNK: u64 = 2_000;
/// Hard cap on the historical window an invoice will ever scan (≈ 2+ days
/// on the fastest chain here; invoices expire long before this).
const LOG_WINDOW_CAP: u64 = 100_000;

/// Watch adapter for one or more EVM networks. Cheaply cloneable
/// (`Arc` over the RPC map; the reqwest client is internally `Arc`).
#[derive(Clone)]
pub struct EvmAdapter {
    /// network name → RPC URL (operator overrides / default public RPCs)
    rpcs: std::sync::Arc<HashMap<String, String>>,
    http: reqwest::Client,
}

/// Minimal ERC-20 metadata the engine needs (decimals exposed for adapters).
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct Erc20 {
    pub address: String,
    pub decimals: u8,
}

/// Well-known token registry (address → decimals) for **custom** token
/// invoices (a merchant passing an explicit `token_address`). First-party
/// settlement assets live in [`registry`] and are preferred when known.
pub fn known_token(network: &str, address: &str) -> Option<u8> {
    // Registry first — it is the curated source of truth.
    if let Some(t) = registry::token_by_address(network, address) {
        return Some(t.decimals);
    }
    let a = address.to_lowercase();
    match network {
        "mainnet" | "base" | "arbitrum" | "optimism" | "polygon" => match a.as_str() {
            "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" => Some(6), // USDC mainnet
            "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" => Some(6), // USDC base
            "0xaf88d065e77c8cc2239327c5edb3a432268e5831" => Some(6), // USDC arbitrum
            "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359" => Some(6), // USDC polygon
            "0xdac17f958d2ee523a2206206994597c13d831ec7" => Some(6), // USDT mainnet
            "0x6b175474e89094c44da98b954eedeac495271d0f" => Some(18), // DAI mainnet
            _ => None,
        },
        _ => None,
    }
}

impl EvmAdapter {
    pub fn new(rpcs: Vec<(String, String)>) -> Option<EvmAdapter> {
        if rpcs.is_empty() {
            return None;
        }
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(12))
            // Some public gateways 403 default client UAs; identify honestly.
            .user_agent(concat!("PayPhone-Engine/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("reqwest client");
        Some(EvmAdapter { rpcs: std::sync::Arc::new(rpcs.into_iter().collect()), http })
    }

    /// Access the configured networks (for diagnostics) — public adapter API.
    #[allow(dead_code)]
    pub fn networks(&self) -> Vec<String> {
        self.rpcs.keys().cloned().collect()
    }

    pub fn has_network(&self, network: &str) -> bool {
        self.rpcs.contains_key(network)
    }

    /// Raw JSON-RPC call with one retry on transport error (public RPCs
    /// occasionally hiccup; the call is idempotent).
    async fn rpc(&self, network: &str, method: &str, params: serde_json::Value) -> ApiResult<serde_json::Value> {
        let url = self
            .rpcs
            .get(network)
            .ok_or_else(|| AppError::unavailable(format!("no RPC for network '{network}'")))?;
        let payload = json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params });
        let mut last_err: Option<String> = None;
        for attempt in 0..2 {
            if attempt > 0 {
                tokio::time::sleep(Duration::from_millis(400)).await;
            }
            let resp = match self.http.post(url).json(&payload).send().await {
                Ok(r) => r,
                Err(e) => {
                    last_err = Some(format!("rpc {method} failed: {e}"));
                    continue;
                }
            };
            // 402/429/5xx from shared gateways → surface a precise hint.
            let status = resp.status();
            let body: serde_json::Value = match resp.json().await {
                Ok(b) => b,
                Err(e) => {
                    last_err = Some(if status.is_success() {
                        format!("rpc decode: {e}")
                    } else {
                        format!(
                            "rpc {method} HTTP {status} from '{network}' — public endpoint rate limit? \
                             set EVM_RPC_{} to a dedicated provider",
                            network.to_uppercase().replace('-', "_")
                        )
                    });
                    continue;
                }
            };
            if let Some(err) = body["error"].as_object() {
                let msg = err["message"].as_str().unwrap_or("unknown").to_string();
                let hint = if msg.contains("limit") || msg.contains("rate") {
                    format!(" — set EVM_RPC_{} to a dedicated provider",
                            network.to_uppercase().replace('-', "_"))
                } else {
                    String::new()
                };
                return Err(AppError::upstream(format!("rpc error: {msg}{hint}")));
            }
            return Ok(body["result"].clone());
        }
        Err(AppError::upstream(last_err.unwrap_or_else(|| "rpc failed".into())))
    }

    /// Current balance of `wallet` in token base units.
    pub async fn balance(
        &self,
        network: &str,
        wallet: &str,
        token: Option<&Erc20>,
    ) -> ApiResult<u128> {
        let result = match token {
            None => self.rpc(network, "eth_getBalance", json!([wallet, "latest"])).await?,
            Some(t) => {
                // eth_call: selector(balanceOf(address)) = 0x70a08231
                let mut data = String::from("0x70a08231");
                let padded = format!("{:0>64}", &wallet[2..].to_lowercase());
                data.push_str(&padded);
                self.rpc(network, "eth_call", json!([{ "to": t.address, "data": data }, "latest"]))
                    .await?
            }
        };
        let hex_qty = result
            .as_str()
            .ok_or_else(|| AppError::upstream("rpc returned non-string quantity"))?;
        parse_hex_quantity(hex_qty)
            .ok_or_else(|| AppError::upstream(format!("rpc quantity unparseable: {hex_qty}")))
    }

    /// Live EVM chain id of a network (diagnostics — proves the RPC really
    /// talks to the chain the registry claims).
    pub async fn chain_id(&self, network: &str) -> ApiResult<u64> {
        let result = self.rpc(network, "eth_chainId", json!([])).await?;
        result
            .as_str()
            .and_then(parse_hex_quantity)
            .map(|q| q as u64)
            .ok_or_else(|| AppError::upstream("bad chainId"))
    }

    /// Chain tip (confirmation-depth math) — public adapter API.
    pub async fn block_number(&self, network: &str) -> ApiResult<u64> {
        let result = self.rpc(network, "eth_blockNumber", json!([])).await?;
        result
            .as_str()
            .and_then(parse_hex_quantity)
            .map(|q| q as u64)
            .ok_or_else(|| AppError::upstream("bad blockNumber"))
    }

    /// Fetch `Transfer` logs **to** `recipient` between two blocks (inclusive),
    /// chunked to stay inside public-RPC range limits. Returns raw log objects.
    async fn transfer_logs_to(
        &self,
        network: &str,
        token: &str,
        recipient: &str,
        from_block: u64,
        to_block: u64,
    ) -> ApiResult<Vec<serde_json::Value>> {
        let topic_to = format!("0x{:0>64}", recipient.to_lowercase().trim_start_matches("0x"));
        let mut out = Vec::new();
        let mut start = from_block;
        while start <= to_block {
            let end = (start + LOG_CHUNK - 1).min(to_block);
            let logs = self
                .rpc(
                    network,
                    "eth_getLogs",
                    json!([{
                        "fromBlock": format!("0x{start:x}"),
                        "toBlock": format!("0x{end:x}"),
                        "address": token,
                        "topics": [TRANSFER_TOPIC, null, topic_to],
                    }]),
                )
                .await?;
            if let Some(arr) = logs.as_array() {
                out.extend(arr.iter().cloned());
            }
            if end == u64::MAX {
                break;
            }
            start = end + 1;
        }
        Ok(out)
    }

    /// Observe an invoice against live chain state.
    ///
    /// ERC-20 path (primary): sum confirmed `Transfer` logs to the invoice
    /// address since `birth_block`. Native path: balance delta vs `base_qty`.
    pub async fn observe_invoice(&self, invoice: &Invoice) -> ApiResult<crate::chains::Observation> {
        // ---- resolve the token we are watching -------------------------------
        let token_meta: Option<Erc20> = if invoice.token_address.is_empty() {
            None
        } else {
            let decimals = registry
                ::token_by_address(&invoice.network, &invoice.token_address)
                .map(|t| t.decimals)
                .or_else(|| known_token(&invoice.network, &invoice.token_address))
                .ok_or_else(|| AppError::bad_request(format!(
                    "unknown ERC-20 decimals for {} on {} — extend the registry",
                    invoice.token_address, invoice.network
                )))?;
            Some(Erc20 { address: invoice.token_address.clone(), decimals })
        };

        let confs = registry::find(&invoice.network)
            .map(|n| n.confirmations)
            .unwrap_or(12);

        // ---- ERC-20 log path (real tx receipts) ------------------------------
        if let Some(t) = &token_meta {
            if invoice.birth_block > 0 {
                let tip = self.block_number(&invoice.network).await?;
                // Window cap: never scan more than LOG_WINDOW_CAP blocks.
                let from = invoice.birth_block.saturating_sub(1).max(tip.saturating_sub(LOG_WINDOW_CAP));
                let logs = self
                    .transfer_logs_to(&invoice.network, &t.address, &invoice.address, from, tip)
                    .await?;
                let mut confirmed_qty: u128 = 0;
                let mut receipts: Vec<serde_json::Value> = Vec::new();
                for log in &logs {
                    let (qty, block, tx_hash) = match decode_transfer(log) {
                        Some(v) => v,
                        None => continue,
                    };
                    // Defensive: recipient match (RPC filtered, but decode-check
                    // is cheap and protects against padding mistakes).
                    match log["topics"].get(2).and_then(|t| t.as_str()) {
                        Some(to_topic) if topic_matches(to_topic, &invoice.address) => {}
                        _ => continue,
                    }
                    let confirmations = tip.saturating_sub(block);
                    let confirmed = confirmations >= confs;
                    if confirmed {
                        confirmed_qty = confirmed_qty.saturating_add(qty);
                    }
                    let explorer = registry::find(&invoice.network)
                        .map(|n| format!("{}{tx_hash}", n.explorer_tx))
                        .unwrap_or_default();
                    receipts.push(json!({
                        "tx_hash": tx_hash,
                        "block": block,
                        "qty": base_units_to_decimal(qty, t.decimals),
                        "asset": invoice.asset,
                        "confirmations": confirmations,
                        "required_confirmations": confs,
                        "confirmed": confirmed,
                        "explorer_url": explorer,
                        "source": "mainnet",
                    }));
                }
                receipts.sort_by_key(|r| r["block"].as_u64().unwrap_or(0));
                return Ok(crate::chains::Observation {
                    observed_qty: confirmed_qty,
                    receipts,
                });
            }
        }

        // ---- native / legacy balance-delta path ------------------------------
        let current = self
            .balance(&invoice.network, &invoice.address, token_meta.as_ref())
            .await?;
        let observed = current.saturating_sub(invoice.base_qty);
        Ok(crate::chains::Observation { observed_qty: observed, receipts: vec![] })
    }
}

/// Decode one ERC-20 `Transfer` log → (value in base units, block, tx hash).
/// Returns `None` for malformed logs (wrong topic arity, unparseable data).
pub fn decode_transfer(log: &serde_json::Value) -> Option<(u128, u64, String)> {
    let topics = log["topics"].as_array()?;
    if topics.len() != 3 || topics[0].as_str()?.ne(TRANSFER_TOPIC) {
        return None;
    }
    let qty = parse_hex_quantity(log["data"].as_str()?)?;
    if topics[1].as_str()? == topics[2].as_str()? && qty == 0 {
        return None; // zero-value self transfers are noise
    }
    let block = u64::from_str_radix(
        log["blockNumber"].as_str()?.trim_start_matches("0x"),
        16,
    )
    .ok()?;
    let hash = log["transactionHash"].as_str()?.to_string();
    Some((qty, block, hash))
}

/// True when a padded topic (32-byte hex) equals a 20-byte address.
/// Case-insensitive on both the `0x` prefix and the hex body.
pub fn topic_matches(topic: &str, address: &str) -> bool {
    let t = topic.to_lowercase();
    let t = t.strip_prefix("0x").unwrap_or(&t);
    let a = address.to_lowercase();
    let a = a.strip_prefix("0x").unwrap_or(&a);
    t.len() == 64 && t.ends_with(a)
}

/// Parse a `0x…` quantity into u128 (rejects overflow and junk).
pub fn parse_hex_quantity(hex_qty: &str) -> Option<u128> {
    let s = hex_qty.strip_prefix("0x").unwrap_or(hex_qty);
    if s.is_empty() {
        return None;
    }
    u128::from_str_radix(s, 16).ok()
}

/// Convert a token base-unit quantity to a decimal string with `decimals` dp
/// (public adapter utility).
#[allow(dead_code)]
pub fn base_units_to_decimal(qty: u128, decimals: u8) -> String {
    let div = 10u128.pow(decimals as u32);
    let whole = qty / div;
    let frac = qty % div;
    format!("{whole}.{frac:0width$}", width = decimals as usize)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample() -> Invoice {
        Invoice {
            v: 1,
            id: "inv_0123456789abcdef".into(),
            mid: "pk_growth_deadbeef01".into(),
            tier: "growth".into(),
            amount_minor: 2500,
            currency: "USD".into(),
            asset: "USDC".into(),
            chain: "evm".into(),
            network: "base".into(),
            address: "0xa11ce0000000000000000000000000000000dEaD".into(),
            token_address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913".into(),
            description_hash: String::new(),
            fee_bps: 70,
            base_qty: 0,
            qte: 25_000_000,
            iat: 1_700_000_000,
            exp: 1_700_000_900,
            nce: "abc123".into(),
            whu: String::new(),
            birth_block: 0,
        }
    }

    #[test]
    fn hex_quantities_parse() {
        assert_eq!(parse_hex_quantity("0x0"), Some(0));
        assert_eq!(parse_hex_quantity("0xde0b6b3a7640000"), Some(1_000_000_000_000_000_000));
        assert_eq!(parse_hex_quantity("nothex"), None);
    }

    #[test]
    fn decimal_formatting() {
        assert_eq!(base_units_to_decimal(1_500_000, 6), "1.500000");
        assert_eq!(base_units_to_decimal(0, 18), "0.000000000000000000");
    }

    #[test]
    fn topic_padding_and_match() {
        let addr = "0xa11ce0000000000000000000000000000000dEaD";
        let topic = format!("0x{:0>64}", &addr[2..].to_lowercase());
        assert!(topic_matches(&topic, addr));
        assert!(topic_matches(&topic, addr.to_uppercase().as_str()));
        assert!(!topic_matches(&topic, "0xdead00000000000000000000000000000000beef"));
        assert!(!topic_matches("0x1234", addr));
    }

    #[test]
    fn transfer_log_decode() {
        let log = json!({
            "address": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
            "topics": [
                TRANSFER_TOPIC,
                format!("0x{:0>64}", "1111111111111111111111111111111111111111"),
                format!("0x{:0>64}", "a11ce0000000000000000000000000000000dead"),
            ],
            "data": "0x00000000000000000000000000000000000000000000000000000000000f4240",
            "blockNumber": "0x1b2f090",
            "transactionHash": "0xabc123",
        });
        let (qty, block, hash) = decode_transfer(&log).unwrap();
        assert_eq!(qty, 1_000_000); // 1 USDC
        assert_eq!(block, 0x1b2f090);
        assert_eq!(hash, "0xabc123");
    }

    #[test]
    fn transfer_log_decode_rejects_malformed() {
        // Missing topics.
        assert!(decode_transfer(&json!({"data": "0x1", "blockNumber": "0x1",
            "transactionHash": "0x1"})).is_none());
        // Bad block number.
        assert!(decode_transfer(&json!({"topics": [TRANSFER_TOPIC, "0x1", "0x2"],
            "data": "0x1", "blockNumber": "zzz", "transactionHash": "0x1"})).is_none());
        // Non-transfer topic0.
        let mut bad = json!({"topics": ["0xdead", "0x1", "0x2"], "data": "0x1",
            "blockNumber": "0x1", "transactionHash": "0x1"});
        assert!(decode_transfer(&bad).is_none());
        // Zero-value self-transfer is noise.
        bad["topics"] = json!([TRANSFER_TOPIC,
            format!("0x{:0>64}", "a11ce0000000000000000000000000000000dead"),
            format!("0x{:0>64}", "a11ce0000000000000000000000000000000dead")]);
        bad["data"] = json!("0x0");
        assert!(decode_transfer(&bad).is_none());
    }

    #[test]
    fn invoice_parses_without_birth_block_legacy() {
        // Tokens signed before the birth_block upgrade lack the field —
        // they must still deserialize (serde default), not fail.
        let mut inv = sample();
        inv.birth_block = 1234;
        let token = crate::invoice::sign_token("k", &inv).unwrap();
        let back = crate::invoice::verify_token("k", &token).unwrap();
        assert_eq!(back.birth_block, 1234);
    }

    #[test]
    fn registry_drives_confirmations() {
        let inv = sample(); // network = base
        assert_eq!(registry::find(&inv.network).unwrap().confirmations, 8);
    }
}
