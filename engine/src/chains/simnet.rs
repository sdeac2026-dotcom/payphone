//! SimNet — PayPhone's built-in blockchain simulator.
//!
//! A payment *chain*, not a database:
//!
//! - Append-only **block journal** (`simnet.jsonl`), one transaction per block.
//! - Every block is **hash-chained**: `hash = sha256(prev_hash | height | ts | kind | payload)`.
//!   On boot the journal is replayed and every link re-verified — silent
//!   tampering is structurally impossible.
//! - Implements the primitives the engine needs: registry (phone→wallet),
//!   escrow with claim codes, payments, balances, and block exploration.
//!
//! Why not just use SQLite? Because the engine's claim to fame is
//! *statelessness*: core services hold **zero** mutable state, and the only
//! file on disk belongs to the simulated chain itself — exactly like a real
//! node owns its chain data. Swap SimNet for a real chain by pointing
//! `EVM_RPC_*` at an endpoint; no engine code changes.

use crate::error::{ApiResult, AppError};
use crate::invoice::Invoice;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// One simulated block.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Block {
    /// Block height (0 = genesis).
    pub height: u64,
    /// Unix seconds.
    pub ts: u64,
    /// Transaction kind: `genesis` | `register` | `escrow` | `claim` | `pay`.
    pub kind: String,
    /// Kind-specific payload.
    pub data: serde_json::Value,
    /// Hash of the previous block (hex).
    pub prev: String,
    /// This block's hash (hex).
    pub hash: String,
}

impl Block {
    fn compute_hash(&self) -> String {
        let canonical = format!(
            "{}|{}|{}|{}|{}",
            self.prev,
            self.height,
            self.ts,
            self.kind,
            serde_json::to_string(&self.data).unwrap_or_default()
        );
        hex::encode(Sha256::digest(canonical.as_bytes()))
    }
}

/// Registry entry (latest wins per phone hash).
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct RegistryEntry {
    pub wallet: String,
    pub payphone_id: String,
    pub registered_at: u64,
}

/// An open (unclaimed) escrow.
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct Escrow {
    pub id: String,
    pub phone_hash: String,
    pub asset: String,
    pub amount_minor: u64,
    /// SHA-256 of the claim code — raw codes never touch the journal.
    pub code_hash: String,
    pub claimed: bool,
    pub created_at: u64,
}

/// In-memory projection of the journal (rebuilt on boot by replay).
struct State {
    blocks: Vec<Block>,
    registry: std::collections::HashMap<String, RegistryEntry>, // phone_hash → entry
    escrows: std::collections::HashMap<String, Escrow>,         // escrow id → escrow
    file: Option<File>,
}

/// The SimNet node.
pub struct SimNet {
    state: Mutex<State>,
}

