import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Test logic và component trong src (component khai `// @vitest-environment jsdom`); test Playwright ở e2e/ chạy
// riêng bằng `pnpm test:e2e` vì cần trình duyệt.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { include: ["src/**/*.test.{ts,tsx}"] },
});
