# PayPhone Security Model

## Threat model & mitigations

### Credentials
- **No key storage.** Merchant secrets are `sk = HMAC(master, pk)` — the
  engine re-derives at request time. A leaked database (if you add one)
  contains no credentials.
- **Master key** (`PAYPHONE_MASTER_KEY`) must live in a KMS/HSM. It derives
  the signing key and phone pepper too (purpose-separated subkeys).
- **Rotation** = issue a new key, drop the old. **Revocation** =
  `PAYPHONE_REVOKED_KEYS` denylist (config-level).
- The demo console stores `sk` in localStorage for convenience — clearly
  labeled as demo-only. Real integrations are server-to-server.

### Request authentication
- `hex(HMAC-SHA256(sk, "{ts}.{METHOD}.{path}.{sha256(body)}"))` with a
  ±300 s timestamp window — replay-proof without nonce storage.
- HMAC `verify_slice` compares in constant time.
- Canonical strings include the raw body hash → the signature covers the
  exact bytes; proxies must forward bodies byte-exact (the Next.js gateway
  does).

### Invoice integrity
- Tokens are `base64url(json) . base64url(HMAC(signing_key))`; any payload
  edit invalidates the signature (unit-tested).
- Tokens travel in the **URL fragment** — browsers never transmit fragments,
  so tokens cannot appear in access logs, referrer headers, or proxies.
- Description text is SHA-256 hashed into the token — no PII in signed data.
- TTL (default 900 s) bounds rate-lock exposure; expiry is enforced in
  status resolution.

### Phone identity & privacy
- Raw numbers are normalized in memory and immediately reduced to
  `HMAC(pepper, E164)`. Nothing else is logged or persisted.
- The per-deployment pepper defeats offline rainbow attacks on common
  numbers. Rotation blinds lookups (re-registration required) — acceptable
  under compromise.
- Claim codes: 6 digits, stored **only as SHA-256** in the journal.
  Production delivers codes via SMS; demo mode returns them inline with an
  explicit banner.
- Rate limits + single-use claims blunt code-guessing; production adds an
  SMS-provider-side attempt cap.

### Custody
- The engine holds **no private keys** — by design there is nothing to
  steal. On all five shipped mainnets (Base, Ethereum, Arbitrum, Polygon,
  Optimism) payments go **directly to the merchant's own wallet**; the
  engine is a watch-only verifier: it reads `Transfer` logs addressed to
  the merchant and emits signed receipts (tx hash + block + explorer link).
- A payment counts only after the network's confirmation depth (6–30
  blocks by network, see `GET /v1/chains`) — unconfirmed transfers keep
  the invoice `pending`, never falsely `paid`.
- ERC-20 observation is log-based and exact: `observed_qty` equals the sum
  of confirmed `Transfer` events to the invoice address since the
  invoice's birth block (verified byte-for-byte against independent RPC
  recounts in `scripts/mainnet_test.py`).
- Addresses on shared merchant wallets are summed across all inbound
  transfers in the window; for strict per-invoice isolation, generate a
  unique receiving address per invoice (or deploy the PaymentRouter
  contract, which derives per-invoice escrow addresses).
- SimNet is a **simulator**: never route real funds through it. It exists
  for development, CI and the hosted demo.

### Webhooks
- `hex(HMAC(secret, "{ts}.{raw_body}"))`, tolerance-checked timestamp,
  constant-time compare (SDKs), 3 retries. Verify before acting — the SDKs
  make it one call.

### Infrastructure
- Token-bucket rate limiting per key (240/min, burst 120).
- CORS is configurable (`PAYPHONE_CORS_ORIGINS`); default `*` is dev-only.
- Amounts are integers in minor units everywhere — floats are forbidden.
- Journal integrity: SimNet re-verifies every hash link on boot; tampering
  is structurally detectable (unit-tested).

### Fail-closed production startup
- `PAYPHONE_ENV=production` changes boot behavior: without a real
  `PAYPHONE_MASTER_KEY` the engine **refuses to start** (exit 1) instead of
  serving traffic with publicly-known development keys.
