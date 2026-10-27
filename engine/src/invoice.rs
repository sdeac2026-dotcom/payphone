//! Stateless invoices.
//!
//! A PayPhone invoice is **not a database row**. It is a small signed object
//! that travels with the payment link itself:
//!
//! ```text
//! token = base64url(canonical_json(invoice)) "." base64url(HMAC(payload))
//! url   = https://pay.example/#/pay/inv_ab12?t={token}
//! ```
//!
//! Because the token lives in the URL **fragment**, it never reaches server
//! access logs. Anyone holding the link can read the invoice; nobody can
//! modify it without invalidating the HMAC. Payment state is *observed on
//! the chain*, not stored: the engine compares the address balance recorded
//! at creation (`base_qty`) with the live balance from the chain adapter.
//!
//! Lifecycle:
//! ```text
//! pending ──(observed ≥ amount)──▶ paid ──(merchant sweep)──▶ settled
//!    │──(partial payment)──▶ underpaid
//!    └──(ttl elapsed)──▶ expired
//! ```

use crate::error::{ApiResult, AppError};
use crate::{fees, oracle};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Blockchain quantity serialization: u128 amounts travel as **decimal
/// strings** in JSON. An 18-decimal stablecoin invoice routinely locks more
/// than u64::MAX base units (e.g. $19.99 of DAI = 1.999e19), which cannot be
/// a JSON number without breaking serde_json — and JavaScript loses integer
/// exactness beyond 2^53 anyway. Deserialization accepts BOTH a string and a
/// number, so legacy tokens minted before this change keep parsing.
pub mod qty_string {
    use serde::{Deserializer, Serializer};
    pub fn serialize<S: Serializer>(v: &u128, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&v.to_string())
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<u128, D::Error> {
        struct V;
        impl serde::de::Visitor<'_> for V {
            type Value = u128;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("u128 quantity as decimal string or number")
            }
            fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<u128, E> {
                v.parse::<u128>().map_err(serde::de::Error::custom)
            }
            fn visit_u64<E: serde::de::Error>(self, v: u64) -> Result<u128, E> {
                Ok(v as u128)
            }
            fn visit_u128<E: serde::de::Error>(self, v: u128) -> Result<u128, E> {
                Ok(v)
            }
        }
        d.deserialize_any(V)
    }
}

/// The complete, self-contained invoice object.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Invoice {
    /// Schema version.
    pub v: u8,
    /// Public identifier, `inv_<16 hex>`.
    pub id: String,
    /// Merchant public key.
    pub mid: String,
    /// Merchant tier (snapshot at creation time).
    pub tier: String,
    /// Amount in USD minor units (cents) — the stable pricing currency.
    pub amount_minor: u64,
    /// Display currency, always `USD` in v1 (multi-currency pricing roadmap).
    pub currency: String,
    /// Settlement asset the payer will send, e.g. `USDC`, `ETH`.
    pub asset: String,
    /// Chain adapter to observe: `simnet` | `evm`.
    pub chain: String,
    /// Network within the chain: `simnet` | `mainnet` | `base` | …
    pub network: String,
    /// Receiving address (merchant-owned, non-custodial).
    pub address: String,
    /// ERC-20 contract address when the asset is a token (empty = native).
    pub token_address: String,
    /// Description hash — the raw text never enters the signed object,
    /// only its SHA-256 (PII hygiene).
    pub description_hash: String,
    /// Fee applied, basis points (snapshot of the schedule).
    pub fee_bps: u64,
    /// Address/token balance observed at creation time (stateless matching).
    #[serde(with = "qty_string")]
    pub base_qty: u128,
    /// Rate-locked quantity the payer must send, in asset base units.
    /// Computed at creation from the oracle price — display, payment and
    /// status matching all use this single number, so a mid-flight price
    /// move cannot desynchronize the checkout from the observer.
    #[serde(with = "qty_string")]
    pub qte: u128,
    /// Unix seconds: creation.
    pub iat: u64,
    /// Unix seconds: expiry (iat + ttl).
    pub exp: u64,
    /// Random nonce, prevents identical-invoice token replay.
    pub nce: String,
    /// Merchant webhook URL for this invoice's events (empty = none).
    pub whu: String,
    /// Block height at creation (chain adapter marks the observation
    /// window start). 0 for simnet invoices and legacy tokens.
    #[serde(default)]
    pub birth_block: u64,
}

