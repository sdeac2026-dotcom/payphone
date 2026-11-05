//! Delegate — the wallet's autopilot for earning and governing.
//!
//! The user's framing: "crypto is so technical, and how to make money out of
//! it is tricky." Delegate is the answer that stays inside the non-custodial
//! boundary: a subsystem that does the HEAVY work on the owner's behalf —
//! scanning every configured network for the wallet's idle balances, matching
//! them against the curated earn registry, flagging dead assets with no venue,
//! and naming exactly what to fund to unlock the rest — so the owner's only
//! job is reviewing the plan and signing. Signing stays local (the same
//! keystore that signs sends); the engine holds no keys, ever.
//!
//! Why not full key-delegation (session keys, smart-account automation)?
//! That exists — EIP-7702 (live since Pectra, May 2025) lets an EOA delegate
//! to contract code and ERC-4337 session keys automate within spending
//! limits — but both move trust from "one signed transaction at a time" to
//! "standing permission," which is a product decision users must opt into,
//! not a default. v1 of Delegate therefore automates everything EXCEPT the
//! signature. The console executes each plan item through the same local
//! signing helpers the Earn panel uses.
//!
//! Honesty rules carried over from the earn registry:
//! - No yield numbers are invented or served. Items carry `reward_source`
//!   (where the income mechanically comes from), never an APY.
//! - Only registry entries with a real `target_contract` can become items;
//!   everything else the plan reports as advisory (idle/unlockable), so the
//!   plan can never suggest a contract that was not address-verified.

use crate::earn::registry_entries;
use crate::error::{ApiResult, AppError};
use axum::extract::{Query, State};
use axum::response::Response;
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

use crate::routes::{guard, ok, Ctx, AppState};

/// Balances at or below this are dust the plan ignores (in whole units of the
/// asset — display strings, not wei).
const DUST_QTY: f64 = 0.000_001;

/// A plan item is only executable if the wallet holds at least this much
/// NATIVE asset on the item's network — every transaction pays gas in native.
const GAS_FLOOR: f64 = 0.000_1;

pub fn router() -> Router<std::sync::Arc<AppState>> {
    Router::new().route("/v1/delegate/plan", get(delegate_plan))
}

#[derive(Deserialize)]
struct PlanQuery {
    address: String,
}

async fn delegate_plan(State(state): Ctx, Query(q): Query<PlanQuery>) -> ApiResult<Response> {
    guard(&state, "delegate-plan")?;
    let evm = state
        .evm
        .as_ref()
        .ok_or_else(|| AppError::unavailable("no EVM RPC configured"))?;

    // Fan out one balance sheet per configured network. `address_balances`
    // caches each sheet for BALANCE_CACHE_TTL, so repeated Delegate opens are
    // cheap; a network with no RPC configured degrades to `skipped`, never a
    // failed request.
    let networks = evm.networks();
    let mut sheets: Vec<(String, Value)> = Vec::new();
    let mut skipped: Vec<(String, String)> = Vec::new();
    for net in &networks {
        match evm.address_balances(&q.address, net).await {
            Ok(sheet) => sheets.push((net.clone(), sheet)),
            Err(e) => skipped.push((net.clone(), e.message)),
        }
    }

    let plan = build_plan(&q.address, &sheets, &skipped);
    Ok(ok(plan))
}

/// One parsed balance row (network, symbol, human qty, original qty string).
struct Row {
    network: String,
    symbol: String,
    qty: f64,
    qty_str: String,
    is_native: bool,
}

fn parse_sheets(sheets: &[(String, Value)]) -> Vec<Row> {
    let mut rows = Vec::new();
    for (network, sheet) in sheets {
        let Some(balances) = sheet.get("balances").and_then(Value::as_array) else {
            continue;
        };
        for b in balances {
            let symbol = b.get("symbol").and_then(Value::as_str).unwrap_or("");
            let qty_str = b
                .get("qty")
                .and_then(Value::as_str)
                .unwrap_or("0")
                .to_string();
            let qty: f64 = qty_str.parse().unwrap_or(0.0);
            if symbol.is_empty() {
                continue;
            }
            let is_native = b.get("kind").and_then(Value::as_str) == Some("native");
            rows.push(Row {
                network: network.clone(),
                symbol: symbol.to_string(),
                qty,
                qty_str,
                is_native,
            });
        }
    }
    rows
}

fn native_qty(rows: &[Row], network: &str) -> f64 {
    rows.iter()
        .filter(|r| r.network == network && r.is_native)
        .map(|r| r.qty)
        .sum::<f64>()
        .max(0.0)
}

