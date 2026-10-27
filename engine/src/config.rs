//! PayPhone Engine configuration.
//!
//! Everything is environment-driven so the engine can run anywhere:
//! a container, a serverless function, a Raspberry Pi. There is no
//! database, no migration, no state directory to provision — only
//! `PAYPHONE_SIMNET_DIR` (the simulated chain's own journal file).
//!
//! Security model of the defaults:
//! - If `PAYPHONE_MASTER_KEY` is not set, a deterministic development key
//!   is used and a loud warning is printed. NEVER ship that to production.
//! - Setting `PAYPHONE_ENV=production` flips the engine to fail-closed: it
//!   refuses to boot without a real master key, disables SimNet unless it
//!   is explicitly opted into, and warns about permissive CORS.
//! - All derived secrets (API keys, invoice signatures) are pure functions
//!   of the master key, so rotating the master key invalidates everything
//!   derived from it in one move.

use std::env;

/// Root configuration for the whole engine.
#[derive(Debug, Clone)]
pub struct Config {
    /// Port the HTTP server binds to.
    pub port: u16,
    /// Root secret from which merchant API keys are derived.
    pub master_key: String,
    /// Key used to sign stateless invoice tokens (derived from master if unset).
    pub signing_key: String,
    /// Pepper mixed into phone-number hashes. Rotating it blinds all lookups.
    pub phone_pepper: String,
    /// Enable the SimNet simulated chain (demo / development).
    pub simnet_enabled: bool,
    /// Directory holding the SimNet append-only journal (`simnet.jsonl`).
    pub simnet_data_dir: String,
    /// Python oracle base URL (price aggregation + risk). Optional.
    pub oracle_url: Option<String>,
    /// EVM JSON-RPC endpoints keyed by network name.
    pub evm_rpcs: Vec<(String, String)>,
    /// Bitcoin Esplora API base (override `BTC_API_BASE`).
    pub btc_api_base: Option<String>,
    /// Solana JSON-RPC endpoint (override `SOL_RPC_URL`).
    pub sol_rpc_url: Option<String>,
    /// TronGrid API base (override `TRON_API_BASE`).
    pub tron_api_base: Option<String>,
    /// CORS allowed origins (`*` for development).
    pub cors_origins: Vec<String>,
    /// Rate limit: requests per minute per API key / IP.
    pub rate_limit_per_min: u32,
    /// Request-signature replay window in seconds.
    pub replay_window_secs: u64,
    /// Default invoice time-to-live in seconds.
    pub invoice_ttl_secs: u64,
    /// Running in demo mode (dev keys + simnet) — surfaces DEMO banners in API.
    pub demo_mode: bool,
    /// `PAYPHONE_ENV=production` — enables fail-closed startup checks.
    pub production: bool,
    /// Revoked merchant `key_id`s (env `PAYPHONE_REVOKED_KEYS`, comma-separated).
    pub revoked_keys: Vec<String>,
    /// Protocol fee recipient (the treasury) — env `PAYPHONE_TREASURY_ADDRESS`.
    /// This is the operator's own wallet: the address that receives the
    /// protocol share (60%) of every processing fee. When set, every invoice
    /// names it as `fee_recipient`, the hosted checkout renders the
    /// fee-settlement line, and SimNet executes the fee transfer alongside
    /// each invoice payment so the full revenue path is observable on-chain.
    /// Use an address valid on the settlement chains you serve (an EVM
    /// `0x…` address for the EVM networks, a `TP…` test address on Tron, etc.).
    pub treasury: Option<String>,
}

