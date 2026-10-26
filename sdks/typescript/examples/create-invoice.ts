/**
 * Example: create an invoice and print the hosted checkout URL.
 * Run:  PAYPHONE_PK=pk_… PAYPHONE_SK=sk_… bun run examples/create-invoice.ts
 */
import { PayPhone } from "../src/index.ts";

const pp = new PayPhone({
  baseUrl: process.env.PAYPHONE_URL ?? "http://127.0.0.1:8080",
  publicKey: process.env.PAYPHONE_PK!,
  secretKey: process.env.PAYPHONE_SK!,
});

const invoice = await pp.invoices.create({
  amount_usd_cents: 2500,
  asset: "USDC",
  chain: "simnet",
  network: "simnet",
  wallet: process.env.PP_WALLET ?? "PP" + "0".repeat(40),
  description: "Pro plan — monthly",
});

console.log("invoice id :", invoice.invoice.id);
console.log("pay        :", invoice.asset_amount, invoice.invoice.asset);
console.log("fee        :", invoice.fee.fee_total_minor, "cents →",
  invoice.fee.split);
console.log("checkout   :", invoice.payment_url);
