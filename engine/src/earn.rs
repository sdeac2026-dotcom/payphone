//! Earn — the wallet as an earning, governing network participant.
//!
//! PayPhone started as payments (receive → hold → send). This module adds the
//! third leg of self-custody: the wallet's assets can WORK — earning PoS
//! validator rewards through liquid staking, earning lending interest on
//! DeFi money markets, and carrying voting power in on-chain governance —
//! while the non-custodial invariant stays byte-for-byte intact:
//!
//! - The engine holds NO private keys and NEVER custodies anything. Every
//!   earning flow ends in a transaction the WALLET signs locally (the same
//!   keystore that signs sends). The engine's job is the boring, dangerous
//!   part done right: a curated, address-verified opportunity registry and
//!   live on-chain position/voting-power reads through the RPC mesh.
//! - No yield numbers are invented or served. Registered entries carry a
//!   `reward_source` (where the yield mechanically comes from) — never an
//!   APY. Rates live at the protocols; users see them there.
//! - Every contract address in the DEFAULT registry was verified against the
//!   protocol's own documentation at the time of writing (docs.lido.fi,
//!   developers.uniswap.org, aave.com docs + block explorers). An entry that
//!   cannot be verified ships as `status: "roadmap"` with no address, never
//!   as a guess.
//!
//! Extending the registry (operator): set `PAYPHONE_EARN_REGISTRY_JSON` to a
//! JSON array of opportunities — it fully replaces the default set (same
//! validation applies; an invalid override falls back to the default with a
//! loud log, never a broken endpoint).
//!
//! Validator honesty: on EVM networks a wallet does not "become" a validator
//! (that means 32 ETH + always-on operator infra). Earning the validator
//! reward rate happens by delegating to an operator set — liquid staking
//! here — or by running your own validator node outside PayPhone, which this
//! wallet can then WATCH (positions reads) but never holds the vote key for.
//! That distinction is spelled out on every staking entry.

use crate::chains::{evm, registry};
use crate::error::{ApiResult, AppError};
use crate::routes::{guard, ok, parse_body, AppState, Ctx};
use axum::extract::{Query, State};
use axum::response::Response;
use axum::routing::{get, post};
use axum::Router;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::OnceLock;
use tiny_keccak::{Hasher, Keccak};

/// Rate-limit bucket shared by the earn surface (registry + positions +
/// governance reads). One bucket keeps abuse of the RPC-backed reads bounded.
const EARN_BUDGET: &str = "earn";

// ------------------------------------------------------------ opportunity ---

/// One earning opportunity in the curated registry.
///
/// Address fields are either `""` (absent) or a `0x` + 40-hex-digit contract
/// address — enforced by [`validate_registry`].
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Opportunity {
    /// Stable machine id (`lido-steth-ethereum`).
    pub id: String,
    /// Engine network name (`ethereum`, `base`, …) — EVM-only in v1.
    pub network: String,
    /// `liquid_staking` | `defi_lending` | `governance` | `nft` | `dapp`.
    pub kind: String,
    /// Protocol display name (`Lido`, `Aave`, `Uniswap DAO`).
    pub protocol: String,
    /// One-line label for the UI.
    pub label: String,
    /// What this is and why it earns, in plain language.
    pub description: String,
    /// Symbol of the asset you put in (`ETH`, `USDC`, `UNI`).
    pub asset: String,
    /// Symbol of the receipt asset you hold after entering ("" if none).
    #[serde(default)]
    pub receipt_asset: String,
    /// Contract the wallet transacts with ("" for roadmap entries).
    #[serde(default)]
    pub target_contract: String,
    /// Governance token to delegate from (governance entries only).
    #[serde(default)]
    pub token_contract: String,
    /// Receipt token the positions reader watches ("" = no live read).
    #[serde(default)]
    pub receipt_contract: String,
    /// Receipt-token decimals for base-unit reads (ERC-20s here: 18).
    #[serde(default = "default_decimals")]
    pub receipt_decimals: u8,
    /// Governance-token decimals (UNI: 18).
    #[serde(default = "default_decimals")]
    pub token_decimals: u8,
    /// How the token reports delegated votes: OZ ERC20Votes exposes
    /// `getVotes(address,uint256)`; Compound-style tokens (UNI) expose
    /// `getCurrentVotes(address)`. Defaults to the OZ form.
    #[serde(default = "default_votes_fn")]
    pub votes_function: String,
    /// `wallet_flow` (one-click in PayPhone Wallet) | `positions_only`
    /// (hold/read here, obtain elsewhere) | `manual` (guidance only).
    pub execution: String,
    /// `active` | `roadmap`.
    pub status: String,
    /// Mechanically where the yield comes from — never a number.
    pub reward_source: String,
    /// Honest risk list, rendered next to the button.
    #[serde(default)]
    pub risks: Vec<String>,
    /// Concrete steps the wallet flow performs (or the manual path).
    #[serde(default)]
    pub steps: Vec<String>,
}