impl SimNet {
    /// Open (or create) the journal and replay it, verifying the hash chain.
    pub fn open(dir: &str) -> std::io::Result<SimNet> {
        std::fs::create_dir_all(dir)?;
        let path = PathBuf::from(dir).join("simnet.jsonl");

        let mut blocks = Vec::new();
        if path.exists() {
            let reader = BufReader::new(File::open(&path)?);
            for line in reader.lines() {
                let line = line?;
                if line.trim().is_empty() {
                    continue;
                }
                let block: Block = serde_json::from_str(&line)
                    .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
                blocks.push(block);
            }
        }
        // Verify chain integrity: recompute every hash link.
        let mut prev = String::from("GENESIS");
        for (i, b) in blocks.iter().enumerate() {
            let expect_height = i as u64;
            if b.height != expect_height {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("journal height gap at block {i}"),
                ));
            }
            if b.prev != prev || b.hash != b.compute_hash() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("journal integrity failure at block {i} — tampering detected"),
                ));
            }
            prev = b.hash.clone();
        }

        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        let mut state = State {
            blocks,
            registry: std::collections::HashMap::new(),
            escrows: std::collections::HashMap::new(),
            file: Some(file),
        };
        if state.blocks.is_empty() {
            let genesis_data = serde_json::json!({ "network": "simnet", "version": 1 });
            let genesis = Block {
                height: 0,
                ts: now(),
                kind: "genesis".into(),
                data: genesis_data,
                prev: "GENESIS".into(),
                hash: String::new(),
            };
            let mut genesis = genesis;
            genesis.hash = genesis.compute_hash();
            persist(&mut state, &genesis)?;
        }
        // Rebuild projections.
        for i in 0..state.blocks.len() {
            let b = state.blocks[i].clone();
            project(&mut state, &b);
        }
        tracing::info!(blocks = state.blocks.len(), "SimNet journal replayed");
        Ok(SimNet { state: Mutex::new(state) })
    }

    /// Append a block and update projections. Serialized through the mutex —
    /// this is the "consensus" of SimNet: total order, single writer.
    fn append(&self, kind: &str, data: serde_json::Value) -> ApiResult<Block> {
        let mut st = self.state.lock().unwrap();
        let tip = st.blocks.last().cloned();
        let block = Block {
            height: tip.as_ref().map(|b| b.height + 1).unwrap_or(1),
            ts: now(),
            kind: kind.to_string(),
            data,
            prev: tip.map(|b| b.hash).unwrap_or_else(|| "GENESIS".into()),
            hash: String::new(),
        };
        let mut block = block;
        block.hash = block.compute_hash();
        persist(&mut st, &block).map_err(|e| AppError::internal(format!("simnet append: {e}")))?;
        project(&mut st, &block);
        Ok(block)
    }

    /// Register (or update) a phone → wallet mapping.
    pub fn register(&self, phone_hash: &str, wallet: &str, payphone_id: &str) -> ApiResult<Block> {
        self.append(
            "register",
            serde_json::json!({
                "phone_hash": phone_hash,
                "wallet": wallet,
                "payphone_id": payphone_id,
            }),
        )
    }

    /// Resolve a phone hash to its registered wallet.
    pub fn resolve(&self, phone_hash: &str) -> Option<RegistryEntry> {
        self.state.lock().unwrap().registry.get(phone_hash).cloned()
    }

    /// Lock funds behind a phone hash + claim code.
    pub fn escrow(
        &self,
        phone_hash: &str,
        asset: &str,
        amount_minor: u64,
        code_hash: &str,
        from: &str,
    ) -> ApiResult<(String, Block)> {
        let id = format!("esc_{}", &hex::encode(Sha256::digest(format!(
            "{}|{}|{}|{}",
            phone_hash, amount_minor, code_hash, now()
        )))[..16]);
        let block = self.append(
            "escrow",
            serde_json::json!({
                "escrow_id": id,
                "phone_hash": phone_hash,
                "asset": asset,
                "amount_minor": amount_minor,
                "code_hash": code_hash,
                "from": from,
            }),
        )?;
        Ok((id, block))
    }

    /// Claim an escrow: verify code, release to the wallet currently
    /// registered for the phone hash. Returns the released amount.
    pub fn claim(&self, escrow_id: &str, code: &str, phone_hash: &str) -> ApiResult<(u64, String, Block)> {
        // Phase 1 (read): validate code + resolve destination wallet.
        let (amount, asset, wallet) = {
            let st = self.state.lock().unwrap();
            let escrow = st
                .escrows
                .get(escrow_id)
                .filter(|e| e.phone_hash == phone_hash && !e.claimed)
                .ok_or_else(|| AppError::not_found("no open escrow for this phone hash"))?;
            let code_hash = hex::encode(Sha256::digest(code.as_bytes()));
            if code_hash != escrow.code_hash {
                return Err(AppError::unauthorized("invalid claim code"));
            }
            let wallet = st
                .registry
                .get(phone_hash)
                .ok_or_else(|| AppError::bad_request(
                    "phone not registered yet — register a payout wallet first, then claim",
                ))?
                .wallet
                .clone();
            (escrow.amount_minor, escrow.asset.clone(), wallet)
        };
        // Phase 2 (write): mark claimed, then append the release payment.
        {
            let mut st = self.state.lock().unwrap();
            if let Some(e) = st.escrows.get_mut(escrow_id) {
                e.claimed = true;
            }
        }
        let block = self.append(
            "claim",
            serde_json::json!({
                "escrow_id": escrow_id,
                "phone_hash": phone_hash,
                "to": wallet,
                "asset": asset,
                "amount_minor": amount,
            }),
        )?;
        Ok((amount, wallet, block))
    }

    /// Record a payment to an address (wallet top-up or invoice payment).
    pub fn pay(
        &self,
        to: &str,
        asset: &str,
        amount_minor: u128,
        invoice_id: Option<&str>,
        from_label: &str,
    ) -> ApiResult<Block> {
        self.append(
            "pay",
            serde_json::json!({
                "to": to,
                "asset": asset,
                "amount_minor": amount_minor.to_string(),
                "invoice_id": invoice_id,
                "from": from_label,
            }),
        )
    }

    /// Total received by an address (lifetime).
    pub fn balance(&self, address: &str) -> u128 {
        let st = self.state.lock().unwrap();
        st.blocks
            .iter()
            .filter(|b| b.kind == "pay" && b.data["to"].as_str() == Some(address))
            .filter_map(|b| b.data["amount_minor"].as_str().and_then(|s| s.parse::<u128>().ok()))
            .sum()
    }

    /// Observe an invoice: sum payments to its unique address since creation.
    pub fn observe_invoice(&self, invoice: &Invoice) -> crate::chains::Observation {
        let st = self.state.lock().unwrap();
        let mut observed = 0u128;
        let mut receipts = Vec::new();
        for b in st.blocks.iter().skip_while(|b| b.ts < invoice.iat) {
            if b.kind == "pay"
                && b.data["to"].as_str() == Some(invoice.address.as_str())
                && b.data["invoice_id"].as_str() == Some(invoice.id.as_str())
            {
                if let Some(q) = b.data["amount_minor"].as_str().and_then(|s| s.parse::<u128>().ok()) {
                    observed += q;
                    receipts.push(serde_json::json!({
                        "tx": b.hash,
                        "height": b.height,
                        "ts": b.ts,
                        "amount_minor": q.to_string(),
                    }));
                }
            }
        }
        crate::chains::Observation { observed_qty: observed, receipts }
    }

    /// Recent blocks for the explorer view.
    pub fn recent_blocks(&self, limit: usize) -> Vec<Block> {
        let st = self.state.lock().unwrap();
        st.blocks.iter().rev().take(limit).cloned().collect()
    }

    /// Chain statistics for /health and the explorer header.
    pub fn stats(&self) -> serde_json::Value {
        let st = self.state.lock().unwrap();
        serde_json::json!({
            "height": st.blocks.len().saturating_sub(1),
            "blocks": st.blocks.len(),
            "registered_numbers": st.registry.len(),
            "open_escrows": st.escrows.values().filter(|e| !e.claimed).count(),
        })
    }
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()
}

