import { NextResponse } from "next/server";

/**
 * Aggregate health of the PayPhone stack: web + engine + oracle.
 * Powers the status chip in the navigation bar.
 *
 * Oracle detection: in the one-container topology every process shares the
 * loopback and `PAYPHONE_ORACLE_URL` is exported to the web process, so a
 * direct probe is exact. In split topologies (or CI harnesses) the web
 * process may not share the oracle's loopback — there we fall back to the
 * engine's own probe result (`oracle_source: "oracle"` vs
 * `"coingecko/static"`), because the engine already knows where its oracle
 * lives.
 */

const ENGINE_URL = process.env.PAYPHONE_ENGINE_URL || "http://127.0.0.1:8080";
const ORACLE_URL = process.env.PAYPHONE_ORACLE_URL; // optional for THIS process

async function probe(url: string): Promise<boolean> {
  try {
    const resp = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(1500) });
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
      signal: AbortSignal.timeout(1500),
    });
    engine = resp.ok;
    if (ORACLE_URL) {
      oracle = await probe(ORACLE_URL);
    } else {
      const body = await resp.json();
      oracle = body?.data?.oracle_source === "oracle";
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
