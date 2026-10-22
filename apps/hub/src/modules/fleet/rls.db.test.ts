import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createPool, withTenant } from "../platform/index.ts";
import { machines, machineTokenScores, machineTokens, projectTokenUsage, registrationTokens } from "./schema.ts";
import { withTokenLookup } from "./tokens.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);

const orgA = randomUUID();
const orgB = randomUUID();
const tag = randomUUID().slice(0, 8);
const ids = { teamA: "", teamB: "", machineA: "", machineB: "", projectA: "", projectB: "" };

beforeAll(async () => {
  // Seed bằng superuser (bỏ qua RLS) để test đứng độc lập với code đăng ký.
  await admin.query(
    "insert into hive.orgs (id, slug, name, created_by) values ($1, $3, 'A', 'u'), ($2, $4, 'B', 'u')",
    [orgA, orgB, `rls-a-${tag}`, `rls-b-${tag}`],
  );
  const one = async (q: string, p: unknown[]) => (await admin.query(q, p)).rows[0].id as string;
  ids.teamA = await one("insert into hive.teams (org_id, slug, name) values ($1, 't', 'T') returning id", [orgA]);
  ids.teamB = await one("insert into hive.teams (org_id, slug, name) values ($1, 't', 'T') returning id", [orgB]);
  const machine =
    "insert into hive.machines (org_id, team_id, name, os, version) values ($1, $2, 'm', 'linux', '1') returning id";
  ids.machineA = await one(machine, [orgA, ids.teamA]);
  ids.machineB = await one(machine, [orgB, ids.teamB]);
  await admin.query(
    `insert into hive.machine_tokens (org_id, team_id, machine_id, token_hash) values
       ($1, $2, $3, $7), ($4, $5, $6, $8)`,
    [orgA, ids.teamA, ids.machineA, orgB, ids.teamB, ids.machineB, `mt-a-${tag}`, `mt-b-${tag}`],
  );
  await admin.query(
    `insert into hive.registration_tokens (org_id, team_id, token_hash, expires_at, created_by) values
       ($1, $2, $5, now() + interval '1 hour', 'u'), ($3, $4, $6, now() + interval '1 hour', 'u')`,
    [orgA, ids.teamA, orgB, ids.teamB, `rt-a-${tag}`, `rt-b-${tag}`],
  );
  await admin.query(
    `insert into hive.machine_token_scores (org_id, team_id, machine_id, score, coverage, score_version, report, generated_at)
     values ($1, $2, $3, 50, 80, 2, '{}', now()), ($4, $5, $6, 70, 90, 2, '{}', now())`,
    [orgA, ids.teamA, ids.machineA, orgB, ids.teamB, ids.machineB],
  );
  const project = async (org: string, team: string, key: string) => {
    const system = await one(
      "insert into hive.systems (org_id, team_id, slug, name) values ($1, $2, 's', 'S') returning id",
      [org, team],
    );
    const conn = await one(
      "insert into hive.scm_connections (org_id, kind, name, secret_enc, created_by) values ($1, 'github', $2, 'x', 'u') returning id",
      [org, key],
    );
    return one(
      `insert into hive.projects (org_id, team_id, system_id, key, name, scm_connection_id, scm_kind, repo_mode,
         repo_owner, repo_name, state, settings, idempotency_key, created_by)
       values ($1, $2, $3, $4, $4, $5, 'github', 'new', 'xdev', $4, 'active', '{}', gen_random_uuid(), 'u') returning id`,
      [org, team, system, key, conn],
    );
  };
  ids.projectA = await project(orgA, ids.teamA, `rls-a-${tag}`);
  ids.projectB = await project(orgB, ids.teamB, `rls-b-${tag}`);
  await admin.query(
    `insert into hive.project_token_usage (org_id, team_id, project_id, machine_id, user_id, period_start, period_end,
       tokens, sessions, policy_drift)
     values ($1, $2, $3, $4, 'u', now() - interval '1 hour', now(), '{}', 1, '{}'),
            ($5, $6, $7, $8, 'u', now() - interval '1 hour', now(), '{}', 1, '{}')`,
    [orgA, ids.teamA, ids.projectA, ids.machineA, orgB, ids.teamB, ids.projectB, ids.machineB],
  );
});

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

async function pgCode(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code;
  }
}
const RLS_VIOLATION = "42501";
const FK_VIOLATION = "23503";
const tables = [machines, machineTokens, registrationTokens, machineTokenScores, projectTokenUsage];

