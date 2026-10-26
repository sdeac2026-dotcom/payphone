# PayPhone Architecture

## Design thesis

A payment network has three jobs: match a payer's intent to a destination,
observe settlement, and route fees. Traditional gateways bolt these onto a
database. PayPhone's thesis is that **every one of them is a pure function of
data the network already has** — so the database can be removed entirely.

| Traditional | PayPhone |
|---|---|
| Invoice row in Postgres | HMAC-signed token in the payment URL fragment |
| API key table | Derived secret: `sk = HMAC(master, pk)` — recomputed per request |
| Payment status column | Observed live from the chain (`current − base_qty ≥ qte`) |
| Identity table | On-chain `PhoneRegistry` (phoneHash → wallet) |
| Redis cache | In-process TTL map (oracle data is time-bounded by definition) |
| Ledger reconciliation | The chain is the ledger |

Consequences: no migrations, no backups, no DB incident response, and
horizontal scaling is just "run more engines" — they share nothing.

## Components

### 1. PayPhone Engine (Rust, `engine/`)

The core. Axum HTTP server, ~2,000 readable lines. Modules:

- **`invoice.rs`** — the stateless invoice object + token format
  (`base64url(canonical_json) . base64url(HMAC)`), lifecycle state machine,
  rate-lock math. The `qte` field (expected quantity in asset base units) is
  sealed at creation; display, payment and status matching all use that one
  number, so price drift cannot desynchronize payer and observer.
- **`keys.rs`** — databaseless merchant keys. Public keys carry the tier
  (`pk_growth_…`); secrets are pure functions of the master key. Request
  signing: `hex(HMAC(sk, "{ts}.{METHOD}.{path}.{sha256(body)}"))` with a
  ±300 s replay window and constant-time verification.
- **`phone.rs`** — E.164 normalization (strict, offline), salted hashing
  (`HMAC(pepper, E164)`), display ids, address validation.
- **`fees.rs`** — the revenue engine: tier schedule (free 150 bps …
  enterprise 30 bps) and the 60/25/15 split, integer minor units only.
- **`chains/`** — `simnet.rs` (hash-chained journal: blocks, registry,
  escrow+claims, tamper detection on replay) and `evm.rs` (JSON-RPC watch
  adapter with ERC-20 support). New chains = one module + one match arm.
- **`oracle.rs`** — resolution order: Python oracle → CoinGecko → flagged
  static fallback. Demos must survive a dead internet.
- **`webhooks.rs`** — signed events (`{ts}.{raw_body}` HMAC), 3 retries.
  v1 emission is poll-driven (documented); the production evolution is a
  background watcher with identical signing.
- **`ratelimit.rs`** — token bucket per key, burst = rate/2.

### 2. Web console (Next.js 16, `src/`)

Single-route application with hash-based views (`#/`, `#/dashboard`,
`#/docs`, `#/pay/{id}?t={token}`), code-split via `next/dynamic`:
- **Landing** — live phone→ID derivation in the browser (same HMAC pipeline
  as the engine).
- **Merchant console** — key issuance, invoicing with live status polling,
  phone identity (register / resolve / escrow / claim), webhook tester with
  signature inspection, SimNet block explorer.
- **Checkout** — hosted payment page: QR (EIP-681 for EVM, custom scheme for
  SimNet), rate-lock disclosure, countdown, demo wallet, phone-native flow,
  receipt with on-chain tx and fee transparency.
- **Docs** — in-app API reference mirroring `docs/`.

The browser signs requests with WebCrypto (`src/lib/payphone/api.ts`) using
the exact canonical string the engine verifies — the SDKs and the console
prove the protocol from both sides. Demo keys live in localStorage, loudly
labeled; real integrations keep secrets server-side.

### 3. Oracle service (Python/FastAPI, `services/oracle-py/`)

- **Prices** — median of CoinGecko + CoinCap with dispersion and staleness
  guards; median resists a single poisoned feed.
- **Quotes** — instant-conversion quotes with the explicit spread (revenue
  line, always returned to the caller).
- **Risk scoring** — explainable heuristics (amount bands, asset volatility,
  thin file, aging) → 0–100 with factor list. Deterministic by design so it
  is auditable and testable.

### 4. Contracts (Solidity, `contracts/`)

`PhoneRegistry` (identity, EIP-712 signed registration) · `PaymentRouter`
(payPhone forward or escrow, protocol fee, `InvoicePaid` events for the
watcher) · `FeeVault` (transparent treasury). See `contracts/README.md`.

## Data flows

### Invoice lifecycle

```text
merchant → POST /v1/invoices (signed)
           engine: validate → fee (tier bps) → rate → qte lock
                   → chain adapter: receiving address + base balance
                   → sign token → 201 {invoice, token, payment_url}
payer    → GET payment_url#/pay/{id}?t={token}   (fragment ≠ server logs)
           checkout polls GET /v1/invoices/{id}?token=…
engine: verify token → observe chain → resolve_status(pending|paid|underpaid|expired)
        → emit signed webhook on transitions
merchant → receives funds in their own wallet (non-custodial)
```

### Phone payment (the headline flow)

```text
payer:  "pay +1 555 010 9999 $15"
engine: normalize → +15550109999 → hash = HMAC(pepper, E164)
        resolve(hash):
          registered  → route to wallet (or router contract)
          unregistered → escrow + 6-digit claim code (journal stores sha256(code))
recipient: registers payout wallet → claims with code → funds release
```

## Trust boundaries

1. **Master key** — derives every merchant secret. KMS/HSM territory.
   Rotation invalidates all derived keys at once (documented trade-off).
2. **Signing key** — seals invoice tokens and webhook signatures.
3. **Phone pepper** — blinds phone hashes; rotating it orphans identity
   lookups (re-registration required) — a feature, not a bug, under
   compromise.
4. **Engine ↔ chain RPC** — read-only; the engine never holds keys.
5. **Browser console** — demo session in localStorage; production
   integrations are server-to-server only.

## Scaling path

- **Stateless core** → add engine replicas behind any LB. Rate limits scale
  per-instance; global limits live at the edge (or later, metered on-chain).
- **Observation** → replace poll-driven emission with a background watcher
  per chain (the emit path is already shared).
- **Oracle** → the service is stateless too; run N, front with a LB.
- **On-chain** → contracts on an L2 (Base) keep fees sub-cent; the FeeVault
  makes protocol revenue auditable without trusting dashboards.

## What v2 looks like

- Background chain watchers + delivery queue with dead-letter storage
- HD per-invoice address derivation (xpub) for EVM direct mode
- Community chain adapters (Solana, Tron, Lightning)
- On-chain metering (FeeVault extension) for global rate limits
- ERC-20 escrow paths in `PaymentRouter`
