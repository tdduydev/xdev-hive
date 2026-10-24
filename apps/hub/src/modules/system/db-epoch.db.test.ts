import { healthOutput } from "@xdev-hive/contracts";
import pg from "pg";
import { afterAll, describe, expect, inject, it } from "vitest";
import { pgCode } from "../../../test/org-fixture.ts";
import { createPool } from "../platform/index.ts";
import { DbEpochCache, readDbEpoch } from "./db-epoch.ts";
import { jobsOnlyFetch } from "./jobs-app.ts";
import { JobsHeartbeat } from "./jobs-health.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
afterAll(() => Promise.all([admin.end(), app.end()]));

const INSUFFICIENT_PRIVILEGE = "42501";

describe("mốc database", () => {
  it("migration tạo đúng một dòng; hive_app chỉ đọc", async () => {
    const { rows } = await admin.query("select epoch from hive.db_epoch");
    expect(rows).toHaveLength(1);
    expect(await readDbEpoch(app)()).toEqual({ dbEpoch: rows[0].epoch, dbRestoredTo: null });
    for (const statement of [
      "update hive.db_epoch set epoch = gen_random_uuid()",
      "insert into hive.db_epoch (id) values (true)",
      "delete from hive.db_epoch",
    ])
      expect(await pgCode(() => app.query(statement))).toBe(INSUFFICIENT_PRIVILEGE);
    const forced = await admin.query(
      "select relrowsecurity, relforcerowsecurity from pg_class where oid = 'hive.db_epoch'::regclass",
    );
    expect(forced.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it("không thêm được dòng thứ hai", async () => {
    expect(await pgCode(() => admin.query("insert into hive.db_epoch (id) values (false)"))).toBe("23514");
  });

  it("health trả mốc mới sau khi khôi phục đổi mốc", async () => {
    const epoch = new DbEpochCache(0);
    epoch.provide(readDbEpoch(app));
    const before = await epoch.current();
    // Cùng câu lệnh deploy/backup-common.sh (db_epoch_sql) chạy sau pg_restore.
    await admin.query(
      "update hive.db_epoch set epoch = gen_random_uuid(), restored_to = '2026-10-11T03:00:00Z', changed_at = now()",
    );
    const after = await epoch.current();
    expect(after.dbEpoch).not.toBe(before.dbEpoch);
    expect(after.dbRestoredTo).toBe("2026-10-11T03:00:00.000Z");

    const res = await jobsOnlyFetch(
      { port: 0, version: "1.2.3", roles: ["jobs"] },
      new JobsHeartbeat(),
      epoch,
    )(new Request("http://hub/api/v1/health"));
    expect(healthOutput.parse(await res.json())).toMatchObject(after);
  });
});
