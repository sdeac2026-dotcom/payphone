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

const nextConfig: NextConfig = {
  output: isStaticExport ? "export" : "standalone",
  basePath: process.env.PAYPHONE_BASE_PATH || undefined,
  images: isStaticExport ? { unoptimized: true } : undefined,
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
