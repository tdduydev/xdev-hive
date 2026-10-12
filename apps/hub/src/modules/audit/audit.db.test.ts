import { randomUUID } from "node:crypto";
import { auditFilters, auditQueryInput } from "@xdev-hive/contracts";
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { seedUsers } from "../../../test/seed.ts";
import { BadRequestError, createPool, type Tx, withTenant } from "../platform/index.ts";
import { requireOrgRole } from "../tenancy/index.ts";
import { exportAudit, queryAudit, recordAudit, withAuditAccess } from "./index.ts";
import { auditLog } from "./schema.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);

const orgA = randomUUID();
const orgB = randomUUID();
let rowB = "";

/** Drizzle bọc lỗi Postgres trong `cause`; so theo mã SQLSTATE cho chắc. */
async function pgCode(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code;
  }
}
// Cùng một mã cho cả vi phạm policy RLS lẫn thiếu quyền trên bảng.
const INSUFFICIENT_PRIVILEGE = "42501";

beforeAll(async () => {
  // Seed bằng superuser (bỏ qua RLS). audit_log không có khoá ngoại nên không cần dựng tổ chức.
  rowB = (
    await admin.query(
      "insert into hive.audit_log (org_id, actor_user_id, action) values ($1, 'u-b', 'team.create') returning id",
      [orgB],
    )
  ).rows[0].id;
});

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

describe("recordAudit", () => {
  it("ghi vào tổ chức của context, lấy người làm từ context khi không truyền", async () => {
    const id = await withTenant(app, { userId: "u-a", orgId: orgA }, (tx) =>
      recordAudit(tx, { action: "team.create", targetType: "team", targetId: "t-1", data: { name: "TA" } }),
    );
    const { rows } = await admin.query("select * from hive.audit_log where id = $1", [id]);
    expect(rows[0]).toMatchObject({
      org_id: orgA,
      actor_user_id: "u-a",
      action: "team.create",
      target_type: "team",
      target_id: "t-1",
      data: { name: "TA" },
    });
  });

  it("actorUserId null nghĩa là hệ thống làm, không lấy từ context", async () => {
    const id = await withTenant(app, { userId: "u-a", orgId: orgA }, (tx) =>
      recordAudit(tx, { action: "system.sync", actorUserId: null }),
    );
    const { rows } = await admin.query("select actor_user_id, data from hive.audit_log where id = $1", [id]);
    expect(rows[0]).toEqual({ actor_user_id: null, data: {} });
  });

  it("rollback cùng thao tác được ghi", async () => {
    const action = `rollback.${randomUUID()}`;
    await expect(
      withTenant(app, { userId: "u-a", orgId: orgA }, async (tx) => {
        await recordAudit(tx, { action });
        throw new Error("thao tác hỏng");
      }),
    ).rejects.toThrow("thao tác hỏng");
    const { rows } = await admin.query("select 1 from hive.audit_log where action = $1", [action]);
    expect(rows).toHaveLength(0);
  });

  it("thiếu tổ chức trong context thì báo lỗi, không ghi lặng lẽ", async () => {
    const code = await pgCode(() => withTenant(app, { userId: "u-a" }, (tx) => recordAudit(tx, { action: "x.y" })));
    expect(code).toBe(INSUFFICIENT_PRIVILEGE);
  });
});