fn default_decimals() -> u8 {
    18
}

fn default_votes_fn() -> String {
    "getVotes(address,uint256)".to_string()
}

impl Opportunity {
    /// Visible across modules — the Delegate planner filters on it too.
    pub(crate) fn is_active(&self) -> bool {
        self.status == "active"
    }

    /// True when the positions reader has something to watch for this entry.
    fn readable_contract(&self) -> Option<&str> {
        if !self.receipt_contract.is_empty() {
            Some(&self.receipt_contract)
        } else if !self.token_contract.is_empty() {
            Some(&self.token_contract)
        } else {
            None
        }
    }
}

// ---------------------------------------------------------- the registry ---

/// The default registry. Addresses below were verified against the
/// protocols' own documentation when this module was written; re-verify any
/// address against its source before trusting it.
fn default_registry() -> Vec<Opportunity> {
    vec![
        Opportunity {
            id: "lido-steth-ethereum".into(),
            network: "ethereum".into(),
            kind: "liquid_staking".into(),
            protocol: "Lido".into(),
            label: "Stake ETH → stETH (delegated to Lido's validator set)".into(),
            description: "Deposit ETH with Lido and hold stETH: your stake is delegated across \
                Lido's curated node-operator set, and the balance grows daily with staking \
                rewards while staying liquid. This is how a wallet earns the Ethereum validator \
                reward rate without running a validator.".into(),
            asset: "ETH".into(),
            receipt_asset: "stETH".into(),
            target_contract: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84".into(),
            token_contract: String::new(),
            receipt_contract: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84".into(),
            receipt_decimals: 18,
            token_decimals: 18,
            votes_function: String::new(),
            execution: "wallet_flow".into(),
            status: "active".into(),
            reward_source: "Ethereum PoS consensus rewards earned by Lido's node operators, \
                minus the protocol fee. No APY is quoted here — see the live rate at Lido."
                .into(),
            risks: vec![
                "Smart-contract risk on Lido (audited, but contracts can fail)".into(),
                "stETH rebases — its balance changes daily; periphery tooling must expect that".into(),
                "Staked ETH unbonds over days once withdrawals are queued".into(),
            ],
            steps: vec![
                "Pick an amount of ETH in PayPhone Wallet → Earn".into(),
                "Sign ONE payable transaction: Lido submit(referral) with the ETH as value".into(),
                "stETH lands in your wallet immediately; watch it in Earn → Positions".into(),
            ],
        },
        Opportunity {
            id: "lido-wsteth-ethereum".into(),
            network: "ethereum".into(),
            kind: "liquid_staking".into(),
            protocol: "Lido (wrapped)".into(),
            label: "Wrap stETH → wstETH (non-rebasing, DeFi-friendly)".into(),
            description: "wstETH is Lido's non-rebasing wrapper: one token holds a growing \
                claim on stETH. Wrapping converts rebasing stETH into a fixed-balance token \
                that plays well with DeFi balances and accounting.".into(),
            asset: "stETH".into(),
            receipt_asset: "wstETH".into(),
            target_contract: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0".into(),
            token_contract: String::new(),
            receipt_contract: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0".into(),
            receipt_decimals: 18,
            token_decimals: 18,
            votes_function: String::new(),
            execution: "wallet_flow".into(),
            status: "active".into(),
            reward_source: "Same underlying staking rewards as stETH, expressed as an \
                appreciating wstETH/stETH exchange rate instead of a growing balance.".into(),
            risks: vec![
                "Wrapper contract risk on top of Lido's".into(),
                "The wstETH/stETH rate moves — unwrap math is rate-dependent".into(),
            ],
            steps: vec![
                "Hold stETH (stake first via the Lido entry above, or receive it)".into(),
                "Approve the wrapper for the stETH amount, then wrap(uint256)".into(),
                "Unwrap any time — unwrap(uint256) returns stETH".into(),
            ],
        },
        Opportunity {
            id: "lido-wsteth-base".into(),
            network: "base".into(),
            kind: "liquid_staking".into(),
            protocol: "Lido (L2)".into(),
            label: "Hold wstETH on Base (staked-ETH exposure, L2 fees)".into(),
            description: "Canonical Lido wstETH exists on Base. Hold your staked-ETH position \
                on an L2: same appreciating token, cheap transfers. PayPhone watches the \
                balance; obtaining it on Base happens via the canonical bridge/paths — not a \
                one-click mint here.".into(),
            asset: "ETH".into(),
            receipt_asset: "wstETH".into(),
            target_contract: String::new(),
            token_contract: String::new(),
            receipt_contract: "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452".into(),
            receipt_decimals: 18,
            token_decimals: 18,
            votes_function: String::new(),
            execution: "positions_only".into(),
            status: "active".into(),
            reward_source: "Ethereum PoS staking rewards (the token is a claim on stETH), \
                held on Base for L2-level fees.".into(),
            risks: vec![
                "Bridge risk is additional to Lido's own contract risk".into(),
                "Check you interact with the canonical Lido L2 deployment only".into(),
            ],
            steps: vec![
                "Acquire wstETH on Base via the canonical bridge or a supported venue".into(),
                "Send it to your PayPhone wallet address on Base".into(),
                "Earn → Positions shows the live balance read from the chain".into(),
            ],
        },
        Opportunity {
            id: "aave-v3-supply-ethereum".into(),
            network: "ethereum".into(),
            kind: "defi_lending".into(),
            protocol: "Aave".into(),
            label: "Supply USDC to Aave V3 (earn lending interest)".into(),
            description: "Deposit USDC into Aave's non-custodial money market and earn the \
                variable lending rate paid by borrowers, withdrawable any time while \
                liquidity lasts. Your deposit is an aToken receipt that accrues interest.".into(),
            asset: "USDC".into(),
            receipt_asset: "aUSDC (V3 receipt)".into(),
            target_contract: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2".into(),
            token_contract: String::new(),
            // NOTE: deliberately empty — the V3 aUSDC receipt address was NOT
            // verified against Aave's official address dashboard at writing
            // time, and the registry never ships unverified addresses. The
            // positions reader therefore shows the USDC balance you still
            // hold at the wallet; the receipt balance lives in the Aave UI.
            receipt_contract: String::new(),
            receipt_decimals: 6,
            token_decimals: 18,
            votes_function: String::new(),
            execution: "wallet_flow".into(),
            status: "active".into(),
            reward_source: "Interest paid by borrowers on Aave V3 (variable, utilization-\
                driven) plus any protocol incentives. Rates live at Aave — none are quoted \
                here.".into(),
            risks: vec![
                "Smart-contract risk on the Aave V3 pool".into(),
                "The lending rate is variable — it moves with utilization".into(),
                "Withdrawals depend on available pool liquidity".into(),
            ],
            steps: vec![
                "Approve the Aave pool for the exact USDC amount (never unlimited)".into(),
                "Sign supply(asset, amount, onBehalfOf=you, referralCode=0)".into(),
                "Withdraw with withdraw(asset, amount, to=your wallet) any time".into(),
            ],
        },
        Opportunity {
            id: "uni-governance".into(),
            network: "ethereum".into(),
            kind: "governance".into(),
            protocol: "Uniswap DAO".into(),
            label: "Govern with UNI (delegate votes, cast votes on proposals)".into(),
            description: "UNI is voting power. Delegate it (to yourself or a trusted \
                address) to activate it, then cast on-chain votes on live proposals with the \
                Governor Bravo contract. Being IN governance is two signed transactions away.".into(),
            asset: "UNI".into(),
            receipt_asset: String::new(),
            target_contract: "0x408ED6354d4973f66138C91495F2f2FCbd8724C3".into(),
            token_contract: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984".into(),
            receipt_contract: String::new(),
            receipt_decimals: 18,
            token_decimals: 18,
            votes_function: "getCurrentVotes(address)".into(),
            execution: "wallet_flow".into(),
            status: "active".into(),
            reward_source: "No yield — this is voting power. (Some DAOs run delegate \
                incentive programs; that is between you and the DAO.)".into(),
            risks: vec![
                "Delegation is public and on-chain — delegate consciously".into(),
                "Votes are irreversible once cast on a proposal".into(),
            ],
            steps: vec![
                "Delegate(address) on the UNI token — to your own address to self-govern".into(),
                "Wait one voting block for the delegation to count".into(),
                "castVote(proposalId, support) on the governor: 0=against, 1=for, 2=abstain".into(),
            ],
        },
        Opportunity {
            id: "nft-custody".into(),
            network: "ethereum".into(),
            kind: "nft".into(),
            protocol: "PayPhone Wallet".into(),
            label: "NFT custody & sovereignty (roadmap: gallery + listings)".into(),
            description: "Self-custody already covers NFTs: any ERC-721/1155 sent to your \
                wallet address is YOURS — no marketplace account holds it. A dedicated \
                gallery view and marketplace listing builders (sell, royalty-aware) are on \
                the roadmap; custody itself needs nothing from PayPhone.".into(),
            asset: "NFT".into(),
            receipt_asset: String::new(),
            target_contract: String::new(),
            token_contract: String::new(),
            receipt_contract: String::new(),
            receipt_decimals: 18,
            token_decimals: 18,
            votes_function: String::new(),
            execution: "manual".into(),
            status: "roadmap".into(),
            reward_source: "None (custody, not yield). Income comes when listing/royalty \
                builders ship — selling or licensing your own property.".into(),
            risks: vec![
                "Only send NFTs on the network the sender used — cross-chain NFT mistakes \
                are unrecoverable".into(),
            ],
            steps: vec![
                "Receive an NFT to your wallet address (works today, any ERC-721)".into(),
                "Roadmap: gallery view, marketplace listing flow, royalty enforcement".into(),
            ],
        },
        Opportunity {
            id: "dapp-passport".into(),
            network: "ethereum".into(),
            kind: "dapp".into(),
            protocol: "PayPhone Wallet".into(),
            label: "Wallet as your Web3 passport (roadmap: dApp connection consent)".into(),
            description: "A self-custody wallet is the login of the decentralized web: \
                signed-message auth, dApp session consent, games and prediction markets. \
                PayPhone ships a consent-first connection surface (you approve each dApp and \
                each scope) on the roadmap — signing never leaves your keystore.".into(),
            asset: "—".into(),
            receipt_asset: String::new(),
            target_contract: String::new(),
            token_contract: String::new(),
            receipt_contract: String::new(),
            receipt_decimals: 18,
            token_decimals: 18,
            votes_function: String::new(),
            execution: "manual".into(),
            status: "roadmap".into(),
            reward_source: "None directly — dApp access unlocks airdrops, partner bounties \
                and on-chain activity you can choose to monetize.".into(),
            risks: vec![
                "Signing UNKNOWN messages can authorize transfers — read before you sign \
                (the consent surface is exactly the mitigation for this)".into(),
            ],
            steps: vec![
                "Roadmap: per-dApp consent list, scoped sessions, signed-login flow".into(),
            ],
        },
    ]
}

