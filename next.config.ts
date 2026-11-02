import type { NextConfig } from "next";

/**
 * PayPhone web console configuration.
 *
 * - Default: `output: "standalone"` — production deploys run
 *   `.next/standalone/server.js` (≈110 MB RSS) which fits constrained hosts
 *   and containers.
 * - `PAYPHONE_STATIC_EXPORT=1` switches to a fully static export for GitHub
 *   Pages (the in-browser demo build; see src/lib/payphone/demo-engine.ts).
 *   Pair it with `PAYPHONE_BASE_PATH=/payphone` for project-page hosting.
 * - `turbopack.memoryLimit` — caps the dev compiler so `next dev` stays within
 *   small sandboxes instead of trading RSS for compile speed until the OOM
 *   killer intervenes.
 */
const isStaticExport = process.env.PAYPHONE_STATIC_EXPORT === "1";

/**
 * Baseline security headers on every console route. CSP stays pragmatic:
 * Next.js hydration requires inline bootstrap scripts, so script-src keeps
 * 'unsafe-inline' — the load-bearing protections here are frame-ancestors
 * (clickjacking), nosniff, referrer hygiene and HSTS. Note: headers() only
 * applies to the server build; the static GitHub-Pages demo build serves
 * plain files and relies on Pages' own headers.
 */
const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "connect-src 'self'",
      "font-src 'self' data:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
  },
];

const nextConfig: NextConfig = {
  output: isStaticExport ? "export" : "standalone",
  basePath: process.env.PAYPHONE_BASE_PATH || undefined,
  images: isStaticExport ? { unoptimized: true } : undefined,
  async headers() {
    if (isStaticExport) return [];
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  turbopack: {
    // Pin the workspace root to THIS package. Without it, Turbopack walks up
    // the directory tree hunting for lockfiles — inside a monorepo checkout
    // (or a sibling staging clone) it can infer the wrong root and nest the
    // standalone output at `.next/standalone/<wrong/path>/server.js`.
    root: process.cwd(),
  },
};

export default nextConfig;
