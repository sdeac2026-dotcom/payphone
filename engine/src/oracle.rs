//! Price oracle with a small in-process TTL cache.
//!
//! Resolution order (first healthy source wins):
//!
//! 1. **PayPhone oracle service** (`services/oracle-py`, FastAPI) — aggregates
//!    CoinGecko + CoinCap, takes the median, applies staleness guards.
//! 2. **CoinGecko public API** — direct fallback, still cache-friendly.
//! 3. **Built-in static table** — last-resort so demos keep working fully
//!    offline; responses are flagged `stale: true` and `source: "static"`.
//!
//! The cache is per-instance memory (TTL 30 s). No database, no Redis —
//! an oracle feed is by definition time-bounded data, so a TTL map is the
//! honest storage model.

use crate::error::{ApiResult, AppError};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// How long a cached price is considered fresh.
const TTL_SECS: u64 = 30;

/// A single asset price point.
#[derive(Debug, Clone, Serialize)]
pub struct Rate {
    pub asset: String,
    /// USD price per 1 unit of the asset.
    pub usd: f64,
    pub source: String,
    /// True when serving from the static fallback table.
    pub stale: bool,
    /// Unix seconds when this point was fetched.
    pub fetched_at: u64,
}

/// Static last-resort prices (2024 ballpark, demo-only).
fn static_price(asset: &str) -> Option<f64> {
    match asset.to_uppercase().as_str() {
        "BTC" => Some(67_000.0),
        "ETH" => Some(3_200.0),
        "SOL" => Some(150.0),
        "BNB" => Some(580.0),
        "XRP" => Some(0.55),
        "MATIC" | "POL" => Some(0.75),
        "TRX" => Some(0.12),
        "CELO" => Some(0.85),
        "DOGE" => Some(0.12),
        "ADA" => Some(0.45),
        "AVAX" => Some(35.0),
        "LINK" => Some(14.0),
        "DOT" => Some(7.0),
        "TON" => Some(5.5),
        "SHIB" => Some(0.000025),
        "PEPE" => Some(0.000011),
        "UNI" => Some(8.0),
        "AAVE" => Some(120.0),
        "LDO" => Some(2.0),
        "CRV" => Some(0.35),
        "MKR" => Some(2_300.0),
        "WETH" | "cbETH" => Some(3_200.0),
        "WBTC" | "cbBTC" | "BTCB" => Some(67_000.0),
        "WAVAX" => Some(35.0),
        "CAKE" => Some(2.2),
        "ARB" => Some(1.1),
        "OP" => Some(2.3),
        "WLD" => Some(1.5),
        "GMX" => Some(25.0),
        "COMP" => Some(55.0),
        "GRT" => Some(0.25),
        "ENS" => Some(25.0),
        "MANA" => Some(0.45),
        "SAND" => Some(0.5),
        "APE" => Some(1.4),
        "USDC" | "USDT" | "DAI" | "CUSD" | "USDGLO" | "PYUSD" | "TUSD" | "FRAX" | "USDS" => Some(1.0),
        _ => None,
    }
}

