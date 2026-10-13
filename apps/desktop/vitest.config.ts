import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  // Giá trị cố định cho test; bản thật gắn lúc build (vite.config.ts).
  define: { __BUILD_SHA__: JSON.stringify("abc1234"), __BUILD_TIME__: JSON.stringify("2026-10-13T07:05:00.000Z") },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@design": fileURLToPath(new URL("../../docs/design-system", import.meta.url)),
    },
  },
  // CI chạy cả repo song song nên các test màn dài (chat, terminal) có lúc quá 5 giây mặc định.
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["src/test-setup.ts"],
    testTimeout: 20_000,
  },
});