/// The pure heart of the planner — no I/O, fully unit-tested. `sheets` is one
/// (network, balance-sheet JSON) pair per scanned network.
pub fn build_plan(
    address: &str,
    sheets: &[(String, Value)],
    skipped: &[(String, String)],
) -> Value {
    let rows = parse_sheets(sheets);
    let mut items: Vec<Value> = Vec::new();
    let mut idle: Vec<Value> = Vec::new();
    let mut unlockable: Vec<Value> = Vec::new();

    // Symbols with an active one-click venue on a given network.
    let active: Vec<&crate::earn::Opportunity> = registry_entries()
        .iter()
        .filter(|o| o.is_active() && o.execution == "wallet_flow" && !o.target_contract.is_empty())
        .collect();

    for opp in &active {
        let row = rows.iter().find(|r| {
            r.network == opp.network
                && r.symbol.eq_ignore_ascii_case(&opp.asset)
                && r.qty > DUST_QTY
                // A native balance below the gas floor cannot fund a
                // transaction at all (the stake itself needs gas first), so
                // it must never surface as an executable item — it is gas
                // dust, and the idle section says so.
                && !(r.is_native && r.qty < GAS_FLOOR)
        });
        match row {
            Some(r) => {
                items.push(json!({
                    "id": opp.id,
                    "protocol": opp.protocol,
                    "label": opp.label,
                    "kind": opp.kind,
                    "network": opp.network,
                    "asset": opp.asset,
                    "balance_qty": r.qty_str,
                    "gas_ok": native_qty(&rows, &opp.network) >= GAS_FLOOR,
                    "receipt_asset": opp.receipt_asset,
                    "target_contract": opp.target_contract,
                    "reward_source": opp.reward_source,
                    "risks": opp.risks,
                    "steps": opp.steps,
                    "explorer": opp.steps.first().cloned().unwrap_or_default(),
                }));
            }
            None => unlockable.push(json!({
                "id": opp.id,
                "protocol": opp.protocol,
                "label": opp.label,
                "network": opp.network,
                "asset": opp.asset,
                "why": format!(
                    "no {} balance on {} yet",
                    opp.asset, opp.network
                ),
                "how": format!(
                    "fund {} on {} (even a small amount) and re-run Delegate — {}",
                    opp.asset, opp.network, opp.label
                ),
            })),
        }
    }

    // Idle: real balances with no one-click venue for that asset on that
    // network — including the user's real case (WLD sitting on Optimism).
    for r in &rows {
        if r.qty <= DUST_QTY {
            continue;
        }
        let has_venue = active.iter().any(|o| {
            o.network == r.network && o.asset.eq_ignore_ascii_case(&r.symbol)
        });
        let gas_dust = r.is_native && r.qty < GAS_FLOOR;
        if !has_venue || gas_dust {
            let note = if gas_dust {
                "gas dust — too small to transact with; top it up before it can earn or pay gas".to_string()
            } else {
                format!(
                    "no curated earn venue for {} on {} yet — hold it, or move it to a network where venues exist",
                    r.symbol, r.network
                )
            };
            idle.push(json!({
                "network": r.network,
                "symbol": r.symbol,
                "qty": r.qty_str,
                "note": note,
            }));
        }
    }

    items.sort_by(|a, b| {
        let qa = a["balance_qty"].as_str().and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
        let qb = b["balance_qty"].as_str().and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
        qb.partial_cmp(&qa).unwrap_or(std::cmp::Ordering::Equal)
    });
    items.truncate(6);
    unlockable.truncate(4);
    idle.truncate(6);

    json!({
        "address": address,
        "generated_at": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
        "non_custodial": "Delegate does the scanning, matching and preparing; every transaction is still signed by you, locally — the engine holds no keys, ever",
        "scanned_networks": sheets.iter().map(|(n, _)| n.clone()).collect::<Vec<_>>(),
        "skipped_networks": skipped.iter().map(|(n, why)| json!({"network": n, "why": why})).collect::<Vec<_>>(),
        "items": items,
        "idle": idle,
        "unlockable": unlockable,
        "counts": {
            "items": items.len(),
            "idle": idle.len(),
            "unlockable": unlockable.len(),
        },
    })
}

// ------------------------------------------------------------------ tests ---

#[cfg(test)]
mod tests {
    use super::*;

    fn sheet(network: &str, native_sym: &str, native_qty: &str, tokens: &[(&str, &str)]) -> Value {
        let mut rows = vec![json!({
            "symbol": native_sym, "qty": native_qty, "kind": "native",
        })];
        for (s, q) in tokens {
            rows.push(json!({"symbol": s, "qty": q, "kind": "erc20"}));
        }
        json!({"network": network, "balances": rows})
    }

