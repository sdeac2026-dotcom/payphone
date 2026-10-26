# Contributing to PayPhone

PayPhone is MIT-licensed and built to be extended. This document gets you
from clone to first PR.

## What needs building (good first issues)

| Area | Task | Difficulty |
|---|---|---|
| `engine/src/chains/` | Solana / Tron / Bitcoin watch adapters (EVM adapter is the reference) | Medium |
| `engine/src/chains/evm.rs` | HD per-invoice address derivation (xpub) for direct mode | Medium |
| `engine/src/webhooks.rs` | Background watcher loop + dead-letter queue for deliveries | Medium |
| `contracts/` | ERC-20 escrow path in `PaymentRouter` (USDC settlement) | Medium |
| `contracts/` | OTP-commitment on-chain claims (v2 of the escrow flow) | Hard |
| `src/` | i18n of the console, mobile checkout polish | Easy |
| `services/oracle-py/` | More price sources + a currency-priority feed for emerging markets | Easy |
| `docs/` | Chain-integration guides, translation | Easy |

## Development setup

```bash
git clone https://github.com/your-org/payphone && cd payphone
cargo build --release                 # engine (Rust 1.75+)
bun install                           # web console deps
cd services/oracle-py && pip install -r requirements.txt

# run the stack
./scripts/supervise.sh &              # engine :8080 + oracle :8001 + web :3000
cd engine && cargo test               # unit tests (15)
python3 scripts/integration_test.py   # end-to-end lifecycle (19 checks)
```

## Ground rules

1. **Statelessness is the contract.** Don't add databases, sessions or
   server-side caches to the engine. If you need state, it belongs on the
   chain, in the signed token, or in a TTL map with a documented TTL.
2. **Integer minor units only.** Floats near money are a bug.
3. **No raw phone numbers, ever** — hash them at the boundary
   (`engine/src/phone.rs`).
4. **Every new endpoint**: error envelope, rate limit, auth decision
   documented in `docs/API.md`, plus a test.
5. **Honest docs.** If something is a demo shim or a limitation, say so in
   the code comment and the docs (see the v1 limitations list in
   `docs/SECURITY.md` — keep it current).
6. **SimNet stays a simulator.** It must never be the path for real funds.

## Pull requests

- Small, focused PRs with a clear description of the *why*.
- `cargo test` + `bun run lint` + `python3 scripts/integration_test.py` green.
- New features need at least one integration test exercising the happy path
  and one rejection path.
- Security-relevant changes: threat-model notes in the PR description.

## Reporting vulnerabilities

Private GitHub security advisory, or security@your-domain. We credit
reporters in release notes (opt-in).
