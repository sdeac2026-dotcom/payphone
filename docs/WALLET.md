# PayPhone Wallet — security model & honest limits

The PayPhone Wallet (`#/wallet` in the console app) is a **non-custodial,
browser-resident EVM wallet** with one differentiating ability: it pays
**phone numbers**, not just addresses.

## What it is

- A BIP-39 wallet (12-word mnemonic, standard `m/44'/60'/0'/0/0` derivation —
  the same path MetaMask, Rabby and Trust use, so imports and exports are
  interoperable in both directions). Raw private-key import is also supported.
- A transaction signer for seven EVM mainnets: **Worldchain (480)**, Base
  (8453), OP Mainnet (10), Polygon (137), Arbitrum One (42161), BNB Chain
  (56), Avalanche C-Chain (43114). Networks are enabled per engine registry;
  operators can override RPCs with `EVM_RPC_<NAME>`.
- A phone-number resolver: `+254 712 …` → salted hash → the recipient's
  registered wallet address (or their deterministic PayPhone address), via the
  public `POST /v1/identity/lookup` endpoint.

## The security model — what we promise

1. **Keys are generated locally** with the platform CSPRNG. Nothing is
   precomputed, nothing is sent to us during generation.
2. **The keystore is encrypted at rest**: PBKDF2-SHA256 (310,000 rounds)
   derives an AES-GCM-256 key from your passphrase; only ciphertext lands in
   localStorage. Changing browsers requires re-import with the phrase.
3. **Keys never leave the browser.** The engine's API has no field that
   accepts key material — the architecture makes exfiltration-by-bug
   structurally impossible, not just "against policy". Signing happens in
   memory; only signed transactions are broadcast (to public RPC endpoints,
   not to PayPhone servers).
4. **No server-side account is required.** The wallet works with zero
   registration — your passphrase is the only credential.
5. **Open-source and auditable.** The entire implementation lives in
   `src/lib/payphone/wallet.ts` — read it before trusting it, that is the
   point of shipping the source.

## The revenue engineering — how the treasury earns

| Transfer | Fee | Where it goes |
|---|---|---|
| PayPhone wallet → PayPhone phone number | **0%** — the closed loop | Recipient only |
| PayPhone wallet → external `0x…` address | **0.5%** (constant `WALLET_SEND_FEE_BPS`) | `PAYPHONE_TREASURY_ADDRESS`, on-chain |

External sends execute **two transactions**: the payment to the recipient and
the protocol fee to the treasury, both visible before signing, both verifiable
on the block explorer. Internal sends deliberately pay nothing — that is the
network effect: every user wants the other side on PayPhone.

**If no treasury is configured** (`PAYPHONE_TREASURY_ADDRESS` unset), the 0.5%
is **waived, visibly** — the checkout sheet reads "WAIVED — treasury not
configured" and no fee transaction is sent. PayPhone is non-custodial: there
is nowhere to hold a fee in escrow, so the fee is either collected on-chain to
a real destination or not charged at all. It is never shown as charged while
going nowhere. Both transactions share one nonce plan (payment = n, fee = n+1)
so the fee can never collide with or trail behind the payment in the mempool.

Invoice-path fees (checkout / API payments) are a separate, **engine-enforced**
mechanism: the engine computes `fee_qty` at the invoice's locked rate and the
`fee_tx` settlement is part of the payment protocol itself.

## Honest limits — what this wallet is NOT

- **It is a hot wallet.** A browser keystore is more convenient — and less
  safe — than a hardware wallet. For life-changing amounts, use a hardware
  signer; the PayPhone Wallet is for payments, not cold storage.
- **Recovery is impossible by design.** Lost passphrase + lost mnemonic =
  lost funds. There is no reset, no support ticket, no backdoor. We say this
  plainly because every custodial product hides it.
- **EVM only in v1.** Bitcoin, Solana and Tron use entirely different signing
  stacks; invoices on those chains still work through the normal checkout
  (scan with any wallet), just not from this embedded wallet yet.
- **The external-send fee is client-enforced, not contract-enforced.** A
  modified client could send externally without paying the 0.5%. The
  on-chain-enforced path (routing external sends through the `FeeVault` /
  `PaymentRouter` contracts already in `contracts/`) is the next milestone;
  the engine-enforced invoice fee is live today.
- **Public RPCs are rate-limited.** Fine for a demo and light use; for
  production volume, set `EVM_RPC_<NETWORK>` per chain.
- **Phone-number privacy is one-way.** Lookups reveal only what a payer
  needs: the PayPhone ID, masked phone and payment address. Raw numbers are
  never logged; the salted hash is never returned. But anyone who knows a
  number can ask for its payment address — that is the feature, and it is
  rate-limited per number.

## Wallet × checkout — the closed loop in practice

1. Merchant creates an invoice (any of the 59 assets / 11 networks).
2. On the hosted checkout, a customer with the PayPhone Wallet unlocked sees
   **"Pay with MY PayPhone Wallet"** (SimNet demo settles instantly, with the
   protocol fee landing as its own `fee_tx`) or **"Pay from my PayPhone
   Wallet (prefilled)"** on real chains — the wallet opens with recipient,
   amount, asset and network already filled.
3. The merchant's webhook fires; funds are already in the merchant's own
   wallet. Nobody intermediated.
