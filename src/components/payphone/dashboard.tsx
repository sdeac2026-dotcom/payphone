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
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import {
  Activity as ActivityIcon, ArrowDownLeft, ArrowUpRight, Blocks, Cable, Copy, CreditCard, ExternalLink, Eye, EyeOff,
  Fingerprint, Globe, Info, KeyRound, Landmark, Link2, Phone, Plus, RefreshCw, RotateCw, Send, ShieldCheck,
  Trash2, TrendingUp, Webhook, Zap,
} from "lucide-react";
import {
  api, connectorStore, invoiceStore, session as store, setAdminToken, shortHash, usd,
  ApiError,
  type ConnectorPaymentSummary,
  type MerchantSession,
  type StoredConnector,
  type WalletActivityAll,
} from "@/lib/payphone/api";
import type { EngineHealth, FeeSchedule, LocalInvoice } from "@/lib/payphone/types";
import { walletAddressStored } from "@/lib/payphone/wallet";
import { CodeBlock, MonoValue, StatCard } from "./bits";

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
          <TabsTrigger value="activity" className="gap-1.5"><ActivityIcon className="h-3.5 w-3.5" /> Activity</TabsTrigger>
          <TabsTrigger value="identity" className="gap-1.5"><Fingerprint className="h-3.5 w-3.5" /> Phone identity</TabsTrigger>
          <TabsTrigger value="webhooks" className="gap-1.5"><Webhook className="h-3.5 w-3.5" /> Webhooks</TabsTrigger>
          <TabsTrigger value="connectors" className="gap-1.5"><Cable className="h-3.5 w-3.5" /> Connectors</TabsTrigger>
          <TabsTrigger value="paypal" className="gap-1.5"><CreditCard className="h-3.5 w-3.5" /> PayPal</TabsTrigger>
          <TabsTrigger value="keys" className="gap-1.5"><KeyRound className="h-3.5 w-3.5" /> API keys</TabsTrigger>
          <TabsTrigger value="explorer" className="gap-1.5"><Blocks className="h-3.5 w-3.5" /> SimNet explorer</TabsTrigger>
        </TabsList>

        <TabsContent value="overview"><Overview merchant={merchant} onOpenInvoices={() => setTab("invoices")} /></TabsContent>
        <TabsContent value="invoices"><Invoices merchant={merchant} onOpenCheckout={onOpenCheckout} /></TabsContent>
        <TabsContent value="activity"><Activity merchant={merchant} /></TabsContent>
        <TabsContent value="identity"><Identity merchant={merchant} /></TabsContent>
        <TabsContent value="webhooks"><Webhooks merchant={merchant} /></TabsContent>
        <TabsContent value="connectors"><Connectors merchant={merchant} /></TabsContent>
        <TabsContent value="paypal"><PayPalTab merchant={merchant} /></TabsContent>
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
      let key: Awaited<ReturnType<typeof api.issueKey>>;
      try {
        key = await api.issueKey(tier);
      } catch (e) {
        // Production deployments gate key issuance behind the platform admin
        // token (PAYPHONE_ADMIN_TOKEN). Ask once, remember, retry.
        const gated = e instanceof ApiError && (e.status === 403 || e.type === "forbidden");
        if (!gated || typeof window === "undefined") throw e;
        const token = window.prompt(
          "This PayPhone deployment is admin-gated.\n" +
            "Enter the platform admin token (PAYPHONE_ADMIN_TOKEN) to issue merchant keys:"
        );
        if (!token) throw e;
        setAdminToken(token);
        key = await api.issueKey(tier);
      }
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

/**
 * Wallet Activity — the full-visibility radar ("where is my money?").
 *
 * One scan fans out across EVERY configured EVM network and reports every
 * ERC-20 transfer touching the address — incoming AND outgoing, ANY token —
 * each labeled with the network it ACTUALLY landed on (the network the
 * sender used, not the one any UI picked), live confirmations and a
 * block-explorer link. Complements the wallet's per-network Incoming card.
 */
const WINDOW_PRESETS = [
  { value: "2000", label: "Recent · ~1–2 h" },
  { value: "9000", label: "Today · ~5–12 h" },
  { value: "20000", label: "Deep · 1–3 days" },
] as const;

function fmtQty(q: string): string {
  const n = Number(q);
  if (!Number.isFinite(n)) return q;
  return n.toLocaleString("en-US", { maximumFractionDigits: Math.min(8, Math.max(2, (q.split(".")[1]?.length ?? 2) - 2)) });
}

function agoLabel(confirmations: number, blockTimeSecs: number | undefined): string {
  const secs = confirmations * (blockTimeSecs ?? 2);
  if (secs < 45) return "just now";
  if (secs < 3600) return `≈ ${Math.round(secs / 60)} min ago`;
  return `≈ ${Math.round(secs / 3600)} h ago`;
}

