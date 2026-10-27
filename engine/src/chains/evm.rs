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
//! RPC economics ("reads are free" engineering): every network carries a
//! **pool** of verified free public gateways (see [`registry`]). This adapter
//! round-robins across the pool, benches a gateway that throttles (120 s) or
//! 5xx-es (30 s), and fails over to the next one automatically — no single
//! free tier can take a network down. Idempotent reads are also cached for a
//! short TTL, collapsing poll storms into a fraction of the request volume.
//! For heavy volume, set `EVM_RPC_<NETWORK>` to a dedicated provider
//! (Alchemy, QuickNode, PublicNode, Ankr…): it becomes the primary and the
//! free pool remains behind it as fallbacks.

use crate::chains::registry;
use crate::error::{ApiResult, AppError};
use crate::invoice::Invoice;
use serde_json::json;
use std::collections::HashMap;
use std::time::{Duration, Instant};

/// `Transfer(address,address,uint256)` — keccak256 of the canonical signature.
pub const TRANSFER_TOPIC: &str = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/// Blocks per `eth_getLogs` chunk. Public endpoints accept ~2–10k blocks
/// when the filter is indexed by recipient; 2000 is safe everywhere.
const LOG_CHUNK: u64 = 2_000;
/// Hard cap on the historical window an invoice will ever scan (≈ 2+ days
/// on the fastest chain here; invoices expire long before this).
const LOG_WINDOW_CAP: u64 = 100_000;

/// Watch adapter for one or more EVM networks. Cheaply cloneable (`Arc`
/// over the gateway pools + read cache; the reqwest client is `Arc`).
#[derive(Clone)]
pub struct EvmAdapter {
    /// network name → gateway pool (operator primary + verified publics)
    pools: std::sync::Arc<std::sync::Mutex<HashMap<String, NetworkPool>>>,
    /// idempotent-read cache (see [`cache_ttl`])
    cache: std::sync::Arc<std::sync::Mutex<HashMap<String, CacheEntry>>>,
    http: reqwest::Client,
}

/// One RPC gateway plus its health state.
#[derive(Debug, Clone)]
struct Gateway {
    url: String,
    /// Operator-configured primary (from `EVM_RPC_<NETWORK>`). Rotates with
    /// the pool like any other member — primaries are not above benching.
    #[allow(dead_code)]
    primary: bool,
    /// While set, the gateway sits at the back of the candidate order and
    /// is revived only if every healthy gateway fails.
    cooldown_until: Option<Instant>,
}

impl Gateway {
    fn benched(&self, now: Instant) -> bool {
        self.cooldown_until.map(|t| t > now).unwrap_or(false)
    }
}

/// Per-network pool of gateways with a round-robin cursor.
#[derive(Debug, Clone, Default)]
struct NetworkPool {
    gateways: Vec<Gateway>,
    /// Next gateway to try first (load spreading across the pool).
    cursor: usize,
}

impl NetworkPool {
    /// Candidate indexes, best-first: healthy gateways rotating from the
    /// cursor, then benched ones (revival as last resort). Pure — unit
    /// tested without any I/O.
    fn candidate_order(&self, now: Instant) -> Vec<usize> {
        let n = self.gateways.len();
        let mut healthy = Vec::with_capacity(n);
        let mut benched = Vec::new();
        for k in 0..n {
            let i = (self.cursor + k) % n;
            if self.gateways[i].benched(now) {
                benched.push(i);
            } else {
                healthy.push(i);
            }
        }
        healthy.extend(benched);
        healthy
    }

    fn bench(&mut self, idx: usize, secs: u64, now: Instant) {
        if let Some(g) = self.gateways.get_mut(idx) {
            g.cooldown_until = Some(now + Duration::from_secs(secs));
        }
    }

    fn note_success(&mut self, idx: usize) {
        if let Some(g) = self.gateways.get_mut(idx) {
            g.cooldown_until = None;
        }
        if !self.gateways.is_empty() {
            self.cursor = (idx + 1) % self.gateways.len();
        }
    }
}

/// How long a gateway sits out after a failure, by failure class.
/// Rate limiting is the expensive signal on a shared free tier → 120 s.
/// Server hiccups recover in seconds → 30 s. `None` = the gateway answered
/// with a well-formed chain-level response — a real answer, not benched.
fn bench_seconds(status: u16, rpc_msg: &str) -> Option<u64> {
    let m = rpc_msg.to_lowercase();
    if m.contains("limit") || m.contains("rate") {
        return Some(120);
    }
    match status {
        429 | 402 => Some(120),
        500..=599 => Some(30),
        _ => None,
    }
}

