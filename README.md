<div align="center">

# PayPhone

**Your phone number is your wallet.**

Open, stateless crypto payment infrastructure. Accept any coin from anyone
on earth through one API — payers need nothing more than the phone number
they already own.

Rust engine · Next.js console · Python oracle · Solidity identity · AGPL-3.0

[Quickstart](#quickstart) · [Architecture](ARCHITECTURE.md) · [API reference](docs/API.md) · [Security](docs/SECURITY.md) · [License](#license)

</div>

<div align="center">

**🟢 LIVE — this network is running right now: [payphone-div0.onrender.com](https://payphone-div0.onrender.com)**

Real chains, real prices, non-custodial settlement straight to merchant
wallets — 7 EVM mainnets + Bitcoin + Solana + Tron.

- **Paying someone?** You need nothing — open the payment link you were sent,
  pay from any wallet, done. No signup, no account, no fees for payers.
- **Want to accept crypto?** Onboarding is autonomous, worldwide, 24/7:
  `free` and `starter` tiers self-serve instantly — `POST /v1/keys`, no
  token, no human. Need more volume? Unlock `growth`/`scale`/`enterprise`
  by paying the tier's price on-chain to the network treasury (any asset,
  any supported network) and `POST /v1/tiers/activate` with the tx hash —
  the engine verifies the payment and issues your key. See
  `GET /v1/tiers` for the live rules. (Special arrangements:
  [lex.ecosystem@gmail.com](mailto:lex.ecosystem@gmail.com).)
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

## How PayPhone makes money

Four revenue lines — all transparent, none custodial:

| Line | What | Where it lands |
|---|---|---|
| **Processing fees** | 0.3–1.5% per payment (tier schedule below) | Treasury / referrer / operations split |
| **Conversion spread** | 40 bps on instant conversion quotes | Operations |
| **Tier upgrades** | Volume thresholds make Growth/Scale upgrades natural | Treasury |
| **Commercial licenses** | AGPL escape hatch for closed-source & white-label use ([COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md)) | Operator |

Processing-fee tiers (public API contract — `GET /v1/fees/schedule`):

| Tier | Fee | Included volume | Highlights |
|---|---|---|---|
| Free | 1.5% | $1k/mo | Everything to start |
| Starter | 1.0% | $25k/mo | Branded checkout, phone escrow |
| Growth | 0.7% | $250k/mo | Conversion quotes, sub-org keys |
| Scale | 0.5% | $2.5M/mo | Dedicated oracle slot, 99.95% SLA |
| Enterprise | 0.3% | Unlimited | Volume pricing, on-prem engine |

Every fee splits **60 / 25 / 15** (protocol / referrers / operations), priced
at the invoice's locked rate and rendered right on the checkout — the protocol
share is settled to the operator treasury named on every invoice. Instant
conversion adds a transparent 40 bps spread. Details:
[docs/REVENUE.md](docs/REVENUE.md).

### Which address receives the money

| Money | Address | Who controls it |
|---|---|---|
| Invoice amount (100%) | The **merchant's own wallet**, embedded non-custodially in every invoice | The merchant |
| Protocol fee share (60%) | `PAYPHONE_TREASURY_ADDRESS` — the operator's wallet, published by `GET /v1/fees/schedule` | The operator |
| Referrer share (25%) | Paid out by the operator to whoever onboarded the merchant | Referrer |
| Operations share (15%) | The operator's operating wallet (RPC, oracle, support) | Operator |

Set the treasury once — `PAYPHONE_TREASURY_ADDRESS` in the environment — and
every invoice, checkout page and fee quote names that exact address, with the
fee quantity priced at the invoice's locked rate.

## PayPhone Wallet — non-custodial, phone-number-first

The app ships a real self-custodial wallet at `#/wallet` — the first wallet
where you pay a **phone number**:

- **Keys never leave the browser.** BIP-39 mnemonic generated locally
  (MetaMask-compatible path m/44'/60'/0'/0/0 — import or export both ways),
  encrypted with your passphrase (PBKDF2-SHA256 310k rounds + AES-GCM-256) in
  localStorage. The engine has no field to receive a key: PayPhone cannot
  freeze, seize, or lose what it never holds.
- **Receives from anywhere, sends anywhere.** Standard addresses on seven EVM
  mainnets — Worldchain, Base, OP Mainnet, Polygon, Arbitrum, BNB Chain and
  Avalanche. Exchange withdrawals land straight into it; funds can be sent to
  any exchange or external wallet, same as any normal address.
- **The closed loop (the moat).** Transfers to a PayPhone phone number resolve
  through the public, rate-limited `POST /v1/identity/lookup` and settle with
  **zero protocol fee**. Transfers to an external `0x…` address carry a
  transparent **0.5% protocol fee, settled on-chain as its own transaction to
  the operator treasury** — two transfers, two hashes, shown before signing.
  Every internal send makes the network stickier; every external send pays
  the rails.
- **Honest limits.** A browser hot wallet (convenient, not hardware-grade);
  EVM-only in v1 (BTC/SOL/TRON signing stacks pending); a lost passphrase AND
  lost phrase means lost funds — by design, for everyone. The external-send
  fee is enforced by the wallet UI, not yet by an on-chain contract;
  invoice-path fees ARE engine-enforced (`fee_tx`). Full security model:
  [docs/WALLET.md](docs/WALLET.md).
- **The safety net — three ways back in.** Built for the people who lose
  things: (1) the **recovery checkpoint** — the phrase is shown once, then a
  word-quiz proves it was written down before the wallet opens; (2) the
  **encrypted backup file** — one click downloads the passphrase-encrypted
  keystore for Google Drive / iCloud, restorable from the Import tab; (3)
  **Guardian recovery** — a zero-knowledge envelope on the engine: the secret
  is re-encrypted in-browser under a separate recovery passphrase and
  uploaded with the phone number and a setup-time recovery code
  (`POST /v1/wallet/recovery/register`). A wiped browser restores with
  phone + code + recovery passphrase (`POST /v1/wallet/recovery/claim`) —
  the engine stores ciphertext it can never decrypt, so non-custodial stays
  non-custodial.

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

**Dual-licensed — pick the one that fits your use:**

- **[GNU AGPL-3.0](LICENSE)** — the default. Run it, study it, fork it, accept
  payments with it. If you *modify* it and offer it as a service, you must
  offer your users the source (AGPL §13 — the clause that keeps SaaS clones
  honest). This guarantees the network core stays open **forever**; no one can
  ever close a fork.
- **[Commercial license](COMMERCIAL-LICENSE.md)** — for running modified or
  white-labeled PayPhone without the AGPL source-disclosure duty, with support
  and legal comfort. From $290/year — this is how the network funds itself
  without taxing openness.

The [TypeScript](sdks/typescript) and [Python](sdks/python) SDKs are MIT, so
integrating against a PayPhone node never creates copyleft obligations for
your own product.
