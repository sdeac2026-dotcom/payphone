import { NextRequest, NextResponse } from "next/server";

/**
 * Same-origin gateway to the PayPhone Engine (Rust, port 8080).
 *
 * The browser only ever talks to this route — keeping engine internals off
 * the public surface and enabling one-port deployments. The request body is
 * forwarded byte-exact because merchant signatures are computed over the
 * raw body bytes.
 */

const ENGINE_URL = process.env.PAYPHONE_ENGINE_URL || "http://127.0.0.1:8080";

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "transfer-encoding", "upgrade",
  "proxy-authenticate", "proxy-authorization", "te", "trailer",
  "host", "content-length",
]);

async function proxy(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  // Route folder is /api/v1/[...path] — `path` excludes the literal `v1`.
  // Sandbox transports may add XTransformPort to the query; never forward it.
  const clean = new URLSearchParams(req.nextUrl.search);
  clean.delete("XTransformPort");
  const qs = clean.toString();
  const target = `${ENGINE_URL}/v1/${path.join("/")}${qs ? `?${qs}` : ""}`;
  console.log(`[pp-proxy] ${req.method} ${req.nextUrl.pathname} -> ${target}`);

  const headers = new Headers();
  req.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) headers.set(key, value);
  });
  // Preserve the public origin so the engine builds correct payment URLs.
  headers.set("x-forwarded-host", req.headers.get("host") ?? "localhost:3000");
  headers.set("x-forwarded-proto", req.nextUrl.protocol.replace(":", ""));

  const method = req.method;
  const body = method === "GET" || method === "HEAD" ? undefined : await req.text();

  // Read-only activity scans fan out across EVERY configured EVM network
  // through the RPC mesh and can legitimately take 10-20 s under gateway
  // pressure (adaptive chunks, failover, cooldowns). Killing them at 8 s
  // made the wallet radar show "engine unreachable" on every uncached poll
  // — the exact "explorer sees it, PayPhone doesn't" anxiety this feature
  // exists to prevent. Scans get 30 s; everything else stays snappy at 8 s.
  const joined = path.join("/");
  const isActivityScan =
    method === "GET" &&
    (joined === "wallet/activity" || /^wallet\/[^/]+\/activity$/.test(joined));
  const timeoutMs = isActivityScan ? 30_000 : 8_000;

  try {
    const upstream = await fetch(target, {
      method,
      headers,
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });

    const respHeaders = new Headers();
    upstream.headers.forEach((value, key) => {
      if (!HOP_BY_HOP.has(key.toLowerCase())) respHeaders.set(key, value);
    });

    // Route handler cache hard-off.
    respHeaders.set("Cache-Control", "no-store");

    return new NextResponse(upstream.body, {
      status: upstream.status,
      headers: respHeaders,
    });
  } catch {
    // Production-safe copy: the wallet auto-polls and self-heals, so the
    // user needs reassurance, not shell commands.
    return NextResponse.json(
      {
        error: {
          type: "engine_offline",
          message:
            "PayPhone engine briefly unreachable — waking or restarting. Reconnecting automatically.",
          code: 503,
        },
      },
      { status: 503 }
    );
  }
}

export {
  proxy as GET,
  proxy as POST,
  proxy as PUT,
  proxy as PATCH,
  proxy as DELETE,
};
