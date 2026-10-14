import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Test logic và component trong src (component khai `// @vitest-environment jsdom`); test Playwright ở e2e/ chạy
// riêng bằng `pnpm test:e2e` vì cần trình duyệt.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  // Máy chạy nhiều tiến trình song song làm test chậm gấp hàng chục lần so với lúc rảnh.
  test: { include: ["src/**/*.test.{ts,tsx}"], testTimeout: 20_000 },
});
