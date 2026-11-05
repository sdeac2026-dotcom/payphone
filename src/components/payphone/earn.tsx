"use client";

/**
 * PayPhone Wallet → Earn & Governance.
 *
 * The wallet's assets can WORK: liquid staking (delegated to a validator
 * set), DeFi lending, and on-chain governance voting — every flow signed
 * locally by the keystore, exactly like sends. The engine contributes the
 * verified opportunity registry and live position/power reads; it never
 * holds keys and never custodies assets. Roadmap entries render as honest
 * guidance, never as fake buttons.
 */

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  AlertTriangle, ArrowRightLeft, CheckCircle2, ExternalLink, Loader2, RefreshCw, ShieldCheck, Vote,
} from "lucide-react";
import {
  earnOpportunities, earnPositions, governanceDelegate, governancePower, governanceVote,
  stakeEthLido, supplyAaveUsdc, wrapStETH,
} from "@/lib/payphone/earn";
import { ApiError, type EarnOpportunity, type EarnPosition } from "@/lib/payphone/api";
import { walletAddress, type WalletChain } from "@/lib/payphone/wallet";

interface PowerSheet {
  votes: string;
  token_balance: string;
  governor: string;
  token: string;
  measured_at_block: number;
}

const EXPLORER: Record<string, string> = {
  ethereum: "https://etherscan.io",
  base: "https://basescan.org",
  arbitrum: "https://arbiscan.io",
  optimism: "https://optimistic.etherscan.io",
  polygon: "https://polygonscan.com",
  bsc: "https://bscscan.com",
  avalanche: "https://snowtrace.io",
  worldchain: "https://worldscan.org",
};