impl Invoice {
    /// Human description placeholder derived from the hash (no PII).
    pub fn description_label(&self) -> String {
        if self.description_hash.is_empty() {
            "Payment".to_string()
        } else {
            format!("Order {}", &self.description_hash[..10.min(self.description_hash.len())])
        }
    }

    /// Remaining lifetime in seconds (0 if expired).
    pub fn seconds_left(&self, now: u64) -> u64 {
        self.exp.saturating_sub(now)
    }
}

/// Sign an invoice into a portable token: `payload.signature`.
pub fn sign_token(signing_key: &str, invoice: &Invoice) -> ApiResult<String> {
    let payload_json = serde_json::to_string(invoice)
        .map_err(|e| AppError::internal(format!("serialize invoice: {e}")))?;
    let payload = b64url(payload_json.as_bytes());
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(signing_key.as_bytes())
        .expect("HMAC accepts any key length");
    mac.update(format!("payphone.inv.v1.{payload}").as_bytes());
    let sig = b64url(&mac.finalize().into_bytes());
    Ok(format!("{payload}.{sig}"))
}

/// Verify and parse a token. Rejects tampering and (optionally) expiry.
pub fn verify_token(signing_key: &str, token: &str) -> ApiResult<Invoice> {
    let (payload, sig) = token
        .split_once('.')
        .ok_or_else(|| AppError::bad_request("malformed invoice token"))?;
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(signing_key.as_bytes())
        .expect("HMAC accepts any key length");
    mac.update(format!("payphone.inv.v1.{payload}").as_bytes());
    let expected = b64url(&mac.finalize().into_bytes());
    if expected != sig {
        return Err(AppError::unauthorized("invoice token signature mismatch"));
    }
    let raw = b64url_decode(payload)?;
    let invoice: Invoice = serde_json::from_slice(&raw)
        .map_err(|e| AppError::bad_request(format!("invoice token unreadable: {e}")))?;
    Ok(invoice)
}

/// Hash free-text description into the token-safe form.
pub fn hash_description(text: &str) -> String {
    if text.trim().is_empty() {
        String::new()
    } else {
        hex::encode(Sha256::digest(text.trim().as_bytes()))
    }
}

/// Outcome of observing the chain for an invoice.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum InvoiceStatus {
    Pending,
    Paid,
    Underpaid,
    Expired,
}

impl InvoiceStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            InvoiceStatus::Pending => "pending",
            InvoiceStatus::Paid => "paid",
            InvoiceStatus::Underpaid => "underpaid",
            InvoiceStatus::Expired => "expired",
        }
    }
}

/// Live status + what the chain actually observed.
#[derive(Debug, Clone, Serialize)]
pub struct InvoiceWithStatus {
    #[serde(flatten)]
    pub invoice: Invoice,
    pub status: InvoiceStatus,
    /// Quantity observed on-chain since creation (token base units).
    #[serde(with = "qty_string")]
    pub observed_qty: u128,
    /// How many seconds remain before expiry.
    pub seconds_left: u64,
}

/// Resolve live status against an observed quantity delta.
pub fn resolve_status(invoice: &Invoice, observed_qty: u128, now: u64) -> InvoiceStatus {
    if observed_qty >= invoice.qte {
        return InvoiceStatus::Paid;
    }
    if now >= invoice.exp {
        return InvoiceStatus::Expired;
    }
    if observed_qty > 0 {
        return InvoiceStatus::Underpaid;
    }
    InvoiceStatus::Pending
}

