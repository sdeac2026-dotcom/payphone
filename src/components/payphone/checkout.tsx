"use client";

/**
 * Checkout — the hosted payment page a payer sees.
 *
 * The invoice token arrives in the URL fragment (`#/pay/{id}?t={token}`),
 * so it never touches server logs. Status is polled live from the engine,
 * which observes the chain directly. On SimNet, a demo wallet button
 * injects the payment so the full lifecycle is testable end-to-end.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ArrowLeft, BadgeCheck, CheckCircle2, Clock, Coins, ExternalLink, Info, Loader2,
  Phone, ShieldCheck, Smartphone, TriangleAlert, Wallet,
} from "lucide-react";
import { api, shortHash, usd } from "@/lib/payphone/api";
import { SendRightNotice } from "./asset-safety";
import { WALLET_CHAINS, walletAddress, walletIsUnlocked } from "@/lib/payphone/wallet";
import type { InvoiceWithStatus } from "@/lib/payphone/types";
import { Logo, MonoValue } from "./bits";

type Phase = "loading" | "ready" | "error";

function fmtCountdown(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function Checkout({ invoiceId, token }: { invoiceId: string; token: string }) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState("");
  const [data, setData] = useState<Awaited<ReturnType<typeof api.invoiceStatus>> | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [paying, setPaying] = useState(false);
  const [payerPhone, setPayerPhone] = useState("");
  const pollRef = useRef<number | null>(null);

  const status = data?.invoice.status;
  const invoice = data?.invoice as InvoiceWithStatus | undefined;
  const demoMode = data?.demo_mode ?? false;
  const isSimnet = invoice?.chain === "simnet";

  const refresh = useCallback(async () => {
    try {
      const d = await api.invoiceStatus(invoiceId, token);
      setData(d);
      setPhase("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load invoice");
      setPhase("error");
    }
  }, [invoiceId, token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Clock for countdown.
  useEffect(() => {
    const t = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(t);
  }, []);

  // Poll while pending/underpaid.
  useEffect(() => {
    if (status === "pending" || status === "underpaid") {
      pollRef.current = window.setInterval(() => void refresh(), 2500);
      return () => {
        if (pollRef.current) window.clearInterval(pollRef.current);
      };
    }
  }, [status, refresh]);

  const paymentUri = useMemo(() => {
    if (!invoice) return "";
    if (isSimnet) {
      return `payphone:simnet?to=${invoice.address}&asset=${invoice.asset}&qty=${invoice.qte}&inv=${invoice.id}`;
    }
    // EIP-681 style for native / token transfers.
    const qty = invoice.qte;
    if (invoice.token_address) {
      return `ethereum:${invoice.token_address}@${invoice.network}/transfer?address=${invoice.address}&uint256=${qty}`;
    }
    return `ethereum:${invoice.address}@${invoice.network}?value=${qty}`;
  }, [invoice, isSimnet]);

  async function payWithPayPhoneWallet() {
    if (!invoice || !data) return;
    setPaying(true);
    setError("");
    try {
      // The user's own non-custodial wallet pays — same signed engine
      // settlement as the demo path, but `from` is their real address.
      // The engine settles the protocol fee as its own fee_tx to treasury.
      await api.simnetPay({
        to: invoice.address,
        asset: invoice.asset,
        amount_minor: Number(invoice.qte),
        invoice_id: invoice.id,
        from: walletAddress() ?? "demo-wallet",
        token,
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Wallet payment failed");
    } finally {
      setPaying(false);
    }
  }

  async function simulateWalletPayment() {
    if (!invoice || !data) return;
    setPaying(true);
    try {
      await api.simnetPay({
        to: invoice.address,
        asset: invoice.asset,
        amount_minor: Number(invoice.qte),
        invoice_id: invoice.id,
        from: "demo-wallet",
        token,
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Payment failed");
    } finally {
      setPaying(false);
    }
  }

  async function payWithPhone() {
    if (!invoice) return;
    setPaying(true);
    try {
      // SimNet derives a per-phone wallet, tops it up from the faucet, pays.
      const health = await api.engineHealth();
      void health;
      const toAddr = `PP${payerPhone.replace(/\D/g, "").padEnd(40, "0").slice(0, 40)}`.slice(0, 42);
      await api.simnetPay({ to: toAddr, asset: invoice.asset, amount_minor: Number(invoice.qte), from: `phone:${payerPhone.slice(-4)}` });
      await api.simnetPay({
        to: invoice.address,
        asset: invoice.asset,
        amount_minor: Number(invoice.qte),
        invoice_id: invoice.id,
        from: `phone:${payerPhone.slice(-4)}`,
        token,
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Phone payment failed");
    } finally {
      setPaying(false);
    }
  }

  // ------------------------------------------------------------------ views

  if (phase === "loading") {
    return (
      <div className="mx-auto max-w-lg px-4 py-16">
        <Card>
          <CardContent className="space-y-4 p-6">
            <Skeleton className="h-6 w-1/2" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-40 w-full" />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div className="mx-auto max-w-lg px-4 py-16">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <TriangleAlert className="h-5 w-5 text-destructive" /> Invoice unavailable
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">{error}</p>
            <p className="text-xs text-muted-foreground">
              The invoice token is signed and may have expired, or the engine is offline.
              Ask the merchant for a fresh payment link.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const paid = status === "paid";
  const expired = status === "expired";
  const underpaid = status === "underpaid";
  const secondsLeft = Math.max(0, (invoice?.exp ?? 0) - now);

  return (
    <div className="mx-auto max-w-lg px-4 py-10 sm:py-14">
      <div className="mb-6 flex items-center justify-between">
        <Logo />
        <Badge variant="outline" className="gap-1 border-primary/40 text-primary">
          {isSimnet ? <Smartphone className="h-3 w-3" /> : <Coins className="h-3 w-3" />}
          {invoice?.chain} · {invoice?.network}
        </Badge>
      </div>

      <Card className="overflow-hidden">
        <CardHeader className="border-b bg-card/50 pb-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground">Amount due</div>
              <div className="mt-1 text-3xl font-semibold tracking-tight">
                {usd(invoice!.amount_minor)}
                <span className="ml-2 text-base font-normal text-muted-foreground">
                  ≈ {data?.asset_amount} {invoice!.asset}
                </span>
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {invoice!.description_hash ? `Order ${invoice!.description_hash.slice(0, 12)}…` : "Payment"} · for merchant {shortHash(invoice!.mid, 8)}
              </div>
            </div>
            <StatusBadge status={status!} secondsLeft={secondsLeft} />
          </div>
        </CardHeader>

        <CardContent className="space-y-5 p-6">
          {paid ? (
            <PaidReceipt data={data!} />
          ) : (
            <>
              {expired ? (
                <Alert>
                  <Clock className="h-4 w-4" />
                  <AlertDescription>
                    This invoice expired. Exchange rates are locked for 15 minutes to protect
                    both sides — ask the merchant for a fresh link.
                  </AlertDescription>
                </Alert>
              ) : (
                <>
                  {/* QR + address */}
                  <div className="flex flex-col items-center gap-3 rounded-xl border bg-background/40 p-5">
                    <div className="rounded-lg bg-white p-3">
                      <QRCodeSVG value={paymentUri} size={168} level="M" aria-label="Payment QR code" />
                    </div>
                    <p className="text-center text-xs text-muted-foreground">
                      Scan with any {invoice!.asset} wallet on {invoice!.chain}/{invoice!.network}
                    </p>
                    <MonoValue value={invoice!.address} display={shortHash(invoice!.address, 14)} />
                    {underpaid && (
                      <p className="text-xs font-medium text-yellow-500">
                        Underpaid — received {data!.receipts.length} payment(s), {Number(data!.remaining_qty).toLocaleString()} {invoice!.asset} still due.
                      </p>
                    )}
                  </div>

                  {/* Asset safety — the #1 loss vector is wrong-network transfers */}
                  <SendRightNotice asset={invoice!.asset} network={invoice!.network} />

                  {/* Wallet pay — real EVM chains, wallet unlocked, network supported */}
                  {!isSimnet && walletIsUnlocked() && WALLET_CHAINS.some((c) => c.name === invoice!.network) && (
                    <Button variant="outline" className="w-full gap-2" asChild>
                      <a
                        href={`#/wallet?network=${invoice!.network}&asset=${encodeURIComponent(invoice!.asset)}&to=${invoice!.address}&amount=${encodeURIComponent(data?.asset_amount ?? "")}`}
                      >
                        <Wallet className="h-4 w-4" /> Pay from my PayPhone Wallet (prefilled)
                      </a>
                    </Button>
                  )}

                  {/* Rate-lock note */}
                  <div className="flex items-start gap-2 rounded-lg bg-muted/40 p-3 text-xs text-muted-foreground">
                    <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                    Rate locked at invoice creation: 1 {invoice!.asset} = {data?.rate ? `$${data.rate.usd.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : "—"}.
                    Send exactly <span className="font-mono">{data?.asset_amount} {invoice!.asset}</span>.
                  </div>

                  {/* Countdown */}
                  <div className="flex items-center justify-between text-sm">
                    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                      <Clock className="h-4 w-4" /> Time remaining
                    </span>
                    <span className="font-mono font-semibold">{fmtCountdown(secondsLeft)}</span>
                  </div>

                  {/* Demo wallet actions (SimNet only) */}
                  {isSimnet && demoMode && (
                    <div className="space-y-3 rounded-xl border border-dashed border-primary/40 bg-primary/5 p-4">
                      <p className="text-xs font-medium uppercase tracking-wider text-primary">
                        Demo mode — simulated chain
                      </p>
                      <Button
                        className="w-full gap-2"
                        onClick={simulateWalletPayment}
                        disabled={paying}
                      >
                        {paying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wallet className="h-4 w-4" />}
                        Simulate wallet payment ({data?.asset_amount} {invoice!.asset})
                      </Button>
                      {walletIsUnlocked() && walletAddress() && (
                        <Button
                          className="w-full gap-2 border-emerald-500/50 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-400"
                          variant="outline"
                          onClick={payWithPayPhoneWallet}
                          disabled={paying}
                        >
                          {paying ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                          Pay with MY PayPhone Wallet ({data?.asset_amount} {invoice!.asset})
                        </Button>
                      )}
                      <Separator />
                      <div className="space-y-2">
                        <Label className="text-xs text-muted-foreground">
                          …or pay with your phone number
                        </Label>
                        <div className="flex gap-2">
                          <Input
                            placeholder="+1 555 010 7777"
                            inputMode="tel"
                            value={payerPhone}
                            onChange={(e) => setPayerPhone(e.target.value)}
                            aria-label="Your phone number"
                          />
                          <Button
                            variant="outline"
                            onClick={payWithPhone}
                            disabled={paying || payerPhone.replace(/\D/g, "").length < 8}
                            className="gap-1.5 shrink-0"
                          >
                            <Phone className="h-4 w-4" /> Pay
                          </Button>
                        </div>
                        <p className="text-[11px] leading-relaxed text-muted-foreground">
                          SimNet derives a wallet from your number and pays the invoice — the exact
                          flow a real phone-native wallet would perform.
                        </p>
                      </div>
                    </div>
                  )}
                </>
              )}
            </>
          )}

          {/* Fee transparency */}
          <Separator />
          <div className="space-y-1.5 text-xs text-muted-foreground">
            <div className="mb-1 font-medium text-foreground">Fee transparency</div>
            <div className="flex justify-between"><span>Amount</span><span className="font-mono">{usd(data!.fee.amount_minor)}</span></div>
            <div className="flex justify-between"><span>Processing fee ({(data!.fee.bps / 100).toFixed(2)}%, paid by merchant)</span><span className="font-mono">{usd(data!.fee.fee_total_minor)}</span></div>
            <div className="flex justify-between"><span className="pl-3">· protocol</span><span className="font-mono">{usd(data!.fee.split.protocol_minor)}</span></div>
            <div className="flex justify-between"><span className="pl-3">· referrer</span><span className="font-mono">{usd(data!.fee.split.referrer_minor)}</span></div>
            <div className="flex justify-between"><span className="pl-3">· operations</span><span className="font-mono">{usd(data!.fee.split.operations_minor)}</span></div>
            {data!.fee_recipient ? (
              <div className="mt-2 rounded-md border bg-muted/30 p-2.5">
                <div className="mb-1 flex justify-between font-medium text-foreground">
                  <span>Protocol fee settlement</span>
                  <span className="font-mono">{data!.fee_recipient.fee_amount_decimal} {data!.fee_recipient.asset}</span>
                </div>
                <p className="text-[11px] leading-relaxed">
                  The protocol share travels to the network treasury, priced at this invoice&apos;s locked rate:
                </p>
                <div className="mt-1 break-all font-mono text-[10px] text-foreground">{data!.fee_recipient.address}</div>
              </div>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <p className="mt-5 text-center text-xs text-muted-foreground">
        Secured by PayPhone Engine · non-custodial · funds go directly to the merchant wallet
      </p>
    </div>
  );
}

function StatusBadge({ status, secondsLeft }: { status: string; secondsLeft: number }) {
  if (status === "paid")
    return <Badge className="gap-1 bg-primary text-primary-foreground"><BadgeCheck className="h-3 w-3" /> Paid</Badge>;
  if (status === "expired")
    return <Badge variant="secondary" className="gap-1"><Clock className="h-3 w-3" /> Expired</Badge>;
  if (status === "underpaid")
    return <Badge variant="outline" className="gap-1 border-yellow-500/60 text-yellow-500"><Clock className="h-3 w-3" /> Underpaid</Badge>;
  return (
    <Badge variant="outline" className="gap-1">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" aria-hidden="true" />
      {fmtCountdown(secondsLeft)}
    </Badge>
  );
}

function PaidReceipt({ data }: { data: Awaited<ReturnType<typeof api.invoiceStatus>> }) {
  const first = data.receipts[0];
  return (
    <div className="space-y-4">
      <div className="flex flex-col items-center gap-2 rounded-xl border border-primary/40 bg-primary/10 p-6 text-center">
        <CheckCircle2 className="h-10 w-10 text-primary" aria-hidden="true" />
        <div className="text-lg font-semibold">Payment received</div>
        <p className="text-xs text-muted-foreground">
          {data.invoice.amount_minor / 100} USD settled in {data.invoice.asset} — the webhook
          has fired and funds are already in the merchant&apos;s wallet.
        </p>
      </div>
      {(() => {
        const rc = data.receipts[0];
        if (!rc) return null;
        const txId = rc.tx ?? rc.tx_hash;
        if (!txId) return null;
        return rc.explorer_url ? (
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Transaction (verified on-chain)</span>
            <a
              href={rc.explorer_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 font-mono text-primary hover:underline"
            >
              {shortHash(txId, 12)} <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        ) : (
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Transaction</span>
            <MonoValue value={txId} display={shortHash(txId, 12)} />
          </div>
        );
      })()}
      {data.receipts.length > 1 && (
        <p className="text-xs text-muted-foreground">+{data.receipts.length - 1} more transaction(s) in this invoice.</p>
      )}
      <Button variant="outline" className="w-full gap-2" onClick={() => (window.location.hash = "#/")}>
        <ArrowLeft className="h-4 w-4" /> Back to PayPhone
      </Button>
    </div>
  );
}
