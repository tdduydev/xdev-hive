import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { createPool, parseMasterKey, withTenant } from "../platform/index.ts";
import { terminalChunks, terminalSessions } from "./schema.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const seeded: Record<"a" | "b", { orgId: string; sessionId: string }> = {} as never;
const tables = [terminalSessions, terminalChunks];

beforeAll(async () => {
  const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
  for (const name of ["a", "b"] as const) {
    const tag = randomUUID().slice(0, 6);
    const org = await seedOrg(admin, `term-rls-${name}-${tag}`);
    const { projectId } = await seedProject(admin, app, {
      orgId: org.orgId,
      teamId: org.teamId,
      systemId: org.systemId,
      adminUserId: org.user("admin"),
      masterKey,
      key: `TR${name}${tag}`,
    });
    const machine = await admin.query(
      "insert into hive.machines (org_id, team_id, name, os, version, shared) values ($1, $2, $3, 'linux', '1', true) returning id",
      [org.orgId, org.teamId, `m-${tag}`],
    );
    const session = await admin.query(
      `insert into hive.terminal_sessions (org_id, team_id, project_id, machine_id, owner_user_id, mode, model, cols, rows)
       values ($1, $2, $3, $4, $5, 'propose', 'sonnet', 80, 24) returning id`,
      [org.orgId, org.teamId, projectId, machine.rows[0].id, org.user("tadmin")],
    );
    await admin.query("insert into hive.terminal_chunks (org_id, session_id, seq, data) values ($1, $2, 0, 'hi')", [
      org.orgId,
      session.rows[0].id,
    ]);
    seeded[name] = { orgId: org.orgId, sessionId: session.rows[0].id };
  }
});

afterAll(async () => Promise.all([admin.end(), app.end()]));

describe("RLS bảng terminal", () => {
  it("bật và ép RLS cho cả hai bảng", async () => {
    const { rows } = await admin.query(
      `select relname, relrowsecurity, relforcerowsecurity from pg_class
       where oid in ('hive.terminal_sessions'::regclass, 'hive.terminal_chunks'::regclass)`,
    );
    expect(rows).toHaveLength(2);
    for (const r of rows) expect([r.relname, r.relrowsecurity, r.relforcerowsecurity]).toEqual([r.relname, true, true]);
  });

  it("không có tenant thì không thấy gì", async () => {
    await withTenant(app, {}, async (tx) => {
      for (const table of tables) expect(await tx.select().from(table)).toHaveLength(0);
    });
  });

  it("chỉ thấy phiên và bản ghi của tổ chức mình, không ghi chéo tổ chức", async () => {
    await withTenant(app, { orgId: seeded.a.orgId }, async (tx) => {
      for (const table of tables) {
        const rows = await tx.select().from(table);
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((row) => row.orgId === seeded.a.orgId)).toBe(true);
      }
      await expect(
        tx
          .insert(terminalChunks)
          .values({ orgId: seeded.b.orgId, sessionId: seeded.b.sessionId, seq: 1, data: Buffer.from("x") }),
      ).rejects.toBeDefined();
    });
  });
});