/// CoinGecko identifiers for supported assets.
fn coingecko_id(asset: &str) -> Option<&'static str> {
    match asset.to_uppercase().as_str() {
        "BTC" => Some("bitcoin"),
        "ETH" => Some("ethereum"),
        "SOL" => Some("solana"),
        "BNB" => Some("binancecoin"),
        "XRP" => Some("ripple"),
        "MATIC" | "POL" => Some("matic-network"),
        "CELO" => Some("celo"),
        "DOGE" => Some("dogecoin"),
        "ADA" => Some("cardano"),
        "TRX" => Some("tron"),
        "AVAX" => Some("avalanche-2"),
        "LINK" => Some("chainlink"),
        "DOT" => Some("polkadot"),
        "TON" => Some("toncoin"),
        "XLM" => Some("stellar"),
        "HBAR" => Some("hedera-hashgraph"),
        "BCH" => Some("bitcoin-cash"),
        "LTC" => Some("litecoin"),
        "ATOM" => Some("cosmos"),
        "FIL" => Some("filecoin"),
        "INJ" => Some("injective"),
        "STX" => Some("blockstack"),
        "NEAR" => Some("near"),
        "APT" => Some("aptos"),
        "SUI" => Some("sui"),
        "ICP" => Some("internet-computer"),
        "XMR" => Some("monero"),
        "ETC" => Some("ethereum-classic"),
        "RENDER" => Some("render-token"),
        "SHIB" => Some("shiba-inu"),
        "PEPE" => Some("pepe"),
        "UNI" => Some("uniswap"),
        "AAVE" => Some("aave"),
        "LDO" => Some("lido-dao"),
        "CRV" => Some("curve-dao-token"),
        "MKR" => Some("maker"),
        "COMP" => Some("compound-governance-token"),
        "GRT" => Some("the-graph"),
        "ENS" => Some("ethereum-name-service"),
        "MANA" => Some("decentraland"),
        "SAND" => Some("the-sandbox"),
        "APE" => Some("apecoin"),
        "ARB" => Some("arbitrum"),
        "OP" => Some("optimism"),
        "GMX" => Some("gmx"),
        "CAKE" => Some("pancakeswap-token"),
        "WLD" => Some("worldcoin-wld"),
        "WETH" => Some("weth"),
        "WBTC" => Some("wrapped-bitcoin"),
        "cbBTC" => Some("coinbase-wrapped-btc"),
        "cbETH" => Some("coinbase-wrapped-staked-eth"),
        "BTCB" => Some("binance-bitcoin"),
        "WAVAX" => Some("wrapped-avax"),
        "TUSD" => Some("true-usd"),
        "FRAX" => Some("frax"),
        "PYUSD" => Some("paypal-usd"),
        "USDS" => Some("usds"),
        "USDC" => Some("usd-coin"),
        "USDT" => Some("tether"),
        "DAI" => Some("dai"),
        _ => None,
    }
}

/// Assets the engine can price today — mirrors the settlement catalog in
/// `chains/registry.rs` plus quote-only majors (XRP, DOGE, ADA, …).
pub const SUPPORTED_ASSETS: &[&str] = &[
    "BTC", "ETH", "SOL", "BNB", "XRP", "MATIC", "POL", "TRX", "CELO", "USDC", "USDT", "DAI",
    "DOGE", "ADA", "AVAX", "LINK", "DOT", "TON", "XLM", "HBAR", "BCH", "LTC", "ATOM", "FIL",
    "INJ", "STX", "NEAR", "APT", "SUI", "ICP", "XMR", "ETC", "RENDER",
    "SHIB", "PEPE", "UNI", "AAVE", "LDO", "CRV", "MKR", "COMP", "GRT", "ENS", "MANA", "SAND",
    "APE", "ARB", "OP", "GMX", "CAKE", "WLD", "WETH", "WBTC", "cbBTC", "cbETH", "BTCB", "WAVAX",
    "TUSD", "FRAX", "PYUSD", "USDS",
];

/// Canonical display decimals per asset (used by the simnet path and
/// quote formatting). Real settlement always resolves decimals from the
/// chain registry — a symbol's precision differs per network (e.g. USDT
/// is 18dp on some EVM networks). Keep in sync with the asset catalog.
pub fn decimals(asset: &str) -> u8 {
    match asset.to_uppercase().as_str() {
        "BTC" | "WBTC" | "cbBTC" | "BTCB" => 8,
        "SOL" => 9,
        "XLM" => 7,
        "XRP" | "TRX" | "USDC" | "USDT" | "PYUSD" => 6,
        "XMR" => 12,
        "DOT" => 10,
        _ => 18,
    }
}

#[derive(Default)]
struct CacheInner {
    map: HashMap<String, (Rate, u64)>,
}

/// TTL cache + upstream client.
pub struct Oracle {
    http: reqwest::Client,
    cache: Mutex<CacheInner>,
    oracle_url: Option<String>,
}

