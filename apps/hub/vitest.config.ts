import { defineConfig } from "vitest/config";

const isolatedDbTests = [
  "src/tenancy.db.test.ts",
  "src/invite-only.db.test.ts",
  "src/migrations-upgrade.db.test.ts",
  "src/modules/tenancy/orphans.db.test.ts",
  "src/modules/audit/retention.db.test.ts",
  "src/modules/knowledge/vector.db.test.ts",
  "src/modules/codereview/queries.db.test.ts",
];

export default defineConfig({
  test: {
    projects: [
      { test: { name: "unit", include: ["src/**/*.test.ts"], exclude: ["src/**/*.db.test.ts"] } },
      {
        // Test có database cần Docker; chạy cùng `pnpm test` để CI luôn kiểm RLS.
        test: {
          name: "db",
          include: ["src/**/*.db.test.ts"],
          exclude: isolatedDbTests,
          globalSetup: ["test/db-setup.ts"],
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
      {
        // bootstrapRoles sửa catalog role chung của cả cụm Postgres, nên các fixture gọi nó không được chạy song song.
        // SC-003 cần đo sau bộ test thường trên database riêng để không tranh tài nguyên với fixture/migration.
        test: {
          name: "db-isolated",
          include: isolatedDbTests,
          globalSetup: ["test/db-setup.ts"],
          sequence: { groupOrder: 1 },
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