impl Config {
    /// Load configuration from the process environment.
    ///
    /// # Panics
    /// When `PAYPHONE_ENV=production` and `PAYPHONE_MASTER_KEY` is missing or
    /// still a development key. This is intentional and fail-closed: a payment
    /// engine that cannot authenticate merchants securely must not serve
    /// traffic at all, rather than silently serving it with known dev keys.
    pub fn from_env() -> Self {
        let port = env::var("PAYPHONE_PORT")
            .or_else(|_| env::var("PORT"))
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(8080);

        let production = matches!(
            env::var("PAYPHONE_ENV").as_deref(),
            Ok("production") | Ok("prod")
        );

        let master_key_env = env::var("PAYPHONE_MASTER_KEY").ok().filter(|s| !s.is_empty());
        let master_key_missing = master_key_env.is_none();
        let master_key =
            master_key_env.unwrap_or_else(|| "dev-master-key-DO-NOT-USE-IN-PRODUCTION".to_string());
        let dev_key = master_key.starts_with("dev-master-key");

        if production && (master_key_missing || dev_key) {
            eprintln!(
                "\n  ✗ FATAL: PAYPHONE_ENV=production requires a real PAYPHONE_MASTER_KEY."
            );
            eprintln!("    Generate one with:  openssl rand -hex 32");
            eprintln!("    Keep it in a KMS/secret manager — never in the repo or image.\n");
            std::process::exit(1);
        }

        // Derive purpose-scoped subkeys from the master key (key separation).
        let signing_key = env::var("PAYPHONE_SIGNING_KEY")
            .unwrap_or_else(|_| derive_subkey(&master_key, "invoice-signing"));
        let phone_pepper = env::var("PAYPHONE_PHONE_PEPPER")
            .unwrap_or_else(|_| derive_subkey(&master_key, "phone-pepper"));

        // SimNet is a developer convenience: default ON for development,
        // default OFF in production (explicit opt-in still possible for
        // staging environments).
        let simnet_enabled = match env::var("PAYPHONE_SIMNET") {
            Ok(v) => v != "0" && v.to_lowercase() != "false",
            Err(_) => !production,
        };

        let simnet_data_dir =
            env::var("PAYPHONE_SIMNET_DIR").unwrap_or_else(|_| ".data".to_string());

        let oracle_url = env::var("PAYPHONE_ORACLE_URL").ok().filter(|s| !s.is_empty());

        // EVM networks: every shipped mainnet gets the first verified public
        // RPC of its registry pool as primary (overridable via
        // `EVM_RPC_<NETWORK>`), and the adapter keeps the rest of the pool as
        // free automatic fallbacks (see chains/evm.rs).
        let mut evm_rpcs: Vec<(String, String)> = crate::chains::registry::NETWORKS
            .iter()
            .map(|net| {
                let env_name = format!("EVM_RPC_{}", net.name.to_uppercase());
                let url = env::var(&env_name)
                    .ok()
                    .filter(|u| !u.is_empty())
                    .unwrap_or_else(|| net.public_rpcs[0].to_string());
                (net.name.to_string(), url)
            })
            .collect();
        // Legacy alias: invoices created with network "mainnet" keep resolving.
        let alias = env::var("EVM_RPC_MAINNET")
            .ok()
            .filter(|u| !u.is_empty())
            .or_else(|| {
                evm_rpcs
                    .iter()
                    .find(|(n, _)| n == "ethereum")
                    .map(|(_, u)| u.clone())
            });
        if let Some(u) = alias {
            evm_rpcs.push(("mainnet".to_string(), u));
        }
        let evm_rpcs = evm_rpcs;

        // Non-EVM watch-only data sources (all default to public endpoints,
        // all overridable for production volume).
        let env_opt = |k: &str| env::var(k).ok().filter(|s| !s.is_empty());
        let btc_api_base = env_opt("BTC_API_BASE");
        let sol_rpc_url = env_opt("SOL_RPC_URL");
        let tron_api_base = env_opt("TRON_API_BASE");

        let cors_origins = env::var("PAYPHONE_CORS_ORIGINS")
            .unwrap_or_else(|_| "*".to_string())
            .split(',')
            .map(|s| s.trim().to_string())
            .collect();

        let rate_limit_per_min = env::var("PAYPHONE_RATE_LIMIT_PER_MIN")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(240);

        let replay_window_secs = env::var("PAYPHONE_REPLAY_WINDOW")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(300);

        let invoice_ttl_secs = env::var("PAYPHONE_INVOICE_TTL")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(900);

        let demo_mode = master_key.starts_with("dev-master-key");

        // Config-level key revocation: comma-separated key_ids, e.g.
        // PAYPHONE_REVOKED_KEYS=4f9c2ab17d03,a1b2c3d4e5f6
        let revoked_keys = env::var("PAYPHONE_REVOKED_KEYS")
            .map(|v| {
                v.split(',')
                    .map(|s| s.trim().to_lowercase())
                    .filter(|s| !s.is_empty())
                    .collect()
            })
            .unwrap_or_default();

        // The treasury: where the protocol share of every fee lands. Optional
        // so development keeps working without one — but a production node
        // earning revenue should always set it (it is the operator's wallet).
        let treasury = env_opt("PAYPHONE_TREASURY_ADDRESS");

        Self {
            port,
            master_key,
            signing_key,
            phone_pepper,
            simnet_enabled,
            simnet_data_dir,
            oracle_url,
            evm_rpcs,
            btc_api_base,
            sol_rpc_url,
            tron_api_base,
            cors_origins,
            rate_limit_per_min,
            replay_window_secs,
            invoice_ttl_secs,
            demo_mode,
            production,
            revoked_keys,
            treasury,
        }
    }

    /// True if an EVM endpoint is configured for the given network.
    pub fn evm_network_available(&self, network: &str) -> bool {
        self.evm_rpcs.iter().any(|(n, _)| n == network)
    }
}

/// Derive a purpose-scoped subkey: `hex(HMAC-SHA256(master, purpose))`.
pub fn derive_subkey(master: &str, purpose: &str) -> String {
    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    let mut mac =
        <Hmac<Sha256> as Mac>::new_from_slice(master.as_bytes()).expect("HMAC accepts any key length");
    mac.update(purpose.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}