describe("RLS của audit_log", () => {
  it("bật và ép RLS", async () => {
    const { rows } = await admin.query(
      "select relrowsecurity, relforcerowsecurity from pg_class where oid = 'hive.audit_log'::regclass",
    );
    expect(rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it("không có context thì trả 0 dòng", async () => {
    expect(await withTenant(app, {}, (tx) => tx.select().from(auditLog))).toHaveLength(0);
  });

  it("không đọc chéo tổ chức", async () => {
    const seen = await withTenant(app, { userId: "u-a", orgId: orgA }, (tx) => tx.select().from(auditLog));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((r) => r.orgId === orgA)).toBe(true);
    const seenB = await withTenant(app, { userId: "u-b", orgId: orgB }, (tx) => tx.select().from(auditLog));
    expect(seenB.map((r) => r.id)).toEqual([rowB]);
  });

  it("không ghi được dòng cho tổ chức khác", async () => {
    const code = await pgCode(() =>
      withTenant(app, { userId: "u-a", orgId: orgA }, (tx) =>
        tx.insert(auditLog).values({ orgId: orgB, actorUserId: "u-a", action: "team.create" }),
      ),
    );
    expect(code).toBe(INSUFFICIENT_PRIVILEGE);
  });
});

describe("append-only", () => {
  it("hive_app chỉ có SELECT và INSERT", async () => {
    const { rows } = await admin.query(
      `select privilege_type from information_schema.role_table_grants
       where grantee = 'hive_app' and table_schema = 'hive' and table_name = 'audit_log' order by 1`,
    );
    expect(rows.map((r) => r.privilege_type)).toEqual(["INSERT", "SELECT"]);
  });

  it("không UPDATE được, kể cả dòng của chính tổ chức", async () => {
    const code = await pgCode(() =>
      withTenant(app, { userId: "u-b", orgId: orgB }, (tx) =>
        tx.update(auditLog).set({ action: "bị sửa" }).where(eq(auditLog.id, rowB)),
      ),
    );
    expect(code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it("không DELETE hay TRUNCATE được", async () => {
    const del = await pgCode(() =>
      withTenant(app, { userId: "u-b", orgId: orgB }, (tx) => tx.delete(auditLog).where(eq(auditLog.id, rowB))),
    );
    expect(del).toBe(INSUFFICIENT_PRIVILEGE);
    await expect(app.query("truncate hive.audit_log")).rejects.toThrow(/permission denied/);
    const { rows } = await admin.query("select action from hive.audit_log where id = $1", [rowB]);
    expect(rows[0].action).toBe("team.create");
  });
});

// Separate organizations keep viewer fixtures independent of append-only assertions above.
const viewerOrg = randomUUID();
const exportOrg = randomUUID();
const owner = `audit-owner-${randomUUID()}`;
const administrator = `audit-admin-${randomUUID()}`;
const member = `audit-member-${randomUUID()}`;
const runId = randomUUID();
const eventIds: string[] = [];
const view = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(app, { userId: owner, orgId: viewerOrg }, fn);
const query = (input: Record<string, unknown> = {}) => view((tx) => queryAudit(tx, auditQueryInput.parse(input)));

beforeAll(async () => {
  await seedUsers(admin, [owner, administrator, member]);
  await admin.query('update auth."user" set name = $2 where id = $1', [owner, "Audit Investigator"]);
  await admin.query("insert into hive.orgs (id, slug, name, created_by) values ($1, $2, 'Viewer', $3)", [
    viewerOrg,
    `audit-${viewerOrg}`,
    owner,
  ]);
  await admin.query(
    `insert into hive.org_members (org_id, user_id, role, status) values
    ($1, $2, 'owner', 'active'), ($1, $3, 'admin', 'active'), ($1, $4, 'member', 'active')`,
    [viewerOrg, owner, administrator, member],
  );
  const fixtures = [
    [
      owner,
      "team.create",
      "team",
      "payment-api",
      { ip: "10.0.0.7", token: "sensitive-fixture", args: { content: "sensitive-fixture" } },
    ],
    [
      null,
      "mcp.memory_write",
      "mcp_tool",
      "memory_write",
      { via: "run", runId, args: { password: "sensitive-fixture" } },
    ],
    [null, "machine.register", "machine", "worker", {}],
    [owner, "audit.denied", "audit_log", null, { result: "denied" }],
    [null, "doc.update", "doc", "handbook", { runId }],
    [owner, "mcp.tasks_list", "mcp_tool", "tasks_list", { via: "user" }],
    [owner, "sandbox.settings.update", "organization", viewerOrg, {}],
    [null, "system.sync", "system", "sync", {}],
    [owner, "notification_channel.update", "notification_channel", "email", { smtpPassword: "sensitive-fixture" }],
  ];
  const fixtureTime = new Date(Date.now() - 3_600_000).toISOString();
  for (const [i, fixture] of fixtures.entries()) {
    const { rows } = await admin.query(
      `insert into hive.audit_log
      (org_id, actor_user_id, action, target_type, target_id, data, created_at)
      values ($1, $2, $3, $4, $5, $6, $8::timestamptz + $7 * interval '1 microsecond') returning id`,
      [viewerOrg, ...fixture, i, fixtureTime],
    );
    eventIds.push(rows[0].id);
  }
  await admin.query(
    "insert into hive.audit_log (org_id, action, created_at) values ($1, 'old.event', now() - interval '10 days'), ($1, 'expired.event', now() - interval '366 days'), ($1, 'future.event', now() + interval '1 day')",
    [viewerOrg],
  );
});

describe("audit viewer", () => {
  it.each([
    [
      {
        actorType: "user",
        actorId: owner,
        action: "team.create",
        area: "people",
        source: "web",
        result: "ok",
        q: "PAYMENT-API",
      },
      ["team.create"],
    ],
    [{ actorType: "run" }, ["mcp.memory_write", "doc.update"]],
    [{ actorType: "system" }, ["machine.register", "system.sync"]],
    [{ actorId: runId }, ["mcp.memory_write", "doc.update"]],
    [{ actorId: "unknown" }, []],
    [{ area: "work" }, ["mcp.tasks_list"]],
    [{ area: "know" }, ["mcp.memory_write", "doc.update"]],
    [{ area: "proj" }, ["machine.register", "system.sync"]],
    [{ area: "people" }, ["team.create"]],
    [{ area: "agent" }, ["sandbox.settings.update"]],
    [{ area: "other" }, ["audit.denied", "notification_channel.update"]],
    [{ action: "team.create" }, ["team.create"]],
    [{ source: "web", result: "denied" }, ["audit.denied"]],
    [{ source: "mcp" }, ["mcp.memory_write", "doc.update", "mcp.tasks_list"]],
    [{ source: "hub" }, ["machine.register", "system.sync"]],
    [{ q: "10.0.0.7" }, ["team.create"]],
    [{ q: "payment-api" }, ["team.create"]],
    [{ q: "Investigator", action: "team.create" }, ["team.create"]],
    [{ q: "sensitive-fixture" }, []],
    [{ q: "%" }, []],
  ])("filters %j", async (filters, expected) => {
    expect((await query(filters)).items.map((item) => item.action).sort()).toEqual([...expected].sort());
  });

  it("supports each range and excludes future records", async () => {
    for (const range of [1, 7]) expect((await query({ range })).items).toHaveLength(9);
    for (const range of [30, 365]) expect((await query({ range })).items).toHaveLength(10);
  });

  it("paginates equal-millisecond timestamps without duplicates or missing entries and freezes the range", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await query({ limit: 2, ...(cursor ? { cursor } : {}) });
      seen.push(...page.items.map((r) => r.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual([...eventIds].reverse());
    expect(new Set(seen).size).toBe(eventIds.length);
    const first = await query({ limit: 1 });
    await expect(query({ cursor: first.nextCursor, range: 30 })).rejects.toBeInstanceOf(BadRequestError);
    await expect(query({ cursor: "invalid" })).rejects.toBeInstanceOf(BadRequestError);
  });

  it("does not expose data, MCP args, arbitrary credentials, or another organization", async () => {
    const page = await query();
    expect(JSON.stringify(page)).not.toContain("sensitive-fixture");
    expect(page.items.every((row) => eventIds.includes(row.id))).toBe(true);
    expect(page.items[0]).not.toHaveProperty("data");
    const b = await withTenant(app, { userId: "u-b", orgId: orgB }, (tx) => queryAudit(tx, auditQueryInput.parse({})));
    expect(b.items.map((r) => r.id)).toEqual([rowB]);
    const withoutContext = await withTenant(app, {}, (tx) => queryAudit(tx, auditQueryInput.parse({})));
    expect(withoutContext.items).toEqual([]);
  });

  it("orders identical timestamps by id and keeps the original time window during pagination", async () => {
    const orgId = randomUUID();
    const tiedIds = Array.from({ length: 7 }, () => randomUUID())
      .sort()
      .reverse();
    const asOf = new Date(Date.now() - 3_600_000).toISOString();
    await admin.query(
      `insert into hive.audit_log (id, org_id, action, created_at)
      select id, $2, 'tied.event', $3::timestamptz from unnest($1::uuid[]) as id`,
      [tiedIds, orgId, asOf],
    );
    const read = (cursor?: string) =>
      withTenant(app, { userId: owner, orgId }, (tx) => queryAudit(tx, auditQueryInput.parse({ limit: 2, cursor })));
    const first = await read();
    const window = JSON.parse(Buffer.from(first.nextCursor ?? "", "base64url").toString());
    const seen = first.items.map((row) => row.id);
    // A new event must not shift the upper bound of subsequent pages.
    await withTenant(app, { userId: owner, orgId }, (tx) => recordAudit(tx, { action: "new.event" }));
    let cursor = first.nextCursor;
    while (cursor) {
      const page = await read(cursor);
      seen.push(...page.items.map((row) => row.id));
      if (page.nextCursor) {
        expect(JSON.parse(Buffer.from(page.nextCursor, "base64url").toString()).asOf).toBe(window.asOf);
      }
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(tiedIds);
    expect((await read()).items[0]?.action).toBe("new.event");
  });

  it("classifies metadata from current MCP, knowledge, SCM and worker writers", async () => {
    const orgId = randomUUID();
    await withTenant(app, { userId: owner, orgId }, async (tx) => {
      for (const entry of [
        { action: "mcp.memory_write", data: { via: "run", runId } },
        { action: "memory.write", actorUserId: null, data: { runId } },
        { action: "scm_connection.create", targetId: randomUUID() },
        { action: "scm.denied", actorUserId: null, data: { provider: "github", actor: "git-user" } },
        { action: "run.finish", actorUserId: null, targetId: runId },
      ])
        await recordAudit(tx, entry);
      const page = await queryAudit(tx, auditQueryInput.parse({}));
      const byAction = Object.fromEntries(page.items.map((row) => [row.action, row]));
      expect(byAction["mcp.memory_write"]).toMatchObject({
        actorType: "run",
        actorId: runId,
        source: "mcp",
        area: "know",
      });
      expect(byAction["memory.write"]).toMatchObject({ actorType: "run", actorId: runId, source: "mcp", area: "know" });
      expect(byAction["scm_connection.create"]).toMatchObject({ actorType: "user", source: "web", area: "proj" });
      expect(byAction["scm.denied"]).toMatchObject({ actorType: "system", source: "hub", result: "denied" });
      expect(byAction["run.finish"]).toMatchObject({
        actorType: "system",
        actor: "xDev Hive",
        source: "hub",
        area: "work",
      });
    });
  });

  it("restricts both read and export to active owner/admin and commits denied access", async () => {
    for (const userId of [owner, administrator]) {
      const page = await withAuditAccess(
        app,
        { orgId: viewerOrg, userId },
        (tx) => requireOrgRole(tx, userId, "admin"),
        (tx) => queryAudit(tx, auditQueryInput.parse({})),
      );
      expect(page.items.length).toBeGreaterThan(0);
    }
    for (const run of [
      (tx: Tx) => queryAudit(tx, auditQueryInput.parse({})),
      (tx: Tx) => exportAudit(tx, { range: 7, format: "json" }),
    ]) {
      await expect(
        withAuditAccess<unknown>(
          app,
          { orgId: viewerOrg, userId: member },
          (tx) => requireOrgRole(tx, member, "admin"),
          run,
        ),
      ).rejects.toMatchObject({ code: "ORG_ROLE_REQUIRED" });
    }
    const { rows } = await admin.query(
      "select action, data from hive.audit_log where org_id = $1 and actor_user_id = $2",
      [viewerOrg, member],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ action: "audit.denied", data: { result: "denied" } });
  });

  it("rejects missing membership and an administrator whose access was revoked", async () => {
    const orgId = randomUUID();
    await admin.query("insert into hive.orgs (id, slug, name, created_by) values ($1, $2, 'Blocked', $3)", [
      orgId,
      `audit-${orgId}`,
      owner,
    ]);
    await admin.query(
      "insert into hive.org_members (org_id, user_id, role, status) values ($1, $2, 'admin', 'blocked')",
      [orgId, administrator],
    );
    for (const userId of [owner, administrator]) {
      for (const run of [
        (tx: Tx) => queryAudit(tx, auditQueryInput.parse({})),
        (tx: Tx) => exportAudit(tx, { range: 7, format: "csv" }),
      ])
        await expect(
          withAuditAccess<unknown>(app, { orgId, userId }, (tx) => requireOrgRole(tx, userId, "admin"), run),
        ).rejects.toMatchObject({ code: "NOT_ORG_MEMBER" });
    }
  });
});

describe("audit export", () => {
  it("exports matching JSON and CSV and records exactly one audit.export per export", async () => {
    const filters = auditFilters.parse({ action: "team.create" });
    const expected = (await query(filters)).items;
    const json = await view((tx) => exportAudit(tx, { ...filters, format: "json" }));
    expect(JSON.parse(await json.text())).toEqual(expected);
    expect(json.type).toBe("application/json");
    const csv = await view((tx) => exportAudit(tx, { ...filters, format: "csv" }));
    expect(await csv.text()).toContain('"timestamp","actor","action","target","result","source","ip"\r\n');
    expect(await csv.text()).toContain('"Audit Investigator","team.create","team:payment-api","ok","web","10.0.0.7"');
    expect(await csv.text()).not.toContain("sensitive-fixture");
    const events = await query({ action: "audit.export" });
    expect(events.items).toHaveLength(2);
    const { rows } = await admin.query("select data from hive.audit_log where org_id=$1 and action='audit.export'", [
      viewerOrg,
    ]);
    expect(rows.map((r) => r.data)).toEqual(
      expect.arrayContaining([
        { format: "json", range: 7, count: 1, truncated: false },
        { format: "csv", range: 7, count: 1, truncated: false },
      ]),
    );
  });

  it("limits exports to 20,000 rows across 500-row batches and marks truncation", async () => {
    await admin.query(
      `insert into hive.audit_log (org_id, action, target_id, created_at)
      select $1, 'bulk.event', n::text, now() - interval '1 hour' from generate_series(1, 20005) n`,
      [exportOrg],
    );
    const file = await withTenant(app, { orgId: exportOrg, userId: owner }, (tx) =>
      exportAudit(tx, { range: 7, format: "json" }),
    );
    const items = JSON.parse(await file.text());
    expect(items).toHaveLength(20000);
    expect(new Set(items.map((r: { id: string }) => r.id)).size).toBe(20000);
    expect(file.name).toBe("audit-limit-20000.json");
    const { rows } = await admin.query("select data from hive.audit_log where org_id=$1 and action='audit.export'", [
      exportOrg,
    ]);
    expect(rows[0].data).toMatchObject({ count: 20000, truncated: true });
    const csv = await withTenant(app, { orgId: exportOrg, userId: owner }, (tx) =>
      exportAudit(tx, { range: 7, format: "csv", action: "bulk.event" }),
    );
    expect(csv.name).toBe("audit-limit-20000.csv");
    expect((await csv.text()).split("\r\n").filter(Boolean)).toHaveLength(20001);
  });

  it("exports an empty result with valid CSV headers and a JSON array", async () => {
    for (const format of ["csv", "json"] as const) {
      const file = await view((tx) => exportAudit(tx, { range: 7, format, action: "missing.action" }));
      expect(await file.text()).toBe(
        format === "json" ? "[]" : '"timestamp","actor","action","target","result","source","ip"\r\n',
      );
    }
  });

  it("escapes spreadsheet formulas and quoted multiline targets in a real CSV export", async () => {
    const orgId = randomUUID();
    const file = await withTenant(app, { userId: owner, orgId }, async (tx) => {
      await recordAudit(tx, {
        action: "=1+1",
        actorUserId: null,
        targetType: "@target",
        targetId: 'comma, quote"\nnext line',
      });
      return exportAudit(tx, { range: 7, format: "csv" });
    });
    expect(await file.text()).toContain(`"'=1+1","'@target:comma, quote""\nnext line"`);
  });
});