impl Invoice {
    /// Quantity still missing for this invoice to be paid (base units).
    pub fn remaining_qty(&self, observed: u128) -> u128 {
        self.qte.saturating_sub(observed)
    }
}

/// Fee breakdown snapshot for this invoice (revenue engine transparency).
pub fn fee_breakdown(invoice: &Invoice) -> fees::FeeBreakdown {
    fees::compute(invoice.amount_minor, invoice.fee_bps, &invoice.tier)
}

/// Protocol fee quantity in **asset base units**, priced at the exact rate
/// locked into this invoice. Derived purely from the signed object —
/// `fee_qty = qte × fee_total / amount` — so payer, merchant and operator all
/// compute the identical number without trusting each other or the clock.
/// An integer proportion: no floats, no re-pricing, no drift.
pub fn fee_qty_for(invoice: &Invoice) -> u128 {
    if invoice.amount_minor == 0 {
        return 0;
    }
    let fee_total =
        fees::compute(invoice.amount_minor, invoice.fee_bps, &invoice.tier).fee_total_minor as u128;
    invoice.qte.saturating_mul(fee_total) / invoice.amount_minor as u128
}

/// Asset quantity the payer should send, given a USD minor amount and price.
/// `price` = USD per 1 asset unit; returns a decimal string with 6 dp.
pub fn asset_amount_string(amount_minor: u64, price: f64) -> String {
    if price <= 0.0 {
        return "0".to_string();
    }
    let usd = amount_minor as f64 / 100.0;
    let qty = usd / price;
    format!("{qty:.6}")
}

/// Rate-locked expected quantity in asset base units:
/// `(usd / price) × 10^decimals`, rounded to the asset's native precision.
/// Uses the per-asset canonical decimals (simnet path / display only).
pub fn expected_qty(amount_minor: u64, price: f64, asset: &str) -> u128 {
    expected_qty_dp(amount_minor, price, oracle::decimals(asset))
}

/// Rate-locked expected quantity at **explicit** decimals — the chain-true
/// version. A symbol's precision differs per network (USDT is 6dp on most
/// chains but 18dp elsewhere; BSC USDC is 18dp), so real settlement must
/// always pass the decimals resolved from the chain registry.
pub fn expected_qty_dp(amount_minor: u64, price: f64, decimals: u8) -> u128 {
    if price <= 0.0 {
        return 0;
    }
    let usd = amount_minor as f64 / 100.0;
    let qty = usd / price * 10f64.powi(decimals as i32);
    qty.round() as u128
}

// ---------------------------------------------------------------- utils ----

pub fn b64url(data: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(data)
}

