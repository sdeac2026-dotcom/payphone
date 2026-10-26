import type { NextConfig } from "next";

/**
 * PayPhone web console configuration.
 *
 * - `output: "standalone"` — production deploys run `.next/standalone/server.js`
 *   (≈110 MB RSS) which fits constrained hosts and containers.
 * - `turbopack.memoryLimit` — caps the dev compiler so `next dev` stays within
 *   small sandboxes instead of trading RSS for compile speed until the OOM
 *   killer intervenes.
 */
const nextConfig: NextConfig = {
  output: "standalone",
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  turbopack: {
    memoryLimit: 1280,
  },
};

export default nextConfig;
