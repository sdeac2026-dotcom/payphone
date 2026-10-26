//! Phone-number identity — the heart of PayPhone.
//!
//! A phone number is the one identifier every human on the planet already
//! owns. PayPhone converts it into a chain-compatible identity:
//!
//! ```text
//! "+1 555 010 1234"
//!   → normalize_e164   "+15550101234"          (strict, offline, no libphonenumber dep)
//!   → phone_hash       sha256(pepper | E164)    (32 bytes, irreversible)
//!   → payphone id      "ph_<first 16 hex>"      (display-safe handle)
//!   → simnet address   "PP<40 hex>"             (SimNet-only derived address)
//! ```
//!
//! Privacy notes:
//! - Raw phone numbers are **never** logged or persisted anywhere.
//! - The per-deployment pepper makes offline rainbow-table attacks on common
//!   numbers economically pointless.
//! - On real chains, `phone_hash` → wallet is resolved by the `PhoneRegistry`
//!   contract; the engine only ever sees the hash.

use crate::error::{ApiResult, AppError};
use hmac::{Hmac, Mac};
use sha2::Sha256;

/// Normalize a user-supplied phone number to strict E.164.
///
/// Accepted input examples:
/// - `+1 (555) 010-1234` → `+15550101234`
/// - `07700 900123` with `default_country="44"` → `+447700900123`
/// - `5550101234` with `default_country="1"` → `+15550101234`
///
/// The validation follows ITU E.164: `+[1-9]\d{7,14}` after normalization.
pub fn normalize_e164(input: &str, default_country: Option<&str>) -> ApiResult<String> {
    let cleaned: String = input
        .chars()
        .filter(|c| !matches!(c, ' ' | '-' | '(' | ')' | '.' | '/' | '\u{00a0}'))
        .collect();

    let e164 = if let Some(rest) = cleaned.strip_prefix('+') {
        format!("+{rest}")
    } else if cleaned.starts_with("00") {
        format!("+{}", &cleaned[2..])
    } else {
        let cc = default_country
            .or(Some("1"))
            .ok_or_else(|| AppError::bad_request("country code required for local format"))?;
        // Local formats usually carry a trunk prefix (leading 0) — strip one.
        let local = cleaned.strip_prefix('0').unwrap_or(&cleaned);
        format!("+{cc}{local}")
    };

    let digits = &e164[1..];
    if digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit()) {
        return Err(AppError::bad_request("phone number contains non-digit characters"));
    }
    if !matches!(digits.chars().next(), Some(c) if c.is_ascii_digit() && c != '0') {
        return Err(AppError::bad_request("country code cannot start with 0"));
    }
    if digits.len() < 8 || digits.len() > 15 {
        return Err(AppError::bad_request(format!(
            "E.164 requires 8–15 digits, got {}",
            digits.len()
        )));
    }
    Ok(e164)
}

