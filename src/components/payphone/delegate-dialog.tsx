"use client";
/**
 * Delegate — the wallet's earning autopilot, opened by the Delegate button.
 *
 * The idea, in the owner's words: "crypto is so technical, and how to make
 * money out of it is always tricky." This dialog does the heavy lifting ON
 * THE OWNER'S BEHALF: one engine call scans every configured network for
 * idle balances, matches them against the curated earn registry, and hands
 * back a concrete plan. The owner reviews it and signs what they approve —
 * each action runs through the SAME local keystore signing helpers the Earn
 * panel uses (stakeEthLido / wrapStETH / supplyAaveUsdc / governanceDelegate).
 *
 * The non-custodial boundary is the feature, not a limitation: the engine
 * prepared everything, but the signature — the only thing that can move
 * funds — is always made by the owner, locally, per transaction. (True
 * key-delegation — EIP-7702 / session keys — is a future opt-in, never a
 * silent default.)
 */
import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type DelegatePlan, type DelegateItem } from "@/lib/payphone/api";
import { walletAddress, WALLET_CHAINS, type WalletChain } from "@/lib/payphone/wallet";
import { stakeEthLido, wrapStETH, supplyAaveUsdc, governanceDelegate } from "@/lib/payphone/earn";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertTriangle, CheckCircle2, ExternalLink, Loader2, Sparkles, Zap,
} from "lucide-react";

function short(a: string): string {
  return a.length > 15 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a;
}

/** The Explorer base for a network name (matches the engine's chains). */
const EXPLORERS: Record<string, string> = {
  ethereum: "https://etherscan.io",
  base: "https://basescan.org",
  optimism: "https://optimistic.etherscan.io",
  arbitrum: "https://arbiscan.io",
  polygon: "https://polygonscan.com",
  bsc: "https://bscscan.com",
  worldchain: "https://worldscan.org",
  avalanche: "https://snowtrace.io",
};

function chainFor(network: string): WalletChain | undefined {
  return WALLET_CHAINS.find((c) => c.name === network);
}

