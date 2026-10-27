import { NextResponse } from "next/server";

/**
 * Aggregate health of the PayPhone stack: web + engine + oracle.
 * Powers the status chip in the navigation bar.
 *
 * Oracle detection: the engine is the probe authority — it already polls the
 * oracle on its own loopback and reports `oracle_source: "oracle"` when the
 * service answers (vs `"coingecko/static"` when it falls back). The web
 * process additionally tries a direct probe when it shares the oracle's
 * loopback (`PAYPHONE_ORACLE_URL` set), and falls back to the engine's
 * verdict — cold free-tier containers can exceed short client timeouts, but
 * the engine's view is always current.
 */

const ENGINE_URL = process.env.PAYPHONE_ENGINE_URL || "http://127.0.0.1:8080";
const ORACLE_URL = process.env.PAYPHONE_ORACLE_URL; // optional for THIS process

async function probe(url: string, timeoutMs = 3000): Promise<boolean> {
  try {
    const resp = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
    return resp.ok;
  } catch {
    return false;
  }
}

export async function GET() {
  let engine = false;
  let oracle = false;
  try {
    const resp = await fetch(`${ENGINE_URL}/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(3000),
    });
    engine = resp.ok;
    const body = engine ? await resp.json() : null;
    const engineSeesOracle = body?.data?.oracle_source === "oracle";
    oracle = ORACLE_URL ? await probe(ORACLE_URL) : false;
    if (!oracle) {
      // Direct probe failed (cold start, no shared loopback, unset env) —
      // trust the engine's own oracle probe.
      oracle = engineSeesOracle;
    }
  } catch {
    // Engine unreachable — still give the oracle a chance for a partial picture.
    if (ORACLE_URL) oracle = await probe(ORACLE_URL);
  }
  return NextResponse.json(
    { web: true, engine, oracle },
    { headers: { "Cache-Control": "no-store" } }
  );
}
