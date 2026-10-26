# PayPhone API Reference (v1)

Base URL: `http://localhost:8080` (engine). Every response is
`{ "data": … }` or `{ "error": { "type", "message", "code" } }`.

## Authentication

Signed headers on every authenticated call:

```text
X-PayPhone-Key:       pk_{tier}_{key_id}
X-PayPhone-Timestamp: unix seconds (±300s window)
X-PayPhone-Signature: hex(HMAC_SHA256(sk, "{ts}.{METHOD}.{path}.{sha256_hex(raw_body)}"))
```

For GET requests, hash the empty string. Path in the canonical string is the
ENGINE path (starts with `/v1`). All amounts are integer minor units —
floats are forbidden.

## Endpoints

### Health
| | |
|---|---|
| `GET /health` | Liveness + capabilities: version, uptime, demo_mode, simnet stats, registered mainnet networks, oracle source, supported assets, rate limit. |

### Chains (multi-network capability sheet)
| | |
|---|---|
| `GET /v1/chains` | Every settleable venue with a **live liveness probe**: 7 real EVM mainnets — `base` (8453), `ethereum` (1), `arbitrum` (42161), `polygon` (137), `optimism` (10), `bsc` (56), `avalanche` (43114) — each with verified chain id, settleable tokens (real contract addresses + per-network decimals), confirmation depth and explorer prefix; plus 3 watch-only non-EVM mainnets — `bitcoin` (Esplora), `solana` (JSON-RPC), `tron` (TronGrid) — and `simnet` (demo) when enabled. |

### Assets (invoice-able catalog — drives asset-first invoicing)
| | |
|---|---|
| `GET /v1/assets` | Every asset the engine can price (57 today), each with `default_chain` + `default_network` (the venue used when an invoice omits routing), `decimals` on the default network, `settleable` flag and the full `settleable_networks[]` list. 37 assets settle today across the 10 real chains; the rest (XRP, DOGE, ADA, TON…) are priced for quotes with settlement on the roadmap. |

### Keys
| | |
|---|---|
| `POST /v1/keys` `{tier}` | Issue a merchant credential. Secret returned **once**. Production: set `PAYPHONE_ADMIN_TOKEN` and send `X-Admin-Token`. |

