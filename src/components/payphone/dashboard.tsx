"use client";

/**
 * Merchant dashboard — onboarding, invoicing, phone identity, webhooks,
 * API keys and the SimNet block explorer. Demo session lives in
 * localStorage (documented); production merchants hold keys server-side.
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import {
  Activity, ArrowUpRight, Blocks, Copy, CreditCard, ExternalLink, Eye, EyeOff,
  Fingerprint, Globe, KeyRound, Link2, Phone, Plus, RefreshCw, Send, ShieldCheck,
  Trash2, TrendingUp, Webhook, Zap,
} from "lucide-react";
import {
  api, invoiceStore, session as store, shortHash, usd,
  type MerchantSession,
} from "@/lib/payphone/api";
import type { EngineHealth, FeeSchedule, LocalInvoice } from "@/lib/payphone/types";
import { MonoValue, StatCard } from "./bits";

const TIERS = ["free", "starter", "growth", "scale", "enterprise"] as const;

/** Fallback network list (mirrors engine/src/chains/registry.rs); replaced by the live /v1/chains sheet on load. */
const FALLBACK_NETWORKS = [
  { id: "simnet", label: "SimNet — demo, no real funds", kind: "simnet", assets: ["USDC"], confirmations: 0, live: true },
  { id: "base", label: "Base — real mainnet", kind: "evm", assets: ["USDC", "USDT", "DAI", "ETH"], confirmations: 8, live: true },
  { id: "ethereum", label: "Ethereum — real mainnet", kind: "evm", assets: ["USDC", "USDT", "DAI", "ETH"], confirmations: 6, live: true },
  { id: "arbitrum", label: "Arbitrum — real mainnet", kind: "evm", assets: ["USDC", "USDT", "ETH"], confirmations: 12, live: true },
  { id: "polygon", label: "Polygon — real mainnet", kind: "evm", assets: ["USDC", "USDT", "POL"], confirmations: 30, live: true },
  { id: "optimism", label: "Optimism — real mainnet", kind: "evm", assets: ["USDC", "USDT", "ETH"], confirmations: 8, live: true },
  { id: "bsc", label: "BNB Chain — real mainnet", kind: "evm", assets: ["USDT", "USDC", "BNB"], confirmations: 15, live: true },
  { id: "avalanche", label: "Avalanche — real mainnet", kind: "evm", assets: ["USDC", "USDT", "AVAX"], confirmations: 10, live: true },
  { id: "mainnet:btc", label: "Bitcoin — real mainnet", kind: "bitcoin", assets: ["BTC"], confirmations: 2, live: true },
  { id: "mainnet:sol", label: "Solana — real mainnet", kind: "solana", assets: ["SOL", "USDC"], confirmations: 32, live: true },
  { id: "mainnet:trx", label: "Tron — real mainnet", kind: "tron", assets: ["TRX", "USDT"], confirmations: 20, live: true },
];
type NetworkOption = (typeof FALLBACK_NETWORKS)[number];

/** Invoice-able asset (from GET /v1/assets) — asset-first routing source. */
type AssetEntry = {
  symbol: string;
  name: string;
  decimals: number;
  default_chain: string;
  default_network: string;
  settleable: boolean;
  settleable_networks: { chain: string; network: string }[];
};

/** Client-side wallet shape check per chain (full validation is engine-side, cryptographic). */
function walletMatchesChain(kind: string, wallet: string): boolean {
  const w = wallet.trim();
  if (!w) return false;
  switch (kind) {
    case "simnet": return /^PP[0-9a-fA-F]{40}$/.test(w) || /^0x[0-9a-fA-F]{40}$/.test(w);
    case "evm": return /^0x[0-9a-fA-F]{40}$/.test(w);
    case "bitcoin": return /^(1|3|bc1)/.test(w) && w.length >= 14 && w.length <= 90;
    case "solana": return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(w);
    case "tron": return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(w);
    default: return true;
  }
}

/** Human hint for the wallet shape the selected chain expects. */
function walletHint(kind: string): string {
  switch (kind) {
    case "evm": return "EVM address (0x…)";
    case "bitcoin": return "Bitcoin address (1… / 3… / bc1…)";
    case "solana": return "Solana pubkey (base58)";
    case "tron": return "TRON address (T…)";
    default: return "SimNet address (PP…)";
  }
}

/** localStorage-backed session as a React external store. */
function useMerchant(): MerchantSession | null {
  const raw = useSyncExternalStore(store.subscribe, store.raw, () => null);
  return useMemo(() => {
    try {
      return raw ? (JSON.parse(raw) as MerchantSession) : null;
    } catch {
      return null;
    }
  }, [raw]);
}