/// Process-wide registry: default set, or a validated env override
/// (`PAYPHONE_EARN_REGISTRY_JSON`), cached after first use.
pub fn registry_entries() -> &'static [Opportunity] {
    static REGISTRY: OnceLock<Vec<Opportunity>> = OnceLock::new();
    REGISTRY.get_or_init(|| {
        if let Ok(raw) = std::env::var("PAYPHONE_EARN_REGISTRY_JSON") {
            if !raw.trim().is_empty() {
                match serde_json::from_str::<Vec<Opportunity>>(&raw) {
                    Ok(list) if list.len() <= 256 => {
                        if let Err(e) = validate_registry(&list) {
                            tracing::warn!(
                                "PAYPHONE_EARN_REGISTRY_JSON rejected ({e}) — using the default earn registry"
                            );
                            return default_registry();
                        }
                        tracing::info!("earn registry: using PAYPHONE_EARN_REGISTRY_JSON override ({} entries)", list.len());
                        return list;
                    }
                    _ => {
                        tracing::warn!(
                            "PAYPHONE_EARN_REGISTRY_JSON is not a valid opportunity array — using the default earn registry"
                        );
                        return default_registry();
                    }
                }
            }
        }
        default_registry()
    })
}

/// Registry invariants. A registry that fails this can never ship — the same
/// gate runs on the default set, on every env override, and in tests.
pub fn validate_registry(list: &[Opportunity]) -> Result<(), String> {
    if list.is_empty() {
        return Err("registry is empty".into());
    }
    let mut ids = std::collections::HashSet::new();
    for o in list {
        if o.id.trim().is_empty() || ids.contains(o.id.as_str()) {
            return Err(format!("duplicate or empty id '{}'", o.id));
        }
        ids.insert(o.id.clone());
        if !matches!(
            o.kind.as_str(),
            "liquid_staking" | "defi_lending" | "governance" | "nft" | "dapp"
        ) {
            return Err(format!("{}: unknown kind '{}'", o.id, o.kind));
        }
        if !matches!(o.execution.as_str(), "wallet_flow" | "positions_only" | "manual") {
            return Err(format!("{}: unknown execution '{}'", o.id, o.execution));
        }
        if !matches!(o.status.as_str(), "active" | "roadmap") {
            return Err(format!("{}: unknown status '{}'", o.id, o.status));
        }
        // Every EVM earn entry names a REAL engine network; v1 is EVM-only.
        let spec = registry::find(&o.network).ok_or_else(|| {
            format!("{}: unknown network '{}' — see GET /v1/chains", o.id, o.network)
        })?;
        if o.asset.trim().is_empty() {
            return Err(format!("{}: asset is required", o.id));
        }
        // Address hygiene: present-or-nothing, and present means well-formed.
        for (field, addr) in [
            ("target_contract", &o.target_contract),
            ("token_contract", &o.token_contract),
            ("receipt_contract", &o.receipt_contract),
        ] {
            if !addr.is_empty() && !is_address(addr) {
                return Err(format!("{}: {} is not a 0x…40-hex address", o.id, field));
            }
        }
        if o.status == "roadmap" {
            if o.execution != "manual" {
                return Err(format!("{}: roadmap entries must be execution 'manual'", o.id));
            }
            if !o.target_contract.is_empty() || !o.receipt_contract.is_empty() {
                return Err(format!("{}: roadmap entries carry no contract addresses", o.id));
            }
            continue;
        }
        // Active entries must say exactly how a wallet acts.
        match o.execution.as_str() {
            "wallet_flow" => {
                if !is_address(&o.target_contract) {
                    return Err(format!(
                        "{}: active wallet_flow entries need a valid target_contract",
                        o.id
                    ));
                }
            }
            "positions_only" | "manual" => {
                if o.target_contract.is_empty() && o.readable_contract().is_none() {
                    return Err(format!(
                        "{}: active {} entries need a target or readable contract",
                        o.id, o.execution
                    ));
                }
            }
            _ => {}
        }
        // Governance entries must carry the token (delegate target) + governor.
        if o.kind == "governance" && o.is_active() {
            if o.votes_function.trim().is_empty() {
                return Err(format!(
                    "{}: governance entries need a votes_function (getVotes(address,uint256) or getCurrentVotes(address))",
                    o.id
                ));
            }
            if !is_address(&o.token_contract) {
                return Err(format!(
                    "{}: governance entries need a valid token_contract (delegation target)",
                    o.id
                ));
            }
            if !is_address(&o.target_contract) {
                return Err(format!(
                    "{}: governance entries need the governor in target_contract",
                    o.id
                ));
            }
        }
        let _ = spec; // network existence already asserted above
    }
    Ok(())
}

