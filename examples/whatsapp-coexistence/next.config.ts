import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: [
    "chat",
    "@chat-adapter/whatsapp-coexistence",
    "@chat-adapter/state-memory",
  ],
  typescript: {
    ignoreBuildErrors: true,
  },
  turbopack: {
    root: "../..",
  },
};

export default nextConfig;