function Activity({ merchant }: { merchant: MerchantSession }) {
  // Default to the LOCAL PayPhone wallet when this browser holds one — the
  // scan must watch the address the user actually receives on, not just the
  // merchant payout wallet. (Watching a mismatched address is exactly how
  // "explorer shows my transfer, dashboard shows nothing" used to happen.)
  const [address, setAddress] = useState(walletAddressStored() ?? merchant.wallet);
  const [windowBlocks, setWindowBlocks] = useState<string>("2000");
  const [direction, setDirection] = useState<"both" | "in" | "out">("both");
  const [data, setData] = useState<WalletActivityAll | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [auto, setAuto] = useState(true);

  const scan = useCallback(
    async (opts?: { silent?: boolean }) => {
      const addr = address.trim();
      if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
        setError("Enter an EVM address (0x + 40 hex characters).");
        return;
      }
      if (!opts?.silent) setBusy(true);
      try {
        const d = await api.walletActivityAll(addr, {
          blocks: Number(windowBlocks),
          direction,
        });
        setData(d);
        setError(null);
      } catch (e) {
        const msg = e instanceof ApiError ? e.message : "scan failed — engine offline?";
        if (!opts?.silent) setError(msg);
      } finally {
        if (!opts?.silent) setBusy(false);
      }
    },
    [address, windowBlocks, direction]
  );

  // First scan when the tab mounts / parameters change; auto-poll while on.
  useEffect(() => {
    void scan();
  }, [scan]);
  useEffect(() => {
    if (!auto) return;
    const t = window.setInterval(() => void scan({ silent: true }), 15000);
    return () => window.clearInterval(t);
  }, [auto, scan]);

  const transfers = data?.transfers ?? [];
  const incoming = transfers.filter((t) => t.direction === "in");
  const outgoing = transfers.filter((t) => t.direction === "out");
  const pending = transfers.filter((t) => !t.confirmed);

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2.5 text-sm">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
        <p className="text-muted-foreground">
          <strong className="text-foreground">Every transfer is on-chain — nothing can go missing.</strong>{" "}
          If a block explorer can see it, it shows here: on the network the sender{" "}
          <em>actually used</em>, with live confirmations and a link you can verify yourself.
          Picked Optimism but the exchange sent on World Chain? The money still lands — this
          panel shows exactly where.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <ActivityIcon className="h-4 w-4 text-primary" /> Wallet activity — all networks
            </CardTitle>
            <div className="flex items-center gap-2">
              <Button size="sm" variant={auto ? "secondary" : "outline"} onClick={() => setAuto(!auto)} className="h-8 text-xs">
                <RefreshCw className={`mr-1 h-3 w-3 ${auto && busy ? "animate-spin" : ""}`} />
                auto {auto ? "15s" : "off"}
              </Button>
              <Button size="sm" onClick={() => void scan()} disabled={busy} className="h-8 text-xs">
                Scan now
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
            <div className="space-y-1">
              <Label htmlFor="activity-address">Watched address</Label>
              <Input
                id="activity-address"
                placeholder="0x… your PayPhone receiving wallet"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                className="font-mono text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label>History</Label>
              <Select value={windowBlocks} onValueChange={setWindowBlocks}>
                <SelectTrigger className="h-9 w-[150px] text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {WINDOW_PRESETS.map((p) => (
                    <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Direction</Label>
              <Select value={direction} onValueChange={(v) => setDirection(v as "both" | "in" | "out")}>
                <SelectTrigger className="h-9 w-[110px] text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="both">In + out</SelectItem>
                  <SelectItem value="in">Incoming</SelectItem>
                  <SelectItem value="out">Outgoing</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {error && (
            <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">{error}</p>
          )}

          {/* scanned networks + native balances strip */}
          {data && (
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="text-muted-foreground">scanned:</span>
              {data.scanned_networks.map((n) => (
                <Badge key={n} variant="secondary" className="text-[10px]">{n}</Badge>
              ))}
              {data.skipped_networks.map((s) => (
                <Badge key={s.network} variant="outline" className="text-[10px] text-amber-600" title={s.note}>
                  {s.network} ⚠
                </Badge>
              ))}
              {data.native_balances.map((nb) => (
                <span key={nb.network} className="ml-1 rounded border bg-background/60 px-1.5 py-0.5 font-mono text-[10px]">
                  {fmtQty(nb.qty)} {nb.asset} <span className="text-muted-foreground">on {nb.network}</span>
                </span>
              ))}
              <span className="ml-auto text-[10px] text-muted-foreground">
                {data.transfer_count} transfer{data.transfer_count === 1 ? "" : "s"} · window {data.window_blocks} blocks{data.cache === "hit" ? " · cached" : ""}
              </span>
            </div>
          )}

          {transfers.length === 0 ? (
            <div className="rounded-lg border border-dashed px-4 py-8 text-center text-sm">
              {busy ? (
                <span className="text-muted-foreground">Scanning every supported network…</span>
              ) : (
                <div className="space-y-1.5">
                  <p className="font-medium">No transfers found in this window.</p>
                  <p className="mx-auto max-w-md text-xs text-muted-foreground">
                    Nothing touching this address on any supported network in the scanned
                    blocks. If you just sent funds: exchanges batch withdrawals, so a
                    transfer can take a few minutes to appear. Pick a deeper history
                    window, or check the sender&apos;s withdrawal status — once it lands on-chain,
                    it appears here automatically.
                  </p>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              {transfers.map((t) => {
                const isIn = t.direction === "in";
                return (
                  <div
                    key={`${t.tx_hash}-${t.log_index}-${t.direction}`}
                    className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border px-3 py-2.5 text-sm ${
                      isIn ? "border-emerald-500/25 bg-emerald-500/[0.04]" : "border-amber-500/25 bg-amber-500/[0.04]"
                    }`}
                  >
                    <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
                      isIn ? "bg-emerald-500/15 text-emerald-600" : "bg-amber-500/15 text-amber-600"
                    }`}>
                      {isIn ? <ArrowDownLeft className="h-4 w-4" /> : <ArrowUpRight className="h-4 w-4" />}
                    </span>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className={`font-semibold ${isIn ? "text-emerald-600" : "text-amber-600"}`}>
                          {isIn ? "+" : "−"}{fmtQty(t.qty)} {t.asset ?? shortHash(t.asset_address, 6)}
                        </span>
                        <Badge variant="outline" className="text-[10px] uppercase tracking-wide">
                          {t.network}
                        </Badge>
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
                        <span>{isIn ? "from" : "to"} <span className="font-mono">{shortHash(t.counterparty, 8)}</span></span>
                        <span>·</span>
                        <a
                          href={t.explorer_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-0.5 font-mono text-primary hover:underline"
                        >
                          {shortHash(t.tx_hash, 8)} <ExternalLink className="h-3 w-3" />
                        </a>
                        <span>·</span>
                        <span>{agoLabel(t.confirmations, data?.block_time_secs?.[t.network])}</span>
                      </div>
                    </div>
                    <div className="ml-auto text-right">
                      {t.confirmed ? (
                        <Badge variant="default" className="bg-emerald-600 text-[10px] text-white">confirmed</Badge>
                      ) : (
                        <Badge variant="outline" className="text-[10px] text-amber-600" title="Network confirmations still accumulating before finality">
                          detected · {t.confirmations}/{t.required_confirmations} confs
                        </Badge>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {data && data.notes.length > 0 && (
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              scan notes: {data.notes.join(" · ")}
            </p>
          )}

          {data && (
            <p className="text-[11px] text-muted-foreground">
              {incoming.length} incoming · {outgoing.length} outgoing · {pending.length} pending confirmations.
              Native-coin (non-token) history is shown as live balances; token transfers are fully listed.
              All reads are watch-only — PayPhone never custodies funds.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

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
            {busy ? <RefreshCw className="h-4 w-4 animate-spin" /> : <ActivityIcon className="h-4 w-4" />} Send signed test event
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

// -------------------------------------------------------------- connectors ----

/**
 * Connectors — the universal payment receiver.
 *
 * One Client ID + Secret that ANY platform can hold (PayPal PYUSD off-ramps,
 * Payoneer/Grey bridge flows, a SaaS backend). The platform mints a payment
 * request with POST /v1/connect/payments {asset, amount_usd_cents,
 * reference} and the engine auto-routes the money into the wallet the owner
 * picked for that asset — address-to-address on-chain, never custodied.
 */

const DEMO_BUILD = process.env.NEXT_PUBLIC_PAYPHONE_DEMO === "1";

type RouteDraft = { asset: string; network: string; wallet: string };

/**
 * Sentinel for the network select's "Auto" option — Radix Select forbids an
 * empty-string SelectItem value (it crashes the whole client on render), so
 * "auto" maps back to "" (engine default venue) when the payload is built.
 */
const AUTO_NETWORK = "auto";

function connectorSnippet(base: string, conn: StoredConnector): string {
  return `curl -X POST ${base}/api/v1/connect/payments \\
  -H "X-PayPhone-Client: ${conn.client_id}" \\
  -H "X-PayPhone-Secret: ${conn.client_secret}" \\
  -H "Content-Type: application/json" \\
  -d '{"asset":"USDC","amount_usd_cents":2500,"reference":"order-1042"}'`;
}

function Connectors({ merchant }: { merchant: MerchantSession }) {
  const raw = useSyncExternalStore(connectorStore.subscribe, connectorStore.raw, () => null);
  const connectors = useMemo<StoredConnector[]>(() => {
    try {
      return raw ? (JSON.parse(raw) as StoredConnector[]) : [];
    } catch {
      return [];
    }
  }, [raw]);
  const [selected, setSelected] = useState<string | null>(null);
  const [assets, setAssets] = useState<AssetEntry[]>([]);
  const [label, setLabel] = useState("");
  const [defaultWallet, setDefaultWallet] = useState(walletAddressStored() ?? merchant.wallet);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [drafts, setDrafts] = useState<RouteDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<StoredConnector | null>(null);
  const { toast } = useToast();

  // Live asset catalog drives the route builder (same source the engine routes by).
  useEffect(() => {
    let cancelled = false;
    api.assets().then((sheet) => {
      if (cancelled || !sheet?.assets?.length) return;
      setAssets(sheet.assets.filter((a) => a.settleable));
    }).catch(() => { /* builder falls back to USDC-only */ });
    return () => { cancelled = true; };
  }, []);

  const active = connectors.find((c) => c.client_id === selected) ?? connectors[0] ?? null;

  function setDraft(i: number, patch: Partial<RouteDraft>) {
    setDrafts((d) => d.map((row, j) => (j === i ? { ...row, ...patch } : row)));
  }

  function addDraft() {
    const first = assets[0]?.symbol ?? "USDC";
    setDrafts((d) => [...d, { asset: first, network: "", wallet: defaultWallet }]);
  }

  async function create() {
    if (DEMO_BUILD) {
      toast({
        title: "Connectors run on the live engine",
        description: "This static demo build can't mint connectors — point the console at a deployed PayPhone engine.",
        variant: "destructive",
      });
      return;
    }
    const routes = drafts
      .filter((d) => d.asset && d.wallet.trim())
      .map((d) => {
        const entry = assets.find((a) => a.symbol === d.asset);
        const sn = entry?.settleable_networks.find((s) => `${s.chain}/${s.network}` === d.network);
        return {
          asset: d.asset,
          chain: sn?.chain ?? entry?.default_chain,
          network: sn?.network ?? "",
          wallet: d.wallet.trim(),
        };
      });
    if (!defaultWallet.trim() && routes.length === 0) {
      toast({
        title: "Pick at least one destination",
        description: "A default wallet (receives every asset that fits its shape) or explicit per-asset routes.",
        variant: "destructive",
      });
      return;
    }
    setBusy(true);
    try {
      const r = await api.createConnector({
        label: label.trim() || undefined,
        default_wallet: defaultWallet.trim() || undefined,
        routes: routes.length ? routes : undefined,
        webhook_url: webhookUrl.trim() || undefined,
      });
      const stored: StoredConnector = {
        client_id: r.client_id,
        client_secret: r.client_secret,
        label: r.label,
        routes: r.routes,
        webhook_url: r.webhook_url,
        created_at: Math.floor(Date.now() / 1000),
      };
      connectorStore.upsert(stored);
      setIssued(stored);
      setSelected(stored.client_id);
      setDrafts([]);
      toast({ title: "Connector created", description: "Client secret shown once — hand it to the platform integration." });
    } catch (e) {
      toast({ title: "Connector creation failed", description: e instanceof Error ? e.message : "unknown error", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function rotate(conn: StoredConnector) {
    try {
      const r = await api.rotateConnectorSecret(conn.client_id, conn.client_secret);
      const updated = { ...conn, client_secret: r.client_secret };
      connectorStore.patch(conn.client_id, { client_secret: r.client_secret });
      setIssued(updated);
      toast({ title: "Secret rotated", description: "The previous secret is dead — the new one is shown once." });
    } catch (e) {
      toast({ title: "Rotation failed", description: e instanceof Error ? e.message : "unknown error", variant: "destructive" });
    }
  }

  const base = typeof window !== "undefined" ? window.location.origin : "https://your-engine.example.com";

  return (
    <div className="grid gap-4 lg:grid-cols-[420px_1fr]">
      {/* ------------------------------------------------- create connector */}
      <Card className="self-start">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Cable className="h-4 w-4 text-primary" /> Create connector
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            A universal receiver: one credential pair any platform can pay through, with YOU deciding
            which wallet each currency lands in.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="conn-label">Label</Label>
            <Input id="conn-label" placeholder="Checkout receiver — main store" value={label} onChange={(e) => setLabel(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="conn-default">
              Default destination wallet <span className="text-muted-foreground">(receives every asset that fits its shape)</span>
            </Label>
            <Input
              id="conn-default"
              placeholder="0x… (EVM) · bc1… (Bitcoin) · T… (Tron) · base58 (Solana)"
              value={defaultWallet}
              onChange={(e) => setDefaultWallet(e.target.value)}
              className="font-mono text-xs"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="conn-webhook">Webhook URL <span className="text-muted-foreground">(optional — invoice.paid etc.)</span></Label>
            <Input id="conn-webhook" placeholder="https://api.yourapp.com/payphone" value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} />
          </div>

          {/* per-asset overrides — "I want USDC to sit on Base, ETH on Ethereum" */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Per-asset routes <span className="text-muted-foreground">(optional overrides)</span></Label>
              <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={addDraft} disabled={!assets.length}>
                <Plus className="h-3 w-3" /> Add route
              </Button>
            </div>
            {drafts.length === 0 && (
              <p className="text-[11px] text-muted-foreground">
                Example: USDC → Base wallet, ETH → Ethereum wallet, PYUSD (PayPal USD) → Ethereum wallet.
              </p>
            )}
            {drafts.map((d, i) => {
              const entry = assets.find((a) => a.symbol === d.asset);
              return (
                <div key={i} className="space-y-1.5 rounded-lg border bg-background/40 p-2.5">
                  <div className="grid grid-cols-2 gap-2">
                    <Select
                      value={d.asset}
                      onValueChange={(v) => {
                        const next = assets.find((a) => a.symbol === v);
                        const stillSettles = next?.settleable_networks.some((s) => `${s.chain}/${s.network}` === d.network);
                        setDraft(i, { asset: v, network: stillSettles ? d.network : "" });
                      }}
                    >
                      <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent className="max-h-64">
                        {assets.map((a) => (
                          <SelectItem key={a.symbol} value={a.symbol}>{a.symbol} — {a.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select
                      value={d.network || AUTO_NETWORK}
                      onValueChange={(v) => setDraft(i, { network: v === AUTO_NETWORK ? "" : v })}
                    >
                      <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value={AUTO_NETWORK}>Auto — {entry?.default_network ?? "default venue"}</SelectItem>
                        {(entry?.settleable_networks ?? []).map((s) => (
                          <SelectItem key={`${s.chain}/${s.network}`} value={`${s.chain}/${s.network}`}>
                            {s.chain === "evm" ? s.network : `${s.chain}/${s.network}`}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex gap-2">
                    <Input
                      placeholder="Destination wallet for this asset"
                      value={d.wallet}
                      onChange={(e) => setDraft(i, { wallet: e.target.value })}
                      className="h-8 font-mono text-xs"
                    />
                    <Button size="sm" variant="ghost" className="h-8 w-8 shrink-0 p-0 text-muted-foreground hover:text-destructive" aria-label="Remove route" onClick={() => setDrafts((rows) => rows.filter((_, j) => j !== i))}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>

          <Button className="w-full gap-2" onClick={create} disabled={busy}>
            {busy ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Cable className="h-4 w-4" />}
            {busy ? "Minting connector…" : "Create connector"}
          </Button>

          {issued && (
            <div className="space-y-2 rounded-lg border border-primary/40 bg-primary/5 p-3 text-sm">
              <div className="font-medium text-primary">Connector ready — client secret shown ONCE</div>
              <div className="flex flex-wrap items-center gap-2">
                <MonoValue value={issued.client_id} display={`client_id ${shortHash(issued.client_id, 12)}`} />
                <MonoValue value={issued.client_secret} display={`client_secret ${issued.client_secret.slice(0, 10)}…`} />
              </div>
              <p className="text-xs text-muted-foreground">
                The engine stores only a keyed hash — this browser holds the only copy. Losing it means rotating.
              </p>
              <CodeBlock lang="bash" code={connectorSnippet(base, issued)} />
            </div>
          )}
        </CardContent>
      </Card>

      {/* ------------------------------------------------------- right side */}
      <div className="space-y-4">
        {/* connector list */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Your connectors ({connectors.length})</CardTitle>
          </CardHeader>
          <CardContent>
            {connectors.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No connectors yet — create one and hand the credentials to any platform.
              </p>
            ) : (
              <div className="space-y-2">
                {connectors.map((c) => (
                  <div
                    key={c.client_id}
                    className={`rounded-lg border px-3 py-2.5 text-sm ${active?.client_id === c.client_id ? "border-primary/50 bg-primary/5" : "bg-background/40"}`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <button type="button" className="min-w-0 text-left" onClick={() => setSelected(c.client_id)}>
                        <div className="font-medium">{c.label || "Untitled connector"}</div>
                        <div className="mt-0.5 font-mono text-xs text-muted-foreground">{shortHash(c.client_id, 14)}</div>
                      </button>
                      <div className="flex items-center gap-1.5">
                        <Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-xs" onClick={() => rotate(c)} title="Replace the client secret">
                          <RotateCw className="h-3 w-3" /> Rotate
                        </Button>
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive" aria-label="Forget connector locally" onClick={() => connectorStore.remove(c.client_id)} title="Forget locally (the engine record lives until restart)">
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {c.routes.map((r, i) => (
                        <Badge key={i} variant="outline" className="text-[10px]">
                          {r.asset === "*" ? "ANY" : r.asset} → {r.chain === "evm" ? (r.network || "default") : r.chain}
                        </Badge>
                      ))}
                      {c.webhook_url && <Badge variant="secondary" className="text-[10px]">webhook</Badge>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* incoming payments */}
        <ConnectorPayments conn={DEMO_BUILD ? null : active} />

        {/* the guide — what this unlocks, honestly */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Receiving from any platform</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-2.5">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
              <p className="text-xs leading-relaxed text-muted-foreground">
                <strong className="text-foreground">Non-custodial by construction.</strong> A minted payment
                request points straight at YOUR wallet for that asset — funds move address-to-address on-chain
                and the engine verifies the transfer live. PayPhone never holds the money, so there is nothing
                to withdraw, freeze or lose.
              </p>
            </div>
            <div>
              <div className="font-medium">PayPal → PYUSD (works today)</div>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                PYUSD is PayPal&apos;s own stablecoin, live on Ethereum and Arbitrum. Eligible PayPal users can
                withdraw PYUSD to any 0x… address — add a PYUSD route above and PayPal money lands in your wallet
                like any other crypto. Own the PayPal account? The <strong>PayPal tab</strong> verifies your
                Client ID/Secret live against PayPal and walks the USD → PYUSD → wallet bridge with your
                destination address pre-filled. Other PayPal balances can only be off-ramped by PayPal itself
                (no third party can pull from them — that&apos;s a PayPal policy, not a PayPhone limit).
              </p>
            </div>
            <div>
              <div className="font-medium">Payoneer · Grey · Wise → bridge flows</div>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Their fiat rails are account-gated on their side. Two bridges work today: (1) withdraw to bank /
                mobile money, buy USDT or USDC on any on-ramp, send on-chain to your connector destination — the
                payment shows up in the feed below; (2) platforms with business APIs call{" "}
                <span className="font-mono text-[11px]">POST /v1/connect/payments</span> with your credentials and
                pay the minted request — full API docs in the Docs tab.
              </p>
            </div>
            <div>
              <div className="font-medium">Any crypto platform → native</div>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                One credential pair receives USDC, USDT, ETH, BTC, SOL, PYUSD and more across 10+ networks —
                you choose which wallet each currency sits in, and webhooks announce every settled payment.
              </p>
            </div>
            {active && <CodeBlock lang="bash" code={connectorSnippet(base, active)} />}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/** Live payment feed for the selected connector (10s poll). */
function ConnectorPayments({ conn }: { conn: StoredConnector | null }) {
  const [rows, setRows] = useState<ConnectorPaymentSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);

  const load = useCallback(
    async (silent?: boolean) => {
      if (!conn) return;
      try {
        const d = await api.connectPayments(conn.client_id, conn.client_secret);
        setRows(d.payments);
        setError(null);
        setCheckedAt(Date.now());
      } catch (e) {
        if (!silent) setError(e instanceof Error ? e.message : "engine offline?");
      }
    },
    [conn]
  );

  useEffect(() => {
    setRows([]);
    setError(null);
    void load();
  }, [load]);
  useEffect(() => {
    if (!conn) return;
    const t = window.setInterval(() => void load(true), 10000);
    return () => window.clearInterval(t);
  }, [conn, load]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <ArrowDownLeft className="h-4 w-4 text-primary" /> Incoming connector payments
          </CardTitle>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {checkedAt && <span>checked {new Date(checkedAt).toLocaleTimeString()}</span>}
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => void load()} disabled={!conn}>
              Refresh
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {!conn ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Select a connector to watch its payment feed.
          </p>
        ) : error ? (
          <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">{error}</p>
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No payments minted yet — the platform (or your curl) creates them via POST /v1/connect/payments.
          </p>
        ) : (
          <div className="pp-scroll max-h-80 space-y-2 overflow-y-auto pr-1">
            {rows.map((p) => (
              <div key={p.payment_id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-background/40 px-3 py-2.5 text-sm">
                <div className="min-w-0">
                  <div className="font-medium">
                    {usd(p.amount_usd_cents)} <span className="text-xs font-normal text-muted-foreground">· {p.asset} on {p.network || p.chain}</span>
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {p.reference || "no reference"} · {shortHash(p.payment_id, 10)} · → {shortHash(p.destination, 8)}
                  </div>
                </div>
                <Badge
                  variant={p.status === "paid" ? "default" : p.status === "expired" ? "secondary" : "outline"}
                  className="text-xs"
                >
                  {p.status}
                </Badge>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ------------------------------------------------------------------ paypal ----

/**
 * PayPal bridge — the owner's OWN PayPal account, connected and verified
 * live. PayPal's REST API cannot be driven from the browser (CORS), so the
 * engine performs the verification call: credentials go through one TLS
 * request and are discarded — the engine never stores them.
 *
 * The honest pipeline this tab walks:
 *   PayPal USD balance → buy PYUSD in the PayPal app → send PYUSD on-chain
 *   to YOUR destination address → the engine observes the transfer like any
 *   other asset payment (paid at network depth, webhook fires) → the wallet
 *   is free to spend/swap/send it anywhere.
 */

const LS_PAYPAL = "payphone.paypal.v1";
type PayPalEnv = "sandbox" | "live";

function PayPalTab({ merchant }: { merchant: MerchantSession }) {
  const [env, setEnv] = useState<PayPalEnv>("sandbox");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [remember, setRemember] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [status, setStatus] = useState<{ app_id: string | null; scopes: string[]; environment: string } | null>(null);
  const [balances, setBalances] = useState<{ currency: string; total: string; primary: boolean }[] | null>(null);
  const [balanceAsOf, setBalanceAsOf] = useState<string | null>(null);
  const [balanceBusy, setBalanceBusy] = useState(false);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [dest, setDest] = useState(walletAddressStored() ?? merchant.wallet);
  const { toast } = useToast();

  // Restored ONLY if the user opted into remembering on this device.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_PAYPAL);
      if (!raw) return;
      const c = JSON.parse(raw) as { client_id?: string; client_secret?: string; environment?: PayPalEnv };
      if (c.client_id && c.client_secret) {
        setClientId(c.client_id);
        setClientSecret(c.client_secret);
        setEnv(c.environment ?? "sandbox");
        setRemember(true);
      }
    } catch {
      /* no remembered credentials */
    }
  }, []);

  function persistChoice() {
    try {
      if (remember && clientId.trim() && clientSecret.trim()) {
        localStorage.setItem(LS_PAYPAL, JSON.stringify({ client_id: clientId.trim(), client_secret: clientSecret.trim(), environment: env }));
      } else {
        localStorage.removeItem(LS_PAYPAL);
      }
    } catch {
      /* storage unavailable */
    }
  }

  async function verify() {
    if (!clientId.trim() || !clientSecret.trim()) {
      toast({ title: "Enter both credentials", description: "Client ID and Secret from developer.paypal.com → Apps & Credentials.", variant: "destructive" });
      return;
    }
    setVerifying(true);
    setStatus(null);
    setBalances(null);
    try {
      const r = await api.paypalVerify({ client_id: clientId.trim(), client_secret: clientSecret.trim(), environment: env });
      setStatus({ app_id: r.app_id, scopes: r.scopes, environment: r.environment });
      persistChoice();
      toast({ title: "PayPal credentials verified", description: `app ${r.app_id ?? "?"} · ${r.environment}` });
    } catch (e) {
      toast({ title: "PayPal said no", description: e instanceof Error ? e.message : "unknown error", variant: "destructive" });
    } finally {
      setVerifying(false);
    }
  }

  async function loadBalance() {
    if (!clientId.trim() || !clientSecret.trim()) return;
    setBalanceBusy(true);
    setBalanceError(null);
    try {
      const r = await api.paypalBalance({ client_id: clientId.trim(), client_secret: clientSecret.trim(), environment: env });
      setBalances(r.balances);
      setBalanceAsOf(r.as_of_time);
    } catch (e) {
      setBalanceError(e instanceof Error ? e.message : "unknown error");
    } finally {
      setBalanceBusy(false);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {/* ---------------------------------------------------- connect card */}
      <Card className="self-start">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Landmark className="h-4 w-4 text-primary" /> Connect PayPal
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Your own PayPal account, verified live. Get free keys at{" "}
            <a className="text-primary underline underline-offset-2" href="https://developer.paypal.com/dashboard/applications" target="_blank" rel="noreferrer">
              developer.paypal.com → Apps &amp; Credentials <ExternalLink className="inline h-3 w-3" />
            </a>{" "}
            — create an app, copy the Client ID and Secret. Use <strong>sandbox</strong> first (free test
            accounts), <strong>live</strong> for real money.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-2">
            <Label>Environment</Label>
            <Select value={env} onValueChange={(v) => setEnv(v as PayPalEnv)}>
              <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="sandbox">Sandbox — free test credentials</SelectItem>
                <SelectItem value="live">Live — real PayPal account</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="pp-id">Client ID</Label>
            <Input id="pp-id" placeholder="AeA1QIZXi…" value={clientId} onChange={(e) => setClientId(e.target.value)} className="font-mono text-xs" autoComplete="off" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="pp-secret">Secret</Label>
            <Input id="pp-secret" type="password" placeholder="EGnHDxD_qRPd…" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} className="font-mono text-xs" autoComplete="off" />
          </div>
          <div className="flex items-start gap-2">
            <Checkbox id="pp-remember" checked={remember} onCheckedChange={(v) => setRemember(v === true)} className="mt-0.5" />
            <Label htmlFor="pp-remember" className="text-xs font-normal text-muted-foreground">
              Remember on this device (stored in this browser only — the engine never keeps PayPal
              credentials; each check passes them through one encrypted call and discards them)
            </Label>
          </div>
          <Button className="w-full gap-2" onClick={verify} disabled={verifying}>
            {verifying ? <RefreshCw className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
            {verifying ? "Verifying with PayPal…" : "Verify credentials live"}
          </Button>

          {status && (
            <div className="space-y-1.5 rounded-lg border border-primary/40 bg-primary/5 p-3 text-sm">
              <div className="font-medium text-primary">Connected — PayPal answered</div>
              <div className="flex flex-wrap items-center gap-2">
                <MonoValue value={status.app_id ?? "—"} display={`app_id ${status.app_id ?? "—"}`} />
                <Badge variant="outline" className="text-[10px]">{status.environment}</Badge>
              </div>
              {status.scopes.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  {status.scopes.length} granted scope{status.scopes.length === 1 ? "" : "s"} — {status.scopes.slice(0, 3).map((s) => s.split("/").pop()).filter(Boolean).join(", ")}
                  {status.scopes.length > 3 ? "…" : ""}
                </p>
              )}
              <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={loadBalance} disabled={balanceBusy}>
                {balanceBusy ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Landmark className="h-3 w-3" />}
                Read USD balance
              </Button>
              {balances && (
                <div className="pt-1">
                  {balances.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No balances reported for this account yet.</p>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {balances.map((b, i) => (
                        <Badge key={i} variant="secondary" className="text-xs">
                          {b.currency} {usd(Math.round(parseFloat(b.total || "0") * 100))}
                        </Badge>
                      ))}
                    </div>
                  )}
                  {balanceAsOf && <p className="mt-1 text-[10px] text-muted-foreground">as of {new Date(balanceAsOf).toLocaleString()}</p>}
                </div>
              )}
              {balanceError && (
                <p className="text-xs text-muted-foreground">{balanceError}</p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ----------------------------------------------------- right side */}
      <div className="space-y-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">PayPal dollars → PYUSD → your wallet</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="space-y-2">
              <Label htmlFor="pp-dest">Destination address for PYUSD on-chain</Label>
              <div className="flex gap-2">
                <Input id="pp-dest" value={dest} onChange={(e) => setDest(e.target.value)} className="font-mono text-xs" placeholder="0x… (Ethereum or Arbitrum)" />
              </div>
              <p className="text-[11px] text-muted-foreground">
                Your PayPhone wallet address works — PYUSD settles on Ethereum and Arbitrum. Add an explicit
                PYUSD route in the <strong>Connectors</strong> tab so arriving PayPal money auto-routes here.
              </p>
            </div>
            <ol className="space-y-2.5">
              {[
                {
                  t: "Buy PYUSD with your USD balance",
                  d: "In the PayPal app: Finances → Crypto (or Buy) → PYUSD → Buy. Your USD balance converts to PYUSD at the rate PayPal shows you.",
                },
                {
                  t: "Send PYUSD to the destination address",
                  d: "PayPal → PYUSD → Send → paste the address above. Double-check the first and last characters — on-chain sends are irreversible.",
                },
                {
                  t: "PayPhone confirms it on-chain",
                  d: "The engine watches PYUSD on Ethereum/Arbitrum. When the transfer reaches network depth the payment flips to paid and your webhooks fire — no manual claiming.",
                },
                {
                  t: "Put it to work",
                  d: "The wallet can now spend it: send to any phone number (Phone-ID) or address, swap into USDC/ETH on a DEX, or pay utilities and services that accept stablecoins.",
                },
              ].map((s, i) => (
                <li key={i} className="flex gap-2.5">
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[11px] font-semibold text-primary">{i + 1}</span>
                  <div>
                    <div className="font-medium">{s.t}</div>
                    <p className="text-xs leading-relaxed text-muted-foreground">{s.d}</p>
                  </div>
                </li>
              ))}
            </ol>
            {dest.trim() && <MonoValue value={dest.trim()} display={`destination ${shortHash(dest.trim(), 12)}`} />}
            <p className="flex items-start gap-2 rounded-lg border bg-muted/30 p-2.5 text-[11px] leading-relaxed text-muted-foreground">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              Buying and external-sending PYUSD are PayPal in-app actions gated by PayPal (region and account
              status) — no API exists for a third party to move your PayPal balance, which is exactly why this
              tab verifies YOUR keys and guides YOUR app steps instead of pretending otherwise.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Which keys do what — no confusion</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2.5 text-sm">
            <div className="rounded-lg border bg-background/40 p-2.5">
              <div className="flex items-center gap-2 font-medium"><Cable className="h-3.5 w-3.5 text-primary" /> PayPhone connector keys (cn_ / cs_)</div>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Created in the <strong>Connectors</strong> tab. Give these to PLATFORMS so they can pay you —
                they can only mint payment requests to your wallets, nothing else.
              </p>
            </div>
            <div className="rounded-lg border bg-background/40 p-2.5">
              <div className="flex items-center gap-2 font-medium"><Landmark className="h-3.5 w-3.5 text-primary" /> PayPal keys (Client ID / Secret)</div>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                From PayPal, for YOUR OWN account. Never share them with anyone — this tab uses them only to
                verify and read balances. Whoever holds them can act on your PayPal app.
              </p>
            </div>
            <div className="rounded-lg border bg-background/40 p-2.5">
              <div className="flex items-center gap-2 font-medium"><ArrowDownLeft className="h-3.5 w-3.5 text-primary" /> Payers need neither</div>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Anyone paying you just opens the payment link — no PayPhone account, no PayPal account, no keys.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
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