fn is_address(s: &str) -> bool {
    s.len() == 42 && s.starts_with("0x") && s[2..].chars().all(|c| c.is_ascii_hexdigit())
}

// -------------------------------------------------------------- calldata ---

fn keccak256(bytes: &[u8]) -> [u8; 32] {
    let mut k = Keccak::v256();
    k.update(bytes);
    let mut out = [0u8; 32];
    k.finalize(&mut out);
    out
}

/// 4-byte function selector for a canonical signature, e.g.
/// `castVote(uint256,uint8)` → `0x56781388`.
pub fn selector(sig: &str) -> String {
    let h = keccak256(sig.as_bytes());
    format!("0x{}", hex::encode(&h[..4]))
}

fn pad_u128(v: u128) -> String {
    format!("{:0>64}", format!("{v:x}"))
}

/// Validate + left-pad a `0x…` address to a 32-byte ABI word (no `0x` — the
/// caller's selector already carries the prefix).
fn pad_address(addr: &str) -> ApiResult<String> {
    if !is_address(addr) {
        return Err(AppError::bad_request(format!(
            "'{addr}' is not a valid 0x…40-hex address"
        )));
    }
    Ok(format!("{:0>64}", &addr[2..].to_lowercase()))
}

/// `castVote(uint256 proposalId, uint8 support)` — selector 0x56781388.
/// support: 0 = against, 1 = for, 2 = abstain (Governor standard).
pub fn cast_vote_calldata(proposal_id: u128, support: u8) -> ApiResult<String> {
    if support > 2 {
        return Err(AppError::bad_request(
            "support must be 0 (against), 1 (for) or 2 (abstain)",
        ));
    }
    Ok(format!(
        "{}{}{}",
        selector("castVote(uint256,uint8)"),
        pad_u128(proposal_id),
        pad_u128(support as u128)
    ))
}

