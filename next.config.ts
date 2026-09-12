import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {
  env: { NEXT_PUBLIC_OFFLINE_VERSION: process.env.VERCEL_GIT_COMMIT_SHA || String(Date.now()) },
  serverExternalPackages: ["mammoth", "pdf-parse"],
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [
          {
            key: "Cache-Control",
            value: "no-cache, no-store, must-revalidate",
          },
          {
            key: "Content-Type",
            value: "application/javascript; charset=utf-8",
          },
        ],
      },
    ];
  },
};

export default withWorkflow(nextConfig);
