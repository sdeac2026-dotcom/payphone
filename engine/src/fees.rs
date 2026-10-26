//! The revenue engine — how PayPhone sustains itself.
//!
//! Every invoice carries a fee computed at creation time from the merchant's
//! tier. The fee is split three ways so the network, its referrers and its
//! operating costs are all covered *by design*, not by an after-the-fact
//! billing process:
//!
//! ```text
//! merchant pays fee  = amount × tier_bps / 10_000
//! ├── protocol (60%) → PayPhone treasury / FeeVault contract
//! ├── referrer (25%) → whoever onboarded the merchant (growth flywheel)
//! └── operations (15%) → RPC providers, oracle infra, support
//! ```
//!
//! Merchants see the exact breakdown on every invoice — transparency is a
//! feature, not a compliance burden. Fees are quoted in minor units
//! (integer cents) to avoid the classic floating-point money bug.

use serde::{Deserialize, Serialize};

/// One pricing tier of the public schedule.
#[derive(Debug, Clone, Serialize)]
pub struct TierFee {
    pub tier: &'static str,
    /// Fee in basis points (100 bps = 1%).
    pub bps: u64,
    /// Monthly volume included before overage, in USD cents (None = unlimited).
    pub included_volume_usd_cents: Option<u64>,
    pub max_invoices_per_month: u64,
    pub features: &'static [&'static str],
}

/// The public, stable fee schedule. Keep in sync with the website pricing
/// table and `sdks/` constants — it is part of the API contract.
pub const SCHEDULE: &[TierFee] = &[
    TierFee {
        tier: "free",
        bps: 150,
        included_volume_usd_cents: Some(1_000_00),
        max_invoices_per_month: 250,
        features: &["PayPhone checkout", "Webhooks", "Community support"],
    },
    TierFee {
        tier: "starter",
        bps: 100,
        included_volume_usd_cents: Some(25_000_00),
        max_invoices_per_month: 5_000,
        features: &["Custom checkout branding", "Phone-ID escrow", "Email support"],
    },
    TierFee {
        tier: "growth",
        bps: 70,
        included_volume_usd_cents: Some(250_000_00),
        max_invoices_per_month: 50_000,
        features: &["Instant conversion quotes", "Sub-organization keys", "Priority support"],
    },
    TierFee {
        tier: "scale",
        bps: 50,
        included_volume_usd_cents: Some(2_500_000_00),
        max_invoices_per_month: 500_000,
        features: &["Dedicated oracle slot", "SLA 99.95%", "Solutions engineer"],
    },
    TierFee {
        tier: "enterprise",
        bps: 30,
        included_volume_usd_cents: None,
        max_invoices_per_month: u64::MAX,
        features: &["Volume pricing", "On-prem engine", "Custom chains & assets"],
    },
];

/// How each collected fee is split. Sums to 100.
pub const SPLIT: (u64, u64, u64) = (60, 25, 15);

/// Full fee breakdown for an amount, in minor units (USD cents).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeeBreakdown {
    /// Payment amount.
    pub amount_minor: u64,
    /// Total fee charged on top of the amount.
    pub fee_total_minor: u64,
    /// What the merchant actually receives.
    pub net_to_merchant_minor: u64,
    /// Applied rate, in basis points.
    pub bps: u64,
    pub tier: String,
    /// Revenue split of the fee.
    pub split: Split,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Split {
    /// Protocol treasury share (FeeVault on-chain).
    pub protocol_minor: u64,
    /// Referrer share (the party that onboarded this merchant).
    pub referrer_minor: u64,
    /// Infrastructure / operations share.
    pub operations_minor: u64,
}

/// Compute the fee breakdown for `amount_minor` at `bps` basis points.
pub fn compute(amount_minor: u64, bps: u64, tier: &str) -> FeeBreakdown {
    let fee_total_minor = amount_minor * bps / 10_000;
    let split = Split {
        protocol_minor: fee_total_minor * SPLIT.0 / 100,
        referrer_minor: fee_total_minor * SPLIT.1 / 100,
        operations_minor: fee_total_minor - fee_total_minor * SPLIT.0 / 100
            - fee_total_minor * SPLIT.1 / 100,
    };
    FeeBreakdown {
        amount_minor,
        fee_total_minor,
        net_to_merchant_minor: amount_minor,
        bps,
        tier: tier.to_string(),
        split,
    }
}

/// Look up the schedule entry for a tier.
pub fn for_tier(tier: &str) -> Option<&'static TierFee> {
    SCHEDULE.iter().find(|t| t.tier == tier)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fee_math_is_exact_and_splits_fully() {
        // $100.00 at growth (70 bps) → $0.70 fee.
        let fb = compute(100_00, 70, "growth");
        assert_eq!(fb.fee_total_minor, 70);
        assert_eq!(fb.net_to_merchant_minor, 100_00);
        assert_eq!(
            fb.split.protocol_minor + fb.split.referrer_minor + fb.split.operations_minor,
            fb.fee_total_minor,
            "split must allocate every cent of the fee"
        );
        // Split ratio 60/25/15 on 70 cents → 42 / 17 / 11.
        assert_eq!(fb.split.protocol_minor, 42);
        assert_eq!(fb.split.referrer_minor, 17);
        assert_eq!(fb.split.operations_minor, 11);
    }
}
