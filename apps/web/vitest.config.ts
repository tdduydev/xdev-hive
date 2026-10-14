import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Chỉ test logic trong src; test Playwright ở e2e/ chạy riêng bằng `pnpm test:e2e` vì cần trình duyệt.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  // Máy chạy nhiều tiến trình song song làm test chậm gấp hàng chục lần so với lúc rảnh.
  test: { include: ["src/**/*.test.ts"], testTimeout: 20_000 },
});
