import type { NextConfig } from "next";

const config: NextConfig = {
  distDir: process.env.NEXT_DIST_DIR || ".next",
  agentRules: false,
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      // Preserve the Origin header on native OAuth POST forms while keeping
      // page paths and query strings out of referrers.
      { key: "Referrer-Policy", value: "strict-origin" },
      { key: "Cache-Control", value: "no-store" },
    ] }];
  },
};
export default config;