/// Salted hash of an E.164 number (hex-encoded, 64 chars).
pub fn phone_hash(e164: &str, pepper: &str) -> String {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(pepper.as_bytes())
        .expect("HMAC accepts any key length");
    mac.update(e164.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

/// Short, display-safe identity handle derived from the full hash.
pub fn payphone_id(full_hash_hex: &str) -> String {
    format!("ph_{}", &full_hash_hex[..16])
}

/// Derive the SimNet payment address for a phone hash (SimNet only).
pub fn simnet_address(full_hash_hex: &str, signing_key: &str) -> String {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(signing_key.as_bytes())
        .expect("HMAC accepts any key length");
    mac.update(format!("simnet-addr|{full_hash_hex}").as_bytes());
    format!("PP{}", hex::encode(&mac.finalize().into_bytes()[..20]))
}

/// Derive the SimNet address for a plain invoice (unique per invoice).
pub fn simnet_invoice_address(invoice_id: &str, signing_key: &str) -> String {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(signing_key.as_bytes())
        .expect("HMAC accepts any key length");
    mac.update(format!("simnet-invoice|{invoice_id}").as_bytes());
    format!("PP{}", hex::encode(&mac.finalize().into_bytes()[..20]))
}

/// Sanity-check a receiving wallet address per chain kind.
///
/// Bitcoin / Solana / Tron are validated **cryptographically** (base58check
/// or bech32 checksum), not just shape-checked: a typo'd address would
/// otherwise create an invoice whose payment is unrecoverable. Fail-closed.
pub fn validate_wallet(chain: &str, wallet: &str) -> ApiResult<()> {
    let ok = match chain {
        // SimNet is the developer sandbox: accept both native "PP<40 hex>"
        // addresses and EVM-style "0x<40 hex>" addresses, so merchants can
        // rehearse with their real wallet addresses before going live.
        "simnet" => is_hex_body(wallet, "PP") || is_hex_body(wallet, "0x"),
        "evm" => is_hex_body(wallet, "0x"),
        "bitcoin" => is_valid_bitcoin_address(wallet),
        "solana" => is_valid_solana_address(wallet),
        "tron" => is_valid_tron_address(wallet),
        _ => !wallet.is_empty() && wallet.len() <= 128,
    };
    if ok {
        Ok(())
    } else {
        Err(AppError::bad_request(format!(
            "wallet '{wallet}' is not a valid {chain} address"
        )))
    }
}

/// True when `wallet` is `prefix` followed by exactly 40 ASCII hex digits.
fn is_hex_body(wallet: &str, prefix: &str) -> bool {
    wallet.len() == prefix.len() + 40
        && wallet.starts_with(prefix)
        && wallet[prefix.len()..].chars().all(|c| c.is_ascii_hexdigit())
}

// ------------------------------------------------------- address formats ----

const B58_ALPHABET: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/// Decode base58 (Bitcoin/Solana/Tron alphabet) to bytes. `None` on any
/// invalid character. Leading '1's decode to leading zero bytes.
fn base58_decode(s: &str) -> Option<Vec<u8>> {
    let mut out: Vec<u8> = Vec::new();
    for c in s.chars() {
        let val = B58_ALPHABET.iter().position(|&a| a as char == c)? as u32;
        let mut carry = val;
        for d in out.iter_mut() {
            let x = (*d as u32) * 58 + carry;
            *d = (x & 0xff) as u8;
            carry = x >> 8;
        }
        while carry > 0 {
            out.push((carry & 0xff) as u8);
            carry >>= 8;
        }
    }
    let zeros = s.chars().take_while(|&c| c == '1').count();
    let mut bytes = vec![0u8; zeros];
    bytes.extend(out.iter().rev());
    Some(bytes)
}

/// sha256(sha256(payload)) — the double-hash used by base58check.
fn sha256d(payload: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let first = Sha256::digest(payload);
    Sha256::digest(first).into()
}

/// base58check: 4-byte sha256d checksum appended to the payload.
fn base58check_decode(s: &str) -> Option<Vec<u8>> {
    let raw = base58_decode(s)?;
    if raw.len() < 5 {
        return None;
    }
    let (payload, checksum) = raw.split_at(raw.len() - 4);
    if &sha256d(payload)[..4] == checksum {
        Some(payload.to_vec())
    } else {
        None
    }
}

/// Bitcoin: legacy base58check (P2PKH `1…`, P2SH `3…`) or SegWit bech32 /
/// bech32m (`bc1q…`, `bc1p…`) — full checksum verification either way.
pub fn is_valid_bitcoin_address(s: &str) -> bool {
    if s.len() < 14 || s.len() > 90 || !s.chars().all(|c| c.is_ascii_graphic()) {
        return false;
    }
    if s.starts_with("bc1") {
        return bech32_checksum_ok(s);
    }
    match base58check_decode(s) {
        Some(p) => p.len() == 21 && (p[0] == 0x00 || p[0] == 0x05),
        None => false,
    }
}

/// Solana: 32-byte ed25519 pubkey in base58 (no checksum; length is the
/// integrity check — base58 alphabet excludes confusables `0OIl`).
pub fn is_valid_solana_address(s: &str) -> bool {
    (32..=44).contains(&s.len())
        && matches!(base58_decode(s), Some(ref b) if b.len() == 32)
}

/// Tron: base58check with a 0x41 version byte + 20-byte body (25 total).
pub fn is_valid_tron_address(s: &str) -> bool {
    s.len() == 34
        && matches!(base58check_decode(s), Some(ref p) if p.len() == 21 && p[0] == 0x41)
}

const BECH32_CHARSET: &[u8] = b"qpzry9x8gf2tvdw0s3jn54khce6mua7l";

/// Verify a `bc1…` address checksum (bech32 BIP-173 for witness v0,
/// bech32m BIP-350 otherwise — taproot `bc1p…` is bech32m).
fn bech32_checksum_ok(addr: &str) -> bool {
    // Bech32 strings are lowercase-only (or uppercase-only) per BIP-173.
    if addr != addr.to_lowercase() && addr != addr.to_uppercase() {
        return false;
    }
    let lower = addr.to_lowercase();
    let Some(sep) = lower.rfind('1') else { return false };
    let (hrp, data_part) = lower.split_at(sep);
    let data = &data_part[1..];
    if hrp != "bc" || data.len() < 6 {
        return false;
    }
    let mut values: Vec<u8> = Vec::with_capacity(hrp.len() * 2 + 1 + data.len());
    for b in hrp.bytes() {
        values.push(b >> 5);
    }
    values.push(0);
    for b in hrp.bytes() {
        values.push(b & 31);
    }
    for c in data.bytes() {
        match BECH32_CHARSET.iter().position(|&x| x == c) {
            Some(i) => values.push(i as u8),
            None => return false,
        }
    }
    let polymod = bech32_polymod(&values);
    // Witness version lives in the first data symbol (msb set on >0):
    // v0 addresses use bech32, v1+ (taproot) use bech32m.
    let witness_v0 = values[hrp.len() * 2 + 1] == 0;
    polymod == if witness_v0 { 1 } else { 0x2bc8_30a3 }
}

fn bech32_polymod(values: &[u8]) -> u32 {
    const GEN: [u32; 5] = [0x3b6a_57b2, 0x2650_8e6d, 0x1ea1_19fa, 0x3d42_33dd, 0x2a14_62b3];
    let mut chk: u32 = 1;
    for &v in values {
        let b = chk >> 25;
        // BIP-173 mask is 25 bits (0x01FF_FFFF) — the width keeps `chk < 2^30`
        // so that `b = chk >> 25` is exactly 5 bits, matching the 5 taps.
        chk = ((chk & 0x01ff_ffff) << 5) ^ v as u32;
        for (i, g) in GEN.iter().enumerate() {
            if (b >> i) & 1 == 1 {
                chk ^= g;
            }
        }
    }
    chk
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalization_matrix() {
        assert_eq!(normalize_e164("+1 (555) 010-1234", None).unwrap(), "+15550101234");
        assert_eq!(normalize_e164("0044 7700 900123", None).unwrap(), "+447700900123");
        assert_eq!(normalize_e164("07700 900123", Some("44")).unwrap(), "+447700900123");
        assert!(normalize_e164("123", None).is_err());
        assert!(normalize_e164("+01234567", None).is_err());
        assert!(normalize_e164("+1555abc1234", None).is_err());
    }

    #[test]
    fn hash_is_deterministic_and_peppered() {
        let a = phone_hash("+15550101234", "pepper-1");
        let b = phone_hash("+15550101234", "pepper-1");
        let c = phone_hash("+15550101234", "pepper-2");
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert_eq!(a.len(), 64);
        assert_eq!(payphone_id(&a), format!("ph_{}", &a[..16]));
    }

    #[test]
    fn simnet_accepts_native_and_evm_addresses() {
        let pp = "PP";
        let native = format!("{}{}", pp, "a".repeat(40));
        let evm = format!("0x{}", "a".repeat(40));
        assert!(validate_wallet("simnet", &native).is_ok());
        assert!(validate_wallet("simnet", &evm).is_ok());
        assert!(validate_wallet("evm", &evm).is_ok());
        // still strict about garbage: non-hex bodies, wrong lengths, prefixes
        assert!(validate_wallet("simnet", &format!("0x{}zz{}", "a", "a".repeat(37))).is_err());
        assert!(validate_wallet("simnet", "PPshort").is_err());
        assert!(validate_wallet("evm", &native).is_err());
        assert!(validate_wallet("evm", &format!("0x{}", "g".repeat(40))).is_err());
    }

    // ------------------------------------------------ address validation ----

    #[test]
    fn bitcoin_addresses_validate_cryptographically() {
        // Real, well-known valid addresses across all three script types.
        assert!(is_valid_bitcoin_address("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa")); // P2PKH genesis
        assert!(is_valid_bitcoin_address("3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy")); // P2SH
        assert!(is_valid_bitcoin_address("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4")); // bech32 v0
        assert!(is_valid_bitcoin_address(
            "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0"
        )); // bech32m taproot
        // A single flipped character invalidates the checksum — fail closed.
        assert!(!is_valid_bitcoin_address("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb"));
        assert!(!is_valid_bitcoin_address("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5"));
        // Bech32 with a bech32m checksum (and vice versa) is invalid.
        assert!(!is_valid_bitcoin_address(
            "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj1"
        ));
        // Wrong version bytes / shapes.
        assert!(!is_valid_bitcoin_address("2NEpo7tynGv3SRb76qVp9uT8pU3dNyeneYf")); // testnet P2SH on mainnet
        assert!(!is_valid_bitcoin_address("bc1garbage"));
        assert!(!is_valid_bitcoin_address(""));
    }

    #[test]
    fn solana_and_tron_addresses_validate() {
        // Real accounts (verified live on mainnet during registry build).
        assert!(is_valid_solana_address("5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9"));
        assert!(is_valid_solana_address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"));
        // Wrong byte-length (a 31-byte pubkey) is rejected.
        assert!(!is_valid_solana_address("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"));
        assert!(!is_valid_solana_address(""));
        // Tron: base58check + 0x41 version.
        assert!(is_valid_tron_address("TV6MuMXfmLbBqPZvBHdwFsDnQeVfnmiuSi"));
        assert!(!is_valid_tron_address("TV6MuMXfmLbBqPZvBHdwFsDnQeVfnmiuSj")); // checksum
        assert!(!is_valid_tron_address("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa")); // BTC ≠ TRON
        assert!(!is_valid_tron_address(""));
    }

    #[test]
    fn validate_wallet_routes_new_chains() {
        assert!(validate_wallet("bitcoin", "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4").is_ok());
        assert!(validate_wallet("solana", "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9").is_ok());
        assert!(validate_wallet("tron", "TV6MuMXfmLbBqPZvBHdwFsDnQeVfnmiuSi").is_ok());
        // A BTC address is NOT a valid solana address, etc.
        assert!(validate_wallet("solana", "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa").is_err());
        assert!(validate_wallet("tron", "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4").is_err());
    }
}
