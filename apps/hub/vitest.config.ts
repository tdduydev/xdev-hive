import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      { test: { name: "unit", include: ["src/**/*.test.ts"], exclude: ["src/**/*.db.test.ts"] } },
      {
        // Test có database cần Docker; chạy cùng `pnpm test` để CI luôn kiểm RLS.
        test: {
          name: "db",
          include: ["src/**/*.db.test.ts"],
          globalSetup: ["test/db-setup.ts"],
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