/// `delegate(address delegatee)` — selector 0x5c19a95c (ERC20Votes).
pub fn delegate_calldata(delegatee: &str) -> ApiResult<String> {
    Ok(format!("{}{}", selector("delegate(address)"), pad_address(delegatee)?))
}

/// `getVotes(address account, uint256 blockNumber)` — selector 0xeb9019d4.
pub fn get_votes_calldata(account: &str, block: u64) -> ApiResult<String> {
    Ok(format!(
        "{}{}{}",
        selector("getVotes(address,uint256)"),
        pad_address(account)?,
        pad_u128(block as u128)
    ))
}

/// `getCurrentVotes(address)` — Compound-style vote read (UNI).
pub fn current_votes_calldata(account: &str) -> ApiResult<String> {
    Ok(format!("{}{}", selector("getCurrentVotes(address)"), pad_address(account)?))
}

/// `submit(address _referral)` payable — Lido's ETH staking entry point.
pub fn lido_submit_calldata(referral: &str) -> ApiResult<String> {
    Ok(format!("{}{}", selector("submit(address)"), pad_address(referral)?))
}

// ---------------------------------------------------------------- reads ---

/// Resolve a registry opportunity by id (or fail with a helpful message).
fn find_opportunity(id: &str) -> ApiResult<&'static Opportunity> {
    registry_entries()
        .iter()
        .find(|o| o.id == id.trim())
        .ok_or_else(|| {
            AppError::not_found(format!(
                "unknown opportunity '{id}' — see GET /v1/earn/opportunities"
            ))
        })
}

fn require_evm(network: &str) -> ApiResult<&'static registry::NetworkSpec> {
    let spec = registry::find(network)
        .ok_or_else(|| AppError::bad_request(format!("unknown EVM network '{network}'")))?;
    Ok(spec)
}

// --------------------------------------------------------------- handlers ---

