"use client";

/**
 * PayPhone single-page application shell.
 *
 * Hash routing keeps the whole product on one deployable route while still
 * giving every surface a deep-linkable URL:
 *
 *   #/                       → landing
 *   #/dashboard              → merchant console
 *   #/docs                   → developer documentation
 *   #/pay/{inv}?t={token}    → hosted checkout (token in fragment)
 *
 * The fragment never reaches a server — invoice tokens stay out of logs
 * by construction.
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import dynamic from "next/dynamic";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { BookOpen, Github, LayoutDashboard, Phone } from "lucide-react";
import { Logo, StatusDot } from "./bits";

/**
 * Views are code-split: the landing compiles on first paint, heavier
 * surfaces (dashboard / docs / checkout) load on demand. This keeps the
 * dev-server memory profile flat in constrained environments.
 */
const Landing = dynamic(() => import("./landing").then((m) => m.Landing), {
  loading: () => <ViewSkeleton />,
});
const Dashboard = dynamic(() => import("./dashboard").then((m) => m.Dashboard), {
  loading: () => <ViewSkeleton />,
});
const Checkout = dynamic(() => import("./checkout").then((m) => m.Checkout), {
  loading: () => <ViewSkeleton />,
});
const Docs = dynamic(() => import("./docs").then((m) => m.Docs), {
  loading: () => <ViewSkeleton />,
});

function ViewSkeleton() {
  return (
    <div className="mx-auto max-w-6xl animate-pulse px-4 py-16 sm:px-6">
      <div className="h-8 w-56 rounded bg-muted" />
      <div className="mt-4 h-4 w-96 max-w-full rounded bg-muted" />
      <div className="mt-10 grid gap-4 sm:grid-cols-3">
        <div className="h-32 rounded-xl bg-muted" />
        <div className="h-32 rounded-xl bg-muted" />
        <div className="h-32 rounded-xl bg-muted" />
      </div>
    </div>
  );
}

type Route =
  | { view: "landing" }
  | { view: "dashboard" }
  | { view: "docs" }
  | { view: "checkout"; id: string; token: string };

function parseHashFrom(rawHash: string): Route {
  const raw = rawHash.replace(/^#\/?/, "");
  if (raw.startsWith("pay/")) {
    const [id, query] = raw.slice(4).split("?");
    const token = new URLSearchParams(query ?? "").get("t") ?? "";
    if (id && token) return { view: "checkout", id, token };
  }
  if (raw.startsWith("dashboard")) return { view: "dashboard" };
  if (raw.startsWith("docs")) return { view: "docs" };
  return { view: "landing" };
}

function subscribeHash(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

export function PayPhoneApp() {
  // location.hash is an external store — React 19 idiom, SSR-safe.
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash, () => "#/"
  );
  const route = useMemo(() => parseHashFrom(hash), [hash]);
  const [health, setHealth] = useState<{ engine: boolean; oracle: boolean } | null>(null);

  useEffect(() => {
    if (hash) window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  }, [hash]);

  const refreshHealth = useCallback(() => {
    // Carry XTransformPort through when the page itself was loaded with it.
    const m = window.location.search.match(/XTransformPort=(\d+)/);
    const suffix = m ? `?XTransformPort=${m[1]}` : "";
    fetch(`/api/health${suffix}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { engine: boolean; oracle: boolean }) => setHealth(d))
      .catch(() => setHealth(null));
  }, []);

  useEffect(() => {
    refreshHealth();
    const t = window.setInterval(refreshHealth, 20000);
    return () => window.clearInterval(t);
  }, [refreshHealth]);

  const go = useCallback((hash: string) => {
    window.location.hash = hash;
  }, []);

  const openCheckout = useCallback((id: string, token: string) => {
    go(`#/pay/${id}?t=${token}`);
  }, [go]);

  const engineOnline = health?.engine ?? null;

  return (
    <div className="flex min-h-screen flex-col">
      {/* ---------------------------------------------------------- navbar */}
      <header className="sticky top-0 z-50 border-b bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-3 px-4 sm:px-6">
          <button
            type="button"
            onClick={() => go("#/")}
            className="rounded-md outline-none ring-ring focus-visible:ring-2"
            aria-label="PayPhone home"
          >
            <Logo />
          </button>

          <nav className="hidden items-center gap-1 md:flex" aria-label="Primary">
            <Button variant="ghost" size="sm" onClick={() => go("#/dashboard")}>
              <LayoutDashboard className="mr-1.5 h-3.5 w-3.5" /> Dashboard
            </Button>
            <Button variant="ghost" size="sm" onClick={() => go("#/docs")}>
              <BookOpen className="mr-1.5 h-3.5 w-3.5" /> Docs
            </Button>
            <Button variant="ghost" size="sm" onClick={() => go("#/")}>
              <Github className="mr-1.5 h-3.5 w-3.5" /> GitHub
            </Button>
          </nav>

          <div className="flex items-center gap-3">
            <StatusDot ok={engineOnline} label={engineOnline === null ? "checking" : engineOnline ? "engine live" : "engine offline"} />
            <Button size="sm" onClick={() => go("#/dashboard")} className="gap-1.5">
              <Phone className="h-3.5 w-3.5" /> Get API keys
            </Button>
          </div>
        </div>
      </header>

      {/* ------------------------------------------------------------ main */}
      <main className="flex-1">
        {route.view === "landing" && (
          <Landing onOpenDashboard={() => go("#/dashboard")} onOpenDocs={() => go("#/docs")} />
        )}
        {route.view === "dashboard" && <Dashboard onOpenCheckout={openCheckout} />}
        {route.view === "docs" && <Docs onOpenDashboard={() => go("#/dashboard")} />}
        {route.view === "checkout" && <Checkout invoiceId={route.id} token={route.token} />}
      </main>

      {/* ---------------------------------------------------------- footer */}
      <footer className="mt-auto border-t bg-card/40">
        <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
          <div className="flex flex-col items-start justify-between gap-6 sm:flex-row">
            <div className="max-w-sm space-y-2">
              <Logo />
              <p className="text-xs leading-relaxed text-muted-foreground">
                Open, stateless crypto payment infrastructure. Built with Rust,
                Next.js, Python and Solidity — MIT licensed, community extensible.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-x-10 gap-y-1.5 text-sm">
              <span className="col-span-2 mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Product</span>
              <button type="button" className="text-left text-muted-foreground hover:text-foreground" onClick={() => go("#/dashboard")}>Merchant console</button>
              <button type="button" className="text-left text-muted-foreground hover:text-foreground" onClick={() => go("#/docs")}>API docs</button>
              <span className="col-span-2 mt-3 mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Developers</span>
              <button type="button" className="text-left text-muted-foreground hover:text-foreground" onClick={() => go("#/docs")}>Quickstart</button>
              <button type="button" className="text-left text-muted-foreground hover:text-foreground" onClick={() => go("#/docs")}>Webhooks</button>
            </div>
            <div className="space-y-2 text-xs text-muted-foreground">
              <StatusDot ok={engineOnline} label={`engine ${engineOnline ? "online" : "offline"}`} />
              <StatusDot ok={health?.oracle ?? null} label={`oracle ${health?.oracle ? "online" : health?.oracle === false ? "offline" : "…"}`} />
              <p>MIT License · v0.1.0</p>
            </div>
          </div>
          <Separator className="my-6" />
          <p className="text-center text-xs text-muted-foreground">
            Your phone number is your wallet. · SimNet is a simulated chain for development — never
            route real funds through it.
          </p>
        </div>
      </footer>
    </div>
  );
}
