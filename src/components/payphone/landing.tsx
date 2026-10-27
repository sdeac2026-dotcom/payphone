"use client";

/**
 * Landing view — product story, interactive phone-ID demo, pricing.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ArrowRight, BookOpen, Boxes, Code2, Fingerprint, Globe2, KeyRound,
  Layers, Lock, Radio, ShieldCheck, Smartphone, Timer, TrendingUp, Wallet, Zap,
} from "lucide-react";
import { CodeBlock, FeeDonut, MonoValue, SectionHead } from "./bits";
import { AssetSafetySection } from "./asset-safety";
import type { FeeSchedule } from "@/lib/payphone/types";

/**
 * Client-side mirror of the engine's phone algorithm (phone.rs) so the
 * hero widget can show the derivation live, offline. Same E.164 → salted
 * hash pipeline; the demo pepper is engine-derived at boot.
 */
async function demoPhoneHash(e164: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode("dev-master-key-DO-NOT-USE-IN-PRODUCTION"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`phone-pepper`));
  const pepper = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
  const key2 = await crypto.subtle.importKey(
    "raw", enc.encode(pepper), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const hash = await crypto.subtle.sign("HMAC", key2, enc.encode(e164));
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function normalizePreview(input: string): string {
  const cleaned = input.replace(/[\s\-()./]/g, "");
  if (cleaned.startsWith("+")) return cleaned;
  if (cleaned.startsWith("00")) return `+${cleaned.slice(2)}`;
  const local = cleaned.startsWith("0") ? cleaned.slice(1) : cleaned;
  return `+1${local}`;
}

const CURL_SAMPLE = `# 1. Create an invoice (signed with your merchant secret)
curl -X POST https://api.payphone.example/v1/invoices \\
  -H "X-PayPhone-Key: pk_growth_4f9c2ab17d03" \\
  -H "X-PayPhone-Timestamp: 1730000000" \\
  -H "X-PayPhone-Signature: $(echo -n "1730000000.POST./v1/invoices.$( \\
       echo -n '{...}' | sha256sum)" | openssl dgst -sha256 -hmac "$SECRET")" \\
  -d '{"amount_usd_cents": 2500, "asset": "USDC", "chain": "evm",
       "network": "base", "wallet": "0xYourWallet"}'

# 2. Engine responds instantly — stateless, no DB round-trips
# {
#   "data": {
#     "invoice": { "id": "inv_9f2c...", "amount_minor": 2500, ... },
#     "token": "eyJ2IjoxLCJpZCI6... .hMk3vQ…",
#     "payment_url": "https://payphone.example/#/pay/inv_9f2c…?t=…"
#   }
# }`;

const TS_SAMPLE = `import { PayPhone } from "@payphone/sdk";

const pp = new PayPhone({
  baseUrl: "https://api.payphone.example",
  publicKey: process.env.PAYPHONE_PK!,
  secretKey: process.env.PAYPHONE_SK!,
});

const invoice = await pp.invoices.create({
  amount_usd_cents: 2500,
  asset: "USDC",
  chain: "evm",
  network: "base",
  wallet: "0xYourWallet",
  description: "Pro plan — monthly",
});

// Hosted checkout + QR + webhooks, one line:
console.log(invoice.payment_url);`;

const PY_SAMPLE = `from payphone import PayPhone

pp = PayPhone(
    base_url="https://api.payphone.example",
    public_key=os.environ["PAYPHONE_PK"],
    secret_key=os.environ["PAYPHONE_SK"],
)

invoice = pp.invoices.create(
    amount_usd_cents=2500,
    asset="USDC",
    chain="evm",
    network="base",
    wallet="0xYourWallet",
)

print(invoice.payment_url)  # hosted checkout, ready to share`;

const FEATURES = [
  {
    icon: Smartphone,
    title: "Phone-ID payments",
    desc: "E.164 → salted hash → on-chain registry. Payers type a phone number; funds route to the registered wallet — or wait in escrow until the recipient claims.",
  },
  {
    icon: Boxes,
    title: "Any coin, any chain",
    desc: "Adapter-based architecture: SimNet for development, EVM for production, community adapters for Solana, Tron and Bitcoin. The chain is the database.",
  },
  {
    icon: Zap,
    title: "Stateless engine",
    desc: "Invoices are HMAC-signed tokens inside the payment URL. No database, no session store, no migration — deploy the engine anywhere Rust runs.",
  },
  {
    icon: TrendingUp,
    title: "Revenue engine built-in",
    desc: "Tiered fees with a transparent 60/25/15 split across protocol, referrers and operations. Sustainability is part of the architecture, not an invoice you send later.",
  },
  {
    icon: ShieldCheck,
    title: "Security-first",
    desc: "Signed requests with replay windows, signed webhooks, constant-time verification, salted phone hashes, no private keys ever touch the engine.",
  },
  {
    icon: Code2,
    title: "Developer platform",
    desc: "REST API, TypeScript & Python SDKs, signed webhooks, a simulated chain for CI, and this whole codebase — MIT licensed on GitHub.",
  },
];

const CHAINS = ["Bitcoin", "Ethereum", "Base", "Arbitrum", "Optimism", "Polygon", "Solana*", "Tron*", "Celo", "Lightning*"];

export function Landing({ onOpenDashboard, onOpenDocs }: { onOpenDashboard: () => void; onOpenDocs: () => void }) {
  const [phone, setPhone] = useState("");
  const [hash, setHash] = useState<string | null>(null);

  const e164 = useMemo(() => {
    const c = normalizePreview(phone);
    return /^\+[1-9]\d{7,14}$/.test(c) ? c : null;
  }, [phone]);

  async function resolve() {
    if (!e164) return;
    const h = await demoPhoneHash(e164);
    setHash(h);
  }

  return (
    <div>
      {/* ------------------------------------------------------------ hero */}
      <section className="pp-grid relative overflow-hidden border-b">
        <div className="pp-glow pointer-events-none absolute inset-0" aria-hidden="true" />
        <div className="mx-auto grid max-w-6xl gap-10 px-4 py-16 sm:px-6 lg:grid-cols-2 lg:py-24">
          <div className="flex flex-col justify-center">
            <Badge variant="outline" className="w-fit gap-1.5 border-primary/40 text-primary">
              <Radio className="h-3 w-3" /> Open-source · Stateless · Non-custodial
            </Badge>
            <h1 className="mt-4 text-4xl font-semibold leading-[1.1] tracking-tight sm:text-5xl lg:text-6xl">
              Your phone number is your{" "}
              <span className="text-primary">wallet</span>.
            </h1>
            <p className="mt-5 max-w-xl text-base leading-relaxed text-muted-foreground sm:text-lg">
              PayPhone is the payment network that lets any business accept every
              cryptocurrency through one API — and lets anyone on earth pay using
              nothing more than the phone number they already own.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <Button size="lg" onClick={onOpenDashboard} className="gap-2">
                Get API keys <ArrowRight className="h-4 w-4" />
              </Button>
              <Button size="lg" variant="outline" onClick={onOpenDocs} className="gap-2">
                <BookOpen className="h-4 w-4" /> Read the docs
              </Button>
            </div>
            <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5"><Globe2 className="h-3.5 w-3.5 text-primary" /> 240+ countries & territories</span>
              <span className="inline-flex items-center gap-1.5"><Timer className="h-3.5 w-3.5 text-primary" /> Sub-second invoice creation</span>
              <span className="inline-flex items-center gap-1.5"><Lock className="h-3.5 w-3.5 text-primary" /> Zero custody of funds</span>
            </div>
          </div>

          {/* Interactive phone → identity demo */}
          <Card className="relative z-10 self-center border-primary/25 shadow-2xl shadow-primary/5">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Fingerprint className="h-4 w-4 text-primary" />
                Try it — derive a PayPhone ID
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                This runs the engine&apos;s exact algorithm in your browser. Nothing is sent or stored.
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-2">
                <Input
                  placeholder="+1 555 010 1234"
                  inputMode="tel"
                  value={phone}
                  onChange={(e) => { setPhone(e.target.value); setHash(null); }}
                  onKeyDown={(e) => { if (e.key === "Enter") resolve(); }}
                  aria-label="Phone number"
                />
                <Button onClick={resolve} disabled={!e164}>Derive</Button>
              </div>
              {e164 && (
                <div className="space-y-2 text-xs text-muted-foreground">
                  <div className="flex items-center gap-2">
                    <span className="w-28 shrink-0">E.164 normalized</span>
                    <MonoValue value={e164} />
                  </div>
                  {hash && (
                    <>
                      <div className="flex items-center gap-2">
                        <span className="w-28 shrink-0">Salted hash</span>
                        <MonoValue value={hash} display={`${hash.slice(0, 18)}…${hash.slice(-8)}`} />
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="w-28 shrink-0">PayPhone ID</span>
                        <MonoValue value={`ph_${hash.slice(0, 16)}`} />
                      </div>
                      <p className="pt-1 leading-relaxed">
                        Pay anyone by pointing their PayPhone ID at the registry — unregistered
                        numbers receive a claim-escrow instead. Raw numbers are never stored.
                      </p>
                    </>
                  )}
                </div>
              )}
              {!e164 && phone.length > 0 && (
                <p className="text-xs text-destructive">Enter a valid phone number (8–15 digits).</p>
              )}
            </CardContent>
          </Card>
        </div>
      </section>

      {/* ---------------------------------------------------- asset safety */}
      <AssetSafetySection />

      {/* ------------------------------------------------------ how it works */}
      <section className="border-b py-16 sm:py-20">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <SectionHead
            kicker="How it works"
            title="Three steps from invoice to settlement"
            desc="The engine observes the chain, not a database. Everything between creation and settlement is a pure function."
          />
          <div className="grid gap-4 md:grid-cols-3">
            {[
              {
                icon: KeyRound,
                step: "01",
                title: "Create a signed invoice",
                desc: "One authenticated API call. The engine locks the exchange rate, derives a receiving address and returns a tamper-proof invoice token — in milliseconds, with zero database writes.",
              },
              {
                icon: Wallet,
                step: "02",
                title: "The customer pays",
                desc: "They scan the QR, follow the payment link, or simply send to a phone number. Any wallet, any coin. The token travels in the URL fragment — servers never log it.",
              },
              {
                icon: ShieldCheck,
                step: "03",
                title: "The chain confirms",
                desc: "The engine watches the chain (or SimNet in dev), marks the invoice paid, splits the fee 60/25/15 and fires your signed webhook. Funds settle straight to your wallet.",
              },
            ].map((s) => (
              <Card key={s.step} className="relative overflow-hidden">
                <CardContent className="p-6">
                  <div className="absolute right-4 top-4 font-mono text-4xl font-semibold text-muted/40">{s.step}</div>
                  <s.icon className="h-6 w-6 text-primary" aria-hidden="true" />
                  <h3 className="mt-4 text-base font-semibold">{s.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{s.desc}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------- features */}
      <section className="border-b py-16 sm:py-20">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <SectionHead kicker="Platform" title="Everything a payment network needs" />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f) => (
              <Card key={f.title} className="transition-colors hover:border-primary/40">
                <CardContent className="p-6">
                  <f.icon className="h-5 w-5 text-primary" aria-hidden="true" />
                  <h3 className="mt-3 font-semibold">{f.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{f.desc}</p>
                </CardContent>
              </Card>
            ))}
          </div>
          <p className="mt-4 text-xs text-muted-foreground">
            * Solana, Tron and Lightning follow the same adapter trait — reference implementations and the integration guide ship in the repository.
          </p>
        </div>
      </section>

      {/* ------------------------------------------------------- developers */}
      <section className="border-b py-16 sm:py-20">
        <div className="mx-auto grid max-w-6xl gap-10 px-4 sm:px-6 lg:grid-cols-2">
          <div>
            <SectionHead
              kicker="Developers"
              title="A payments API you can read the source of"
              desc="Every endpoint is documented, every primitive is testable, and the entire engine is ~2,000 lines of readable Rust. Start with curl, graduate to the SDKs."
            />
            <div className="flex flex-wrap gap-3">
              <Button variant="outline" onClick={onOpenDocs} className="gap-2">
                <BookOpen className="h-4 w-4" /> API reference
              </Button>
              <Button variant="outline" onClick={onOpenDashboard} className="gap-2">
                <Layers className="h-4 w-4" /> Try the dashboard
              </Button>
            </div>
          </div>
          <Tabs defaultValue="curl" className="w-full">
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="curl">cURL</TabsTrigger>
              <TabsTrigger value="ts">TypeScript</TabsTrigger>
              <TabsTrigger value="py">Python</TabsTrigger>
            </TabsList>
            <TabsContent value="curl"><CodeBlock lang="bash" code={CURL_SAMPLE} /></TabsContent>
            <TabsContent value="ts"><CodeBlock lang="typescript" code={TS_SAMPLE} /></TabsContent>
            <TabsContent value="py"><CodeBlock lang="python" code={PY_SAMPLE} /></TabsContent>
          </Tabs>
        </div>
      </section>

      {/* ---------------------------------------------------------- pricing */}
      <section className="border-b py-16 sm:py-20">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <SectionHead
            center
            kicker="Pricing"
            title="Pay per transaction. No fixed costs."
            desc="The fee is computed at invoice time and split transparently — you can verify every cent on-chain via the FeeVault contract."
          />
          <div className="grid items-center gap-8 lg:grid-cols-[1fr_auto]">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {[
                { tier: "Free", bps: "1.5%", vol: "$1k/mo included", desc: "Everything to start accepting crypto." },
                { tier: "Starter", bps: "1.0%", vol: "$25k/mo included", desc: "Branded checkout + phone escrow." },
                { tier: "Growth", bps: "0.7%", vol: "$250k/mo included", desc: "Conversion quotes + sub-org keys.", featured: true },
                { tier: "Scale", bps: "0.5%", vol: "$2.5M/mo included", desc: "Dedicated oracle slot + 99.95% SLA." },
              ].map((p) => (
                <Card key={p.tier} className={p.featured ? "border-primary/60 shadow-lg shadow-primary/10" : ""}>
                  <CardContent className="p-5">
                    {p.featured && <Badge className="mb-2 bg-primary text-primary-foreground">Most popular</Badge>}
                    <div className="font-semibold">{p.tier}</div>
                    <div className="mt-1 text-2xl font-semibold tracking-tight text-primary">{p.bps}</div>
                    <div className="text-xs text-muted-foreground">{p.vol}</div>
                    <p className="mt-3 text-sm text-muted-foreground">{p.desc}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
            <div className="flex flex-col items-center gap-3 rounded-xl border bg-card p-6">
              <FeeDonut protocol={60} referrer={25} operations={15} />
              <div className="space-y-1 text-xs text-muted-foreground">
                <div className="flex items-center gap-2"><span className="h-2 w-2 rounded-full" style={{ background: "oklch(0.75 0.15 163)" }} /> 60% protocol treasury</div>
                <div className="flex items-center gap-2"><span className="h-2 w-2 rounded-full" style={{ background: "oklch(0.68 0.12 200)" }} /> 25% referrers</div>
                <div className="flex items-center gap-2"><span className="h-2 w-2 rounded-full" style={{ background: "oklch(0.72 0.1 90)" }} /> 15% operations</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ----------------------------------------------------------- chains */}
      <section className="border-b py-12">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="flex flex-wrap items-center justify-center gap-2.5">
            <span className="mr-2 text-xs uppercase tracking-wider text-muted-foreground">Chains & assets</span>
            {CHAINS.map((c) => (
              <Badge key={c} variant="secondary" className="font-mono text-[11px]">{c}</Badge>
            ))}
          </div>
        </div>
      </section>

      {/* -------------------------------------------------------------- CTA */}
      <section className="py-16 sm:py-20">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="pp-grid relative overflow-hidden rounded-2xl border border-primary/25 bg-card p-8 text-center sm:p-14">
            <div className="pp-glow pointer-events-none absolute inset-0" aria-hidden="true" />
            <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              Start accepting crypto in the next five minutes.
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-sm text-muted-foreground sm:text-base">
              Generate a merchant key in the demo dashboard, create your first invoice on SimNet,
              and watch a payment settle — then point the same code at mainnet.
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-3">
              <Button size="lg" onClick={onOpenDashboard} className="gap-2">
                Launch dashboard <ArrowRight className="h-4 w-4" />
              </Button>
              <Button size="lg" variant="outline" onClick={onOpenDocs}>
                Architecture & API
              </Button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
