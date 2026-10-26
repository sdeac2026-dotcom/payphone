# Deploying PayPhone

The stack is three processes and a domain. No database, no queue, no
migrations. This runbook takes you from repo to live payment network.

## 0. One-container deploy — Railway / Render (fastest path to real payments)

The repo ships a production image definition (`Dockerfile`) that runs all
three processes in one container with **exactly one public port** (the web
console; the engine and oracle stay on loopback inside the container).
`railway.json` and `render.yaml` prewire the platform so this is a
point-and-click deploy.

### Railway (recommended — always-on from the first minute)

1. Push the repo to GitHub, then open
   [railway.com/new](https://railway.com/new) → **Deploy from GitHub repo**
   → pick `payphone`. Railway reads `railway.json` (Dockerfile build,
   `/api/health` healthcheck, restart-on-failure).
2. In **Variables**, add:

   | Variable | Value |
   |---|---|
   | `PAYPHONE_ENV` | `production` |
   | `PAYPHONE_MASTER_KEY` | `openssl rand -hex 32` |
   | `PAYPHONE_SIGNING_KEY` | `openssl rand -hex 32` |
   | `PAYPHONE_PHONE_PEPPER` | `openssl rand -hex 32` |
   | `PAYPHONE_ADMIN_TOKEN` | `openssl rand -hex 24` |
   | `PAYPHONE_CHECKOUT_URL` | `https://<your-service>.up.railway.app` (set after the first deploy) |
   | `PAYPHONE_CORS_ORIGINS` | `https://<your-service>.up.railway.app` |

3. **Settings → Networking → Generate Domain** → your public URL. Every
   payment link the engine mints now points at this domain
   (`PAYPHONE_CHECKOUT_URL`), and hosted checkout pages are served by the
   same deployment.
4. Deploy → watch the build (first build compiles the Rust engine, ~5–8 min;
   subsequent builds reuse the cargo cache mount).

### Render (alternative — use the paid plan for payments)

Render's free plan sleeps after 15 idle minutes — unacceptable for a
checkout link. `render.yaml` pins `plan: starter` and generates all four
secrets at apply time:

1. Render Dashboard → **New → Blueprint** → point at the repo → **Apply**.
2. After the first deploy, set `PAYPHONE_CHECKOUT_URL` +
   `PAYPHONE_CORS_ORIGINS` to your service URL (`https://payphone.onrender.com`
   or a custom domain) → **Manual Deploy** to apply.

### First real-money run (both platforms)

1. Open the dashboard → **Create your merchant account**. The deployment is
   admin-gated: paste your `PAYPHONE_ADMIN_TOKEN` once when prompted — it is
   remembered in your browser and sent as `X-Admin-Token` on key issuance.
2. Enter your real wallet address (the one that must receive funds —
   settlement is non-custodial, funds never touch PayPhone).
3. Create an invoice in a **real asset** (USDC on Base, ETH, BTC, SOL, …),
   share the hosted checkout link, pay a small real amount from any wallet,
   watch the invoice flip to **paid** with an on-chain receipt.
4. Verify `GET /api/health` → `{"web":true,"engine":true,"oracle":true}` and
   `GET /api/v1/chains` → every network `rpc_live: true`.

All seven EVM mainnets + Bitcoin + Solana + Tron ship enabled on public RPC
endpoints — zero extra config to start. For production volume, override
`EVM_RPC_*` / `SOL_RPC_URL` / `TRON_API_BASE` with indexed providers
(Alchemy, QuickNode, Helius); see the matrix below.

### Other Docker hosts

```bash
docker build -t payphone .
docker run -p 8080:8080 --env-file .env \
  -e PORT=8080 \
  -e PAYPHONE_ENV=production \
  -e PAYPHONE_MASTER_KEY=$(openssl rand -hex 32) \
  -e PAYPHONE_SIGNING_KEY=$(openssl rand -hex 32) \
  -e PAYPHONE_PHONE_PEPPER=$(openssl rand -hex 32) \
  -e PAYPHONE_ADMIN_TOKEN=$(openssl rand -hex 24) \
  -e PAYPHONE_CHECKOUT_URL=https://pay.yourdomain.com \
  payphone
```

Fly.io, Coolify, Dokku, any VPS with Docker — same image, same envs.

## 1. Build

```bash
# engine (release, static-ish binary)
cd engine && cargo build --release
# → engine/target/release/payphone-engine

# web console (standalone output, ~110 MB RSS at runtime)
bunx next build
cp -r .next/static .next/standalone/.next/
cp -r public .next/standalone/

# oracle
cd services/oracle-py && pip install -r requirements.txt
```

## 2. Environment matrix

### Engine (secrets → KMS, never in files)

| Variable | Required | Purpose |
|---|---|---|
| `PAYPHONE_ENV` | **prod: `production`** | Fail-closed mode: refuses to boot without real keys, SimNet off by default |
| `PAYPHONE_MASTER_KEY` | **yes** | Root of all merchant key derivation |
| `PAYPHONE_SIGNING_KEY` | **yes** | Invoice token + webhook signatures |
| `PAYPHONE_PHONE_PEPPER` | **yes** | Phone-hash privacy |
| `PAYPHONE_SIMNET` | prod: `0` | Disable the demo chain |
| `EVM_RPC_BASE` / `_ETHEREUM` / `_ARBITRUM` / `_POLYGON` / `_OPTIMISM` / `_BSC` / `_AVALANCHE` | optional | Override the default **public mainnet** RPC per network. All seven EVM mainnets work out of the box on public endpoints (rate-limited); use indexed providers (Alchemy, QuickNode, PublicNode) for production volume. Legacy `EVM_RPC_MAINNET` aliases to ethereum. |
| `BTC_API_BASE` | optional | Esplora API for Bitcoin watch-only settlement. Default `https://blockstream.info/api` (confirmed-balance deltas + explorer receipts). Any Esplora-compatible host works; mempool.space mirrors are drop-in. |
| `SOL_RPC_URL` | optional | Solana JSON-RPC for SOL / SPL (USDC) watch-only settlement. Default `https://api.mainnet-beta.solana.com` (aggressively rate-limited — use Helius/QuickNode for volume). |
| `TRON_API_BASE` | optional | TronGrid base for TRX / TRC-20 (USDT) watch-only settlement. Default `https://api.trongrid.io`; free tier throttles deep pagination — TronPro lifts it. |
| `PAYPHONE_CHECKOUT_URL` | recommended | Public origin for payment links (e.g. `https://pay.yourdomain.com`) |
| `PAYPHONE_ORACLE_URL` | recommended | e.g. `http://127.0.0.1:8001` |
| `PAYPHONE_ADMIN_TOKEN` | prod | Gates `POST /v1/keys` |
| `PAYPHONE_REVOKED_KEYS` | as needed | Comma-separated `key_id`s — instant revocation of leaked merchant keys |
| `PAYPHONE_CORS_ORIGINS` | prod | Comma list; never `*` in prod |
| `PAYPHONE_PORT` | no | Default 8080 |
| `PAYPHONE_INVOICE_TTL` | no | Default 900 s |

### Web

| Variable | Purpose |
|---|---|
| `PAYPHONE_ENGINE_URL` | Engine address the gateway proxies to (default `http://127.0.0.1:8080`) |
| `PORT` | Standalone server port (default 3000) |

### Oracle

| Variable | Purpose |
|---|---|
| `ORACLE_PORT` | Default 8001 |
| `ORACLE_CACHE_TTL` | Price cache seconds (default 30) |
| `ORACLE_SPREAD_BPS` | Conversion spread (default 40) |

## 3. Run (systemd units)

```ini
# /etc/systemd/system/payphone-engine.service
[Unit]
Description=PayPhone Engine
After=network-online.target

[Service]
EnvironmentFile=/etc/payphone/engine.env
ExecStart=/opt/payphone/engine/target/release/payphone-engine
Restart=always
User=payphone
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/payphone   # only needed for SimNet (dev)

[Install]
WantedBy=multi-user.target
```

Mirror for `payphone-web` (`bun .next/standalone/server.js`) and
`payphone-oracle` (`uvicorn main:app`). One restart policy, three units,
zero state to babysit.

## 4. TLS edge

Caddy example:

```caddy
pay.yourdomain.com {
    route /api/* {
        reverse_proxy 127.0.0.1:3000
    }
    reverse_proxy 127.0.0.1:3000
}

engine.yourdomain.com {
    @internal not remote_ip 10.0.0.0/8
    respond @internal 403
    reverse_proxy 127.0.0.1:8080
}
```

Keep the engine private (VPN / private subnet) — merchants talk to it
through the web gateway or your own edge. Set
`PAYPHONE_CHECKOUT_URL=https://pay.yourdomain.com` so payment links carry
the public origin (the engine also honors `X-Forwarded-Host`/`-Proto`).

## 5. Go-live checklist

- [ ] `PAYPHONE_ENV=production` set (fail-closed: engine refuses to boot misconfigured)
- [ ] Master/signing keys + pepper generated with `openssl rand -hex 32`,
      stored in KMS, never in git
- [ ] `PAYPHONE_SIMNET=0`; all chains live (7 EVM mainnets + Bitcoin/Solana/Tron ship enabled on public defaults — verify `GET /v1/chains` shows `rpc_live: true` and `chain_id_matches: true`, then point `EVM_RPC_*` / `BTC_API_BASE` / `SOL_RPC_URL` / `TRON_API_BASE` at your providers)
- [ ] `PAYPHONE_ADMIN_TOKEN` set; key issuance behind it
- [ ] `PAYPHONE_CORS_ORIGINS` locked to your console origin
- [ ] Webhook endpoints verified with `POST /v1/webhooks/test` + SDK check
- [ ] Small real-value invoice paid end-to-end; receipt visible on-chain
- [ ] Rate limits reviewed at your edge (engine default: 240/min/key)
- [ ] Backups: none needed for the engine (stateless!) — but export the
      KMS key policy and note the master key's rotation date
- [ ] Monitoring: probe `/health` (engine), `/api/health` (web), `/health`
      (oracle); alert on `oracle_source: static` and `demo_mode: true`

## 6. Scaling notes

- Engine replicas share nothing — add instances behind the LB.
- Observation volume: point `EVM_RPC_*` at indexed providers (Alchemy,
  QuickNode); their webhook products can drive the same emit path later.
- Oracle is stateless; run N and load-balance.
- The FeeVault makes protocol revenue auditable without internal tooling.
