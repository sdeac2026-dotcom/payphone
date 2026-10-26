# @payphone/sdk (TypeScript)

Thin, zero-dependency client for the PayPhone Engine. Node 18+ (native
fetch + webcrypto) and edge runtimes.

## Install

```bash
# from the monorepo
import { PayPhone } from "./sdks/typescript/src/index.ts";

# when published
npm install @payphone/sdk
```

## Quickstart

```ts
import { PayPhone } from "@payphone/sdk";

const pp = new PayPhone({
  baseUrl: "https://api.payphone.example",
  publicKey: process.env.PAYPHONE_PK!,   // pk_growth_…
  secretKey: process.env.PAYPHONE_SK!,   // sk_growth_…  (keep server-side!)
});

// 1. Create an invoice — rate-locked, stateless, non-custodial
const inv = await pp.invoices.create({
  amount_usd_cents: 2500,
  asset: "USDC",
  chain: "simnet",          // "evm" in production
  network: "simnet",        // "base" | "mainnet" | …
  wallet: "0xYourWallet",   // your receiving address
  description: "Pro plan — monthly",
});

console.log(inv.payment_url);   // share this — token rides in the fragment
console.log(inv.fee);           // transparent fee split

// 2. Poll status (or rely on webhooks)
const status = await pp.invoices.get(inv.invoice.id, inv.token);
console.log(status.invoice.status);  // pending | paid | underpaid | expired
```

## Phone payments

```ts
// Pay someone by phone number
const id = await pp.identity.resolve("+1 555 010 1234");
if (id.registered) {
  // send directly to id.wallet via your own wallet/router
} else {
  const esc = await pp.identity.escrow("+1 555 010 1234", 1500);
  // deliver esc.claim_code to the recipient (SMS in production)
  // they register a wallet, then claim:
  await pp.identity.claim(esc.escrow_id, "+1 555 010 1234", esc.claim_code);
}
```

## Webhook verification (Express example)

```ts
app.post("/payphone/webhook", express.raw({ type: "*/*" }), (req, res) => {
  const { valid, event } = PayPhone.verifyWebhook(req.body, req.headers, process.env.PAYPHONE_WEBHOOK_SECRET!);
  if (!valid) return res.sendStatus(400);
  if (event?.type === "invoice.paid") fulfillOrder(event.data.invoice_id as string);
  res.sendStatus(200);
});
```

See `examples/` for complete runnable scripts.
