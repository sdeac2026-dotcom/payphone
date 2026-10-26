"use client";

/**
 * Shared UI atoms for the PayPhone console.
 */

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

/** PayPhone wordmark — phone glyph + name. */
export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <span className="relative flex h-7 w-7 items-center justify-center rounded-lg bg-primary/15 ring-1 ring-primary/40">
        <svg viewBox="0 0 24 24" className="h-4 w-4 text-primary" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="7" y="2" width="10" height="20" rx="2.5" />
          <path d="M11 18.5h2" />
          <path d="M10.2 8.2a2.55 2.55 0 0 1 3.6 3.6c-.9.9-1.8 1-1.8 2.2" />
        </svg>
      </span>
      <span className="text-lg font-semibold tracking-tight">
        Pay<span className="text-primary">Phone</span>
      </span>
    </span>
  );
}

/** Copy-to-clipboard code block with language label. */
export function CodeBlock({
  code,
  lang = "bash",
  className,
}: {
  code: string;
  lang?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={cn("group relative overflow-hidden rounded-lg border bg-[oklch(0.14_0.01_170)]", className)}>
      <div className="flex items-center justify-between border-b px-3 py-1.5">
        <span className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">{lang}</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(code);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            } catch {
              /* clipboard unavailable */
            }
          }}
          aria-label="Copy code"
        >
          {copied ? <Check className="h-3.5 w-3.5 text-primary" /> : <Copy className="h-3.5 w-3.5" />}
        </Button>
      </div>
      <pre className="pp-scroll max-h-80 overflow-auto p-3 text-[12.5px] leading-relaxed">
        <code className="font-mono">{code}</code>
      </pre>
    </div>
  );
}

/** Monospace copyable value (hashes, addresses, keys). */
export function MonoValue({ value, display }: { value: string; display?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="inline-flex max-w-full items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1 font-mono text-xs text-foreground/90 transition-colors hover:border-primary/50"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          /* clipboard unavailable */
        }
      }}
      title="Click to copy"
    >
      <span className="truncate">{display ?? value}</span>
      {copied ? <Check className="h-3 w-3 shrink-0 text-primary" /> : <Copy className="h-3 w-3 shrink-0 text-muted-foreground" />}
    </button>
  );
}

/** Live status pill used in the navbar and health cards. */
export function StatusDot({ ok, label }: { ok: boolean | null; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          ok === null ? "bg-yellow-500 animate-pulse" : ok ? "bg-primary" : "bg-destructive"
        )}
        aria-hidden="true"
      />
      {label}
    </span>
  );
}

/** Big-number stat card. */
export function StatCard({
  label,
  value,
  sub,
  className,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
  className?: string;
}) {
  return (
    <div className={cn("rounded-xl border bg-card p-4", className)}>
      <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-1.5 text-2xl font-semibold tracking-tight">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

/** Section heading with optional kicker. */
export function SectionHead({
  kicker,
  title,
  desc,
  center,
}: {
  kicker?: string;
  title: string;
  desc?: string;
  center?: boolean;
}) {
  return (
    <div className={cn("mb-8 max-w-2xl", center && "mx-auto text-center")}>
      {kicker && (
        <div className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-primary">{kicker}</div>
      )}
      <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h2>
      {desc && <p className="mt-3 text-sm leading-relaxed text-muted-foreground sm:text-base">{desc}</p>}
    </div>
  );
}

/** Fee-split donut rendered with a conic gradient (no chart lib needed). */
export function FeeDonut({ protocol, referrer, operations }: { protocol: number; referrer: number; operations: number }) {
  const style = {
    background: `conic-gradient(
      oklch(0.75 0.15 163) 0 ${protocol}%,
      oklch(0.68 0.12 200) ${protocol}% ${protocol + referrer}%,
      oklch(0.72 0.1 90) ${protocol + referrer}% 100%
    )`,
  } as const;
  return (
    <div className="relative h-36 w-36">
      <div className="h-full w-full rounded-full" style={style} aria-hidden="true" />
      <div className="absolute inset-[18px] flex flex-col items-center justify-center rounded-full bg-card">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Fee split</span>
        <span className="text-sm font-semibold">{protocol}% / {referrer}% / {operations}%</span>
      </div>
    </div>
  );
}