/** localStorage-backed invoice list as a React external store. */
function useInvoices(): LocalInvoice[] {
  const raw = useSyncExternalStore(invoiceStore.subscribe, invoiceStore.raw, () => null);
  return useMemo(() => {
    try {
      return raw ? (JSON.parse(raw) as LocalInvoice[]) : [];
    } catch {
      return [];
    }
  }, [raw]);
}

export function Dashboard({ onOpenCheckout }: { onOpenCheckout: (id: string, token: string) => void }) {
  const merchant = useMerchant();
  const [tab, setTab] = useState("overview");

  function onOnboarded(m: MerchantSession) {
    store.save(m);
  }

  if (!merchant) {
    return <Onboarding onDone={onOnboarded} />;
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Merchant console</h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
            <MonoValue value={merchant.pk} display={shortHash(merchant.pk, 10)} />
            <Badge variant="secondary" className="uppercase">{merchant.tier}</Badge>
            <span>fee {(merchantTierBps(merchant.tier) / 100).toFixed(2)}%</span>
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="gap-2 text-destructive hover:text-destructive"
          onClick={() => { store.clear(); }}
        >
          <Trash2 className="h-3.5 w-3.5" /> Reset demo session
        </Button>
      </div>

      <Tabs value={tab} onValueChange={setTab} className="w-full">
        <TabsList className="mb-6 flex h-auto w-full flex-wrap justify-start gap-1 bg-muted/50 p-1">
          <TabsTrigger value="overview" className="gap-1.5"><TrendingUp className="h-3.5 w-3.5" /> Overview</TabsTrigger>
          <TabsTrigger value="invoices" className="gap-1.5"><CreditCard className="h-3.5 w-3.5" /> Invoices</TabsTrigger>
          <TabsTrigger value="identity" className="gap-1.5"><Fingerprint className="h-3.5 w-3.5" /> Phone identity</TabsTrigger>
          <TabsTrigger value="webhooks" className="gap-1.5"><Webhook className="h-3.5 w-3.5" /> Webhooks</TabsTrigger>
          <TabsTrigger value="keys" className="gap-1.5"><KeyRound className="h-3.5 w-3.5" /> API keys</TabsTrigger>
          <TabsTrigger value="explorer" className="gap-1.5"><Blocks className="h-3.5 w-3.5" /> SimNet explorer</TabsTrigger>
        </TabsList>

        <TabsContent value="overview"><Overview merchant={merchant} onOpenInvoices={() => setTab("invoices")} /></TabsContent>
        <TabsContent value="invoices"><Invoices merchant={merchant} onOpenCheckout={onOpenCheckout} /></TabsContent>
        <TabsContent value="identity"><Identity merchant={merchant} /></TabsContent>
        <TabsContent value="webhooks"><Webhooks merchant={merchant} /></TabsContent>
        <TabsContent value="keys"><Keys merchant={merchant} /></TabsContent>
        <TabsContent value="explorer"><Explorer /></TabsContent>
      </Tabs>
    </div>
  );
}

function merchantTierBps(tier: string): number {
  return { free: 150, starter: 100, growth: 70, scale: 50, enterprise: 30 }[tier] ?? 150;
}

// ------------------------------------------------------------- onboarding ----

