import { defineConfig } from "vitest/config";

// Chỉ test logic trong src; test Playwright ở e2e/ chạy riêng bằng `pnpm test:e2e` vì cần trình duyệt.
export default defineConfig({ test: { include: ["src/**/*.test.ts"] } });
