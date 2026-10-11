import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/modules/*/schema.ts",
  out: "./db/migrations",
  schemaFilter: ["hive"],
  migrations: { schema: "hive", table: "migrations" },
});
