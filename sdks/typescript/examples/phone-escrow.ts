/**
 * Example: phone-number payment with claim escrow.
 * Pay someone whose number isn't registered yet — funds wait in escrow
 * until they register a wallet and claim with the code.
 */
import { PayPhone } from "../src/index.ts";

const pp = new PayPhone({
  baseUrl: process.env.PAYPHONE_URL ?? "http://127.0.0.1:8080",
  publicKey: process.env.PAYPHONE_PK!,
  secretKey: process.env.PAYPHONE_SK!,
});

const phone = "+1 555 010 9999";

// Does the number have a payout wallet?
const id = await pp.identity.resolve(phone);
console.log("payphone id:", id.payphone_id, "| registered:", id.registered);

if (!id.registered) {
  // Lock funds behind a claim code (delivered via SMS in production).
  const esc = await pp.identity.escrow(phone, 1500);
  console.log("escrow:", esc.escrow_id, "| claim code (demo):", esc.claim_code);

  // …recipient registers their wallet, then claims…
  await pp.identity.register(phone, "PP" + "c".repeat(40));
  const claim = await pp.identity.claim(esc.escrow_id, phone, esc.claim_code);
  console.log("released:", claim.released_amount_usd_cents, "cents →", claim.wallet);
} else {
  console.log("route payment to:", id.wallet);
}