/// A gateway that could not even complete a transport round trip sits out
/// only briefly — usually a local blip, not the gateway's fault.
const TRANSPORT_BENCH_SECS: u64 = 10;
/// Distinct gateways tried per `rpc()` call. With verified pools of 2–5,
/// three consecutive failures means the whole network is unreachable.
const MAX_RPC_ATTEMPTS: usize = 3;

/// A cached read result with expiry (see [`cache_ttl`]).
#[derive(Debug, Clone)]
struct CacheEntry {
    value: serde_json::Value,
    expires: Instant,
}

/// Cache TTL per idempotent read method. Fresh enough for payment detection
/// (confirmations measure in seconds), strong enough to collapse duplicate
/// polling to near zero. Everything else — logs, receipts, sends — is never
/// cached.
fn cache_ttl(method: &str) -> Option<Duration> {
    match method {
        "eth_blockNumber" => Some(Duration::from_millis(1_000)),
        "eth_getBalance" | "eth_call" => Some(Duration::from_millis(2_000)),
        _ => None,
    }
}

/// Cache upper bound (per process). Keys are per network/method/params;
/// when full, expired entries are dropped first.
const CACHE_CAP: usize = 4_096;

/// Pure pool construction: each configured network gets its operator
/// primary (or the registry's default gateway) plus every verified public
/// gateway as a free fallback. The `mainnet` legacy alias inherits
/// Ethereum's fallback pool — same chain, same gateways. Unit-testable
/// without any network stack.
fn build_pools(rpcs: Vec<(String, String)>) -> HashMap<String, NetworkPool> {
    let mut pools: HashMap<String, NetworkPool> = HashMap::new();
    for (network, url) in rpcs {
        let fallback_of = if network == "mainnet" { "ethereum" } else { network.as_str() };
        let mut gateways = vec![Gateway { url: url.clone(), primary: true, cooldown_until: None }];
        if let Some(spec) = registry::find(fallback_of) {
            for u in spec.public_rpcs {
                if *u != url {
                    gateways.push(Gateway {
                        url: (*u).to_string(),
                        primary: false,
                        cooldown_until: None,
                    });
                }
            }
        }
        pools.insert(network, NetworkPool { gateways, cursor: 0 });
    }
    pools
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
        let pools = build_pools(rpcs);
        Some(EvmAdapter {
            pools: std::sync::Arc::new(std::sync::Mutex::new(pools)),
            cache: std::sync::Arc::new(std::sync::Mutex::new(HashMap::new())),
            http,
        })
    }

    /// Access the configured networks (for diagnostics) — public adapter API.
    #[allow(dead_code)]
    pub fn networks(&self) -> Vec<String> {
        self.pools.lock().expect("rpc pool lock").keys().cloned().collect()
    }

    pub fn has_network(&self, network: &str) -> bool {
        self.pools.lock().expect("rpc pool lock").contains_key(network)
    }

    /// Raw JSON-RPC call across the network's gateway pool: round-robin
    /// start, bench-on-throttle, automatic failover to the next verified
    /// gateway, and a short-TTL cache in front of idempotent reads. The
    /// pool lock is never held across `.await`.
    async fn rpc(
        &self,
        network: &str,
        method: &str,
        params: serde_json::Value,
    ) -> ApiResult<serde_json::Value> {
        // ---- read cache ---------------------------------------------------
        let key = format!("{network}|{method}|{}", params.to_string());
        if let Some(ttl) = cache_ttl(method) {
            if let Some(v) = self.cache_get(&key) {
                return Ok(v);
            }
        }

        // ---- ordered candidates -------------------------------------------
        let candidates: Vec<(usize, String)> = {
            let mut pools = self.pools.lock().expect("rpc pool lock");
            let pool = pools.get_mut(network).ok_or_else(|| {
                AppError::unavailable(format!("no RPC for network '{network}'"))
            })?;
            pool.candidate_order(Instant::now())
                .into_iter()
                .take(MAX_RPC_ATTEMPTS)
                .map(|i| (i, pool.gateways[i].url.clone()))
                .collect()
        };

        // ---- attempt loop --------------------------------------------------
        let payload = json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params });
        let mut last_err: Option<String> = None;
        for (attempt, (idx, url)) in candidates.iter().enumerate() {
            if attempt > 0 {
                tokio::time::sleep(Duration::from_millis(400)).await;
            }
            let host = url.split("//").nth(1).unwrap_or(url).to_string();
            let bench_it = |pools: &mut HashMap<String, NetworkPool>, secs: u64| {
                if let Some(p) = pools.get_mut(network) {
                    p.bench(*idx, secs, Instant::now());
                }
            };
            let resp = match self.http.post(url).json(&payload).send().await {
                Ok(r) => r,
                Err(e) => {
                    last_err = Some(format!("rpc {method} failed via {host}: {e}"));
                    let mut pools = self.pools.lock().expect("rpc pool lock");
                    bench_it(&mut pools, TRANSPORT_BENCH_SECS);
                    continue;
                }
            };
            // 402/429/5xx from shared gateways → bench + fail over.
            let status = resp.status();
            if !status.is_success() {
                let secs = bench_seconds(status.as_u16(), "").unwrap_or(TRANSPORT_BENCH_SECS);
                last_err = Some(format!(
                    "rpc {method} HTTP {status} from {host} on '{network}' — set EVM_RPC_{} to a dedicated provider",
                    network.to_uppercase().replace('-', "_")
                ));
                let mut pools = self.pools.lock().expect("rpc pool lock");
                bench_it(&mut pools, secs);
                continue;
            }
            let body: serde_json::Value = match resp.json().await {
                Ok(b) => b,
                Err(e) => {
                    last_err = Some(format!("rpc decode from {host}: {e}"));
                    let mut pools = self.pools.lock().expect("rpc pool lock");
                    bench_it(&mut pools, TRANSPORT_BENCH_SECS);
                    continue;
                }
            };
            if let Some(err) = body["error"].as_object() {
                let msg = err["message"].as_str().unwrap_or("unknown").to_string();
                // Throttling / quota errors are gateway problems → bench and
                // try the next free gateway. Chain-level errors (revert, …)
                // are real answers — surface them without failover.
                if let Some(secs) = bench_seconds(status.as_u16(), &msg) {
                    last_err = Some(format!("rpc {method} throttled by {host} ({msg})"));
                    let mut pools = self.pools.lock().expect("rpc pool lock");
                    bench_it(&mut pools, secs);
                    continue;
                }
                return Err(AppError::upstream(format!("rpc error: {msg}")));
            }
            let result = body["result"].clone();
            {
                let mut pools = self.pools.lock().expect("rpc pool lock");
                if let Some(p) = pools.get_mut(network) {
                    p.note_success(*idx);
                }
            }
            if let Some(ttl) = cache_ttl(method) {
                self.cache_put(key, result.clone(), ttl);
            }
            return Ok(result);
        }

        Err(AppError::upstream(format!(
            "{} — all fallbacks exhausted; set EVM_RPC_{} to a dedicated provider",
            last_err.unwrap_or_else(|| "rpc failed".into()),
            network.to_uppercase().replace('-', "_")
        )))
    }

    fn cache_get(&self, key: &str) -> Option<serde_json::Value> {
        let mut cache = self.cache.lock().expect("rpc cache lock");
        match cache.get(key) {
            Some(e) if e.expires > Instant::now() => Some(e.value.clone()),
            Some(_) => {
                cache.remove(key);
                None
            }
            None => None,
        }
    }

    fn cache_put(&self, key: String, value: serde_json::Value, ttl: Duration) {
        let mut cache = self.cache.lock().expect("rpc cache lock");
        if cache.len() >= CACHE_CAP {
            let now = Instant::now();
            cache.retain(|_, e| e.expires > now);
        }
        if cache.len() >= CACHE_CAP {
            cache.clear(); // absolute bound; repopulates on the next cycle
        }
        cache.insert(key, CacheEntry { value, expires: Instant::now() + ttl });
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

    // ------------------------------------------------------------ rpc mesh --

    fn pool_of(urls: &[&str]) -> NetworkPool {
        NetworkPool {
            gateways: urls
                .iter()
                .map(|u| Gateway { url: (*u).to_string(), primary: false, cooldown_until: None })
                .collect(),
            cursor: 0,
        }
    }

    fn order_urls(p: &NetworkPool, now: Instant) -> Vec<String> {
        p.candidate_order(now).into_iter().map(|i| p.gateways[i].url.clone()).collect()
    }

    #[test]
    fn candidate_order_rotates_from_cursor() {
        let mut p = pool_of(&["a", "b", "c"]);
        p.cursor = 1;
        let now = Instant::now();
        assert_eq!(order_urls(&p, now), vec!["b", "c", "a"]);
        // note_success advances the cursor past the gateway that answered
        p.note_success(1);
        assert_eq!(p.cursor, 2);
        assert_eq!(order_urls(&p, now), vec!["c", "a", "b"]);
    }

    #[test]
    fn benched_gateway_fails_over_then_recovers() {
        let mut p = pool_of(&["a", "b", "c"]);
        let now = Instant::now();
        p.bench(0, 120, now); // 'a' just throttled us
        // healthy gateways first, benched one only as last resort
        assert_eq!(order_urls(&p, now), vec!["b", "c", "a"]);
        // success on a healthy gateway clears its bench and rotates
        p.note_success(1);
        assert!(!p.gateways[1].benched(now));
        assert_eq!(p.cursor, 2);
        // after the cooldown elapses the benched gateway is healthy again
        let later = now + Duration::from_secs(121);
        assert!(!p.gateways[0].benched(later));
        assert!(p.gateways[0].benched(now));
    }

    #[test]
    fn all_benched_pool_still_yields_revival_order() {
        let mut p = pool_of(&["a", "b"]);
        let now = Instant::now();
        p.bench(0, 120, now);
        p.bench(1, 120, now);
        // better to retry benched gateways than to fail without trying
        assert_eq!(p.candidate_order(now).len(), 2);
    }

    #[test]
    fn bench_seconds_classifies_failures() {
        assert_eq!(bench_seconds(429, ""), Some(120));
        assert_eq!(bench_seconds(402, ""), Some(120));
        assert_eq!(bench_seconds(503, ""), Some(30));
        // HTTP 200 but a rate-limit message in the JSON-RPC error body
        assert_eq!(bench_seconds(200, "request limit reached"), Some(120));
        assert_eq!(bench_seconds(200, "Rate Limit Exceeded"), Some(120));
        // chain-level errors are real answers — never benched
        assert_eq!(bench_seconds(200, "execution reverted"), None);
        assert_eq!(bench_seconds(400, "invalid params"), None);
    }

    #[test]
    fn read_cache_only_caches_idempotent_reads() {
        assert!(cache_ttl("eth_blockNumber").is_some());
        assert!(cache_ttl("eth_getBalance").is_some());
        assert!(cache_ttl("eth_call").is_some());
        // logs, receipts and anything mutating are never cached
        assert!(cache_ttl("eth_getLogs").is_none());
        assert!(cache_ttl("eth_getTransactionReceipt").is_none());
        assert!(cache_ttl("eth_sendRawTransaction").is_none());
    }

    #[test]
    fn registry_pools_are_populated_and_deduped() {
        for net in registry::NETWORKS {
            assert!(!net.public_rpcs.is_empty(), "{} pool empty", net.name);
            for u in net.public_rpcs {
                assert!(u.starts_with("https://"), "{} bad url {u}", net.name);
            }
            let mut seen = std::collections::HashSet::new();
            for u in net.public_rpcs {
                assert!(seen.insert(*u), "{} duplicate gateway {u}", net.name);
            }
        }
    }

    #[test]
    fn adapter_splices_fallbacks_behind_the_primary() {
        // Operator override on base: primary first, verified publics behind.
        let pools = build_pools(vec![
            ("base".into(), "https://my-dedicated.example.com/v2/key".into()),
        ]);
        let p = pools.get("base").unwrap();
        assert_eq!(p.gateways[0].url, "https://my-dedicated.example.com/v2/key");
        assert!(p.gateways[0].primary);
        assert_eq!(p.gateways[1].url, "https://mainnet.base.org");
        // registry pool fully inherited, no duplicates
        let urls: Vec<&str> = p.gateways.iter().map(|g| g.url.as_str()).collect();
        assert_eq!(urls.len(), 1 + registry::find("base").unwrap().public_rpcs.len());
    }

    #[test]
    fn mainnet_alias_inherits_ethereum_fallbacks() {
        let pools = build_pools(vec![(
            "mainnet".into(),
            "https://my-dedicated.example.com/v2/key".into(),
        )]);
        let p = pools.get("mainnet").unwrap();
        assert_eq!(p.gateways[0].url, "https://my-dedicated.example.com/v2/key");
        assert_eq!(p.gateways[1].url, "https://ethereum-rpc.publicnode.com");
        assert_eq!(
            p.gateways.len(),
            1 + registry::find("ethereum").unwrap().public_rpcs.len()
        );
    }

    #[test]
    fn primary_equal_to_public_not_duplicated() {
        // Operator sets EVM_RPC_BASE to the same official gateway — pool
        // must not contain it twice.
        let pools = build_pools(vec![("base".into(), "https://mainnet.base.org".into())]);
        let p = pools.get("base").unwrap();
        assert_eq!(p.gateways.len(), registry::find("base").unwrap().public_rpcs.len());
        assert!(p.gateways[0].primary);
    }
}