/// Append one serialized block to the journal file.
fn persist(st: &mut State, block: &Block) -> std::io::Result<()> {
    if let Some(f) = st.file.as_mut() {
        writeln!(f, "{}", serde_json::to_string(block).unwrap_or_default())?;
        f.flush()?;
        f.sync_all().ok();
    }
    st.blocks.push(block.clone());
    Ok(())
}

/// Fold a block into the registry/escrow projections.
fn project(st: &mut State, block: &Block) {
    let (registry, escrows) = (&mut st.registry, &mut st.escrows);
    match block.kind.as_str() {
        "register" => {
            if let (Some(ph), Some(w)) = (
                block.data["phone_hash"].as_str(),
                block.data["wallet"].as_str(),
            ) {
                registry.insert(
                    ph.to_string(),
                    RegistryEntry {
                        wallet: w.to_string(),
                        payphone_id: block.data["payphone_id"]
                            .as_str()
                            .unwrap_or_default()
                            .to_string(),
                        registered_at: block.ts,
                    },
                );
            }
        }
        "escrow" => {
            if let Some(id) = block.data["escrow_id"].as_str() {
                escrows.insert(
                    id.to_string(),
                    Escrow {
                        id: id.to_string(),
                        phone_hash: block.data["phone_hash"].as_str().unwrap_or_default().into(),
                        asset: block.data["asset"].as_str().unwrap_or("USDC").into(),
                        amount_minor: block.data["amount_minor"].as_u64().unwrap_or(0),
                        code_hash: block.data["code_hash"].as_str().unwrap_or_default().into(),
                        claimed: false,
                        created_at: block.ts,
                    },
                );
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir() -> String {
        use std::sync::atomic::{AtomicU32, Ordering};
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let d = format!("/tmp/simnet-test-{}-{n}", std::process::id());
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn journal_replays_with_integrity() {
        let dir = tmpdir();
        {
            let sim = SimNet::open(&dir).unwrap();
            sim.register("phash1", "PPwallet1", "ph_abc").unwrap();
            sim.pay("PPwallet1", "USDC", 5000, None, "test").unwrap();
            assert_eq!(sim.balance("PPwallet1"), 5000);
        }
        // Reopen — replay must rebuild the same state.
        let sim = SimNet::open(&dir).unwrap();
        assert_eq!(sim.balance("PPwallet1"), 5000);
        assert!(sim.resolve("phash1").is_some());
        assert!(sim.stats()["blocks"].as_u64().unwrap() >= 3);
    }

    #[test]
    fn tampered_journal_is_rejected() {
        let dir = tmpdir();
        {
            let sim = SimNet::open(&dir).unwrap();
            sim.pay("PPvictim", "USDC", 100, None, "test").unwrap();
        }
        // Flip an amount in the file.
        let path = format!("{dir}/simnet.jsonl");
        let content = std::fs::read_to_string(&path).unwrap();
        let tampered = content.replace("\"100\"", "\"999999\"");
        std::fs::write(&path, tampered).unwrap();
        assert!(SimNet::open(&dir).is_err(), "tampering must be detected");
    }

    #[test]
    fn escrow_claim_flow() {
        let dir = tmpdir();
        let sim = SimNet::open(&dir).unwrap();
        sim.register("phash2", "PPwallet2", "ph_def").unwrap();
        let code = "123456";
        let code_hash = hex::encode(Sha256::digest(code.as_bytes()));
        let (esc_id, _) = sim.escrow("phash2", "USDC", 2500, &code_hash, "PPpayer").unwrap();

        // Wrong code rejected.
        assert!(sim.claim(&esc_id, "000000", "phash2").is_err());
        // Correct code releases to registered wallet.
        let (amount, wallet, _) = sim.claim(&esc_id, code, "phash2").unwrap();
        assert_eq!(amount, 2500);
        assert_eq!(wallet, "PPwallet2");
        // Double claim rejected.
        assert!(sim.claim(&esc_id, code, "phash2").is_err());
    }
}