/// `GET /v1/earn/opportunities` — the curated registry: what a PayPhone
/// wallet can earn, on which networks, with verified contracts, honest risks
/// and zero invented yield numbers.
async fn opportunities(State(state): Ctx) -> ApiResult<Response> {
    guard(&state, EARN_BUDGET)?;
    let all = registry_entries();
    let active = all.iter().filter(|o| o.is_active()).count();
    Ok(ok(json!({
        "count": all.len(),
        "active_count": active,
        "registry_source": if std::env::var("PAYPHONE_EARN_REGISTRY_JSON").map(|v| !v.trim().is_empty()).unwrap_or(false) { "env_override" } else { "default" },
        "non_custodial": "every earning flow ends in a transaction your wallet signs locally — the engine holds no keys, ever",
        "yield_policy": "no APY numbers are served by this API; reward_source explains mechanically where yield comes from and the live rate lives at the protocol",
        "opportunities": all,
        "extend": "operators add entries (or replace the set) via PAYPHONE_EARN_REGISTRY_JSON — same validation applies",
    })))
}

#[derive(Deserialize)]
struct PositionsQuery {
    network: String,
    address: String,
}

/// `GET /v1/earn/positions?network=&address=` — live on-chain read of what
/// this address currently HOLDS across the registry's watchable contracts
/// (staking receipts, governance tokens), plus the native balance.
async fn positions(
    State(state): Ctx,
    Query(q): Query<PositionsQuery>,
) -> ApiResult<Response> {
    guard(&state, EARN_BUDGET)?;
    let spec = require_evm(q.network.trim())?;
    let address = q.address.trim().to_string();
    if !is_address(&address) {
        return Err(AppError::bad_request("address must be a 0x…40-hex EVM address"));
    }
    let evm = state.evm.as_ref().ok_or_else(|| {
        AppError::unavailable("no EVM RPC configured (set EVM_RPC_<NETWORK>)")
    })?;

    let native = evm
        .balance(&spec.name, &address, None)
        .await
        .map(|b| evm::base_units_to_decimal(b, 18))
        .unwrap_or_else(|e| format!("unavailable: {e}"));

    let mut rows = Vec::new();
    for o in registry_entries() {
        if o.network != spec.name {
            continue;
        }
        let Some(contract) = o.readable_contract() else {
            continue;
        };
        let (symbol, decimals) = if !o.receipt_contract.is_empty() {
            (o.receipt_asset.as_str(), o.receipt_decimals)
        } else {
            (o.asset.as_str(), o.token_decimals)
        };
        let qty = evm
            .balance(&spec.name, &address, Some(&evm::Erc20 {
                address: contract.to_string(),
                decimals,
            }))
            .await;
        rows.push(match qty {
            Ok(b) => json!({
                "opportunity_id": o.id,
                "protocol": o.protocol,
                "symbol": symbol,
                "contract": contract,
                "balance": evm::base_units_to_decimal(b, decimals),
            }),
            Err(e) => json!({
                "opportunity_id": o.id,
                "symbol": symbol,
                "error": format!("read unavailable: {e}"),
            }),
        });
    }

    Ok(ok(json!({
        "network": spec.name,
        "chain_id": spec.chain_id,
        "address": address,
        "native_balance": native,
        "positions": rows,
        "note": "read straight from the chain through the engine's RPC mesh — nothing here is engine-held; the wallet owns the contracts' receipts directly",
    })))
}

#[derive(Deserialize)]
struct PowerQuery {
    opportunity: String,
    address: String,
}

/// `GET /v1/governance/power?opportunity=&address=` — live voting power for
/// a governance entry: token balance + delegated votes.
async fn governance_power(
    State(state): Ctx,
    Query(q): Query<PowerQuery>,
) -> ApiResult<Response> {
    guard(&state, EARN_BUDGET)?;
    let o = find_opportunity(&q.opportunity)?;
    if o.kind != "governance" || !o.is_active() {
        return Err(AppError::bad_request(format!(
            "'{}' is not an active governance entry", o.id
        )));
    }
    let address = q.address.trim().to_string();
    if !is_address(&address) {
        return Err(AppError::bad_request("address must be a 0x…40-hex EVM address"));
    }
    let evm = state.evm.as_ref().ok_or_else(|| {
        AppError::unavailable("no EVM RPC configured (set EVM_RPC_<NETWORK>)")
    })?;

    let token_balance = evm
        .balance(&o.network, &address, Some(&evm::Erc20 {
            address: o.token_contract.clone(),
            decimals: o.token_decimals,
        }))
        .await
        .map(|b| evm::base_units_to_decimal(b, o.token_decimals));

    // OZ ERC20Votes measures power at a PAST block (use the last settled
    // one); Compound-style tokens (UNI's getCurrentVotes) read at latest.
    let comp_style = o.votes_function.eq_ignore_ascii_case("getCurrentVotes(address)");
    let settled = if comp_style {
        evm.block_number(&o.network).await? // informational block stamp
    } else {
        let tip = evm.block_number(&o.network).await?;
        tip.saturating_sub(1).max(1)
    };
    let votes_data = if comp_style {
        current_votes_calldata(&address)?
    } else {
        get_votes_calldata(&address, settled)?
    };
    let votes_raw = evm
        .eth_call(&o.network, &o.token_contract, &votes_data, "latest")
        .await?;
    let votes = evm::parse_hex_quantity(&votes_raw).unwrap_or(0);

    Ok(ok(json!({
        "opportunity": o.id,
        "protocol": o.protocol,
        "network": o.network,
        "governor": o.target_contract,
        "token": o.token_contract,
        "address": address,
        "token_balance": token_balance.unwrap_or_else(|e| format!("unavailable: {e}")),
        "votes": evm::base_units_to_decimal(votes, o.token_decimals),
        "votes_raw": votes.to_string(),
        "measured_at_block": settled,
        "note": "votes are the delegated voting power — delegate() on the token activates raw balance as votes",
    })))
}