pub fn b64url_decode(data: &str) -> ApiResult<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(data)
        .map_err(|_| AppError::bad_request("invalid base64url payload"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Invoice {
        Invoice {
            v: 1,
            id: "inv_0123456789abcdef".into(),
            mid: "pk_growth_deadbeef01".into(),
            tier: "growth".into(),
            amount_minor: 2500,
            currency: "USD".into(),
            asset: "USDC".into(),
            chain: "simnet".into(),
            network: "simnet".into(),
            address: "PPabcdef".into(),
            token_address: String::new(),
            description_hash: String::new(),
            fee_bps: 70,
            base_qty: 0,
            qte: 25_000_000,
            iat: 1_700_000_000,
            exp: 1_700_000_900,
            nce: "abc123".into(),
            whu: "https://merchant.example/hooks".into(),
            birth_block: 0,
        }
    }

    #[test]
    fn token_roundtrip_and_tamper_detection() {
        let inv = sample();
        let token = sign_token("key", &inv).unwrap();
        let back = verify_token("key", &token).unwrap();
        assert_eq!(back, inv);
        // Tamper with payload (flip a character).
        let (payload, sig) = token.split_once('.').unwrap();
        let mut chars: Vec<char> = payload.chars().collect();
        let mid = chars.len() / 2;
        chars[mid] = if chars[mid] == 'A' { 'B' } else { 'A' };
        let tampered = format!("{}.{sig}", chars.iter().collect::<String>());
        assert!(verify_token("key", &tampered).is_err());
        // Wrong key.
        assert!(verify_token("other-key", &token).is_err());
    }

    #[test]
    fn status_transitions() {
        let mut inv = sample();
        inv.chain = "evm".into();
        inv.qte = 1000;
        assert_eq!(resolve_status(&inv, 0, 1_700_000_500), InvoiceStatus::Pending);
        assert_eq!(resolve_status(&inv, 500, 1_700_000_500), InvoiceStatus::Underpaid);
        assert_eq!(resolve_status(&inv, 1000, 1_700_000_500), InvoiceStatus::Paid);
        assert_eq!(resolve_status(&inv, 0, 1_700_001_000), InvoiceStatus::Expired);
        assert_eq!(inv.remaining_qty(400), 600);
    }

    #[test]
    fn rate_lock_math() {
        // $25 of USDC at $1.00 → 25 × 10^6 base units.
        assert_eq!(expected_qty(2500, 1.0, "USDC"), 25_000_000);
        // $10 of BTC at $50,000 → 0.0002 BTC → 20_000 sats (8 dp).
        assert_eq!(expected_qty(1000, 50_000.0, "BTC"), 20_000);
        // Chain-true precision: USDT is 18dp on some EVM networks — the same
        // $25 invoice locks 25 × 10^18 base units there.
        assert_eq!(expected_qty_dp(2500, 1.0, 18), 25_000_000_000_000_000_000);
        // SOL native is 9dp: $15 at $150 → 0.1 SOL.
        assert_eq!(expected_qty_dp(1500, 150.0, 9), 100_000_000);
    }

    #[test]
    fn description_never_leaks_pii() {
        assert!(hash_description("invoice #1001 for Alice").is_empty() == false);
        assert_eq!(hash_description("").len(), 0);
    }

    #[test]
    fn fee_qty_is_the_exact_proportion_at_the_locked_rate() {
        // $25.00 at growth (70 bps) → fee $0.17 → at the locked rate
        // (25_000_000 base units for $25.00) the fee is 170_000 base units.
        let inv = sample();
        assert_eq!(fee_qty_for(&inv), 170_000);
        // 18-decimal stablecoin invoice: $19.99 at growth (70 bps) →
        // fee_total = 1999 × 70 / 10_000 = 13 cents; fee qty tracks exactly.
        let mut big = sample();
        big.amount_minor = 19_99;
        big.qte = 19_990_000_000_000_000_000;
        let expected = big.qte.saturating_mul(13) / 19_99;
        assert_eq!(fee_qty_for(&big), expected);
        // Degenerate amounts stay safe.
        let mut zero = sample();
        zero.amount_minor = 0;
        assert_eq!(fee_qty_for(&zero), 0);
    }

    #[test]
    fn quantities_serialize_as_strings_and_roundtrip() {
        // 18dp stablecoin quantities exceed u64::MAX — they must survive the
        // JSON layer exactly, as decimal strings (JS-safe, serde-safe).
        let huge: u128 = 19_990_000_000_000_000_000; // $19.99 of DAI
        let mut inv = sample();
        inv.qte = huge;
        inv.base_qty = huge;
        let json = serde_json::to_value(&inv).unwrap();
        assert_eq!(json["qte"], "19990000000000000000");
        assert_eq!(json["base_qty"], "19990000000000000000");
        // Round-trip through the string form.
        let back: Invoice = serde_json::from_value(json).unwrap();
        assert_eq!(back.qte, huge);
        // Legacy tokens with NUMERIC quantities still parse.
        let mut legacy = serde_json::to_value(&inv).unwrap();
        legacy["qte"] = serde_json::json!(25_000_000u64);
        legacy["base_qty"] = serde_json::json!(0u64);
        let back2: Invoice = serde_json::from_value(legacy).unwrap();
        assert_eq!(back2.qte, 25_000_000);
        assert_eq!(back2.base_qty, 0);
    }
}