function Onboarding({ onDone }: { onDone: (m: MerchantSession) => void }) {
  const [tier, setTier] = useState<string>("growth");
  const [wallet, setWallet] = useState("");
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<{ pk: string; sk: string } | null>(null);
  const [showSk, setShowSk] = useState(false);
  const { toast } = useToast();

  async function generate() {
    setBusy(true);
    try {
      const key = await api.issueKey(tier);
      const pk = key.public_key;
      const sk = key.secret_key;
      const w = wallet.trim() || "PP" + Array.from({ length: 40 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
      setIssued({ pk, sk });
      onDone({ pk, sk, tier: key.tier, wallet: w, webhook_url: "", created_at: Date.now() });
      toast({ title: "Merchant key created", description: "Secret key shown once — it is derived, never stored." });
    } catch (e) {
      toast({ title: "Key issuance failed", description: e instanceof Error ? e.message : "unknown error", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-xl px-4 py-12 sm:py-16">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Zap className="h-5 w-5 text-primary" /> Create your merchant account
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Keys are <span className="text-foreground">derived, not stored</span> — the engine
            recomputes your secret from its master key at verification time. There is no key
            database to leak.
          </p>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2">
            <Label>Pricing tier</Label>
            <Select value={tier} onValueChange={setTier}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {TIERS.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t} — {(merchantTierBps(t) / 100).toFixed(2)}% per transaction
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Receiving wallet <span className="text-muted-foreground">(optional — SimNet auto-generates)</span></Label>
            <Input
              placeholder="PP… or 0x… (your own wallet — PayPhone never custodies funds)"
              value={wallet}
              onChange={(e) => setWallet(e.target.value)}
            />
          </div>
          <Button className="w-full" onClick={generate} disabled={busy}>
            {busy ? "Deriving keys…" : "Generate API keys"}
          </Button>
          {issued && (
            <div className="rounded-lg border border-primary/40 bg-primary/5 p-4 text-sm">
              <div className="font-medium text-primary">Secret key — shown once</div>
              <div className="mt-2 break-all font-mono text-xs">{issued.sk}</div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- overview ----

function Overview({ merchant, onOpenInvoices }: { merchant: MerchantSession; onOpenInvoices: () => void }) {
  const [health, setHealth] = useState<EngineHealth | null>(null);
  const [schedule, setSchedule] = useState<FeeSchedule | null>(null);
  const invoices = useInvoices();

  useEffect(() => {
    void api.engineHealth().then(setHealth);
    void api.feeSchedule().then(setSchedule);
  }, []);

  const paid = invoices.filter((i) => i.status === "paid");
  const volume = 0; // volumes are observed on-chain; demo counter uses statuses below

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Invoices" value={invoices.length} sub="created in this browser" />
        <StatCard label="Paid" value={paid.length} sub={`${Math.round((paid.length / Math.max(invoices.length, 1)) * 100)}% conversion`} />
        <StatCard label="Your fee rate" value={`${(merchantTierBps(merchant.tier) / 100).toFixed(2)}%`} sub={`tier: ${merchant.tier}`} />
        <StatCard label="SimNet height" value={health?.simnet?.height ?? "—"} sub="blocks on the demo chain" />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Stack health</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2.5 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Engine</span>
              <span className="font-mono text-xs">v{health?.version ?? "—"} · {health?.status ?? "offline"}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Oracle</span>
              <span className="font-mono text-xs">{health?.oracle_source ?? "—"}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Demo mode</span>
              <Badge variant={health?.demo_mode ? "outline" : "secondary"} className="text-xs">
                {health?.demo_mode ? "dev keys — do not ship" : "production keys"}
              </Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">EVM networks</span>
              <span className="font-mono text-xs">{health?.chains.evm_networks.length ? health.chains.evm_networks.join(", ") : "none configured"}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Registered phone IDs</span>
              <span className="font-mono text-xs">{health?.simnet?.registered_numbers ?? 0}</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Recent invoices</CardTitle>
          </CardHeader>
          <CardContent>
            {invoices.length === 0 ? (
              <div className="py-6 text-center text-sm text-muted-foreground">
                No invoices yet.
                <Button variant="link" className="px-1" onClick={onOpenInvoices}>Create your first one</Button>
              </div>
            ) : (
              <div className="space-y-2">
                {invoices.slice(0, 5).map((i) => (
                  <div key={i.id} className="flex items-center justify-between rounded-lg border bg-background/40 px-3 py-2 text-sm">
                    <div>
                      <span className="font-medium">{i.amount_usd}</span>
                      <span className="ml-2 text-xs text-muted-foreground">{i.asset} · {shortHash(i.id, 8)}</span>
                    </div>
                    <Badge variant={i.status === "paid" ? "default" : i.status === "expired" ? "secondary" : "outline"} className="text-xs">
                      {i.status}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
            <p className="mt-3 text-xs text-muted-foreground">
              {volume === 0 && "Invoice state is verified against the chain on demand — nothing is cached server-side."}
            </p>
          </CardContent>
        </Card>
      </div>

      {schedule && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Public fee schedule</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wider text-muted-foreground">
                    <th className="pb-2 pr-4">Tier</th>
                    <th className="pb-2 pr-4">Fee</th>
                    <th className="pb-2 pr-4">Included volume</th>
                    <th className="pb-2">Features</th>
                  </tr>
                </thead>
                <tbody>
                  {schedule.schedule.map((t) => (
                    <tr key={t.tier} className="border-b last:border-0">
                      <td className="py-2.5 pr-4 font-medium">{t.tier}</td>
                      <td className="py-2.5 pr-4 font-mono text-primary">{(t.bps / 100).toFixed(2)}%</td>
                      <td className="py-2.5 pr-4 text-muted-foreground">{t.included_volume_usd_cents === null ? "Unlimited" : usd(t.included_volume_usd_cents)}</td>
                      <td className="py-2.5 text-xs text-muted-foreground">{t.features.join(" · ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- invoices ----

function Invoices({
  merchant, onOpenCheckout,
}: {
  merchant: MerchantSession;
  onOpenCheckout: (id: string, token: string) => void;
}) {
  const invoices = useInvoices();
  const [amount, setAmount] = useState("25.00");
  const [asset, setAsset] = useState("USDC");
  const [assets, setAssets] = useState<AssetEntry[]>([]);
  const [networks, setNetworks] = useState<NetworkOption[]>(FALLBACK_NETWORKS);
  const [net, setNet] = useState("auto"); // "auto" = asset catalog picks the venue
  const [description, setDescription] = useState("Pro plan — monthly");
  const [busy, setBusy] = useState(false);
  const [lastCreated, setLastCreated] = useState<{ id: string; token: string; url: string } | null>(null);
  const { toast } = useToast();

  const assetEntry = assets.find((a) => a.symbol === asset);
  const pinned = net !== "auto" ? networks.find((n) => n.id === net) : undefined;
  // Effective chain kind: the pin when set, else the asset's default route.
  const effectiveKind = pinned?.kind ?? (assetEntry?.default_chain === "none" ? "evm" : assetEntry?.default_chain ?? "evm");
  const effectiveNetLabel = pinned?.id ?? assetEntry?.default_network ?? "base";
  const isReal = effectiveKind !== "simnet";
  const walletOk = walletMatchesChain(effectiveKind, merchant.wallet);

  // Live asset catalog (asset-first invoicing) + network sheet.
  useEffect(() => {
    let cancelled = false;
    api.assets().then((sheet) => {
      if (cancelled || !sheet?.assets?.length) return;
      setAssets(sheet.assets.filter((a) => a.settleable));
    }).catch(() => { /* asset picker falls back to the network-derived list */ });
    api.chains().then((sheet) => {
      if (cancelled || !sheet?.networks?.length) return;
      setNetworks(sheet.networks.map((n) => ({
        // Offchain rows share network name "mainnet" — prefix with the kind.
        id: n.kind === "evm" || n.kind === "simnet" ? n.name : `${n.kind}/${n.name}`,
        label: n.kind === "evm"
          ? `${n.name} — real mainnet (chain ${n.chain_id})`
          : n.kind === "simnet"
            ? "SimNet — demo, no real funds"
            : `${n.kind} ${n.name} — real mainnet`,
        kind: n.kind,
        assets: [...n.settleable_tokens.map((t) => t.symbol), n.native_asset],
        confirmations: n.confirmations_required,
        live: n.probe?.rpc_live === true,
      })));
    }).catch(() => { /* fallback list already in place */ });
    return () => { cancelled = true; };
  }, []);

  // Live status refresh for stored invoices.
  useEffect(() => {
    let cancelled = false;
    async function tick() {
      for (const inv of invoices.filter((i) => i.status === "pending" || i.status === "underpaid")) {
        try {
          const d = await api.invoiceStatus(inv.id, inv.token);
          if (cancelled) return;
          if (d.invoice.status !== inv.status) {
            invoiceStore.updateStatus(inv.id, d.invoice.status);
          }
        } catch {
          /* engine hiccup — next tick */
        }
      }
    }
    const t = window.setInterval(() => void tick(), 4000);
    return () => { cancelled = true; window.clearInterval(t); };
  }, [invoices]);

  async function create() {
    const cents = Math.round(parseFloat(amount) * 100);
    if (!Number.isFinite(cents) || cents <= 0) {
      toast({ title: "Invalid amount", variant: "destructive" });
      return;
    }
    if (isReal && !walletOk) {
      toast({
        title: `Payout wallet does not match ${effectiveKind}`,
        description: `This invoice settles on ${effectiveNetLabel}. Expected ${walletHint(effectiveKind)} — update your wallet in onboarding.`,
        variant: "destructive",
      });
      return;
    }
    setBusy(true);
    try {
      // Asset-first: when no network is pinned the engine routes through the
      // asset catalog (chain/network omitted). Pinning overrides both.
      const d = await api.createInvoice(
        {
          amount_usd_cents: cents,
          asset,
          chain: pinned ? pinned.kind : "",
          network: pinned ? pinned.id.replace(/^(bitcoin|solana|tron)\//, "") : "",
          wallet: merchant.wallet,
          description,
          webhook_url: merchant.webhook_url || undefined,
        },
        { pk: merchant.pk, sk: merchant.sk }
      );
      invoiceStore.add({
        id: d.invoice.id,
        token: d.token,
        amount_usd: usd(d.invoice.amount_minor),
        asset,
        chain: pinned ? pinned.id : `${effectiveKind}/${d.invoice.network}`,
        description,
        created_at: Date.now(),
        status: "pending",
      });
      setLastCreated({ id: d.invoice.id, token: d.token, url: d.payment_url });
      toast({
        title: "Invoice created",
        description: `${asset} settles on ${d.invoice.chain}/${d.invoice.network} · fee ${usd(d.fee.fee_total_minor)} (${(d.fee.bps / 100).toFixed(2)}%)`,
      });
    } catch (e) {
      toast({ title: "Invoice failed", description: e instanceof Error ? e.message : "unknown error", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[380px_1fr]">
      <Card className="self-start">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base"><Plus className="h-4 w-4 text-primary" /> Create invoice</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="inv-amount">Amount (USD)</Label>
            <Input id="inv-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          {/* Asset-first: the merchant names the asset; the engine routes it. */}
          <div className="space-y-2">
            <Label>Crypto asset</Label>
            <Select value={asset} onValueChange={(v) => {
              setAsset(v);
              // If the pinned network can't settle the new asset, fall back to auto.
              const entry = assets.find((a) => a.symbol === v);
              const pinnedSettles = entry && pinned && entry.settleable_networks.some((s) =>
                s.chain === "evm" ? pinned.kind === "evm" && s.network === pinned.id
                  : `${s.chain}/${s.network}` === pinned.id,
              );
              if (pinned && !pinnedSettles) setNet("auto");
            }}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent className="max-h-72">
                {(assets.length ? assets : [{ symbol: "USDC", name: "USD Coin", decimals: 6, default_chain: "evm", default_network: "base", settleable: true, settleable_networks: [] }] as AssetEntry[]).map((a) => (
                  <SelectItem key={a.symbol} value={a.symbol}>
                    {a.symbol} — {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              {assets.length
                ? `${assets.length} assets settle across 10 real chains — just pick one; the engine routes it.`
                : "Loading the live asset catalog…"}
            </p>
          </div>
          <div className="space-y-2">
            <Label>Settlement network</Label>
            <Select value={net} onValueChange={setNet}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">
                  Auto — {assetEntry?.default_network ?? "base"} (recommended)
                </SelectItem>
                {networks.map((n) => (
                  <SelectItem key={n.id} value={n.id}>{n.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              {assetEntry
                ? `${asset} settles on: ${assetEntry.settleable_networks.map((s) => (s.chain === "evm" ? s.network : `${s.chain}/${s.network}`)).join(", ")}`
                : "Default routing comes from the asset catalog."}
            </p>
          </div>
          {isReal ? (
            <div className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-2.5 text-xs text-emerald-700 dark:text-emerald-400">
              <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                <strong>REAL MAINNET.</strong> Payers send {asset} on {effectiveNetLabel} to your wallet;
                the engine verifies the transfer on-chain and marks the invoice paid after
                {" "}{pinned?.confirmations ?? (effectiveKind === "bitcoin" ? 2 : effectiveKind === "solana" ? 32 : effectiveKind === "tron" ? 20 : 8)} confirmations. Non-custodial — the engine never holds keys.
                {pinned && !pinned.live && " (public RPC currently unreachable — invoice creation may fail until it recovers or an EVM_RPC_* override is set.)"}
              </span>
            </div>
          ) : (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5 text-xs text-amber-700 dark:text-amber-400">
              Demo chain — payments are simulated. Pick any real asset above (BTC, ETH, SOL, USDC…) to settle on a real mainnet.
            </div>
          )}
          {isReal && !walletOk && (
            <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-2.5 text-xs text-destructive">
              Your payout wallet doesn&apos;t look like {walletHint(effectiveKind)} — update it in onboarding before creating this invoice.
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="inv-desc">Description</Label>
            <Textarea id="inv-desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
            <p className="text-[11px] text-muted-foreground">Hashed into the invoice token — never stored in clear text.</p>
          </div>
          <Button className="w-full gap-2" onClick={create} disabled={busy}>
            {busy ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
            {busy ? "Signing & creating…" : "Create invoice"}
          </Button>
          {lastCreated && (
            <div className="space-y-2 rounded-lg border border-primary/40 bg-primary/5 p-3 text-sm">
              <div className="font-medium text-primary">Invoice ready</div>
              <MonoValue value={lastCreated.url} display={`#/pay/${shortHash(lastCreated.id, 6)}…`} />
              <div className="flex gap-2">
                <Button size="sm" className="flex-1 gap-1.5" onClick={() => onOpenCheckout(lastCreated.id, lastCreated.token)}>
                  <ExternalLink className="h-3.5 w-3.5" /> Open checkout
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="flex-1 gap-1.5"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(lastCreated.url);
                      toast({ title: "Payment link copied" });
                    } catch { /* noop */ }
                  }}
                >
                  <Copy className="h-3.5 w-3.5" /> Copy link
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="self-start">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Invoices ({invoices.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {invoices.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Nothing here yet — create an invoice and share the link.
            </p>
          ) : (
            <div className="max-h-[540px] space-y-2 overflow-y-auto pp-scroll pr-1">
              {invoices.map((i) => (
                <div key={i.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-background/40 px-3 py-2.5 text-sm">
                  <div className="min-w-0">
                    <div className="font-medium">{i.amount_usd} <span className="text-xs font-normal text-muted-foreground">· {i.asset}</span></div>
                    <div className="truncate text-xs text-muted-foreground">{i.description || "Payment"} · {shortHash(i.id, 8)}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={i.status === "paid" ? "default" : i.status === "expired" ? "secondary" : i.status === "underpaid" ? "outline" : "outline"} className="text-xs">
                      {i.status}
                    </Badge>
                    <Button size="sm" variant="ghost" className="h-7 gap-1 px-2" onClick={() => onOpenCheckout(i.id, i.token)}>
                      <ArrowUpRight className="h-3.5 w-3.5" /> View
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- identity ----

function Identity({ merchant }: { merchant: MerchantSession }) {
  const [lookupPhone, setLookupPhone] = useState("");
  const [lookup, setLookup] = useState<Awaited<ReturnType<typeof api.resolvePhone>> | null>(null);
  const [regPhone, setRegPhone] = useState("");
  const [regWallet, setRegWallet] = useState(merchant.wallet);
  const [escrowPhone, setEscrowPhone] = useState("");
  const [escrowAmount, setEscrowAmount] = useState("15.00");
  const [escrow, setEscrow] = useState<{ escrow_id: string; claim_code: string } | null>(null);
  const [claimId, setClaimId] = useState("");
  const [claimPhone, setClaimPhone] = useState("");
  const [claimCode, setClaimCode] = useState("");
  const [claimResult, setClaimResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();

  async function doLookup() {
    setBusy(true);
    try {
      setLookup(await api.resolvePhone(lookupPhone, { pk: merchant.pk, sk: merchant.sk }));
    } catch (e) {
      toast({ title: "Lookup failed", description: e instanceof Error ? e.message : "unknown", variant: "destructive" });
    } finally { setBusy(false); }
  }

  async function doRegister() {
    setBusy(true);
    try {
      const r = await api.registerPhone(regPhone, regWallet, { pk: merchant.pk, sk: merchant.sk });
      toast({ title: "Phone registered", description: `SimNet block #${r.tx.height}` });
    } catch (e) {
      toast({ title: "Registration failed", description: e instanceof Error ? e.message : "unknown", variant: "destructive" });
    } finally { setBusy(false); }
  }

  async function doEscrow() {
    setBusy(true);
    try {
      const cents = Math.round(parseFloat(escrowAmount) * 100);
      const r = await api.createEscrow(escrowPhone, cents, { pk: merchant.pk, sk: merchant.sk });
      setEscrow(r);
      toast({ title: "Escrow created", description: `Claim code generated for block #${r.tx.height}` });
    } catch (e) {
      toast({ title: "Escrow failed", description: e instanceof Error ? e.message : "unknown", variant: "destructive" });
    } finally { setBusy(false); }
  }

  async function doClaim() {
    setBusy(true);
    try {
      const r = await api.claimEscrow(claimId, claimPhone, claimCode);
      setClaimResult(`${usd(r.released_amount_usd_cents)} released to ${shortHash(r.wallet, 8)} in block #${r.tx.height}`);
      toast({ title: "Escrow claimed" });
    } catch (e) {
      setClaimResult(null);
      toast({ title: "Claim failed", description: e instanceof Error ? e.message : "unknown", variant: "destructive" });
    } finally { setBusy(false); }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base"><Globe className="h-4 w-4 text-primary" /> Resolve a phone number</CardTitle>
          <p className="text-sm text-muted-foreground">Check whether a number has a registered payout wallet.</p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Input placeholder="+1 555 010 1234" inputMode="tel" value={lookupPhone} onChange={(e) => setLookupPhone(e.target.value)} />
            <Button onClick={doLookup} disabled={busy || lookupPhone.replace(/\D/g, "").length < 8}>Resolve</Button>
          </div>
          {lookup && (
            <div className="space-y-2 rounded-lg border bg-background/40 p-3 text-sm">
              <div className="flex justify-between"><span className="text-muted-foreground">PayPhone ID</span><MonoValue value={lookup.payphone_id} /></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Masked phone</span><span className="font-mono text-xs">{lookup.masked_phone}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Registered</span>
                <Badge variant={lookup.registered ? "default" : "secondary"}>{lookup.registered ? "yes" : "no"}</Badge>
              </div>
              {lookup.wallet && <div className="flex justify-between"><span className="text-muted-foreground">Wallet</span><MonoValue value={lookup.wallet} display={shortHash(lookup.wallet, 10)} /></div>}
            </div>
          )}
          <Separator />
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium"><Fingerprint className="h-4 w-4 text-primary" /> Register a payout wallet</div>
            <Input placeholder="+1 555 010 4321" inputMode="tel" value={regPhone} onChange={(e) => setRegPhone(e.target.value)} />
            <Input placeholder="Receiving wallet (PP… / 0x…)" value={regWallet} onChange={(e) => setRegWallet(e.target.value)} />
            <Button className="w-full" onClick={doRegister} disabled={busy || regPhone.replace(/\D/g, "").length < 8 || regWallet.length < 8}>
              Bind phone → wallet
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base"><Phone className="h-4 w-4 text-primary" /> Send to an unregistered phone</CardTitle>
          <p className="text-sm text-muted-foreground">
            Funds lock in escrow behind a 6-digit claim code until the recipient registers a wallet and claims.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Input placeholder="+1 555 010 9999" inputMode="tel" value={escrowPhone} onChange={(e) => setEscrowPhone(e.target.value)} />
            <Input className="w-28" inputMode="decimal" value={escrowAmount} onChange={(e) => setEscrowAmount(e.target.value)} aria-label="Amount" />
            <Button onClick={doEscrow} disabled={busy || escrowPhone.replace(/\D/g, "").length < 8} className="gap-1.5 shrink-0">
              <Send className="h-3.5 w-3.5" /> Escrow
            </Button>
          </div>
          {escrow && (
            <div className="space-y-2 rounded-lg border border-primary/40 bg-primary/5 p-3 text-sm">
              <div className="flex justify-between"><span className="text-muted-foreground">Escrow</span><MonoValue value={escrow.escrow_id} display={shortHash(escrow.escrow_id, 10)} /></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Claim code (demo: shown inline)</span><span className="font-mono font-semibold tracking-widest text-primary">{escrow.claim_code}</span></div>
              <p className="text-xs text-muted-foreground">Production delivers this code to the recipient by SMS — the journal only ever stores its hash.</p>
            </div>
          )}
          <Separator />
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium"><ShieldCheck className="h-4 w-4 text-primary" /> Claim escrowed funds</div>
            <Input placeholder="esc_…" value={claimId} onChange={(e) => setClaimId(e.target.value)} />
            <div className="grid grid-cols-2 gap-2">
              <Input placeholder="+1 555 010 9999" inputMode="tel" value={claimPhone} onChange={(e) => setClaimPhone(e.target.value)} />
              <Input placeholder="6-digit code" inputMode="numeric" maxLength={6} value={claimCode} onChange={(e) => setClaimCode(e.target.value)} />
            </div>
            <Button className="w-full" onClick={doClaim} disabled={busy || !claimId || claimCode.length !== 6}>
              Claim funds
            </Button>
            {claimResult && (
              <p className="rounded-lg border border-primary/40 bg-primary/5 p-3 text-sm text-primary">{claimResult}</p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- webhooks ----

function Webhooks({ merchant }: { merchant: MerchantSession }) {
  const [url, setUrl] = useState(merchant.webhook_url);
  const [result, setResult] = useState<Awaited<ReturnType<typeof api.webhookTest>> | null>(null);
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();

  async function sendTest() {
    setBusy(true);
    try {
      store.patch({ webhook_url: url });
      const r = await api.webhookTest(url || "http://127.0.0.1:9", { pk: merchant.pk, sk: merchant.sk });
      setResult(r);
    } catch (e) {
      toast({ title: "Test failed", description: e instanceof Error ? e.message : "unknown", variant: "destructive" });
    } finally { setBusy(false); }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base"><Webhook className="h-4 w-4 text-primary" /> Webhook endpoint</CardTitle>
          <p className="text-sm text-muted-foreground">
            Events: <span className="font-mono text-xs">invoice.paid · invoice.underpaid · invoice.expired</span>
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <Input placeholder="https://api.yourapp.com/payphone/webhook" value={url} onChange={(e) => setUrl(e.target.value)} />
          <Button className="w-full gap-2" onClick={sendTest} disabled={busy}>
            {busy ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Activity className="h-4 w-4" />} Send signed test event
          </Button>
          <p className="text-xs text-muted-foreground">
            Every delivery carries <span className="font-mono">X-PayPhone-Signature</span>{" "}
            = HMAC-SHA256(webhook_secret, &quot;&#123;timestamp&#125;.&#123;raw_body&#125;&quot;).
            Verify with the SDK&apos;s <span className="font-mono">verifyWebhook()</span>.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Last test event</CardTitle>
        </CardHeader>
        <CardContent>
          {!result ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Send a test event to inspect its exact payload and signature.</p>
          ) : (
            <div className="space-y-3 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Delivery</span>
                <Badge variant={result.delivery.delivered ? "default" : "secondary"}>
                  {result.delivery.delivered ? `delivered in ${result.delivery.attempts} attempt(s)` : "endpoint unreachable (expected for placeholders)"}
                </Badge>
              </div>
              <pre className="pp-scroll max-h-64 overflow-auto rounded-lg border bg-[oklch(0.14_0.01_170)] p-3 font-mono leading-relaxed">
                {JSON.stringify({ headers: result.headers, payload: result.payload }, null, 2)}
              </pre>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// -------------------------------------------------------------------- keys ----

function Keys({ merchant }: { merchant: MerchantSession }) {
  const [show, setShow] = useState(false);
  const [schedule, setSchedule] = useState<FeeSchedule | null>(null);
  useEffect(() => { void api.feeSchedule().then(setSchedule); }, []);
  const tierInfo = schedule?.schedule.find((t) => t.tier === merchant.tier);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base"><KeyRound className="h-4 w-4 text-primary" /> Your credentials</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Public key</Label>
            <MonoValue value={merchant.pk} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Secret key (demo — stored in this browser only)</Label>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded-md border bg-muted/40 px-2 py-1 font-mono text-xs">
                {show ? merchant.sk : "sk_••••••••••••••••••••••••••••••••"}
              </code>
              <Button variant="ghost" size="sm" onClick={() => setShow(!show)} aria-label="Toggle secret visibility">
                {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
            </div>
          </div>
          <Separator />
          <p className="text-xs leading-relaxed text-muted-foreground">
            <span className="font-medium text-foreground">How databaseless keys work:</span> the engine
            computes <span className="font-mono">sk = HMAC(master, pk)</span> at request time and verifies
            your signature in constant time. Rotation = issue a new key and drop the old one. Revocation
            = a denylist entry. Nothing to leak from a database, because there is no database.
          </p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            <span className="text-yellow-500">Demo caveat:</span> this console is a browser demo, so the
            secret lives in localStorage. Real integrations keep keys in server env / KMS — see the
            SDK quickstart.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Tier details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {tierInfo ? (
            <>
              <div className="flex justify-between"><span className="text-muted-foreground">Tier</span><span className="font-medium uppercase">{tierInfo.tier}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Fee</span><span className="font-mono text-primary">{(tierInfo.bps / 100).toFixed(2)}%</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Included volume</span><span>{tierInfo.included_volume_usd_cents === null ? "Unlimited" : `${usd(tierInfo.included_volume_usd_cents)} / mo`}</span></div>
              <Separator />
              <ul className="space-y-1.5 text-xs text-muted-foreground">
                {tierInfo.features.map((f) => <li key={f} className="flex items-center gap-2"><Link2 className="h-3 w-3 text-primary" /> {f}</li>)}
              </ul>
            </>
          ) : (
            <p className="text-muted-foreground">Loading schedule…</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- explorer ----

function Explorer() {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.simnetBlocks>> | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try { setData(await api.simnetBlocks(40)); } catch { /* offline */ } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(t);
  }, [load]);

  const kindColor: Record<string, string> = {
    genesis: "bg-muted text-muted-foreground",
    register: "bg-[oklch(0.68_0.12_200)]/15 text-[oklch(0.68_0.12_200)] border-[oklch(0.68_0.12_200)]/40",
    escrow: "bg-[oklch(0.72_0.1_90)]/15 text-[oklch(0.72_0.1_90)] border-[oklch(0.72_0.1_90)]/40",
    claim: "bg-[oklch(0.75_0.15_163)]/15 text-primary border-primary/40",
    pay: "bg-[oklch(0.7_0.15_40)]/15 text-[oklch(0.7_0.15_40)] border-[oklch(0.7_0.15_40)]/40",
  };

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between pb-3">
        <div>
          <CardTitle className="flex items-center gap-2 text-base"><Blocks className="h-4 w-4 text-primary" /> SimNet explorer</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            A real hash-chained journal — every block re-verified on boot. This is what &quot;the chain is the database&quot; looks like in dev.
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          {data && <span>height <span className="font-mono text-foreground">{data.stats.height}</span></span>}
          <Button variant="ghost" size="sm" onClick={() => void load()} aria-label="Refresh blocks"><RefreshCw className={loading ? "h-4 w-4 animate-spin" : "h-4 w-4"} /></Button>
        </div>
      </CardHeader>
      <CardContent>
        {!data ? (
          <p className="py-8 text-center text-sm text-muted-foreground">SimNet unavailable — is the engine running?</p>
        ) : (
          <div className="pp-scroll max-h-[560px] space-y-2 overflow-y-auto pr-1">
            {data.blocks.map((b) => (
              <div key={b.hash} className="rounded-lg border bg-background/40 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-muted-foreground">#{b.height}</span>
                    <Badge variant="outline" className={`text-[10px] uppercase ${kindColor[b.kind] ?? ""}`}>{b.kind}</Badge>
                  </div>
                  <span className="font-mono text-[10px] text-muted-foreground">{new Date(b.ts * 1000).toLocaleTimeString()}</span>
                </div>
                <div className="mt-1.5 truncate font-mono text-[11px] text-muted-foreground">
                  {JSON.stringify(b.data).slice(0, 140)}
                </div>
                <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground/60">{b.hash.slice(0, 40)}…</div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
