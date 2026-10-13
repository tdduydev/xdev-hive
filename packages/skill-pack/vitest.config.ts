import { defineConfig } from "vitest/config";

// skills/ là dữ liệu: không chạy file mẫu nào trong đó như test.
export default defineConfig({ test: { include: ["src/**/*.test.ts"] } });