#[derive(Deserialize)]
struct VoteReq {
    opportunity: String,
    /// Proposal id as a decimal string (governors use uint256; JSON numbers
    /// from other languages lose precision above 2^53).
    proposal_id: String,
    /// 0 = against, 1 = for, 2 = abstain.
    support: u8,
}

/// `POST /v1/governance/vote-calldata` — the exact transaction the wallet
/// signs to cast a vote on the entry's governor. The engine builds bytes; it
/// never signs, never broadcasts, never holds a key.
async fn governance_vote(State(state): Ctx, body: axum::body::Bytes) -> ApiResult<Response> {
    guard(&state, EARN_BUDGET)?;
    let req: VoteReq = parse_body(&body)?;
    let o = find_opportunity(&req.opportunity)?;
    if o.kind != "governance" || !o.is_active() {
        return Err(AppError::bad_request(format!(
            "'{}' is not an active governance entry", o.id
        )));
    }
    let proposal_id: u128 = req.proposal_id.trim().parse().map_err(|_| {
        AppError::bad_request("proposal_id must be a decimal uint256 string (e.g. \"345\")")
    })?;
    if proposal_id == 0 {
        return Err(AppError::bad_request("proposal_id must be ≥ 1"));
    }
    let data = cast_vote_calldata(proposal_id, req.support)?;
    let spec = require_evm(&o.network)?;
    Ok(ok(json!({
        "opportunity": o.id,
        "action": "castVote",
        "to": o.target_contract,
        "value": "0x0",
        "data": data,
        "chain_id": spec.chain_id,
        "network": o.network,
        "support_meaning": { "0": "against", "1": "for", "2": "abstain" },
        "how": "sign this transaction with the PayPhone wallet (or any EOA) and broadcast through any RPC — governance votes are ordinary EVM transactions",
        "non_custodial": "the engine assembles bytes; your keystore signs; the engine never sees a private key",
    })))
}

#[derive(Deserialize)]
struct DelegateReq {
    opportunity: String,
    /// The address that RECEIVES the voting power (often your own).
    delegatee: String,
}

/// `POST /v1/governance/delegate-calldata` — the transaction that activates
/// voting power: `delegate(address)` on the governance token itself.
async fn governance_delegate(State(state): Ctx, body: axum::body::Bytes) -> ApiResult<Response> {
    guard(&state, EARN_BUDGET)?;
    let req: DelegateReq = parse_body(&body)?;
    let o = find_opportunity(&req.opportunity)?;
    if o.kind != "governance" || !o.is_active() {
        return Err(AppError::bad_request(format!(
            "'{}' is not an active governance entry", o.id
        )));
    }
    let data = delegate_calldata(req.delegatee.trim())?;
    let spec = require_evm(&o.network)?;
    Ok(ok(json!({
        "opportunity": o.id,
        "action": "delegate",
        "to": o.token_contract,
        "value": "0x0",
        "data": data,
        "chain_id": spec.chain_id,
        "network": o.network,
        "how": "sign with the wallet that holds the token; power counts from the next voting block",
        "non_custodial": "delegation moves voting power, never tokens — your UNI stays in your wallet",
    })))
}

// ----------------------------------------------------------------- router ---

/// Earn + governance routes, merged into the v1 router.
pub fn router() -> Router<std::sync::Arc<AppState>> {
    Router::new()
        .route("/v1/earn/opportunities", get(opportunities))
        .route("/v1/earn/positions", get(positions))
        .route("/v1/governance/power", get(governance_power))
        .route("/v1/governance/vote-calldata", post(governance_vote))
        .route("/v1/governance/delegate-calldata", post(governance_delegate))
}

// ------------------------------------------------------------------ tests ---

#[cfg(test)]
mod tests {
    use super::*;

    // Selector values independently verified with viem at build time —
    // if tiny-keccak ever disagrees with the ecosystem, this fails loudly.
    #[test]
    fn selectors_match_the_reference_implementations() {
        assert_eq!(selector("castVote(uint256,uint8)"), "0x56781388");
        assert_eq!(selector("delegate(address)"), "0x5c19a95c");
        assert_eq!(selector("getVotes(address,uint256)"), "0xeb9019d4");
        assert_eq!(selector("balanceOf(address)"), "0x70a08231");
        assert_eq!(selector("submit(address)"), "0xa1903eab");
    }

