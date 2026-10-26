<div align="center">

# PayPhone

**Your phone number is your wallet.**

Open, stateless crypto payment infrastructure. Accept any coin from anyone
on earth through one API — payers need nothing more than the phone number
they already own.

Rust engine · Next.js console · Python oracle · Solidity identity · MIT

[Quickstart](#quickstart) · [Architecture](ARCHITECTURE.md) · [API reference](docs/API.md) · [Security](docs/SECURITY.md)

</div>

<div align="center">

**🟢 LIVE — this network is running right now: [payphone-div0.onrender.com](https://payphone-div0.onrender.com)**

Real chains, real prices, non-custodial settlement straight to merchant
wallets — 7 EVM mainnets + Bitcoin + Solana + Tron.

- **Paying someone?** You need nothing — open the payment link you were sent,
  pay from any wallet, done. No signup, no account, no fees for payers.
- **Want to accept crypto?** Merchant onboarding is operator-gated to keep
  scammers off the domain — request access at
  [lex.ecosystem@gmail.com](mailto:lex.ecosystem@gmail.com) and receive your
  keys.
- **Just exploring?** Try the [in-browser demo](https://sdeac2026-dotcom.github.io/payphone/)
  (SimNet toy chain, nothing real moves) or deploy your own node below.

*Node sleeps after ~15 idle minutes on the free tier — first visitor waits
~50s while it wakes.*

</div>

<div align="center">

**💸 Go live with real money in one click:**

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template?template=https://github.com/sdeac2026-dotcom/payphone)

One Docker container, one public port, all 10 real networks enabled
(7 EVM mainnets + Bitcoin + Solana + Tron). Set 5 env vars, deploy, share
payment links. Full runbook: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) ·
Render blueprint: [`render.yaml`](render.yaml)

</div>

---

## What is this?

PayPhone is a complete crypto payment network with three unusual properties:

1. **Phone-number identity.** A payer types `+1 555 010 1234` instead of a
   0x address. The number is normalized to E.164, salted-hashed
   (`keccak256(pepper ‖ E164)`), and resolved to a wallet through an on-chain
   registry. Unregistered numbers receive funds through **claim escrow** —
   the recipient proves phone ownership and claims. No custody, ever.

2. **A stateless engine.** Invoices are **HMAC-signed tokens that travel
   inside the payment URL fragment**. Merchant API keys are **derived, not
   stored** (`sk = HMAC(master, pk)`). Payment state is **observed from the
   chain**, not read from a table. There is no database to run, back up,
   migrate or leak.

3. **A built-in revenue engine.** Tiered fees (1.5% → 0.3%) split
   **60% protocol / 25% referrers / 15% operations** — computed at invoice
   time, embedded in the token, and settled on-chain through a transparent
   `FeeVault`. The network sustains itself by design.

```
Payer ──▶ PayPhone checkout (QR / link / phone number)
                │  invoice token (signed, in URL fragment)
                ▼
        PayPhone Engine (Rust, stateless)
        ├── chain adapters: 7 EVM mainnets · Bitcoin · Solana · Tron · SimNet (dev)
        ├── oracle service (Python): median-of-sources pricing + risk
        └── revenue engine: tiered fees, 60/25/15 split
                │
                ▼
        Merchant wallet ─── funds settle directly, non-custodial
```

## Monorepo layout

```
├── engine/            Rust (axum) — the core payment engine
│   └── src/           invoices · phone identity · fees · chains · auth · webhooks
├── src/               Next.js 16 — landing, merchant console, checkout, docs
├── services/
│   └── oracle-py/     Python (FastAPI) — price aggregation, quotes, risk
├── contracts/         Solidity — PhoneRegistry · PaymentRouter · FeeVault
├── sdks/
│   ├── typescript/    @payphone/sdk — zero-dependency client + examples
│   └── python/        payphone — requests-based client + examples
├── docs/              API reference · security · deployment · revenue
└── scripts/           supervisor · keeper · integration tests · preview shim
```

## Quickstart

**1. Run the engine** (Rust 1.75+):

```bash
cd engine
cargo run --release
# → PayPhone Engine v0.1.0 on http://0.0.0.0:8080 (SimNet enabled, demo keys)
```

**2. Run the web console** (Node 18+ / Bun):

```bash
bun install
bunx next build && bun run start     # http://localhost:3000
# …or in development: bun run dev
```

**3. Run the oracle** (optional but recommended):

```bash
cd services/oracle-py && pip install -r requirements.txt
uvicorn main:app --port 8001
```

**4. Accept your first payment.** Open the console, generate a merchant key,
create an invoice on SimNet, and pay it from the simulated wallet — the full
lifecycle (rate lock → chain observation → fee split → webhook) in under a
minute. Then point the same code at mainnet:

```bash
PAYPHONE_SIMNET=0 \
EVM_RPC_BASE=https://mainnet.base.org \
PAYPHONE_MASTER_KEY=$(openssl rand -hex 32) \
PAYPHONE_SIGNING_KEY=$(openssl rand -hex 32) \
PAYPHONE_PHONE_PEPPER=$(openssl rand -hex 32) \
./engine/target/release/payphone-engine
```

### One API call

```bash
curl -X POST http://localhost:8080/v1/invoices \
  -H "X-PayPhone-Key: pk_growth_…" \
  -H "X-PayPhone-Timestamp: 1730000000" \
  -H "X-PayPhone-Signature: $(…)" \
  -d '{"amount_usd_cents": 2500, "asset": "USDC",
       "chain": "evm", "network": "base", "wallet": "0xYourWallet"}'
```

```json
{
  "data": {
    "invoice": { "id": "inv_9f2c…", "qte": "25000000", "exp": 1730000900 },
    "token": "eyJ2IjoxLC… .hMk3vQ…",
    "payment_url": "https://pay.your-domain/#/pay/inv_9f2c…?t=eyJ…",
    "asset_amount": "25.000000",
    "fee": { "fee_total_minor": 17, "split": { "protocol_minor": 10, "referrer_minor": 4, "operations_minor": 3 } }
  }
}
```

The `token` in the URL fragment is the invoice — signed, portable, and never
stored server-side. Status is observed live from the chain:

```bash
curl "http://localhost:8080/v1/invoices/inv_9f2c…?token=eyJ…"
→ { "invoice": { "status": "paid", … }, "receipts": [ { "tx": "0x…", … } ] }
```

## Security model

| Threat | Mitigation |
|---|---|
| Credential theft | Keys are derived from a KMS-held master — nothing stored, nothing to leak |
| Replay attacks | Timestamped HMAC signatures, ±300 s window, constant-time verification |
| Invoice tampering | HMAC-signed tokens; any edit invalidates the signature |
| Token leakage in logs | Tokens ride in the URL **fragment** — browsers never send it to servers |
| Phone number harvesting | Salted per-deployment hash; raw numbers never logged or stored |
| Custody risk | Non-custodial by construction — the engine holds no keys, ever |
| Webhook forgery | Signed with HMAC-SHA256 over `{timestamp}.{raw_body}` |
| Rate abuse | Token-bucket limiter per key (240/min default), hard fee cap on-chain |

Full threat model: [docs/SECURITY.md](docs/SECURITY.md).

## Revenue model

| Tier | Fee | Included volume | Highlights |
|---|---|---|---|
| Free | 1.5% | $1k/mo | Everything to start |
| Starter | 1.0% | $25k/mo | Branded checkout, phone escrow |
| Growth | 0.7% | $250k/mo | Conversion quotes, sub-org keys |
| Scale | 0.5% | $2.5M/mo | Dedicated oracle slot, 99.95% SLA |
| Enterprise | 0.3% | Unlimited | Volume pricing, on-prem engine |

Every fee splits **60 / 25 / 15** (protocol / referrers / operations) and the
protocol share accumulates in the on-chain [`FeeVault`](contracts/FeeVault.sol)
— income anyone can audit. Instant conversion adds a transparent 40 bps
spread. Details: [docs/REVENUE.md](docs/REVENUE.md).

## SimNet — the chain you develop against

SimNet is a real blockchain simulator, not a mock database: an append-only
journal with hash-chained blocks, replay verification on boot, escrow with
claim codes, and a block explorer built into the console. Your CI can run the
entire payment lifecycle with zero gas. Flip `PAYPHONE_SIMNET=0` and set
`EVM_RPC_*` to go live — no code changes.

## Extending PayPhone

- **Add a chain** — implement the adapter surface (derive addresses, observe
  payments, emit receipts) and add a match arm. `engine/src/chains/evm.rs`
  is the ~200-line reference implementation. Solana, Tron, Bitcoin and
  Lightning are up for grabs.
- **Improve the watcher** — v1 uses balance-delta observation with the
  creation-time baseline sealed in the invoice token. Indexed-provider
  webhooks are the production evolution; the signing contract won't change.
- **Build on the API** — every primitive is public: resolve any phone number,
  quote conversions, audit the fee schedule, verify webhooks.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the lay of the land.

## Deploying

Three processes and a domain — no database, no queue, no migrations:

```text
Caddy / nginx (TLS) ─┬─ Next.js standalone  :3000
                     └─ PayPhone Engine     :8080
                        Python oracle       :8001
```

Full runbook (env matrix, KMS setup, mainnet checklist):
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## License

MIT — see [LICENSE](LICENSE).
