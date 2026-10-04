import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Database drivers and the ONNX embedding runtime stay as plain Node
  // modules on the server; they are never bundled, and never reach a browser.
  serverExternalPackages: ["neo4j-driver", "@qdrant/js-client-rest", "bcryptjs"],
  poweredByHeader: false,
  // CLAUDE.md is the hand-written project brief; do not let `next dev` append to it
  agentRules: false,
  // the floating dev badge sits on top of the database health panel
  devIndicators: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "same-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
