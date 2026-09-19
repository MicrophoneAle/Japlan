import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["sharp", "@browserbasehq/stagehand"],
};

export default nextConfig;
