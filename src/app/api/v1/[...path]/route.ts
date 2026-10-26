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

  try {
    const upstream = await fetch(target, {
      method,
      headers,
      body,
      cache: "no-store",
      // 8s ceiling keeps the UI responsive if the engine hiccups.
      signal: AbortSignal.timeout(8000),
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
    return NextResponse.json(
      {
        error: {
          type: "engine_offline",
          message:
            "PayPhone Engine unreachable. Start it with: cd engine && cargo run --release (or ./scripts/supervise.sh)",
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
