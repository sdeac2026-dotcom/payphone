import { NextResponse } from "next/server";

/**
 * Aggregate health of the PayPhone stack: web + engine + oracle.
 * Powers the status chip in the navigation bar.
 */

const ENGINE_URL = process.env.PAYPHONE_ENGINE_URL || "http://127.0.0.1:8080";
const ORACLE_URL = process.env.PAYPHONE_ORACLE_URL || "http://127.0.0.1:8001";

async function probe(url: string): Promise<boolean> {
  try {
    const resp = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(1500) });
    return resp.ok;
  } catch {
    return false;
  }
}

export async function GET() {
  const [engine, oracle] = await Promise.all([
    probe(`${ENGINE_URL}/health`),
    probe(`${ORACLE_URL}/health`),
  ]);
  return NextResponse.json(
    { web: true, engine, oracle },
    { headers: { "Cache-Control": "no-store" } }
  );
}
