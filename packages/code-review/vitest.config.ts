import { defineConfig } from "vitest/config";

export default defineConfig({
  // Component chỉ cần DOM giả; test thuần (patch.test.ts) vẫn chạy được trong môi trường này.
  test: { environment: "jsdom", include: ["src/**/*.test.{ts,tsx}"], setupFiles: ["src/test-setup.ts"] },
});