### Invoices
| | |
|---|---|
| `POST /v1/invoices` (auth) | Create. **Asset-first**: body is `amount_usd_cents` (1…10¹³), `asset` (any catalog symbol — `BTC`, `SOL`, `TRX`, `USDC`, `LINK`, `PEPE`… see `GET /v1/assets`), `wallet` (your receiving address on that chain), and *optionally* `chain` + `network`. **When `chain` is omitted the engine auto-routes through the asset catalog** (`BTC`→bitcoin/mainnet, `SOL`→solana/mainnet, `TRX`→tron/mainnet, `USDC`→evm/base, `ARB`→evm/arbitrum, `PEPE`→evm/bsc…). Explicit `chain`: `evm`\|`bitcoin`\|`solana`\|`tron`\|`simnet`; `network` defaults per chain (`base` for EVM, `mainnet` elsewhere; legacy `mainnet` alias on EVM → `ethereum`). Multi-chain assets can pin any network from their `settleable_networks` (e.g. `USDT` on `tron` settles TRC-20, on `bsc` at 6dp via the verified Tether contract, on `base`…). Token contracts (ERC-20 / SPL mint / TRC-20) resolve automatically from the registry. Optional: `token_address?` (custom contract; decimals must be registered), `description?` (hashed into token), `ttl_secs?` (60–86400, default 900), `webhook_url?`. Returns invoice + `token` + `payment_url` + `asset_amount` (rate-locked at the chain's own precision) + `fee` breakdown + `birth_block`. Addresses are validated **cryptographically** at creation (base58check for BTC/TRON, bech32/bech32m for SegWit/taproot, 32-byte pubkey for Solana) — a typo'd address is rejected, not paid to the void. |
| `GET /v1/invoices/:id?token=` | Live status observed **from the chain**: `pending` \| `paid` \| `underpaid` \| `expired`, `observed_qty`, `receipts[]`, `remaining_qty`, fee breakdown. Emits webhooks on transitions. Quantities (`qte`, `base_qty`, `observed_qty`, `remaining_qty`) travel as **decimal strings** — 18-decimal stablecoins exceed u64/JS-safe integers. EVM receipts are real on-chain transfers: `tx_hash`, `block`, `qty`, `confirmations`, `required_confirmations`, `confirmed`, `explorer_url`; TRON receipts carry real tx ids from confirmed TRC-20 transfers; Bitcoin receipts link blockstream explorer txs. A payment counts toward `observed_qty` only after the network's confirmation depth. |

### Rates & conversion
| | |
|---|---|
| `GET /v1/rates?assets=BTC,ETH,USDC` | Aggregated USD prices with `source` and `stale` flags. |
| `GET /v1/quote?amount_usd_cents=&asset=&spread_bps?=40` | Conversion quote; spread is a revenue line, returned transparently. |

### Fees (public revenue model)
| | |
|---|---|
| `GET /v1/fees/schedule` | All tiers (bps, included volume, features) + 60/25/15 split. |
| `GET /v1/fees/quote?amount_usd_cents=&tier=` | Exact breakdown for an amount. |

### Phone identity
| | |
|---|---|
| `POST /v1/identity/resolve` (auth) `{phone, default_country?}` | E.164 normalize → salted hash → `{payphone_id, phone_hash, masked_phone, registered, wallet?}`. Raw numbers never logged/stored. |
| `POST /v1/identity/register` (auth) `{phone, wallet}` | Bind hash → payout wallet. |
| `POST /v1/identity/escrow` (auth) `{phone, amount_usd_cents}` | Lock funds for an unregistered number. Returns `escrow_id` + `claim_code` (demo: inline; production: delivered via SMS; journal stores only its SHA-256). |
| `POST /v1/identity/claim` `{escrow_id, phone, code}` | Verify code → release to the registered wallet. Single-use. |

### Webhooks
| | |
|---|---|
| `POST /v1/webhooks/test` (auth) `{url, event?}` | Send a signed test event; returns payload, headers, delivery result. |
| `POST /v1/webhooks/verify` `{secret, timestamp, signature, payload}` | Teach-by-doing verification endpoint. |

Delivery headers: `X-PayPhone-Event`, `X-PayPhone-Timestamp`,
`X-PayPhone-Signature: hex(HMAC(secret, "{ts}.{raw_body}"))`. Events:
`invoice.paid`, `invoice.underpaid`, `invoice.expired`. Retries: 3 (1s/3s).

### SimNet (development chain — disabled with `PAYPHONE_SIMNET=0`)
| | |
|---|---|
| `GET /v1/simnet/blocks?limit=` | Explorer feed: hash-chained blocks + stats. |
| `POST /v1/simnet/pay` `{to, asset, amount_minor, invoice_id?, from?}` | Inject a payment (the "demo wallet"). |
| `GET /v1/simnet/balance/:address` | Lifetime received by an address. |

## Errors

| HTTP | type | meaning |
|---|---|---|
| 400 | `bad_request` | Malformed input |
| 401 | `invalid_signature` | Signature mismatch / stale timestamp |
| 401 | `missing_credentials` | Signed headers absent |
| 403 | `forbidden` | Admin-gated action |
| 404 | `not_found` | Unknown route or escrow |
| 429 | `rate_limited` | Token bucket exhausted |
| 502 | `upstream_unavailable` | Chain RPC / oracle failure |
| 503 | `unavailable` / `engine_offline` | Capability disabled / engine down |

## Rate limits

Token bucket per API key: 240 requests/min, burst 120. Scale globally at
your edge, or wait for on-chain metering in the FeeVault.
