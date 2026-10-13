import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { contract } from "@xdev-hive/contracts";
import { defineConfig, type Plugin } from "vite";
import { contractMethods } from "./src/lib/rpc-methods.ts";

const hub = process.env.HIVE_HUB_URL ?? "http://localhost:3000";

/** `virtual:rpc-methods`: bảng method của thủ tục, xem src/lib/rpc-methods.ts. */
function rpcMethods(): Plugin {
  const id = "virtual:rpc-methods";
  return {
    name: "hive-rpc-methods",
    resolveId: (source) => (source === id ? `\0${id}` : undefined),
    load: (resolved) =>
      resolved === `\0${id}` ? `export default ${JSON.stringify(contractMethods(contract))};` : undefined,
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), rpcMethods()],
  // Component của shadcn/ui import theo `@/…`.
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  // /ws để thử worker qua cổng của Vite (HIVE_PUBLIC_URL khi dev), lệnh cài in ra địa chỉ này. /mcp và /.well-known
  // cũng vậy: token MCP có audience là HIVE_PUBLIC_URL/mcp nên CLI phải gọi qua đúng địa chỉ đó.
  server: {
    proxy: {
      "/rpc": hub,
      "/api": hub,
      // Chỉ endpoint /mcp; /mcp/consent là trang của web.
      "^/mcp(\\?.*)?$": hub,
      "/.well-known": hub,
      "/ws": { target: hub, ws: true },
    },
  },
});