impl Oracle {
    pub fn new(oracle_url: Option<String>) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(6))
            .build()
            .expect("reqwest client");
        Self { http, cache: Mutex::new(CacheInner::default()), oracle_url }
    }

    fn now() -> u64 {
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()
    }

    /// Get the USD rate for one asset (cache-first).
    pub async fn rate(&self, asset: &str) -> ApiResult<Rate> {
        let asset_u = asset.to_uppercase();
        if !SUPPORTED_ASSETS.contains(&asset_u.as_str()) {
            return Err(AppError::bad_request(format!("unsupported asset '{asset}'")));
        }

        // Stablecoins are pinned to parity for INVOICING: merchants price in
        // USD, and a ±0.1% aggregation wobble must never turn an exact
        // payment into an underpaid invoice. (Conversion QUOTES still use
        // live market prices — see /v1/quote.)
        if matches!(
            asset_u.as_str(),
            "USDC" | "USDT" | "DAI" | "TUSD" | "FRAX" | "USDS" | "PYUSD"
        ) {
            return Ok(Rate {
                asset: asset_u.clone(),
                usd: 1.0,
                source: "parity".into(),
                stale: false,
                fetched_at: Self::now(),
            });
        }

        if let Some((rate, at)) = self.cache.lock().unwrap().map.get(&asset_u) {
            if Self::now().saturating_sub(*at) < TTL_SECS {
                return Ok(rate.clone());
            }
        }

        // 1) Python oracle.
        if let Some(base) = &self.oracle_url {
            let url = format!("{base}/v1/prices?assets={}", asset_u.to_lowercase());
            if let Ok(resp) = self.http.get(&url).send().await {
                if let Ok(body) = resp.json::<OracleResponse>().await {
                    if let Some(p) = body.prices.first() {
                        let rate = Rate {
                            asset: asset_u.clone(),
                            usd: p.usd,
                            source: format!("oracle:{}", body.source),
                            stale: false,
                            fetched_at: Self::now(),
                        };
                        self.cache.lock().unwrap().map.insert(asset_u, (rate.clone(), Self::now()));
                        return Ok(rate);
                    }
                }
            }
        }

        // 2) CoinGecko direct.
        if let Some(id) = coingecko_id(&asset_u) {
            let url = format!("https://api.coingecko.com/api/v3/simple/price?ids={id}&vs_currencies=usd");
            if let Ok(resp) = self.http.get(&url).send().await {
                if let Ok(body) = resp.json::<serde_json::Value>().await {
                    if let Some(usd) = body[id]["usd"].as_f64() {
                        let rate = Rate {
                            asset: asset_u.clone(),
                            usd,
                            source: "coingecko".into(),
                            stale: false,
                            fetched_at: Self::now(),
                        };
                        self.cache.lock().unwrap().map.insert(asset_u, (rate.clone(), Self::now()));
                        return Ok(rate);
                    }
                }
            }
        }

        // 3) Static fallback (demo must go on even when the internet doesn't).
        if let Some(usd) = static_price(&asset_u) {
            return Ok(Rate {
                asset: asset_u,
                usd,
                source: "static".into(),
                stale: true,
                fetched_at: Self::now(),
            });
        }

        Err(AppError::upstream(format!("no price source available for '{asset}'")))
    }

    /// Rates for a comma-separated asset list (e.g. `BTC,ETH,USDC`).
    pub async fn rates(&self, assets: &str) -> ApiResult<Vec<Rate>> {
        let mut out = Vec::new();
        for a in assets.split(',').map(str::trim).filter(|s| !s.is_empty()) {
            out.push(self.rate(a).await?);
        }
        if out.is_empty() {
            return Err(AppError::bad_request("provide at least one asset"));
        }
        Ok(out)
    }

    /// Health snapshot for /health and the status chips in the dashboard.
    pub async fn source_health(&self) -> String {
        if let Some(base) = &self.oracle_url {
            if let Ok(resp) = self.http.get(format!("{base}/health")).send().await {
                if resp.status().is_success() {
                    return "oracle".to_string();
                }
            }
        }
        "coingecko/static".to_string()
    }
}

#[derive(Debug, Deserialize)]
struct OracleResponse {
    source: String,
    prices: Vec<OraclePrice>,
}

#[derive(Debug, Deserialize)]
struct OraclePrice {
    asset: String,
    usd: f64,
}