    #[test]
    fn whale_with_eth_usdc_uni_gets_three_executable_items() {
        let sheets = vec![
            ("ethereum".to_string(), sheet("ethereum", "ETH", "12.5", &[("UNI", "300"), ("USDC", "0")])),
        ];
        let plan = build_plan("0xabc", &sheets, &[]);
        let items = plan["items"].as_array().unwrap();
        // USDC = 0 → Aave is unlockable advice, never an item. Executable:
        // lido (ETH 12.5) + uni (UNI 300).
        assert_eq!(items.len(), 2, "lido + uni only; zero USDC must not fake an item");
        // sorted by balance qty desc: UNI 300 first, then ETH 12.5
        assert_eq!(items[0]["id"], "uni-governance");
        assert_eq!(items[0]["balance_qty"], "300");
        assert_eq!(items[1]["id"], "lido-steth-ethereum");
        assert!(items[1]["gas_ok"].as_bool().unwrap());
        // USDC=0 → Aave becomes unlockable advice, never an item
        let unl = plan["unlockable"].as_array().unwrap();
        assert!(unl.iter().any(|u| u["id"] == "aave-v3-supply-ethereum"));
        // nothing idle: every nonzero row has a venue or IS one
        assert!(plan["idle"].as_array().unwrap().is_empty());
    }

    #[test]
    fn real_user_wallet_wld_on_optimism_is_idle_not_faked() {
        // The live case that motivated the feature: 0.15 WLD + gas dust on
        // optimism, nothing on ethereum. The plan must NOT invent an item —
        // WLD has no venue; ETH dust is sub-gas-floor on a network with no
        // venues anyway.
        let sheets = vec![
            ("optimism".to_string(), sheet("optimism", "ETH", "0.0005248969", &[("WLD", "0.1500000000")])),
            ("ethereum".to_string(), sheet("ethereum", "ETH", "0", &[])),
        ];
        let plan = build_plan("0xdef", &sheets, &[]);
        assert!(plan["items"].as_array().unwrap().is_empty(), "no fake items for assets without venues");
        let idle = plan["idle"].as_array().unwrap();
        let wld = idle.iter().find(|r| r["symbol"] == "WLD").expect("WLD reported as idle");
        assert!(wld["note"].as_str().unwrap().contains("no curated earn venue"));
        let eth = idle.iter().find(|r| r["symbol"] == "ETH" && r["network"] == "optimism").expect("optimism ETH reported");
        // 0.0005 native is ABOVE the gas floor and optimism has no venue →
        // the honest note is "no venue", not gas dust.
        assert!(eth["note"].as_str().unwrap().contains("no curated earn venue"));
        // every active one-click venue the user COULD fund shows as unlockable
        let unl = plan["unlockable"].as_array().unwrap();
        assert!(unl.iter().any(|u| u["id"] == "lido-steth-ethereum"));
        assert!(unl.iter().any(|u| u["id"] == "aave-v3-supply-ethereum"));
        assert!(unl.iter().any(|u| u["id"] == "uni-governance"));
    }

    #[test]
    fn dust_balances_never_become_items_and_eth_below_gas_floor_is_flagged() {
        let sheets = vec![
            ("ethereum".to_string(), sheet("ethereum", "ETH", "0.00005", &[("USDC", "5000")])),
        ];
        let plan = build_plan("0x123", &sheets, &[]);
        let items = plan["items"].as_array().unwrap();
        // USDC 5000 → Aave item, but native 0.00005 < GAS_FLOOR → gas_ok false
        let aave = items.iter().find(|i| i["id"] == "aave-v3-supply-ethereum").expect("aave item from real USDC balance");
        assert_eq!(aave["gas_ok"], json!(false), "sub-gas-floor native must flag gas_ok=false");
        assert!(!items.iter().any(|i| i["id"] == "lido-steth-ethereum"), "ETH dust must not become a Lido item");
        // UNI has no balance → unlockable, not an item
        assert!(plan["unlockable"].as_array().unwrap().iter().any(|u| u["id"] == "uni-governance"));
    }

    #[test]
    fn skipped_networks_are_reported_never_fatal() {
        let sheets = vec![(
            "ethereum".to_string(),
            sheet("ethereum", "ETH", "1.0", &[]),
        )];
        let skipped = vec![("worldchain".to_string(), "no RPC configured".to_string())];
        let plan = build_plan("0xabc", &sheets, &skipped);
        assert_eq!(plan["scanned_networks"].as_array().unwrap().len(), 1);
        let sk = plan["skipped_networks"].as_array().unwrap();
        assert_eq!(sk[0]["network"], "worldchain");
        assert_eq!(sk[0]["why"], "no RPC configured");
    }
}
