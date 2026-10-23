import { HUB_DATA_INVENTORY } from "@xdev-hive/contracts";
import pg from "pg";
import { afterAll, expect, inject, it } from "vitest";

const admin = new pg.Pool({ connectionString: inject("db").adminUrl });
afterAll(() => admin.end());

it("mọi bảng nghiệp vụ trong hive và auth có trong Dữ liệu hub giữ", async () => {
  const { rows } = await admin.query<{ name: string }>(
    "select table_schema || '.' || table_name as name from information_schema.tables where table_schema in ('hive', 'auth') and table_type = 'BASE TABLE'",
  );
  const tables = HUB_DATA_INVENTORY.flatMap((c) => c.tables);
  expect(rows.map((r) => r.name).sort()).toEqual([...tables].sort());
});