export function DelegateDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { toast } = useToast();
  const [plan, setPlan] = useState<DelegatePlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [signingId, setSigningId] = useState<string | null>(null);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [demo, setDemo] = useState(false);

  const load = useCallback(async () => {
    const addr = walletAddress();
    if (!addr || !open) return;
    setBusy(true);
    setErr(null);
    setDemo(false);
    try {
      const p = await api.delegatePlan(addr);
      setPlan(p);
      // Prefill every item's amount with the full matching balance.
      const pre: Record<string, string> = {};
      for (const it of p.items) pre[it.id] = it.balance_qty;
      setAmounts(pre);
    } catch (e) {
      if (e instanceof ApiError && e.type === "demo_error") {
        // Static demo build: no live chain behind the in-browser engine.
        setDemo(true);
        setPlan(null);
      } else {
        setErr(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusy(false);
    }
  }, [open]);

  useEffect(() => {
    if (open) load();
    else {
      setPlan(null);
      setErr(null);
      setDemo(false);
      setSigningId(null);
    }
  }, [open, load]);

  // Governance items need an optional delegatee (defaults to self).
  const [delegatee, setDelegatee] = useState<Record<string, string>>({});

  async function runItem(item: DelegateItem) {
    const chain = chainFor(item.network);
    const amt = (amounts[item.id] ?? "").trim();
    if (!chain || !amt || parseFloat(amt) <= 0) return;
    setSigningId(item.id);
    try {
      let note = "";
      if (item.id === "lido-steth-ethereum") {
        const h = await stakeEthLido(chain, amt);
        note = `Staked ${amt} ETH via Lido — stETH arriving (${short(h)}…)`;
      } else if (item.id === "lido-wsteth-ethereum") {
        const { approve, wrap } = await wrapStETH(chain, amt);
        note = `Wrapped ${amt} stETH → wstETH (${short(approve)}…, ${short(wrap)}…)`;
      } else if (item.id === "aave-v3-supply-ethereum") {
        const { approve, supply } = await supplyAaveUsdc(chain, amt);
        note = `Supplied ${amt} USDC to Aave — earning lending interest (${short(supply)}…)`;
      } else if (item.kind === "governance") {
        // Self-delegate by default: the standard first move that activates
        // the wallet's own voting power. Editable for a trusted delegatee.
        const to = (delegatee[item.id] || walletAddress() || "").trim();
        const h = await governanceDelegate(chain, item.id, to);
        note = `Voting power delegated to ${short(to)} (${short(h)}…)`;
      } else {
        return;
      }
      toast({ title: "Signed & broadcast", description: note });
      setTimeout(load, 4000);
    } catch (e) {
      toast({
        title: "Not completed",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    } finally {
      setSigningId(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" /> Delegate
          </DialogTitle>
          <DialogDescription>
            Your earning autopilot: it scans every network you have assets on,
            matches the curated earn registry, and prepares everything. You
            review the plan and sign — each transaction is signed locally by
            YOUR wallet, exactly like a send.
          </DialogDescription>
        </DialogHeader>

        {busy && (
          <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Scanning every network for idle balances and earning venues…
          </p>
        )}

        {!busy && demo && (
          <p className="py-6 text-sm text-muted-foreground">
            The static demo has no live chain behind it — open the live wallet to
            run the Delegate scan.
          </p>
        )}

        {!busy && err && (
          <div className="space-y-2 py-4">
            <p className="flex items-center gap-1.5 text-sm text-destructive">
              <AlertTriangle className="h-4 w-4" /> {err}
            </p>
            <Button size="sm" variant="outline" onClick={load}>Try again</Button>
          </div>
        )}

        {!busy && plan && (
          <div className="space-y-5">
            <p className="text-xs text-muted-foreground">
              Scanned {plan.scanned_networks.length} networks
              {plan.skipped_networks.length > 0 &&
                ` (${plan.skipped_networks.map((s) => s.network).join(", ")} skipped)`}
              . No yield numbers are invented — each entry says where its income
              mechanically comes from.
            </p>

            {plan.items.length === 0 && plan.idle.length === 0 && (
              <p className="text-sm text-muted-foreground">
                Nothing to delegate yet — the scan found no idle balances.
              </p>
            )}

            {plan.items.length > 0 && (
              <div className="space-y-3">
                <p className="text-sm font-medium">Executable now — sign to start earning</p>
                {plan.items.map((it) => {
                  const chain = chainFor(it.network);
                  const isGov = it.kind === "governance";
                  const amt = amounts[it.id] ?? "";
                  return (
                    <div key={it.id} className="space-y-2 rounded-md border px-3 py-2.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{it.protocol}</span>
                        <Badge variant="outline" className="text-[10px] uppercase">{it.network}</Badge>
                        {isGov && <Badge variant="outline" className="text-[10px] uppercase">governance</Badge>}
                        <span className="text-xs text-muted-foreground">{it.label}</span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Your balance: <span className="font-mono">{it.balance_qty} {it.asset}</span>
                        {it.receipt_asset && ` → you hold ${it.receipt_asset}`}. Income: {it.reward_source}
                      </p>
                      {it.risks.length > 0 && (
                        <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
                          {it.risks.slice(0, 3).map((r) => <li key={r}>{r}</li>)}
                        </ul>
                      )}
                      <div className="flex flex-wrap items-end gap-2">
                        {!isGov && (
                          <div className="space-y-1">
                            <Label className="text-xs">Amount</Label>
                            <Input
                              className="h-8 w-32 font-mono text-sm"
                              inputMode="decimal"
                              value={amt}
                              onChange={(e) => setAmounts((m) => ({ ...m, [it.id]: e.target.value }))}
                            />
                          </div>
                        )}
                        {isGov && (
                          <div className="space-y-1">
                            <Label className="text-xs">Delegatee (blank = yourself)</Label>
                            <Input
                              className="h-8 w-52 font-mono text-sm"
                              placeholder="0x… or blank for self"
                              value={delegatee[it.id] ?? ""}
                              onChange={(e) => setDelegatee((m) => ({ ...m, [it.id]: e.target.value }))}
                            />
                          </div>
                        )}
                        <Button
                          size="sm"
                          className="bg-emerald-600 hover:bg-emerald-700 text-white"
                          disabled={!chain || !it.gas_ok || signingId !== null || (!isGov && !(parseFloat(amt) > 0))}
                          onClick={() => runItem(it)}
                        >
                          {signingId === it.id
                            ? <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Signing…</>
                            : <><Zap className="mr-1.5 h-3.5 w-3.5" /> Sign &amp; {isGov ? "delegate" : it.id.startsWith("aave") ? "supply" : "stake"}</>}
                        </Button>
                        {chain && (
                          <a
                            className="flex items-center gap-1 pb-1.5 text-xs text-primary underline-offset-2 hover:underline"
                            href={`${EXPLORERS[it.network] ?? chain.explorer}/address/${it.target_contract}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            contract <ExternalLink className="h-3 w-3" />
                          </a>
                        )}
                      </div>
                      {!it.gas_ok && (
                        <p className="flex items-center gap-1.5 text-xs text-amber-600">
                          <AlertTriangle className="h-3.5 w-3.5" /> Your {chain?.native ?? "native"} balance on {it.network} is too
                          low to pay gas — top it up first.
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {plan.idle.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-sm font-medium">Idle — no curated venue yet</p>
                {plan.idle.map((r) => (
                  <div key={`${r.network}-${r.symbol}`} className="rounded-md border px-3 py-2 text-sm">
                    <span className="font-mono">{r.qty} {r.symbol}</span>
                    <Badge variant="outline" className="ml-2 text-[10px] uppercase">{r.network}</Badge>
                    <p className="mt-0.5 text-xs text-muted-foreground">{r.note}</p>
                  </div>
                ))}
              </div>
            )}

            {plan.unlockable.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-sm font-medium">Unlockable — fund to switch on</p>
                {plan.unlockable.map((u) => (
                  <div key={u.id} className="rounded-md border px-3 py-2 text-sm">
                    <span className="font-medium">{u.protocol}</span>
                    <Badge variant="outline" className="ml-2 text-[10px] uppercase">{u.network}</Badge>
                    <p className="mt-0.5 text-xs text-muted-foreground">{u.how}</p>
                  </div>
                ))}
              </div>
            )}

            <p className="flex items-start gap-1.5 border-t pt-3 text-xs text-muted-foreground">
              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
              {plan.non_custodial}
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
