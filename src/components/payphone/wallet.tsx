"use client";

/**
 * PayPhone Wallet — the non-custodial, phone-number-first wallet view.
 *
 * Three states:
 *   absent  → create / import (keys generated or imported locally)
 *   locked  → passphrase unlock (AES-GCM keystore in localStorage)
 *   open    → balances, send (phone = fee-free loop, 0x = external + fee),
 *             activity, reveal/export/destroy
 *
 * This component NEVER sends key material anywhere. All signing is local;
 * the engine only sees: fee-schedule reads, phone lookups, and — for
 * simnet-mode demo invoices — settlement requests that carry no secrets.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
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
  AlertTriangle, ArrowDownToLine, ArrowRightLeft, CheckCircle2, Copy, Eye, ExternalLink,
  KeyRound, Loader2, Lock, Plus, RefreshCw, Send, ShieldCheck, Trash2, Wallet as WalletIcon,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { SendRightNotice } from "./asset-safety";
import {
  WALLET_CHAINS, activityLog, feePreview, walletAddress, walletAddressStored,
  walletBalances, walletCreate, walletDestroy, walletExists,
  walletImportMnemonic, walletImportPrivateKey, walletIsUnlocked, walletLock,
  walletRevealSecret, walletSend, resolveRecipient, walletUnlock, walletIncoming,
  type Recipient, type SendResult, type TokenBalance, type WalletActivity,
  type WalletRadar,
} from "@/lib/payphone/wallet";
import { WALLET_SEND_FEE_BPS } from "@/lib/payphone/wallet";
import { ApiError } from "@/lib/payphone/api";

export interface WalletPrefill {
  network?: string;
  asset?: string;
  to?: string;
  amount?: string;
}

function short(a: string): string {
  return a.length > 15 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a;
}

export function Wallet({ prefill }: { prefill?: WalletPrefill }) {
  const [exists, setExists] = useState(false);
  const [open, setOpen] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setExists(walletExists());
    setOpen(walletIsUnlocked());
    setReady(true);
  }, []);

  const refresh = useCallback(() => {
    setExists(walletExists());
    setOpen(walletIsUnlocked());
  }, []);

  if (!ready) return null;

  if (!exists) return <Onboarding onDone={refresh} />;
  if (!open) return <Unlock onUnlock={refresh} onLockedReset={refresh} />;
  return <WalletMain prefill={prefill} onChanged={refresh} />;
}

// ------------------------------------------------------------- onboarding --

function Onboarding({ onDone }: { onDone: () => void }) {
  const { toast } = useToast();
  const [mode, setMode] = useState<"create" | "import">("create");
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [mnemonic, setMnemonic] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [importWords, setImportWords] = useState("");
  const [importKey, setImportKey] = useState("");
  const [busy, setBusy] = useState(false);

  const passOk = pass.length >= 8 && pass === pass2;

  async function create() {
    setBusy(true);
    try {
      const { mnemonic } = await walletCreate(pass);
      setMnemonic(mnemonic);
    } catch (e) {
      toast({ title: "Could not create wallet", description: String((e as Error).message ?? e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function finishCreate() {
    onDone();
    toast({ title: "Wallet created", description: "Encrypted locally. Only you hold the keys." });
  }

  async function doImportMnemonic() {
    setBusy(true);
    try {
      const addr = await walletImportMnemonic(importWords, pass);
      toast({ title: "Wallet imported", description: addr });
      onDone();
    } catch (e) {
      toast({ title: "Import failed", description: String((e as Error).message ?? e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function doImportKey() {
    setBusy(true);
    try {
      const addr = await walletImportPrivateKey(importKey, pass);
      toast({ title: "Wallet imported", description: addr });
      onDone();
    } catch (e) {
      toast({ title: "Import failed", description: String((e as Error).message ?? e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  if (mnemonic) {
    return (
      <Card className="mx-auto max-w-xl border-primary/30">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><ShieldCheck className="h-5 w-5 text-primary" /> Write down your recovery phrase</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            These 12 words are the <span className="text-foreground">only way</span> to recover your wallet.
            We encrypt them with your passphrase in this browser — we cannot show them again, cannot
            reset them, and never send them anywhere. Anyone with these words controls the funds.
          </p>
          <div className="grid grid-cols-3 gap-2 rounded-lg border bg-muted/40 p-4 font-mono text-sm">
            {mnemonic.split(" ").map((w, i) => (
              <span key={i}><span className="mr-1 text-muted-foreground">{i + 1}.</span>{w}</span>
            ))}
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            I wrote the 12 words down and stored them somewhere safe (paper, offline).
          </label>
          <Button className="w-full" disabled={!confirmed} onClick={finishCreate}>
            <CheckCircle2 className="mr-2 h-4 w-4" /> I&apos;m done — open my wallet
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><WalletIcon className="h-5 w-5 text-primary" /> Set up your PayPhone Wallet</CardTitle>
          <p className="text-sm text-muted-foreground">
            Non-custodial: keys are generated in this browser and encrypted with your passphrase.
            PayPhone the network never sees them — and can never freeze your funds.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <Tabs value={mode} onValueChange={(v) => setMode(v as "create" | "import")}>
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="create"><Plus className="mr-1.5 h-4 w-4" />Create new</TabsTrigger>
              <TabsTrigger value="import"><KeyRound className="mr-1.5 h-4 w-4" />Import</TabsTrigger>
            </TabsList>            {/* onValueChange gives a string — narrow it back */}
            <TabsContent value="create" className="space-y-4 pt-4">
              <p className="text-sm text-muted-foreground">A fresh wallet with a 12-word recovery phrase (standard BIP-39 — works with MetaMask, Rabby, Trust).</p>
              <Button className="w-full" disabled={!passOk || busy} onClick={create}>
                <Plus className="mr-2 h-4 w-4" /> Generate my wallet
              </Button>
            </TabsContent>
            <TabsContent value="import" className="space-y-4 pt-4">
              <div className="space-y-2">
                <Label>Recovery phrase (12–24 words) — or a private key below</Label>
                <Textarea className="font-mono text-sm" placeholder="word1 word2 word3 …" value={importWords} onChange={(e) => { setImportWords(e.target.value); setImportKey(""); }} />
                <Label className="pt-2">…or private key (0x…)</Label>
                <Input type="password" placeholder="0x…" value={importKey} onChange={(e) => { setImportKey(e.target.value); setImportWords(""); }} />
                <p className="text-xs text-muted-foreground">Imports are MetaMask-compatible (m/44&apos;/60&apos;/0&apos;/0/0) — the same seed yields the same addresses.</p>
              </div>
              <Button className="w-full" disabled={!passOk || busy || (!importWords && !importKey)}
                onClick={importWords ? doImportMnemonic : doImportKey}>
                <KeyRound className="mr-2 h-4 w-4" /> Import wallet
              </Button>
            </TabsContent>
          </Tabs>
          <Separator />
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Passphrase (encrypts the keystore)</Label>
              <Input type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder="min 8 characters" />
            </div>
            <div className="space-y-1.5">
              <Label>Repeat passphrase</Label>
              <Input type="password" value={pass2} onChange={(e) => setPass2(e.target.value)} placeholder="again" />
            </div>
          </div>
          <p className="flex items-start gap-2 rounded-md bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            If you forget this passphrase and lose the recovery phrase, your funds are unrecoverable — by design, by anyone.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

