import { defineConfig } from "nitro";

export default defineConfig({
  serverDir: "./server",
  compatibilityDate: "2025-01-20",
  traceDeps: ["@discordjs/ws"],
});
