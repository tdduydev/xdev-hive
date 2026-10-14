import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { createPool, parseMasterKey, withTenant } from "../platform/index.ts";
import {
  machineRemoteState,
  pushSubscriptions,
  remoteDevices,
  terminalChunks,
  terminalEvents,
  terminalSessions,
} from "./schema.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const seeded: Record<
  "a" | "b",
  { orgId: string; sessionId: string; localId: string; machineId: string; user: string }
> = {} as never;
const tables = [terminalSessions, terminalChunks, terminalEvents, remoteDevices, pushSubscriptions, machineRemoteState];
const names = [
  "terminal_sessions",
  "terminal_chunks",
  "terminal_events",
  "remote_devices",
  "push_subscriptions",
  "machine_remote_state",
];

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
    const owner = org.user("tmember");
    const personal = await admin.query(
      "insert into hive.machines (org_id, team_id, name, os, version) values ($1, $2, $3, 'darwin', '1') returning id",
      [org.orgId, org.teamId, `p-${tag}`],
    );
    const machineId = personal.rows[0].id;
    // Phiên `hive chat` tại máy cá nhân: không dự án, không chế độ, không model.
    const local = await admin.query(
      `insert into hive.terminal_sessions (org_id, team_id, origin, machine_id, owner_user_id, cli, cwd_label, remote, cols, rows)
       values ($1, $2, 'local', $3, $4, 'codex', 'code/app', true, 120, 40) returning id`,
      [org.orgId, org.teamId, machineId, owner],
    );
    await admin.query(
      "insert into hive.terminal_events (org_id, session_id, seq, kind, actor_user_id, device_id) values ($1, $2, 3, 'control_grant', $3, 'dev-0001')",
      [org.orgId, local.rows[0].id, owner],
    );
    await admin.query(
      "insert into hive.remote_devices (org_id, machine_id, id, user_id, label) values ($1, $2, 'dev-0001', $3, 'iPhone')",
      [org.orgId, machineId, owner],
    );
    await admin.query(
      "insert into hive.push_subscriptions (org_id, user_id, endpoint, p256dh, auth) values ($1, $2, $3, 'k', 'a')",
      [org.orgId, owner, `https://push.test/${tag}`],
    );
    await admin.query(
      `insert into hive.machine_remote_state (machine_id, org_id, enabled, roots) values ($1, $2, true, '[{"id":"root-0001","label":"code"}]')`,
      [machineId, org.orgId],
    );
    seeded[name] = {
      orgId: org.orgId,
      sessionId: session.rows[0].id,
      localId: local.rows[0].id,
      machineId,
      user: owner,
    };
  }
});

afterAll(async () => Promise.all([admin.end(), app.end()]));

describe("RLS bảng terminal", () => {
  it("bật và ép RLS cho mọi bảng", async () => {
    const { rows } = await admin.query(
      `select relname, relrowsecurity, relforcerowsecurity from pg_class
       where relnamespace = 'hive'::regnamespace and relname = any($1)`,
      [names],
    );
    expect(rows).toHaveLength(names.length);
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

  it("phiên Leader vẫn phải có dự án, chế độ và model", async () => {
    await expect(
      admin.query(
        `insert into hive.terminal_sessions (org_id, team_id, machine_id, owner_user_id, cols, rows)
         select org_id, team_id, machine_id, owner_user_id, 80, 24 from hive.terminal_sessions where id = $1`,
        [seeded.a.sessionId],
      ),
    ).rejects.toThrow(/terminal_sessions_hub_fields/);
  });

  it("purge_terminal_chunks xoá bản ghi quá số ngày giữ log của tổ chức, không đụng tổ chức khác", async () => {
    await admin.query(
      `insert into hive.terminal_chunks (org_id, session_id, seq, data, created_at)
       values ($1, $2, 0, 'old', now() - interval '400 days'), ($3, $4, 0, 'old', now() - interval '20 days')`,
      [seeded.a.orgId, seeded.a.localId, seeded.b.orgId, seeded.b.localId],
    );
    await withTenant(app, {}, (tx) => tx.execute(sql`select hive.purge_terminal_chunks()`));
    const { rows } = await admin.query(
      "select org_id, session_id from hive.terminal_chunks where org_id = any($1) order by org_id, session_id",
      [[seeded.a.orgId, seeded.b.orgId]],
    );
    const left = rows.map((r) => `${r.org_id}/${r.session_id}`).sort();
    expect(left).toEqual(
      [
        `${seeded.a.orgId}/${seeded.a.sessionId}`,
        `${seeded.b.orgId}/${seeded.b.sessionId}`,
        `${seeded.b.orgId}/${seeded.b.localId}`,
      ].sort(),
    );
  });
});