- In production SimNet is **off by default** (explicit opt-in only), and the
  banner warns about wide-open CORS or missing EVM RPCs.

## Anti-phishing & anti-scam design

Phishing works when there are credentials worth stealing and a lookalike page
to steal them on. PayPhone removes both primitives by construction:

**1. There are no payer accounts to phish.**
Payers never sign up, never log in, and never hold a balance on PayPhone.
They pay from their own wallet (MetaMask, Phantom, exchanges…) directly to
the merchant's address. A fake "PayPhone login page" has nothing to harvest —
there is no password, seed phrase, or balance that PayPhone ever sees. If any
site or message asks a user for a **seed phrase or private key "to receive a
PayPhone payment", it is a scam, full stop** — the protocol never needs them.

**2. There is no pooled honeypot to hack.**
The engine is **non-custodial**: it holds no private keys and no user funds.
Merchants are paid directly to their own wallets. A full compromise of the
platform cannot move anyone's money — at worst it can mint fraudulent
invoices, which merchants detect via their own webhook verification and
on-chain receipts.

**3. Phone numbers cannot be scraped from us.**
Numbers are normalized in memory, then immediately reduced to
`HMAC(pepper, E164)`; the plaintext is never persisted, logged, or shown.
There is no directory to dump and no list to smish. A registered number maps
to a PayPhone ID (`ph_…`), never to a raw number, in every API response.

**4. Payment links are tamper-evident.**
Every hosted checkout URL carries an HMAC-signed token in the **URL
fragment** (never transmitted to any server). Editing amount, asset, or
destination address in the URL invalidates the signature and the checkout
refuses to render it. Rate-locked quantity (`qte`) is sealed inside the token,
so a man-in-the-middle cannot quietly change what the payer sees vs what the
merchant expects.

**5. Verifiable merchant identity on every checkout.**
The hosted checkout displays the merchant public key
(`pk_{tier}_{key_id}`) and order reference. Merchants should publish their
`pk` (e.g. in the site footer); a payer can compare the checkout's key with
the merchant's published key before paying. A lookalike site cannot mint a
matching key — the pk is bound to the platform master key.

**6. Scam-containment for escrow claims.**
Pay-by-phone escrows release only with a 6-digit single-use claim code,
stored server-side **only as SHA-256**, delivered out-of-band (SMS in
production), rate-limited per number, and single-use by construction
(unit-tested). An attacker who learns only a phone number gets nothing.

**7. Webhook trust for merchants.**
Engine events are signed `hex(HMAC(signing_key, "{ts}.{body}"))` with a
timestamp tolerance and constant-time compare in both SDKs. Merchants ignore
unsigned or stale webhooks → fake "payment received" callbacks don't work.

**Operator anti-abuse checklist**
- [ ] Publish your `pk_…` where payers can find it; teach them to check it.
- [ ] Never ask any user for seed phrases or private keys. Say it publicly.
- [ ] Set `PAYPHONE_ADMIN_TOKEN` so only your back office can issue keys.
- [ ] Revoke a leaked merchant key instantly via `PAYPHONE_REVOKED_KEYS`.
- [ ] Keep `PAYPHONE_ENV=production` so dev keys can never silently serve.
- [ ] Verify every webhook with the SDK before fulfilling orders.

## Known limitations (v1) — honest list
- Poll-driven webhook emission (transitions detected on status reads).
  The emit path is production-ready; the background watcher is the next step.
- EVM observation is balance-delta based; concurrent invoices to one address
  require unique amounts or the PaymentRouter contract. HD per-invoice
  derivation is on the roadmap.
- SimNet claim codes are returned inline in demo mode (labeled) instead of
  being delivered via SMS.
- Rate limits are per-instance; global limits belong at the edge until
  on-chain metering ships.

## Reporting
Email security@your-domain or open a private GitHub security advisory. We
disclose fixes in release notes.
