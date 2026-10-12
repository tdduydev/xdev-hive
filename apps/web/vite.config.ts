import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const hub = process.env.HIVE_HUB_URL ?? "http://localhost:3000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Component của shadcn/ui import theo `@/…`.
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  // /ws để thử worker qua cổng của Vite (HIVE_PUBLIC_URL khi dev), lệnh cài in ra địa chỉ này. /mcp và /.well-known
  // cũng vậy: token MCP có audience là HIVE_PUBLIC_URL/mcp nên CLI phải gọi qua đúng địa chỉ đó.
  server: {
    proxy: {
      "/rpc": hub,
      "/api": hub,
      "/mcp": hub,
      "/.well-known": hub,
      "/ws": { target: hub, ws: true },
    },
  },
});
