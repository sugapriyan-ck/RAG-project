import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdf-parse ships Node-only code; keep it out of the bundler.
  serverExternalPackages: ["pdf-parse"],
};

export default nextConfig;
