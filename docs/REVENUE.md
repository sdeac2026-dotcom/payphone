# The PayPhone Revenue Engine

How the network sustains itself — computed at invoice time, embedded in the
signed token, named on the checkout, and settled to a wallet anyone can
verify.

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
├── 60% protocol  → the treasury: PAYPHONE_TREASURY_ADDRESS (the operator's wallet)
├── 25% referrer  → the party that onboarded the merchant (growth flywheel)
└── 15% operations → RPC providers, oracle infra, support
```

Example — $100.00 at Growth (70 bps): fee $0.70 → protocol $0.42,
referrer $0.17, operations $0.11. The full breakdown is embedded in every
invoice response **and rendered on the payer's checkout** — transparency is
a feature.

### The treasury address (the "which wallet gets paid" answer)

The operator sets `PAYPHONE_TREASURY_ADDRESS` once. From then on:

- **every invoice** names the treasury as `fee_recipient`, with the fee
  quantity priced at the invoice's own locked rate
  (`fee_qty = qte × fee_total / amount` — exact integer math, unit-tested);
- **the hosted checkout** renders the fee-settlement line (amount + address)
  for the payer, next to the standard fee transparency block;
- **`GET /v1/fees/schedule`** publishes the treasury publicly, so anyone can
  verify which address the protocol share is owed to;
- **on SimNet** the fee is settled automatically as its own journal
  transaction (`fee:inv_…`) alongside every invoice payment — the whole
  revenue path is observable end-to-end without gas.

On real chains the fee line is a transparent settlement instruction priced
into the merchant relationship (enforced by key issuance); the on-chain
`FeeVault` contract that auto-splits at payment time is the v2 evolution.

## Revenue lines

1. **Processing fees** (above) — the core engine.
2. **Wallet send fees** — 0.5% on external transfers made from the embedded
   PayPhone Wallet (`#/wallet`), settled **on-chain as its own transaction**
   to the treasury; transfers to PayPhone phone numbers are deliberately
   **free** — the closed loop is the growth engine, external sends pay for
   the rails. The fee constant is `WALLET_SEND_FEE_BPS` in
   `src/lib/payphone/wallet.ts`; the security trade-offs are documented in
   [WALLET.md](WALLET.md) (client-enforced until the contract-enforced v2).
3. **Instant conversion spread** — 40 bps default on
   `GET /v1/quote`; funds conversion liquidity operations. Always returned
   to the caller as `spread_bps` / `revenue_usd` — never hidden.
4. **Tier subscriptions** — optional; the included-volume thresholds make
   high-volume merchants upgrade naturally. Metering is stateless today
   (tier in the key) with on-chain metering in the FeeVault as the v2 path.
5. **Commercial licenses** — the dual-licensing track: businesses that want
   to run modified or white-labeled PayPhone **without** the AGPL
   source-disclosure obligation buy a commercial license
   ([COMMERCIAL-LICENSE.md](../COMMERCIAL-LICENSE.md), from $290/yr).
   The AGPL keeps the network open forever; commercial licensing turns that
   openness into lifetime revenue. Contributions are dual-licensed by
   policy (see CONTRIBUTING.md) so both tracks stay legally clean.

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
  unit-tested (`fee_math_is_exact_and_splits_fully`); the fee quantity is
  derived in `engine/src/invoice.rs::fee_qty_for`
  (`fee_qty_is_the_exact_proportion_at_the_locked_rate`).
- The checkout renders the breakdown from the invoice response; nothing is
  recalculated client-side.
- Gas for on-chain fee forwarding is covered by the 15% operations share.
