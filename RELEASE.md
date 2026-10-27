# PayPhone — Release Package

Production-ready source for the PayPhone crypto payment network.

## Layout
- `engine/`         Rust settlement engine (axum). Build: `cargo build --release`
- `src/`            Next.js merchant console + hosted checkout
- `services/oracle-py/`  Python pricing oracle (CoinGecko + CoinCap aggregation)
- `contracts/`      Solidity: PaymentRouter, PhoneRegistry, FeeVault
- `sdks/`           TypeScript + Python merchant SDKs
- `docs/`           API.md, DEPLOYMENT.md, REVENUE.md, SECURITY.md
- `scripts/`        Ops supervision (keeper.sh) + full test suites + registry tooling

## Quick start
1. `cd engine && cargo build --release`
2. `PAYPHONE_MASTER_KEY=<64-hex> PAYPHONE_ORACLE_URL=http://127.0.0.1:8001 ./target/release/payphone-engine`
3. `cd services/oracle-py && pip install -r requirements.txt && uvicorn main:app --port 8001`
4. `bun install && bun run build && bun run start`   # merchant console
5. Verify: `python3 scripts/integration_test.py && python3 scripts/invoice_matrix_test.py`

## Security gates before going live
- Set `PAYPHONE_MASTER_KEY` (engine refuses invoice signing without it in production mode)
- See docs/SECURITY.md (phishing/scam hardening) and docs/DEPLOYMENT.md (domain, TLS, mainnet)
