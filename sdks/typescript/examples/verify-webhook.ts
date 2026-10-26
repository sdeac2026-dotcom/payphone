/**
 * Example: verify a PayPhone webhook with Express.
 * Run: PAYPHONE_WEBHOOK_SECRET=… node examples/verify-webhook.ts
 */
import express from "express";
import { PayPhone } from "../src/index.ts";

const app = express();

app.post("/payphone/webhook", express.raw({ type: "*/*" }), (req, res) => {
  const { valid, event, reason } = PayPhone.verifyWebhook(
    req.body,
    req.headers,
    process.env.PAYPHONE_WEBHOOK_SECRET ?? ""
  );

  if (!valid) {
    console.warn("rejected webhook:", reason);
    return res.sendStatus(400);
  }

  switch (event?.type) {
    case "invoice.paid":
      console.log("invoice paid →", event.data.invoice_id, "→ fulfill order");
      break;
    case "invoice.underpaid":
      console.log("invoice underpaid →", event.data);
      break;
    case "invoice.expired":
      console.log("invoice expired →", event.data.invoice_id);
      break;
    default:
      console.log("event:", event?.type);
  }
  res.sendStatus(200);
});

app.listen(3001, () => console.log("webhook receiver on :3001 — point the engine here"));