// ----------------------------------------------------------------- unlock --

function Unlock({ onUnlock, onLockedReset }: { onUnlock: () => void; onLockedReset: () => void }) {
  const { toast } = useToast();
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const stored = walletAddressStored();

  async function unlock() {
    setBusy(true);
    try {
      const addr = await walletUnlock(pass);
      toast({ title: "Wallet unlocked", description: addr });
      onUnlock();
    } catch (e) {
      toast({ title: "Unlock failed", description: String((e as Error).message ?? e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mx-auto max-w-md">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Lock className="h-5 w-5 text-primary" /> Unlock your wallet</CardTitle>
        <p className="text-sm text-muted-foreground">Keystore found for <span className="font-mono text-xs">{short(stored ?? "")}</span>. The passphrase decrypts it — locally, only.</p>
      </CardHeader>
      <CardContent className="space-y-4">
        <Input type="password" autoFocus value={pass} onChange={(e) => setPass(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && pass && unlock()} placeholder="passphrase" />
        <Button className="w-full" disabled={!pass || busy} onClick={unlock}><Lock className="mr-2 h-4 w-4" /> Unlock</Button>
        <Button variant="ghost" className="w-full text-destructive hover:text-destructive" onClick={() => {
          if (confirm("Remove the encrypted keystore from this browser? Without your recovery phrase the funds become unreachable.")) {
            walletDestroy();
            onLockedReset();
          }
        }}>
          <Trash2 className="mr-2 h-4 w-4" /> Remove keystore from this browser
        </Button>
      </CardContent>
    </Card>
  );
}

// ------------------------------------------------------------- wallet main --

function WalletMain({ prefill, onChanged }: { prefill?: WalletPrefill; onChanged: () => void }) {
  const { toast } = useToast();
  const addr = walletAddress() ?? "";
  const [network, setNetwork] = useState(prefill?.network && WALLET_CHAINS.some((c) => c.name === prefill.network) ? prefill.network : "worldchain");
  const chain = WALLET_CHAINS.find((c) => c.name === network)!;
  const [balances, setBalances] = useState<TokenBalance[] | null>(null);
  const [asset, setAsset] = useState(prefill?.asset ?? "USDC");
  const [to, setTo] = useState(prefill?.to ?? "");
  const [amount, setAmount] = useState(prefill?.amount ?? "");
  const [resolved, setResolved] = useState<Recipient | null>(null);
  const [feeInfo, setFeeInfo] = useState<{ internal: boolean; feeQty: string; treasuryConfigured: boolean } | null>(null);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<SendResult | null>(null);
  const [activity, setActivity] = useState<WalletActivity[]>([]);
  const [radar, setRadar] = useState<WalletRadar | null>(null);
  const [radarBusy, setRadarBusy] = useState(false);
  const [radarErr, setRadarErr] = useState<string | null>(null);
  const [reveal, setReveal] = useState<string | null>(null);
  const [revealPass, setRevealPass] = useState("");

  const tokens = useMemo(() => balances ?? [], [balances]);

  const loadBalances = useCallback(async () => {
    setBalances(null);
    try {
      const b = await walletBalances(chain);
      setBalances(b);
    } catch (e) {
      toast({ title: "Balance fetch failed", description: String((e as Error).message ?? e), variant: "destructive" });
      setBalances([]);
    }
  }, [chain, toast]);

  useEffect(() => { loadBalances(); }, [loadBalances]);
  useEffect(() => { setActivity(activityLog()); }, []);

  // ---- money radar: incoming transfers, live from the chain ---------------
  // A deposit that lands while this tab is open appears on its own within
  // ~20 s — no refresh, no support ticket, no "where is my money".
  const loadRadar = useCallback(async () => {
    if (!addr) return;
    setRadarBusy(true);
    setRadarErr(null);
    try {
      setRadar(await walletIncoming(chain, addr));
    } catch (e) {
      // Static-demo build (GitHub Pages): the in-browser demo engine has no
      // live chain behind it — show the calm empty state, never an error.
      if (e instanceof ApiError && e.type === "demo_error") {
        setRadar({ network: chain.name, native_asset: "", native_balance: "", incoming: [], incoming_count: 0 });
      } else {
        setRadarErr(String((e as Error).message ?? e));
      }
    } finally {
      setRadarBusy(false);
    }
  }, [chain, addr]);

  useEffect(() => { loadRadar(); }, [loadRadar]);
  useEffect(() => {
    const t = setInterval(loadRadar, 20_000);
    return () => clearInterval(t);
  }, [loadRadar]);

  // Live recipient resolution: phone → PayPhone identity (fee-free), 0x → external.
  useEffect(() => {
    let live = true;
    (async () => {
      setResolved(null); setFeeInfo(null);
      const v = to.trim();
      if (v.length < 6) return;
      try {
        const r = await resolveRecipient(v);
        if (!live) return;
        setResolved(r);
        const decimals = assetIsNative(asset) ? 18 : (tokens.find((t) => t.symbol === asset)?.decimals ?? 18);
        let qty = 0n;
        try { qty = BigInt(Math.round(parseFloat(amount || "0") * 10 ** decimals)); } catch { qty = 0n; }
        const f = await feePreview(qty, r.kind === "internal");
        if (!live) return;
        setFeeInfo({ internal: f.internal, feeQty: f.feeQty > 0n ? (Number(f.feeQty) / 10 ** decimals).toFixed(6) : "0", treasuryConfigured: f.treasuryConfigured });
      } catch { /* not resolvable yet — user still typing */ }
    })();
    return () => { live = false; };
  }, [to, amount, asset, tokens]);

  function assetIsNative(a: string): boolean {
    return a.toLowerCase() === chain.native.toLowerCase();
  }

  async function send() {
    if (!resolved || !amount) return;
    setSending(true); setResult(null);
    try {
      const r = await walletSend({ network, asset, recipientInput: to, amount });
      setResult(r);
      setActivity(activityLog());
      toast({ title: "Transaction signed & broadcast", description: `${amount} ${asset} → ${r.resolved.kind === "internal" ? r.resolved.maskedPhone : short(r.resolved.address)}` });
      setTimeout(loadBalances, 4000);
    } catch (e) {
      toast({ title: "Send failed", description: String((e as Error).message ?? e), variant: "destructive" });
    } finally {
      setSending(false);
    }
  }

  async function doReveal() {
    try {
      setReveal(await walletRevealSecret(revealPass));
    } catch (e) {
      toast({ title: "Wrong passphrase", description: String((e as Error).message ?? e), variant: "destructive" });
    }
  }

  const assetOptions = [chain.native, ...tokens.filter((t) => t.address).map((t) => t.symbol)];

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      {/* address card */}
      <Card className="border-primary/30">
        <CardContent className="flex flex-col items-center gap-5 sm:flex-row">
          <div className="rounded-xl bg-white p-2 ring-1 ring-black/10">
            <QRCodeSVG value={addr} size={116} />
          </div>
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="gap-1 border-emerald-500/40 text-emerald-600"><ShieldCheck className="h-3 w-3" /> Non-custodial</Badge>
              <Badge variant="outline">You hold the keys</Badge>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Your address — receives from anyone, anywhere</p>
              <span className="break-all font-mono text-sm">{addr}</span>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => { navigator.clipboard.writeText(addr); toast({ title: "Address copied" }); }}>
                <Copy className="mr-1.5 h-3.5 w-3.5" /> Copy
              </Button>
              <Button size="sm" variant="outline" onClick={() => window.open(`${chain.explorer}/address/${addr}`, "_blank")}>
                <ExternalLink className="mr-1.5 h-3.5 w-3.5" /> {chain.label} explorer
              </Button>
              <span className="flex-1" />
              <Button size="sm" variant="ghost" onClick={() => { walletLock(); onChanged(); }}><Lock className="mr-1.5 h-3.5 w-3.5" /> Lock</Button>
            </div>
            <SendRightNotice />
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* balances */}
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">Balances</CardTitle>
            <Select value={network} onValueChange={(v) => { setNetwork(v); const c2 = WALLET_CHAINS.find((x) => x.name === v)!; setAsset(c2.native === "ETH" ? "USDC" : "USDT"); }}>
              <SelectTrigger className="h-8 w-[150px]"><SelectValue /></SelectTrigger>
              <SelectContent>{WALLET_CHAINS.map((c) => <SelectItem key={c.name} value={c.name}>{c.label}</SelectItem>)}</SelectContent>
            </Select>
          </CardHeader>
          <CardContent className="space-y-2">
            {balances === null && <p className="text-sm text-muted-foreground">Reading {chain.label}…</p>}
            {balances?.length === 0 && <p className="text-sm text-muted-foreground">No balances readable right now.</p>}
            {balances && balances.length > 0 && (
              <div className="space-y-1.5">
                {balances.map((b) => (
                  <div key={b.symbol} className="flex items-center justify-between rounded-md border px-3 py-2">
                    <span className="text-sm font-medium">{b.symbol}{b.address ? "" : <span className="ml-1.5 text-xs text-muted-foreground">(native)</span>}</span>
                    <span className="font-mono text-sm">{Number(b.balance) === 0 ? "0" : Number(b.balance).toFixed(6)}</span>
                  </div>
                ))}
              </div>
            )}
            <p className="pt-1 text-xs text-muted-foreground">
              Funds here came in from anywhere — exchanges, other wallets, invoices. Send out to anywhere. Standard network rules apply (send tokens on the network they exist on).
            </p>
          </CardContent>
        </Card>

        {/* send */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><Send className="h-4 w-4 text-primary" /> Send</CardTitle>
            <p className="text-sm text-muted-foreground">To a phone number (fee-free PayPhone loop) or any 0x… address (0.5% protocol fee → treasury).</p>
            <p className="text-xs text-muted-foreground">Public-network sends are final — double-check the recipient and the network before you sign.</p>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1.5">
              <Label>Recipient — phone or 0x address</Label>
              <Input placeholder="+254 712 345 678  or  0x…" value={to} onChange={(e) => setTo(e.target.value)} />
              {resolved && (
                <p className={`flex items-center gap-1.5 text-xs ${resolved.kind === "internal" ? "text-emerald-600" : "text-muted-foreground"}`}>
                  {resolved.kind === "internal"
                    ? <><CheckCircle2 className="h-3.5 w-3.5" /> PayPhone identity {resolved.payphoneId} · {resolved.maskedPhone} — fee-free closed loop</>
                    : <><ArrowRightLeft className="h-3.5 w-3.5" /> External address — protocol fee applies</>}
                </p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label>Asset</Label>
                <Select value={asset} onValueChange={setAsset}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{assetOptions.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Amount</Label>
                <Input inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
              </div>
            </div>
            {feeInfo && amount && parseFloat(amount) > 0 && (
              <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs space-y-1">
                <div className="flex justify-between"><span className="text-muted-foreground">Recipient receives</span><span className="font-mono text-xs">{amount} {asset}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Protocol fee</span><span className="font-mono text-xs">{feeInfo.internal ? "FREE (internal loop)" : !feeInfo.treasuryConfigured ? "WAIVED — treasury not configured" : `${feeInfo.feeQty} ${asset} (${Number(WALLET_SEND_FEE_BPS) / 100}%)`}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Network gas</span><span className="text-xs">paid to {chain.label} validators</span></div>
              </div>
            )}
            <Button className="w-full" disabled={!resolved || !amount || sending || parseFloat(amount) <= 0} onClick={send}>
              {sending ? "Signing & broadcasting…" : "Review & send"}
            </Button>
            {result && (
              <div className="rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3 text-xs space-y-1">
                {result.txs.map((t, i) => (
                  <div key={i} className="flex justify-between gap-2">
                    <span>{t.role === "fee" ? "Protocol fee → treasury" : "Payment"}</span>
                    <a
                      className="font-mono text-[11px] text-primary underline-offset-2 hover:underline"
                      href={`${result.explorerUrl}/tx/${t.hash}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {short(t.hash)} ↗
                    </a>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* incoming — the money radar */}
      <Card className="border-emerald-500/30">
        <CardHeader className="flex-row items-start justify-between space-y-0">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2 text-base">
              <ArrowDownToLine className="h-4 w-4 text-emerald-600" /> Incoming — live on {chain.label}
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              Everything sent to your address appears here automatically, read straight from the chain — you never have to wonder where your money is.
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={loadRadar} disabled={radarBusy}>
            {radarBusy
              ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
            Refresh
          </Button>
        </CardHeader>
        <CardContent className="space-y-2">
          {radarErr && (
            <p className="text-xs text-amber-600">
              Radar hiccup ({radarErr}) — balances are unaffected; it retries automatically.
            </p>
          )}
          {radar && radar.incoming.length > 0 && (
            <div className="space-y-1.5">
              {radar.incoming.slice(0, 8).map((t, i) => (
                <div key={`${t.tx_hash}-${t.asset}-${i}`} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className={t.confirmed ? "border-emerald-500/40 text-emerald-600" : "border-amber-500/40 text-amber-600"}>
                      {t.confirmed
                        ? <><CheckCircle2 className="mr-1 h-3 w-3" /> Confirmed · {t.confirmations} confs</>
                        : <><Loader2 className="mr-1 h-3 w-3 animate-spin" /> Detected — finalizing {t.confirmations}/{t.required_confirmations}</>}
                    </Badge>
                    <span className="font-medium text-emerald-700">+{t.qty} {t.asset}</span>
                    <span className="text-xs text-muted-foreground">from {short(t.from)}</span>
                  </span>
                  <a
                    className="flex items-center gap-1 text-xs text-primary underline-offset-2 hover:underline"
                    href={t.explorer_url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View on explorer <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
              ))}
            </div>
          )}
          {radar && radar.incoming.length === 0 && (
            <div className="space-y-1.5 rounded-md border border-dashed px-3 py-4 text-sm text-muted-foreground">
              <p>Nothing has landed here recently — if something does, it shows up on its own within seconds, with the tx hash and explorer link.</p>
              <p className="text-xs">
                Withdrawing from an exchange (OKX, Binance…)? Pick the network matching this tab — WLD arrives on <b>OP Mainnet</b> when you select Optimism in the withdrawal dialog, on <b>Worldchain</b> when you select World Chain. Picked the other one? The funds are still yours — they are on that other chain; switch this tab&apos;s network and they are right here.
              </p>
            </div>
          )}
          {radar && (
            <p className="text-xs text-muted-foreground">
              Watches every settleable token on {chain.label} · updates every 20 s while this tab is open · native {radar.native_asset} balance {radar.native_balance ? radar.native_balance : "—"}
            </p>
          )}
        </CardContent>
      </Card>

      {/* activity */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Activity — your sends</CardTitle>
          <p className="text-sm text-muted-foreground">Transfers signed in this browser. Incoming money lives in the Incoming feed above.</p>
        </CardHeader>
        <CardContent>
          {activity.length === 0 ? (
            <p className="text-sm text-muted-foreground">No sends yet from this browser.</p>
          ) : (
            <div className="space-y-1.5">
              {activity.slice(0, 10).map((a, i) => (
                <div key={i} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                  <span className="flex items-center gap-2">
                    <Badge variant="outline" className={a.internal ? "border-emerald-500/40 text-emerald-600" : ""}>{a.internal ? "internal · free" : "external"}</Badge>
                    {a.label}
                  </span>
                  <span className="text-muted-foreground text-xs">{a.amount} {a.asset} → {short(a.to)}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* security */}
      <Card>
        <CardHeader><CardTitle className="text-base">Security</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => setReveal("")}><Eye className="mr-1.5 h-3.5 w-3.5" /> Reveal recovery phrase / key</Button>
          <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" onClick={() => {
            if (confirm("Remove the keystore from this browser? Your funds remain on-chain; only the recovery phrase can restore access.")) { walletDestroy(); onChanged(); }
          }}>
            <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Remove from browser
          </Button>
          <span className="flex-1" />
          <p className="w-full text-xs text-muted-foreground">
            Encrypted with PBKDF2-SHA256 (310k rounds) + AES-GCM-256, stored only in this browser. The passphrase
            and recovery phrase never leave your device. We cannot recover either for you.
          </p>
        </CardContent>
      </Card>

      {/* reveal dialog */}
      <Dialog open={reveal !== null} onOpenChange={(o) => !o && setReveal(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Reveal secret</DialogTitle>
            <DialogDescription>Enter your passphrase. This decrypts the keystore locally — nothing is transmitted.</DialogDescription>
          </DialogHeader>
          {reveal ? (
            <div className="space-y-3">
              <div className="break-all rounded-md border bg-muted/40 p-3 font-mono text-sm">{reveal}</div>
              <p className="text-xs text-destructive">Anyone with this secret controls the funds. Clear it from screen when done.</p>
            </div>
          ) : (
            <div className="space-y-3">
              <Input type="password" placeholder="passphrase" value={revealPass} onChange={(e) => setRevealPass(e.target.value)} />
              <Button className="w-full" onClick={doReveal}><Eye className="mr-2 h-4 w-4" /> Decrypt &amp; reveal</Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
