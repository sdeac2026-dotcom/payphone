import { Lightbulb, Network, ShieldCheck, TriangleAlert } from "lucide-react";
import { SectionHead } from "./bits";

/**
 * Asset safety — the "Right coin. Right network." notice.
 *
 * Wrong-network and cross-system transfers are the #1 way people lose funds
 * in crypto. This module ships the guidance everywhere money moves: the
 * landing page (full section), the hosted checkout and the wallet (compact
 * notice). Calm, corporate tone: one golden rule, what is safe, what is
 * never safe, and what is recoverable after all.
 */

const EVM_NETWORKS =
  "Ethereum, Base, Worldchain, Arbitrum, Optimism, Polygon, BNB Chain and Avalanche";

export function SendRightNotice({ asset, network }: { asset?: string; network?: string }) {
  return (
    <div
      className="flex items-start gap-2.5 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs dark:border-amber-500/30 dark:bg-amber-500/5"
      role="note"
      aria-label="Asset safety notice"
    >
      <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-500" />
      <div className="space-y-1">
        <p className="font-medium text-amber-700 dark:text-amber-400">
          Right coin, right network — public transactions cannot be reversed
        </p>
        <p className="leading-relaxed text-muted-foreground">
          {asset && network ? (
            <>
              Send <span className="font-semibold text-foreground">{asset}</span> on{" "}
              <span className="font-semibold text-foreground">{network}</span> only.{" "}
            </>
          ) : null}
          This address receives assets on EVM networks ({EVM_NETWORKS}). Never send native
          Bitcoin, Solana or Tron coins to an 0x… address — different address systems, and such
          transfers are unrecoverable by anyone, including us. Sent a token on the wrong EVM
          network? It is not lost: your address exists on every EVM network — switch networks to
          see it.
        </p>
      </div>
    </div>
  );
}

export function AssetSafetySection() {
  return (
    <section className="border-b py-16 sm:py-20">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <SectionHead
          kicker="Asset safety"
          title="Right coin. Right network. Every time."
          desc="PayPhone moves real money on public networks. One five-second habit keeps every payment safe — and we would rather say it twice than see a single cent lost."
        />

        {/* the golden rule */}
        <div className="mb-6 flex items-start gap-3 rounded-xl border border-primary/40 bg-primary/5 p-5">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
          <div>
            <p className="text-sm font-semibold text-foreground">The golden rule of every transfer</p>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              Send a coin only on a network where that coin lives, and match the address type to
              the network. Every exchange labels the network on its withdrawal form — read it,
              match it, and when in doubt send a small test amount first.
            </p>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <div className="rounded-xl border bg-background/40 p-5">
            <div className="mb-3 flex h-8 w-8 items-center justify-center rounded-lg border border-emerald-500/40 bg-emerald-500/10">
              <Network className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
            </div>
            <p className="text-sm font-semibold">One address, every EVM network</p>
            <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
              Your PayPhone address works across {EVM_NETWORKS}. ETH, USDC, USDT, USDT0, WLD —
              and any token on those networks — arrive safely, sent from any exchange or wallet
              on Earth.
            </p>
          </div>

          <div className="rounded-xl border bg-background/40 p-5">
            <div className="mb-3 flex h-8 w-8 items-center justify-center rounded-lg border border-amber-500/40 bg-amber-500/10">
              <TriangleAlert className="h-4 w-4 text-amber-600 dark:text-amber-500" />
            </div>
            <p className="text-sm font-semibold">Never cross the address systems</p>
            <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
              Native Bitcoin (bc1…), Solana and Tron coins use entirely different address systems.
              Sent to an 0x… address, they cannot be reversed, recovered or refunded — by anyone.
              PayPhone invoices on those chains always generate the correct per-chain address.
            </p>
          </div>

          <div className="rounded-xl border bg-background/40 p-5">
            <div className="mb-3 flex h-8 w-8 items-center justify-center rounded-lg border border-sky-500/40 bg-sky-500/10">
              <Lightbulb className="h-4 w-4 text-sky-600 dark:text-sky-400" />
            </div>
            <p className="text-sm font-semibold">Wrong EVM network? Usually not lost.</p>
            <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
              Sent USDC on Polygon when you meant Base? Your address exists on every EVM network
              — switch networks in any wallet and the funds are there. Only transfers across
              different address systems are unrecoverable.
            </p>
          </div>
        </div>

        <p className="mt-6 text-xs leading-relaxed text-muted-foreground">
          And because PayPhone is non-custodial: your recovery phrase is the only key to your
          funds. We cannot see it, store it, or reset it — write it down, keep it offline, and
          share it with no one. Full guide in the docs under Asset safety.
        </p>
      </div>
    </section>
  );
}