export function EarnPanel({ chain, onChanged }: { chain: WalletChain; onChanged: () => void }) {
  const { toast } = useToast();
  const addr = walletAddress() ?? "";
  const [opps, setOpps] = useState<EarnOpportunity[] | null>(null);
  const [oppsError, setOppsError] = useState<string | null>(null);
  const [demoMode, setDemoMode] = useState(false);
  const [positions, setPositions] = useState<EarnPosition[] | null>(null);
  const [native, setNative] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [stakeAmount, setStakeAmount] = useState("");
  const [wrapAmount, setWrapAmount] = useState("");
  const [supplyAmount, setSupplyAmount] = useState("");

  const gov = opps?.find((o) => o.kind === "governance" && o.status === "active") ?? null;
  const [delegatee, setDelegatee] = useState("");
  const [proposalId, setProposalId] = useState("");
  const [support, setSupport] = useState<"0" | "1" | "2">("1");
  const [power, setPower] = useState<PowerSheet | null>(null);

  // Registry load as a RETRYABLE action. The old fire-once effect turned one
  // failed fetch (engine asleep, blip) into a permanently hollow panel — no
  // actions, no reason, no way back. Now a failure renders an honest reason
  // with a Try again button, so the earn entry point is never a dead card.
  const loadOpps = useCallback(async () => {
    setOpps(null);
    setOppsError(null);
    try {
      setOpps(await earnOpportunities());
    } catch (e) {
      if (e instanceof ApiError && e.type === "demo_error") setDemoMode(true);
      else setOppsError(String((e as Error).message ?? e));
    }
  }, []);

  useEffect(() => { void loadOpps(); }, [loadOpps]);

  const loadPositions = useCallback(async () => {
    if (!addr) return;
    try {
      const p = await earnPositions(chain.name, addr);
      setPositions(p.positions);
      setNative(p.native_balance);
    } catch {
      setPositions(null);
    }
  }, [chain.name, addr]);

  useEffect(() => { loadPositions(); }, [loadPositions]);

  const loadPower = useCallback(async () => {
    if (!gov || !addr || chain.name !== gov.network) { setPower(null); return; }
    try {
      setPower(await governancePower(gov.id, addr));
    } catch {
      setPower(null);
    }
  }, [gov, addr, chain.name]);

  useEffect(() => { loadPower(); }, [loadPower]);

  function refreshed(label: string, hashes: string[]) {
    toast({ title: label, description: hashes.map((h) => h.slice(0, 14) + "…").join("  ") });
    onChanged();
    void loadPositions();
    void loadPower();
  }

  function failed(what: string, e: unknown) {
    toast({ title: `${what} — not completed`, description: String((e as Error).message ?? e), variant: "destructive" });
  }

  async function doStake() {
    if (!stakeAmount || parseFloat(stakeAmount) <= 0) return;
    setBusy("lido-steth-ethereum");
    try {
      const hash = await stakeEthLido(chain, stakeAmount);
      setStakeAmount("");
      refreshed(`Staked — stETH is in your wallet (tx ${hash.slice(0, 10)}…)`, [hash]);
    } catch (e) { failed("Staking", e); } finally { setBusy(null); }
  }

  async function doWrap() {
    if (!wrapAmount || parseFloat(wrapAmount) <= 0) return;
    setBusy("lido-wsteth-ethereum");
    try {
      const { approve, wrap } = await wrapStETH(chain, wrapAmount);
      setWrapAmount("");
      refreshed(`Wrapped — wstETH is in your wallet (approve ${approve.slice(0, 8)}…, wrap ${wrap.slice(0, 8)}…)`, [approve, wrap]);
    } catch (e) { failed("Wrapping", e); } finally { setBusy(null); }
  }

  async function doSupply() {
    if (!supplyAmount || parseFloat(supplyAmount) <= 0) return;
    setBusy("aave-v3-supply-ethereum");
    try {
      const { approve, supply } = await supplyAaveUsdc(chain, supplyAmount);
      setSupplyAmount("");
      refreshed(`Supplied to Aave — earning lending interest (approve ${approve.slice(0, 8)}…, supply ${supply.slice(0, 8)}…)`, [approve, supply]);
    } catch (e) { failed("Supplying", e); } finally { setBusy(null); }
  }

  async function doDelegate() {
    if (!gov || !delegatee.trim()) return;
    setBusy("delegate");
    try {
      const hash = await governanceDelegate(chain, gov.id, delegatee);
      refreshed(`Voting power delegated to ${delegatee.slice(0, 10)}…`, [hash]);
    } catch (e) { failed("Delegation", e); } finally { setBusy(null); }
  }

  async function doVote() {
    if (!gov || !proposalId.trim()) return;
    setBusy("vote");
    try {
      const hash = await governanceVote(chain, gov.id, proposalId, Number(support) as 0 | 1 | 2);
      refreshed(`Vote cast on proposal ${proposalId}`, [hash]);
    } catch (e) { failed("Voting", e); } finally { setBusy(null); }
  }

  const activeFlow = opps?.filter((o) => o.status === "active" && o.execution === "wallet_flow" && o.kind !== "governance") ?? [];
  const watchOnly = opps?.filter((o) => o.status === "active" && o.execution === "positions_only") ?? [];
  const roadmap = opps?.filter((o) => o.status === "roadmap") ?? [];

  function actionFor(o: EarnOpportunity) {
    const onNetwork = chain.name === o.network;
    if (!onNetwork) {
      return (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <ArrowRightLeft className="h-3.5 w-3.5" /> Lives on {o.network} — switch the wallet network (top selector) to act.
        </p>
      );
    }
    if (o.id === "lido-steth-ethereum") {
      return (
        <div className="flex gap-2">
          <Input inputMode="decimal" placeholder={`Amount in ${o.asset}`} value={stakeAmount} onChange={(e) => setStakeAmount(e.target.value)} />
          <Button disabled={!stakeAmount || parseFloat(stakeAmount) <= 0 || busy !== null} onClick={doStake}>
            {busy === o.id ? <Loader2 className="h-4 w-4 animate-spin" /> : "Stake"}
          </Button>
        </div>
      );
    }
    if (o.id === "lido-wsteth-ethereum") {
      return (
        <div className="flex gap-2">
          <Input inputMode="decimal" placeholder={`Amount in ${o.asset}`} value={wrapAmount} onChange={(e) => setWrapAmount(e.target.value)} />
          <Button disabled={!wrapAmount || parseFloat(wrapAmount) <= 0 || busy !== null} onClick={doWrap}>
            {busy === o.id ? <Loader2 className="h-4 w-4 animate-spin" /> : "Wrap"}
          </Button>
        </div>
      );
    }
    if (o.id === "aave-v3-supply-ethereum") {
      return (
        <div className="flex gap-2">
          <Input inputMode="decimal" placeholder={`Amount in ${o.asset}`} value={supplyAmount} onChange={(e) => setSupplyAmount(e.target.value)} />
          <Button disabled={!supplyAmount || parseFloat(supplyAmount) <= 0 || busy !== null} onClick={doSupply}>
            {busy === o.id ? <Loader2 className="h-4 w-4 animate-spin" /> : "Supply"}
          </Button>
        </div>
      );
    }
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Vote className="h-4 w-4 text-primary" /> Earn &amp; Governance
          <Badge variant="outline" className="gap-1 border-emerald-500/40 text-emerald-600"><ShieldCheck className="h-3 w-3" /> non-custodial</Badge>
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Put assets to work: stake with a validator set, earn lending interest, hold voting power.
          Every action is a transaction YOUR wallet signs — the engine builds the bytes and reads the chain, nothing more.
        </p>
        <p className="text-xs text-muted-foreground">
          No APY is quoted here on purpose — live rates live at the protocols. Risks are listed on every entry.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {demoMode && (
          <p className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            Static demo build — the earn registry is served by the live engine; open the console against a running engine to stake and vote.
          </p>
        )}

{opps === null && oppsError === null && !demoMode && (
          <p className="text-sm text-muted-foreground">Reading the earn registry…</p>
        )}

        {oppsError !== null && (
          <div className="space-y-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2.5">
            <p className="text-sm font-medium text-destructive">Couldn't load the earn registry.</p>
            <p className="text-xs text-muted-foreground">{oppsError}</p>
            <Button size="sm" variant="outline" onClick={() => void loadOpps()}>
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Try again
            </Button>
          </div>
        )}

        {opps !== null && opps.length === 0 && oppsError === null && !demoMode && (
          <p className="text-sm text-muted-foreground">
            No earning opportunities are listed right now — check back soon.
          </p>
        )}

        {activeFlow.map((o) => (
          <div key={o.id} className="space-y-2 rounded-md border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{o.protocol}</Badge>
              <Badge variant="outline" className="text-xs">{o.asset} → {o.receipt_asset || "voting power"}</Badge>
              <span className="flex-1" />
              <a className="text-xs text-primary underline-offset-2 hover:underline" href={`${EXPLORER[o.network] ?? ""}/address/${o.target_contract}`} target="_blank" rel="noreferrer">
                verified contract <ExternalLink className="inline h-3 w-3" />
              </a>
            </div>
            <p className="text-sm font-medium">{o.label}</p>
            <p className="text-xs leading-relaxed text-muted-foreground">{o.description}</p>
            <p className="text-xs text-muted-foreground"><span className="font-medium">Where yield comes from:</span> {o.reward_source}</p>
            <ul className="space-y-0.5 text-xs">
              {o.risks.map((r) => (
                <li key={r} className="flex gap-1.5 text-amber-700"><AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />{r}</li>
              ))}
            </ul>
            {actionFor(o)}
          </div>
        ))}

        {watchOnly.map((o) => (
          <div key={o.id} className="space-y-1 rounded-md border border-dashed p-3">
            <Badge variant="outline">{o.protocol} · watch-only</Badge>
            <p className="text-sm font-medium">{o.label}</p>
            <p className="text-xs leading-relaxed text-muted-foreground">{o.description}</p>
          </div>
        ))}

        {gov && (
          <div className="space-y-3 rounded-md border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{gov.protocol}</Badge>
              <Badge variant="outline" className="text-xs">governance</Badge>
              <span className="flex-1" />
              <a className="text-xs text-primary underline-offset-2 hover:underline" href={`${EXPLORER[gov.network] ?? ""}/address/${gov.target_contract}`} target="_blank" rel="noreferrer">
                governor <ExternalLink className="inline h-3 w-3" />
              </a>
            </div>
            <p className="text-sm font-medium">{gov.label}</p>
            <p className="text-xs leading-relaxed text-muted-foreground">{gov.description}</p>
            {chain.name !== gov.network && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <ArrowRightLeft className="h-3.5 w-3.5" /> Governance lives on {gov.network} — switch the wallet network to act.
              </p>
            )}
            {power && chain.name === gov.network && (
              <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs space-y-1">
                <div className="flex justify-between"><span className="text-muted-foreground">{gov.asset} balance</span><span className="font-mono">{power.token_balance}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Delegated voting power (block {power.measured_at_block})</span><span className="font-mono">{power.votes}</span></div>
                {power.votes === "0" && <p className="text-amber-700">Voting power is 0 — delegate below first (to yourself is fine).</p>}
              </div>
            )}
            {chain.name === gov.network && (
              <>
                <div className="flex gap-2">
                  <Input placeholder="Delegate to (0x… — your own address is fine)" value={delegatee} onChange={(e) => setDelegatee(e.target.value)} />
                  <Button variant="outline" disabled={!delegatee.trim() || busy !== null} onClick={doDelegate}>
                    {busy === "delegate" ? <Loader2 className="h-4 w-4 animate-spin" /> : "Delegate"}
                  </Button>
                </div>
                <div className="flex gap-2">
                  <Input inputMode="numeric" placeholder="Proposal id (e.g. 45)" value={proposalId} onChange={(e) => setProposalId(e.target.value.replace(/[^0-9]/g, ""))} />
                  <Select value={support} onValueChange={(v) => setSupport(v as "0" | "1" | "2")}>
                    <SelectTrigger className="w-[130px]"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1">For</SelectItem>
                      <SelectItem value="0">Against</SelectItem>
                      <SelectItem value="2">Abstain</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button disabled={!proposalId || busy !== null} onClick={doVote}>
                    {busy === "vote" ? <Loader2 className="h-4 w-4 animate-spin" /> : "Cast vote"}
                  </Button>
                </div>
                <ul className="space-y-0.5 text-xs">
                  {gov.risks.map((r) => (
                    <li key={r} className="flex gap-1.5 text-amber-700"><AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />{r}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}

        {positions && positions.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Your positions on {chain.label} (read live from the chain)</p>
            {positions.map((p) => (
              <div key={p.opportunity_id} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                <span className="flex items-center gap-2">
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                  <span className="font-medium">{p.symbol}</span>
                  <span className="text-xs text-muted-foreground">{p.opportunity_id}</span>
                </span>
                <span className="font-mono text-sm">{p.balance ?? p.error}</span>
              </div>
            ))}
            {native && <p className="text-xs text-muted-foreground">Native balance: <span className="font-mono">{native}</span> — gas for earning actions is paid in it.</p>}
          </div>
        )}

        {roadmap.length > 0 && (
          <div className="space-y-2 rounded-md border border-dashed p-3">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">On the roadmap — custody works today, richer flows are coming</p>
            {roadmap.map((o) => (
              <div key={o.id} className="space-y-1">
                <p className="text-sm font-medium">{o.label}</p>
                <p className="text-xs leading-relaxed text-muted-foreground">{o.description}</p>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
