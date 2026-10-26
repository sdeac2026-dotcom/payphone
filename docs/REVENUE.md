# The PayPhone Revenue Engine

How the network sustains itself — computed at invoice time, embedded in the
signed token, auditable on-chain.

## Fee schedule (public API contract)

| Tier | Fee | Included volume / mo | Max invoices / mo |
|---|---|---|---|
| Free | 1.5% | $1,000 | 250 |
| Starter | 1.0% | $25,000 | 5,000 |
| Growth | 0.7% | $250,000 | 50,000 |
| Scale | 0.5% | $2.5M | 500,000 |
| Enterprise | 0.3% | Unlimited | Unlimited |

The tier is part of the merchant's public key (`pk_scale_…`), so pricing
survives without an accounts database. `GET /v1/fees/schedule` returns the
live table; keep it in sync across engine, website and SDKs — it is part of
the API contract.

## Where the money goes

Every fee splits **60 / 25 / 15**:

```text
fee = amount × tier_bps / 10_000     (integer minor units, no floats)
├── 60% protocol  → FeeVault contract (on-chain, event-auditable)
├── 25% referrer  → the party that onboarded the merchant (growth flywheel)
└── 15% operations → RPC providers, oracle infra, support
```

Example — $100.00 at Growth (70 bps): fee $0.70 → protocol $0.42,
referrer $0.17, operations $0.11. The full breakdown is embedded in every
invoice response **and rendered on the payer's checkout** — transparency is
a feature.

## Revenue lines

1. **Processing fees** (above) — the core engine.
2. **Instant conversion spread** — 40 bps default on
   `GET /v1/quote`; funds conversion liquidity operations. Always returned
   to the caller as `spread_bps` / `revenue_usd` — never hidden.
3. **Tier subscriptions** — optional; the included-volume thresholds make
   high-volume merchants upgrade naturally. Metering is stateless today
   (tier in the key) with on-chain metering in the FeeVault as the v2 path.

## Why this design sustains the network

- **No fixed costs**: the stack is stateless — engine replicas cost
  compute, nothing else.
- **No custody spread**: funds never sit in PayPhone accounts, so there is
  no treasury risk to price in.
- **Referrer share** makes distribution self-funding: integrators earn 25%
  of every fee they bring, forever, computed per invoice.
- **On-chain transparency**: `FeeVault` emits `FeeReceived` for every
  protocol cent — anyone can verify income without trusting a dashboard.

## Operations

- Fees are computed in `engine/src/fees.rs` — single source of truth,
  unit-tested (`fee_math_is_exact_and_splits_fully`).
- The checkout renders the breakdown from the invoice response; nothing is
  recalculated client-side.
- Gas for on-chain fee forwarding is covered by the 15% operations share.
