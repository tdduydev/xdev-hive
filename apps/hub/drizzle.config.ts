import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/modules/*/schema.ts",
  out: "./db/migrations",
  schemaFilter: ["hive", "auth"],
  migrations: { schema: "hive", table: "migrations" },
});
