"use client";

/**
 * Developer docs — in-app API reference, guides and architecture notes.
 * Mirrors docs/*.md in the repository.
 */

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { CodeBlock } from "./bits";
import { SendRightNotice } from "./asset-safety";

const SECTIONS = [
  { id: "quickstart", label: "Quickstart" },
  { id: "auth", label: "Authentication" },
  { id: "invoices", label: "Invoices" },
  { id: "phone", label: "Phone identity & escrow" },
  { id: "webhooks", label: "Webhooks" },
  { id: "fees", label: "Fees & revenue" },
  { id: "chains", label: "Chains & adapters" },
  { id: "safety", label: "Asset safety" },
  { id: "oracle", label: "Oracle service" },
  { id: "sdks", label: "SDKs" },
  { id: "errors", label: "Errors & rate limits" },
  { id: "deploy", label: "Self-hosting" },
] as const;

export function Docs({ onOpenDashboard }: { onOpenDashboard: () => void }) {
  const [active, setActive] = useState<string>("quickstart");

  useEffect(() => {
    const onHash = () => {
      const el = document.getElementById(active);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    onHash();
  }, [active]);

  return (
    <div className="mx-auto grid max-w-6xl gap-8 px-4 py-8 sm:px-6 lg:grid-cols-[220px_1fr] lg:py-12">
      {/* Sidebar */}
      <nav className="lg:sticky lg:top-20 lg:self-start" aria-label="Documentation">
        <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Documentation</div>
        <ul className="flex flex-wrap gap-1.5 lg:flex-col">
          {SECTIONS.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                className={cn(
                  "rounded-md px-3 py-1.5 text-left text-sm transition-colors hover:bg-muted",
                  active === s.id ? "bg-muted font-medium text-foreground" : "text-muted-foreground"
                )}
                onClick={() => setActive(s.id)}
              >
                {s.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <div className="min-w-0 space-y-14">
        <Quickstart onOpenDashboard={onOpenDashboard} />
        <Auth />
        <Invoices />
        <Phone />
        <Webhooks />
        <Fees />
        <Chains />
        <Safety />
        <Oracle />
        <Sdks />
        <Errors />
        <Deploy />
      </div>
    </div>
  );
}

function H({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2 id={id} className="scroll-mt-24 text-xl font-semibold tracking-tight sm:text-2xl">
      {children}
    </h2>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="text-sm leading-relaxed text-muted-foreground">{children}</p>;
}

// ------------------------------------------------------------------ sections

function Quickstart({ onOpenDashboard }: { onOpenDashboard: () => void }) {
  return (
    <section className="space-y-4">
      <H id="quickstart">Quickstart</H>
      <P>
        PayPhone is a REST API over HTTPS. Every authenticated call is signed with your merchant
        secret — no cookies, no sessions, nothing to store server-side. In this demo deployment the
        engine runs on SimNet (a simulated chain) so you can exercise the full lifecycle for free.
      </P>
      <CodeBlock lang="bash" code={`# 1. Issue a merchant key (demo endpoint; production gates this behind an admin token)
curl -s http://localhost:8080/v1/keys -X POST \\
  -H 'Content-Type: application/json' -d '{"tier":"growth"}'

# 2. Sign requests: sk = your secret, body = raw JSON bytes
#    canonical = "{timestamp}.{METHOD}.{path}.{sha256(body)}"
#    signature = hex(HMAC_SHA256(sk, canonical))

# 3. Create an invoice, open the payment_url — done.`} />
      <P>
        The fastest path: open the dashboard, generate keys, create an invoice and pay it from the
        simulated wallet. Everything you do there maps 1:1 to the API.
      </P>
      <Button variant="outline" onClick={onOpenDashboard}>Open the dashboard</Button>
    </section>
  );
}

function Auth() {
  return (
    <section className="space-y-4">
      <H id="auth">Authentication</H>
      <P>
        Keys look like <code className="font-mono text-xs text-foreground">pk_&#123;tier&#125;_&#123;key_id&#125;</code> /{" "}
        <code className="font-mono text-xs text-foreground">sk_…</code>. The engine never stores them: it
        recomputes <span className="font-mono text-xs">sk = HMAC(master, pk)</span> at request time.
        Send three headers on every authenticated call:
      </P>
      <CodeBlock lang="text" code={`X-PayPhone-Key: pk_growth_4f9c2ab17d03
X-PayPhone-Timestamp: 1730000000        (unix seconds, ±300s window)
X-PayPhone-Signature: <hex>             (see below)

canonical  = "{timestamp}.{METHOD}.{path}.{sha256_hex(raw_body)}"
signature  = hex(HMAC_SHA256(sk_as_bytes, canonical))`} />
      <P>
        The timestamp window blocks replays without nonce storage. Verification is constant-time.
        For GET requests, hash the empty string as the body. The TypeScript/Python SDKs implement
        all of this for you.
      </P>
    </section>
  );
}

function Invoices() {
  return (
    <section className="space-y-4">
      <H id="invoices">Invoices</H>
      <P>
        An invoice is a <span className="text-foreground">signed token</span>, not a database row.
        Create it, then hand the payment URL to your customer — the token rides in the URL fragment,
        which browsers never send to servers, so it can&apos;t appear in access logs.
      </P>
      <CodeBlock lang="bash" code={`POST /v1/invoices
{
  "amount_usd_cents": 2500,        // integer minor units — never floats
  "asset": "USDC",                 // BTC, ETH, SOL, USDC, USDT, DAI…
  "chain": "evm", "network": "base",
  "wallet": "0xYourWallet",        // non-custodial: your receiving address
  "description": "Pro plan",       // hashed into the token, never stored raw
  "webhook_url": "https://…",      // per-invoice webhook (optional)
  "ttl_secs": 900                  // rate-lock window (60..86400)
}

→ 201 {
  "invoice": { "id": "inv_…", "qte": "25000000", "exp": 1730000900, … },
  "token": "eyJ….<sig>",
  "payment_url": "https://…/#/pay/inv_…?t=eyJ….<sig>",
  "asset_amount": "25.000000",     // rate-locked quantity to send
  "fee": { "fee_total_minor": 17, "split": { … } }
}

GET /v1/invoices/{id}?token={token}   → live status, observed from the chain
# statuses: pending · paid · underpaid · expired`} />
      <P>
        The token seals the <span className="font-mono text-xs">qte</span> (expected base-unit
        quantity) locked at creation. Display, payment and status-matching all use that one number,
        so a price move mid-checkout can never desynchronize the payer from the observer.
      </P>
    </section>
  );
}

function Phone() {
  return (
    <section className="space-y-4">
      <H id="phone">Phone identity &amp; escrow</H>
      <P>
        Phone numbers are normalized to E.164, then salted-hashed with a per-deployment pepper.
        Raw numbers are never logged or stored. The hash maps to a wallet through the registry
        (the <span className="font-mono text-xs">PhoneRegistry</span> contract on real chains; the
        SimNet journal in dev).
      </P>
      <CodeBlock lang="bash" code={`POST /v1/identity/resolve    {"phone": "+1 555 010 1234"}
→ { "payphone_id": "ph_9f2c…", "registered": true, "wallet": "0x…" }

POST /v1/identity/register   {"phone": "…", "wallet": "0x…"}
→ binds the hash to a payout wallet (registry entry, on-chain)

POST /v1/identity/escrow     {"phone": "…", "amount_usd_cents": 1500}
→ recipient not registered? funds lock in escrow behind a 6-digit claim code
→ production delivers the code via SMS; the journal stores only its SHA-256

POST /v1/identity/claim      {"escrow_id": "…", "phone": "…", "code": "123456"}
→ code verified against its hash; funds release to the registered wallet`} />
      <P>
        This is the Celo-style phone-attestation model, generalized: identity is a pure function of
        something the recipient already owns, and unregistered recipients are supported through
        escrow rather than rejection.
      </P>
    </section>
  );
}

function Webhooks() {
  return (
    <section className="space-y-4">
      <H id="webhooks">Webhooks</H>
      <P>
        State transitions fire signed events to your endpoint with three retries (1s/3s backoff).
        Verify before trusting:
      </P>
      <CodeBlock lang="bash" code={`X-PayPhone-Event: invoice.paid
X-PayPhone-Timestamp: 1730000000
X-PayPhone-Signature: hex(HMAC_SHA256(webhook_secret, "{ts}.{raw_body}"))

# response envelope
{ "id": "evt_…", "type": "invoice.paid", "api_version": "v1",
  "created_at": 1730000000,
  "data": { "invoice_id": "inv_…", "status": "paid", "chain": "evm" } }`} />
      <P>
        Note the current design honestly: v1 emission is <span className="text-foreground">poll-driven</span> —
        transitions are detected when invoice status is fetched, and the engine dispatches from
        there. A background watcher loop is the production evolution; the signing contract will not
        change, so start verifying webhooks now.
      </P>
    </section>
  );
}

function Fees() {
  return (
    <section className="space-y-4">
      <H id="fees">Fees &amp; revenue</H>
      <P>
        The fee is computed at invoice creation from the merchant tier, split three ways, and
        embedded in the invoice token — merchants and payers can both audit it:
      </P>
      <CodeBlock lang="text" code={`fee   = amount × tier_bps / 10_000
split = 60% protocol treasury   → FeeVault contract (on-chain, transparent)
        25% referrers           → the party that onboarded the merchant
        15% operations          → RPC providers, oracle infra, support

tiers: free 1.5% · starter 1.0% · growth 0.7% · scale 0.5% · enterprise 0.3%

GET /v1/fees/schedule            → the full public table
GET /v1/fees/quote?amount=10000  → exact breakdown for an amount`} />
      <P>
        Instant conversion adds a spread (default 40 bps) quoted transparently by{" "}
        <span className="font-mono text-xs">GET /v1/quote</span>. Together these lines sustain the
        network without storage fees, subscriptions for core features, or custody spreads.
      </P>
    </section>
  );
}

function Chains() {
  return (
    <section className="space-y-4">
      <H id="chains">Chains &amp; adapters</H>
      <P>
        The engine talks to chains, not databases. Each chain implements one adapter surface:
        derive/receive addresses, observe payments, report receipts. Today:
      </P>
      <ul className="ml-4 list-disc space-y-1.5 text-sm text-muted-foreground">
        <li><span className="text-foreground">SimNet</span> — hash-chained journal with escrow &amp; claims; tamper-evident, replays on boot. Full lifecycle, zero gas.</li>
        <li><span className="text-foreground">EVM</span> — production watch adapter over JSON-RPC (<span className="font-mono text-xs">EVM_RPC_MAINNET=…</span>). Balance-delta observation with the creation-time baseline sealed in the token; ERC-20 via <span className="font-mono text-xs">balanceOf</span>.</li>
        <li><span className="text-foreground">Solana / Tron / Bitcoin</span> — same trait, awaiting community adapters. The EVM module is the reference (~200 lines).</li>
      </ul>
      <CodeBlock lang="bash" code={`# Enable EVM observation (example: Base mainnet)
EVM_RPC_BASE=https://mainnet.base.org

# Disable SimNet in production
PAYPHONE_SIMNET=0`} />
    </section>
  );
}

function Safety() {
  return (
    <section className="space-y-4">
      <H id="safety">Asset safety</H>
      <P>
        Public blockchain transfers are final — there is no reversal, no chargeback and no support
        ticket that can recover coins sent to the wrong place. Nearly every lost-funds report in
        crypto traces back to one mistake: sending a coin on a network where it does not live.
        PayPhone ships this guidance at every point where money moves — the landing page, every
        hosted checkout and the wallet — and repeats the essential rule here.
      </P>
      <div className="rounded-xl border border-primary/40 bg-primary/5 p-4 text-sm">
        <p className="font-semibold text-foreground">The golden rule</p>
        <p className="mt-1 leading-relaxed text-muted-foreground">
          Send a coin only on a network where that coin lives, and match the address type to the
          network. Every exchange labels the network on its withdrawal form — read it, match it,
          and when in doubt send a small test amount first.
        </p>
      </div>
      <P>
        <strong>What a 0x… address receives safely:</strong> ETH, USDC, USDT, USDT0, WLD and any
        other token on Ethereum, Base, Worldchain, Arbitrum, Optimism, Polygon, BNB Chain and
        Avalanche — sent from any exchange or wallet on Earth. <strong>What it can never
        receive:</strong> native Bitcoin (bc1…), Solana or Tron coins — entirely different address
        systems, and cross-system transfers are unrecoverable by anyone. PayPhone invoices on
        those chains generate the correct per-chain addresses automatically.
      </P>
      <P>
        <strong>Wrong EVM network is usually not lost:</strong> an 0x… address exists on every EVM
        network, so USDC sent on Polygon instead of Base is still yours — switch networks in any
        wallet to see it. Tokens not yet listed in the wallet UI also still arrive at the address;
        any wallet holding the same recovery phrase will show them.
      </P>
      <SendRightNotice />
      <P>
        And because PayPhone is non-custodial: the recovery phrase is the only key to the funds.
        We cannot see it, store it, or reset it. Write it down, keep it offline, and share it with
        no one.
      </P>
    </section>
  );}

function Oracle() {
  return (
    <section className="space-y-4">
      <H id="oracle">Oracle service</H>
      <P>
        <span className="font-mono text-xs">services/oracle-py</span> is a small FastAPI service that
        aggregates CoinGecko + CoinCap with a median filter and staleness guards, quotes conversions
        with the PayPhone spread, and scores payment risk with explainable heuristics. The engine
        prefers it and falls back to CoinGecko directly, then to clearly-flagged static prices —
        demos never die because a third-party API hiccuped.
      </P>
      <CodeBlock lang="bash" code={`cd services/oracle-py
pip install -r requirements.txt
uvicorn main:app --port 8001

# engine wiring
PAYPHONE_ORACLE_URL=http://127.0.0.1:8001`} />
    </section>
  );
}

function Sdks() {
  return (
    <section className="space-y-4">
      <H id="sdks">SDKs</H>
      <P>
        Thin, dependency-light clients in <span className="font-mono text-xs">sdks/</span>. Both
        implement request signing, invoice creation, status polling and webhook verification.
      </P>
      <div className="grid gap-4 md:grid-cols-2">
        <CodeBlock lang="typescript" code={`import { PayPhone } from "@payphone/sdk";

const pp = new PayPhone({ baseUrl, publicKey, secretKey });
const inv = await pp.invoices.create({
  amount_usd_cents: 2500, asset: "USDC",
  chain: "simnet", network: "simnet", wallet: "PP…",
});
console.log(inv.payment_url);

// webhook verification (express example)
app.post("/hook", express.raw({ type: "*/*" }), (req, res) => {
  const ok = PayPhone.verifyWebhook(
    req.body, req.headers, process.env.WEBHOOK_SECRET!);
  res.sendStatus(ok ? 200 : 400);
});`} />
        <CodeBlock lang="python" code={`from payphone import PayPhone

pp = PayPhone(base_url, public_key, secret_key)
inv = pp.invoices.create(
    amount_usd_cents=2500,
    asset="USDC",
    chain="simnet", network="simnet",
    wallet="PP…",
)
print(inv.payment_url)

# webhook verification (flask example)
@app.post("/hook")
def hook():
    ok = verify_webhook(
        request.data, dict(request.headers), WEBHOOK_SECRET)
    return ("", 200 if ok else 400)`} />
      </div>
    </section>
  );
}

function Errors() {
  const rows = useMemo(
    () => [
      ["400", "bad_request", "Malformed input — field validation failed"],
      ["401", "invalid_signature", "Signature mismatch or expired timestamp"],
      ["401", "missing_credentials", "Signed headers absent"],
      ["403", "forbidden", "Admin-gated action without admin token"],
      ["404", "not_found", "Unknown route or escrow"],
      ["429", "rate_limited", "Token bucket exhausted (default 240/min/key)"],
      ["502", "upstream_unavailable", "Chain RPC or oracle failure"],
      ["503", "engine_offline / unavailable", "Engine down, or capability disabled"],
    ],
    []
  );
  return (
    <section className="space-y-4">
      <H id="errors">Errors &amp; rate limits</H>
      <P>Every error has the same envelope — branch on <span className="font-mono text-xs">error.type</span>:</P>
      <CodeBlock lang="json" code={`{ "error": { "type": "invalid_signature",
             "message": "signature does not match request", "code": 401 } }`} />
      <div className="overflow-hidden rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wider text-muted-foreground">
            <tr><th className="px-3 py-2">HTTP</th><th className="px-3 py-2">type</th><th className="px-3 py-2">meaning</th></tr>
          </thead>
          <tbody>
            {rows.map(([code, type, meaning]) => (
              <tr key={type + code} className="border-t">
                <td className="px-3 py-2 font-mono text-xs">{code}</td>
                <td className="px-3 py-2 font-mono text-xs text-primary">{type}</td>
                <td className="px-3 py-2 text-muted-foreground">{meaning}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <P>
        Rate limiting is a token bucket per API key (240/min, burst 120) — scale horizontally by
        putting global limits at your edge, or wait for the metering plan in the FeeVault contract.
      </P>
    </section>
  );
}

function Deploy() {
  return (
    <section className="space-y-4">
      <H id="deploy">Self-hosting</H>
      <P>
        The whole stack is three processes and a domain. No database server, no message queue, no
        migrations.
      </P>
      <CodeBlock lang="bash" code={`# engine
cd engine && cargo build --release
PAYPHONE_MASTER_KEY=$(openssl rand -hex 32) \\
PAYPHONE_SIGNING_KEY=$(openssl rand -hex 32) \\
PAYPHONE_PHONE_PEPPER=$(openssl rand -hex 32) \\
PAYPHONE_SIMNET=0 \\
EVM_RPC_BASE=https://mainnet.base.org \\
PAYPHONE_PORT=8080 \\
./target/release/payphone-engine

# web (Next.js) — set the engine URL, then deploy anywhere
PAYPHONE_ENGINE_URL=https://engine.internal:8080 npm run build

# oracle (optional but recommended)
cd services/oracle-py && uvicorn main:app --port 8001`} />
      <P>
        Terminate TLS at your edge (Caddy/nginx/Cloudflare), point{" "}
        <span className="font-mono text-xs">PAYPHONE_CHECKOUT_URL</span> at your public domain so
        payment links are absolute, and put the master key in a KMS — everything derives from it.
      </P>
      <div className="flex flex-wrap gap-2">
        <Badge variant="outline" className="font-mono text-xs">engine/ — Rust</Badge>
        <Badge variant="outline" className="font-mono text-xs">src/ — Next.js 16</Badge>
        <Badge variant="outline" className="font-mono text-xs">services/ — Python</Badge>
        <Badge variant="outline" className="font-mono text-xs">contracts/ — Solidity</Badge>
        <Badge variant="outline" className="font-mono text-xs">sdks/ — TS &amp; Python</Badge>
      </div>
      <Separator />
      <P>
        Full details live in the repository: <span className="font-mono text-xs">ARCHITECTURE.md</span>,{" "}
        <span className="font-mono text-xs">docs/SECURITY.md</span>,{" "}
        <span className="font-mono text-xs">docs/DEPLOYMENT.md</span> and{" "}
        <span className="font-mono text-xs">docs/REVENUE.md</span>.
      </P>
    </section>
  );
}
