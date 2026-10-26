//! Chain adapters.
//!
//! The engine talks to *chains*, not to a database. `mod.rs` defines the
//! coordinator that dispatches to whichever adapter an invoice uses:
//!
//! - [`simnet::SimNet`] — a real, hash-chained blockchain simulator kept as
//!   an append-only journal. It has blocks, tamper evidence, replay on boot,
//!   escrow and a claim protocol — everything a payment chain needs, minus
//!   consensus overhead. It exists so the full payment lifecycle is
//!   demonstrable end-to-end without spending mainnet gas.
//! - [`evm::EvmAdapter`] — production watch adapter for seven EVM mainnets
//!   via JSON-RPC (eth_getLogs for ERC-20s, balance-delta for natives).
//! - [`bitcoin::BitcoinAdapter`] — watch-only BTC via the Esplora API
//!   (confirmed-balance delta + best-effort tx receipts).
//! - [`solana::SolanaAdapter`] — watch-only SOL / SPL via JSON-RPC
//!   (balance-delta).
//! - [`tron::TronAdapter`] — watch-only TRX / TRC-20 via TronGrid
//!   (confirmed event-sum for TRC-20, balance-delta for native).
//!
//! Adding a chain = adding one adapter module and a match arm in
//! [`Coordinator`]. That's the whole integration surface — see
//! `docs/API.md` → "Adding a chain".

pub mod bitcoin;
pub mod evm;
pub mod registry;
pub mod simnet;
pub mod solana;
pub mod tron;

use crate::error::{ApiResult, AppError};
use crate::invoice::Invoice;
use serde::Serialize;
use std::sync::Arc;

/// Supported chain kinds (the `chain` field of an invoice).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ChainKind {
    Simnet,
    Evm,
    Bitcoin,
    Solana,
    Tron,
}

impl ChainKind {
    pub fn parse(s: &str) -> ApiResult<ChainKind> {
        match s.to_lowercase().as_str() {
            "simnet" => Ok(ChainKind::Simnet),
            "evm" => Ok(ChainKind::Evm),
            "bitcoin" | "btc" => Ok(ChainKind::Bitcoin),
            "solana" | "sol" => Ok(ChainKind::Solana),
            "tron" => Ok(ChainKind::Tron),
            other => Err(AppError::bad_request(format!(
                "unknown chain '{other}' (supported: simnet, evm, bitcoin, solana, tron)"
            ))),
        }
    }

    /// Canonical `chain` string stored in invoices / used in signing.
    pub fn as_str(&self) -> &'static str {
        match self {
            ChainKind::Simnet => "simnet",
            ChainKind::Evm => "evm",
            ChainKind::Bitcoin => "bitcoin",
            ChainKind::Solana => "solana",
            ChainKind::Tron => "tron",
        }
    }
}

/// What the chain observer reports for an invoice.
#[derive(Debug, Clone, Serialize)]
pub struct Observation {
    /// Observed quantity delta since invoice creation (asset base units).
    /// Serialized as a decimal string — 18dp stablecoins exceed u64::MAX.
    #[serde(with = "crate::invoice::qty_string")]
    pub observed_qty: u128,
    /// Extra chain-specific receipt info (tx hashes, block heights).
    pub receipts: Vec<serde_json::Value>,
}

/// Dispatch coordinator over concrete adapters (no trait objects —
/// enum dispatch keeps the hot path monomorphic and the binary lean).
#[derive(Clone)]
pub struct Coordinator {
    pub simnet: Option<Arc<simnet::SimNet>>,
    pub evm: Option<evm::EvmAdapter>,
    pub bitcoin: Option<bitcoin::BitcoinAdapter>,
    pub solana: Option<solana::SolanaAdapter>,
    pub tron: Option<tron::TronAdapter>,
}

impl Coordinator {
    /// Observe the chain for an invoice.
    pub async fn observe(&self, invoice: &Invoice) -> ApiResult<Observation> {
        match ChainKind::parse(&invoice.chain)? {
            ChainKind::Simnet => {
                let sim = self
                    .simnet
                    .as_ref()
                    .ok_or_else(|| AppError::unavailable("simnet disabled"))?;
                Ok(sim.observe_invoice(invoice))
            }
            ChainKind::Evm => {
                let evm = self
                    .evm
                    .as_ref()
                    .ok_or_else(|| AppError::unavailable("no EVM RPC configured"))?;
                evm.observe_invoice(invoice).await
            }
            ChainKind::Bitcoin => {
                let btc = self
                    .bitcoin
                    .as_ref()
                    .ok_or_else(|| AppError::unavailable("no Bitcoin API configured (BTC_API_BASE)"))?;
                btc.observe_invoice(invoice).await
            }
            ChainKind::Solana => {
                let sol = self
                    .solana
                    .as_ref()
                    .ok_or_else(|| AppError::unavailable("no Solana RPC configured (SOL_RPC_URL)"))?;
                sol.observe_invoice(invoice).await
            }
            ChainKind::Tron => {
                let trx = self
                    .tron
                    .as_ref()
                    .ok_or_else(|| AppError::unavailable("no Tron API configured (TRON_API_BASE)"))?;
                trx.observe_invoice(invoice).await
            }
        }
    }

    /// Validate that a chain/network combo is actually usable right now.
    pub fn ensure_chain_available(
        &self,
        kind: ChainKind,
        network: &str,
        simnet_enabled: bool,
    ) -> ApiResult<()> {
        match kind {
            ChainKind::Simnet => {
                if !simnet_enabled || self.simnet.is_none() {
                    return Err(AppError::unavailable("simnet is disabled on this engine"));
                }
                Ok(())
            }
            ChainKind::Evm => {
                let evm = self.evm.as_ref().ok_or_else(|| AppError::unavailable(
                    "no EVM RPC configured (set EVM_RPC_<NETWORK>)",
                ))?;
                if !evm.has_network(network) {
                    return Err(AppError::unavailable(format!(
                        "no RPC configured for EVM network '{network}'"
                    )));
                }
                Ok(())
            }
            ChainKind::Bitcoin => {
                if self.bitcoin.is_none() {
                    return Err(AppError::unavailable("no Bitcoin API configured"));
                }
                if !network.eq_ignore_ascii_case("mainnet") {
                    return Err(AppError::bad_request(
                        "bitcoin invoices settle on network 'mainnet' only",
                    ));
                }
                Ok(())
            }
            ChainKind::Solana => {
                if self.solana.is_none() {
                    return Err(AppError::unavailable("no Solana RPC configured"));
                }
                if !network.eq_ignore_ascii_case("mainnet") {
                    return Err(AppError::bad_request(
                        "solana invoices settle on network 'mainnet' only",
                    ));
                }
                Ok(())
            }
            ChainKind::Tron => {
                if self.tron.is_none() {
                    return Err(AppError::unavailable("no Tron API configured"));
                }
                if !network.eq_ignore_ascii_case("mainnet") {
                    return Err(AppError::bad_request(
                        "tron invoices settle on network 'mainnet' only",
                    ));
                }
                Ok(())
            }
        }
    }
}