    #[test]
    fn cast_vote_calldata_matches_viem_encoding() {
        // encodeFunctionData({abi:[castVote], args:[345n, 1n]}) — viem output.
        assert_eq!(
            cast_vote_calldata(345, 1).unwrap(),
            "0x5678138800000000000000000000000000000000000000000000000000000000000001590000000000000000000000000000000000000000000000000000000000000001"
        );
        assert!(cast_vote_calldata(1, 3).is_err()); // support out of range
        assert!(cast_vote_calldata(1, 7).is_err());
    }

    #[test]
    fn delegate_and_votes_calldata_match_viem_encoding() {
        // delegate("0x6c3eA90364068520032917BaeA2B6b7dD45a1C53") — viem output
        // (address words are lowercase, left-padded to 32 bytes).
        assert_eq!(
            delegate_calldata("0x6c3eA90364068520032917BaeA2B6b7dD45a1C53").unwrap(),
            "0x5c19a95c0000000000000000000000006c3ea90364068520032917baea2b6b7dd45a1c53"
        );
        assert!(delegate_calldata("0x123").is_err());
        assert!(delegate_calldata("not an address").is_err());
        // getVotes at block 22800000 — viem output.
        assert_eq!(
            get_votes_calldata("0x6c3eA90364068520032917BaeA2B6b7dD45a1C53", 22_800_000).unwrap(),
            "0xeb9019d40000000000000000000000006c3ea90364068520032917baea2b6b7dd45a1c5300000000000000000000000000000000000000000000000000000000015be680"
        );
    }

    #[test]
    fn comp_style_votes_calldata_matches_viem_encoding() {
        // getCurrentVotes("0x6c3eA90364068520032917BaeA2B6b7dD45a1C53") — viem.
        assert_eq!(
            current_votes_calldata("0x6c3eA90364068520032917BaeA2B6b7dD45a1C53").unwrap(),
            "0xb4b5ea570000000000000000000000006c3ea90364068520032917baea2b6b7dd45a1c53"
        );
    }

    #[test]
    fn default_registry_passes_validation() {
        let all = default_registry();
        assert!(all.len() >= 5, "registry grew empty");
        validate_registry(&all).expect("the shipped default registry must always validate");
        // Active entries carry verified-shape addresses; roadmap entries none.
        for o in &all {
            if o.status == "roadmap" {
                assert!(o.target_contract.is_empty());
            }
        }
        // The governance entry points at the verified Uniswap deployments.
        let uni = all.iter().find(|o| o.id == "uni-governance").unwrap();
        assert_eq!(uni.target_contract.to_lowercase(), "0x408ed6354d4973f66138c91495f2f2fcbd8724c3");
        assert_eq!(uni.token_contract.to_lowercase(), "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984");
        // Every active entry names a real network in the chain registry.
        for o in &all {
            if o.is_active() {
                assert!(registry::find(&o.network).is_some(), "{}: bad network", o.id);
            }
        }
    }

    #[test]
    fn registry_validation_rejects_broken_sets() {
        let mut bad = default_registry();
        bad[0].network = "not-a-network".into();
        assert!(validate_registry(&bad).is_err());

        let mut bad = default_registry();
        bad[1].id = bad[0].id.clone();
        assert!(validate_registry(&bad).is_err());

        let mut bad = default_registry();
        bad[0].target_contract = "0xdeadbeef".into(); // active entry, garbage address
        assert!(validate_registry(&bad).is_err());

        let mut bad = default_registry();
        let roadmap = bad.iter_mut().find(|o| o.status == "roadmap").unwrap();
        roadmap.target_contract = "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84".into();
        assert!(validate_registry(&bad).is_err(), "roadmap entries must not ship addresses");

        assert!(validate_registry(&[]).is_err());
    }

    #[test]
    fn env_override_parses_and_falls_back() {
        // A valid minimal override round-trips through serde.
        let minimal = json!([{
            "id": "test-entry",
            "network": "ethereum",
            "kind": "defi_lending",
            "protocol": "Test",
            "label": "Test entry",
            "description": "d",
            "asset": "USDC",
            "target_contract": "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
            "execution": "wallet_flow",
            "status": "active",
            "reward_source": "test"
        }]);
        let parsed: Vec<Opportunity> = serde_json::from_value(minimal).unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].receipt_decimals, 18); // serde default kicked in
        assert!(validate_registry(&parsed).is_ok());

        // Garbage is a fallback, not a crash — that path is exercised in
        // registry_entries() via tracing; here we assert the parse actually
        // fails so the fallback triggers.
        assert!(serde_json::from_str::<Vec<Opportunity>>("not json").is_err());
    }

    #[test]
    fn lido_submit_is_payable_bytes_only() {
        let data = lido_submit_calldata("0x0000000000000000000000000000000000000000").unwrap();
        assert_eq!(&data[..10], selector("submit(address)").as_str());
        assert_eq!(data.len(), 10 + 64);
    }
}
