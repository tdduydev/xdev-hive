import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const hub = process.env.HIVE_HUB_URL ?? "http://localhost:3000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // /ws để thử worker qua cổng của Vite (HIVE_PUBLIC_URL khi dev), lệnh cài in ra địa chỉ này.
  server: { proxy: { "/rpc": hub, "/api": hub, "/ws": { target: hub, ws: true } } },
});