describe("RLS bảng fleet", () => {
  it("không có context thì mọi bảng trả 0 dòng", async () => {
    await withTenant(app, {}, async (tx) => {
      for (const t of tables) expect(await tx.select().from(t)).toHaveLength(0);
    });
  });

  it("context tổ chức A chỉ thấy dữ liệu của A", async () => {
    await withTenant(app, { orgId: orgA }, async (tx) => {
      for (const t of tables) {
        const rows = await tx.select().from(t);
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((r) => r.orgId === orgA)).toBe(true);
      }
    });
  });

  it("không ghi được máy cho tổ chức khác", async () => {
    const code = await pgCode(() =>
      withTenant(app, { orgId: orgA }, (tx) =>
        tx.insert(machines).values({ orgId: orgB, teamId: ids.teamB, name: "x", os: "linux", version: "1" }),
      ),
    );
    expect(code).toBe(RLS_VIOLATION);
  });

  it("UPDATE không chuyển được máy sang tổ chức khác", async () => {
    const code = await pgCode(() =>
      withTenant(app, { orgId: orgA }, (tx) =>
        tx.update(machines).set({ orgId: orgB }).where(eq(machines.id, ids.machineA)),
      ),
    );
    expect(code).toBe(RLS_VIOLATION);
  });

  it("máy không trỏ được tới đội của tổ chức khác (khoá kép)", async () => {
    const code = await pgCode(() =>
      withTenant(app, { orgId: orgA }, (tx) =>
        tx.insert(machines).values({ orgId: orgA, teamId: ids.teamB, name: "y", os: "linux", version: "1" }),
      ),
    );
    expect(code).toBe(FK_VIOLATION);
  });

  it("machine token không trỏ được tới máy của tổ chức khác (khoá kép)", async () => {
    const code = await pgCode(() =>
      withTenant(app, { orgId: orgA }, (tx) =>
        tx.insert(machineTokens).values({ orgId: orgA, teamId: ids.teamA, machineId: ids.machineB, tokenHash: "z" }),
      ),
    );
    expect(code).toBe(FK_VIOLATION);
  });

  it("điểm token không trỏ được tới máy của tổ chức khác (khoá kép)", async () => {
    const code = await pgCode(() =>
      withTenant(app, { orgId: orgA }, (tx) =>
        tx.insert(machineTokenScores).values({
          orgId: orgA,
          teamId: ids.teamA,
          machineId: ids.machineB,
          coverage: 1,
          scoreVersion: 2,
          report: {} as never,
          generatedAt: new Date(),
        }),
      ),
    );
    expect(code).toBe(FK_VIOLATION);
  });

  const usageRow = (orgId: string, teamId: string, machineId: string, projectId: string) => ({
    orgId,
    teamId,
    projectId,
    machineId,
    userId: "u",
    periodStart: new Date(Date.now() - 3_600_000),
    periodEnd: new Date(),
    tokens: {},
    sessions: 1,
    policyDrift: [],
  });

  it("token theo dự án không trỏ được tới máy hay dự án của tổ chức khác (khoá kép)", async () => {
    const insert = (machineId: string, projectId: string) =>
      withTenant(app, { orgId: orgA }, (tx) =>
        tx.insert(projectTokenUsage).values(usageRow(orgA, ids.teamA, machineId, projectId)),
      );
    expect(await pgCode(() => insert(ids.machineB, ids.projectA))).toBe(FK_VIOLATION);
    expect(await pgCode(() => insert(ids.machineA, ids.projectB))).toBe(FK_VIOLATION);
  });

  it("không ghi được token theo dự án cho tổ chức khác", async () => {
    const code = await pgCode(() =>
      withTenant(app, { orgId: orgA }, (tx) =>
        tx.insert(projectTokenUsage).values(usageRow(orgB, ids.teamB, ids.machineB, ids.projectB)),
      ),
    );
    expect(code).toBe(RLS_VIOLATION);
  });
});

describe("tìm theo băm token khi chưa có tổ chức", () => {
  it("chỉ thấy đúng dòng có băm đó, ở đúng bảng có băm đó", async () => {
    await withTokenLookup(app, `mt-a-${tag}`, async (tx) => {
      expect((await tx.select().from(machineTokens)).map((r) => r.machineId)).toEqual([ids.machineA]);
      expect(await tx.select().from(registrationTokens)).toHaveLength(0);
      expect(await tx.select().from(machines)).toHaveLength(0);
    });
    await withTokenLookup(app, `rt-b-${tag}`, async (tx) => {
      expect((await tx.select().from(registrationTokens)).map((r) => r.orgId)).toEqual([orgB]);
    });
  });

  it("băm sai thì không thấy gì", async () => {
    await withTokenLookup(app, "khong-co", async (tx) => {
      for (const t of tables) expect(await tx.select().from(t)).toHaveLength(0);
    });
  });

  it("biết băm cũng không sửa hay xoá được dòng", async () => {
    await withTokenLookup(app, `rt-a-${tag}`, async (tx) => {
      expect(await tx.update(registrationTokens).set({ usedAt: new Date() }).returning()).toHaveLength(0);
      expect(await tx.delete(registrationTokens).returning()).toHaveLength(0);
    });
    const { rows } = await admin.query("select used_at from hive.registration_tokens where token_hash = $1", [
      `rt-a-${tag}`,
    ]);
    expect(rows[0].used_at).toBeNull();
  });

  it("app.fleet_token_hash không rò sang lần mượn kết nối sau", async () => {
    await withTokenLookup(app, `mt-a-${tag}`, async () => {});
    const client = await app.connect();
    try {
      const { rows } = await client.query("select hive.ctx_fleet_token() as t");
      expect(rows[0]).toEqual({ t: null });
    } finally {
      client.release();
    }
  });
});
