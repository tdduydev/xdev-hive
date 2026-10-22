import { randomUUID } from "node:crypto";
import { call } from "@orpc/server";
import { DEFAULT_AGENT_POLICY, type MachineEventInput } from "@xdev-hive/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { errorCode, type OrgFixture, seedOrg } from "../../../test/org-fixture.ts";
import { catalogRouter } from "../catalog/index.ts";
import { saveAgentPolicy } from "../governance/index.ts";
import type { Auth } from "../identity/index.ts";
import { createPool, withTenant } from "../platform/index.ts";
import { ORG_HEADER } from "../tenancy/index.ts";
import { deleteMyProjectUsage, purgeProjectUsage } from "./project-usage.ts";
import { receiveMachineEvent } from "./token-scores.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);

type Fixture = OrgFixture & { user: (n: string) => string };
const tag = randomUUID().slice(0, 8);
let org: Fixture;
let other: Fixture;
/** Dự án của đội chính, dự án của đội CRM, dự án của tổ chức khác. */
let project = { id: "", key: "" };
let crmProject = { id: "", key: "" };
let otherProject = { id: "", key: "" };
/** Máy theo người đăng ký: thành viên, viewer, người không thuộc đội, quản trị đội, máy chưa ghi người đăng ký. */
const m = { member: "", viewer: "", loner: "", tadmin: "", nobody: "", other: "" };

async function seedProject(o: Fixture, teamId: string, systemId: string, key: string) {
  const conn = (
    await admin.query(
      `insert into hive.scm_connections (org_id, kind, name, secret_enc, created_by)
       values ($1, 'github', $2, 'x', 'seed') returning id`,
      [o.orgId, `gh-${key}`],
    )
  ).rows[0].id;
  const id = (
    await admin.query(
      `insert into hive.projects (org_id, team_id, system_id, key, name, scm_connection_id, scm_kind, repo_mode,
         repo_owner, repo_name, state, settings, idempotency_key, created_by)
       values ($1, $2, $3, $4, $4, $5, 'github', 'new', 'xdev', $4, 'active', '{}', gen_random_uuid(), 'seed')
       returning id`,
      [o.orgId, teamId, systemId, key, conn],
    )
  ).rows[0].id as string;
  return { id, key };
}

async function seedMachine(o: Fixture, name: string, owner: string | null) {
  const { rows } = await admin.query(
    `insert into hive.machines (org_id, team_id, name, os, version, registered_by)
     values ($1, $2, $3, 'linux', '1', $4) returning id`,
    [o.orgId, o.teamId, `${name}-${tag}`, owner],
  );
  return rows[0].id as string;
}

beforeAll(async () => {
  org = await seedOrg(admin, `pu${tag}`);
  other = await seedOrg(admin, `pu2${tag}`);
  project = await seedProject(org, org.teamId, org.systemId, `thanh-toan-${tag}`);
  crmProject = await seedProject(org, org.otherTeamId, org.otherSystemId, `crm-${tag}`);
  otherProject = await seedProject(other, other.teamId, other.systemId, `khac-${tag}`);
  m.member = await seedMachine(org, "member", org.user("tmember"));
  m.viewer = await seedMachine(org, "viewer", org.user("tviewer"));
  m.loner = await seedMachine(org, "loner", org.user("loner"));
  m.tadmin = await seedMachine(org, "tadmin", org.user("tadmin"));
  m.nobody = await seedMachine(org, "nobody", null);
  m.other = await seedMachine(other, "other", other.user("tmember"));
});

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

const machine = (id: string, o: Fixture = org) => ({ id, orgId: o.orgId, teamId: o.teamId });
const newKey = () => `k${randomUUID().replaceAll("-", "")}`;

const propose = (projectId: string, content: string, key = newKey()): MachineEventInput => ({
  key,
  kind: "memory.propose",
  createdAt: new Date().toISOString(),
  payload: { projectId, kind: "note", content },
});

const usage = (
  projectId: string,
  periodEnd: Date,
  opts: { sessions?: number; weighted?: number } = {},
  key = newKey(),
): MachineEventInput => ({
  key,
  kind: "project.token_usage",
  createdAt: new Date().toISOString(),
  payload: {
    projectId,
    periodStart: new Date(periodEnd.getTime() - 60 * 60 * 1000).toISOString(),
    periodEnd: periodEnd.toISOString(),
    tokens: {
      claude: { input: 1000, output: 200, cacheRead: 5000, weighted: opts.weighted ?? 1700.4 },
      codex: { input: 300, output: 50, cacheRead: 0, weighted: 300 },
    },
    sessions: opts.sessions ?? 3,
    score: 72,
    policyDrift: ["rtk"],
  },
});

const usageRows = async (machineId: string) =>
  (
    await admin.query(
      "select project_id, user_id, team_id, sessions, score, policy_drift from hive.project_token_usage where machine_id = $1",
      [machineId],
    )
  ).rows;

describe("máy gửi memory.propose (spec 029 T021)", () => {
  const setMode = (mode: "off" | "propose" | "direct") =>
    withTenant(app, { userId: org.user("admin"), orgId: org.orgId }, (tx) =>
      saveAgentPolicy(tx, org.user("admin"), { ...DEFAULT_AGENT_POLICY, agentMemory: { mode, maxPerRun: 5 } }),
    );
  afterAll(() => setMode(DEFAULT_AGENT_POLICY.agentMemory.mode));
  const memoriesWith = async (content: string) =>
    (
      await admin.query(
        "select id, status, project_id, team_id, author_user_id from hive.memories where org_id = $1 and content = $2",
        [org.orgId, content],
      )
    ).rows;

  it("tổ chức tắt memory thì từ chối MEMORY_DISABLED, không ghi gì", async () => {
    await setMode("off");
    try {
      const content = `Tắt ${tag}`;
      const out = await receiveMachineEvent(app, machine(m.member), propose(project.id, content));
      expect(out).toMatchObject({ outcome: "rejected", code: "MEMORY_DISABLED" });
      expect(await memoriesWith(content)).toHaveLength(0);
    } finally {
      await setMode("direct");
    }
  });

  it("chủ máy không ghi được vào dự án thì NOT_PROJECT_MEMBER", async () => {
    const cases: Array<[string, string]> = [
      [m.loner, project.id], // không thuộc đội của dự án
      [m.viewer, project.id], // viewer chỉ đọc
      [m.nobody, project.id], // máy chưa ghi người đăng ký
      [m.member, crmProject.id], // dự án của đội khác
      [m.member, otherProject.id], // dự án của tổ chức khác: RLS giấu, như không tồn tại
      [m.member, randomUUID()],
    ];
    for (const [id, projectId] of cases) {
      const content = `Không nhận ${randomUUID()}`;
      const out = await receiveMachineEvent(app, machine(id), propose(projectId, content));
      expect(out).toMatchObject({ outcome: "rejected", code: "NOT_PROJECT_MEMBER" });
      expect(await memoriesWith(content)).toHaveLength(0);
    }
  });

  it("nhận thì memory chờ duyệt dù chính sách cho ghi thẳng; audit ghi máy nguồn; gửi lại khoá thì duplicate", async () => {
    await setMode("direct");
    const content = `Dự án dùng pnpm qua corepack ${tag}`;
    const e = propose(project.id, content);
    const first = await receiveMachineEvent(app, machine(m.member), e);
    expect(first).toMatchObject({ key: e.key, outcome: "accepted" });
    const again = await receiveMachineEvent(app, machine(m.member), e);
    expect(again).toMatchObject({ key: e.key, outcome: "duplicate", receivedAt: first.receivedAt });

    const rows = await memoriesWith(content);
    expect(rows).toEqual([
      {
        id: expect.any(String),
        status: "pending",
        project_id: project.id,
        team_id: org.teamId,
        author_user_id: org.user("tmember"),
      },
    ]);
    const audit = await admin.query(
      "select action, actor_user_id, data from hive.audit_log where org_id = $1 and target_id = $2",
      [org.orgId, rows[0].id],
    );
    expect(audit.rows).toEqual([
      {
        action: "memory.write",
        actor_user_id: org.user("tmember"),
        data: { kind: "note", status: "pending", source: "machine", machineId: m.member },
      },
    ]);
  });
});

describe("máy gửi project.token_usage (spec 029 T022)", () => {
  it("ghi đứng tên chủ máy; trong 10 phút thì RATE_LIMITED; cùng kỳ gửi lại thì cập nhật", async () => {
    const end = new Date(Date.now() - 5 * 60 * 1000);
    const first = await receiveMachineEvent(app, machine(m.member), usage(project.id, end));
    expect(first).toMatchObject({ outcome: "accepted" });
    expect(await usageRows(m.member)).toEqual([
      {
        project_id: project.id,
        user_id: org.user("tmember"),
        team_id: org.teamId,
        sessions: 3,
        score: 72,
        policy_drift: ["rtk"],
      },
    ]);

    const tooSoon = await receiveMachineEvent(app, machine(m.member), usage(project.id, new Date()));
    expect(tooSoon).toMatchObject({ outcome: "rejected", code: "RATE_LIMITED" });
    expect(tooSoon.reason).toMatch(/10 phút/);
    expect(await usageRows(m.member)).toHaveLength(1);

    // Qua 10 phút, máy gửi lại đúng kỳ đó (vd. sau khi mất mạng) thì ghi đè, không thêm dòng.
    await admin.query(
      "update hive.project_token_usage set received_at = now() - interval '11 minutes' where machine_id = $1",
      [m.member],
    );
    const later = await receiveMachineEvent(app, machine(m.member), usage(project.id, end, { sessions: 5 }));
    expect(later).toMatchObject({ outcome: "accepted" });
    expect((await usageRows(m.member)).map((r) => r.sessions)).toEqual([5]);
  });

  it("vai trò tính theo đội của từng dự án", async () => {
    const out = await receiveMachineEvent(app, machine(m.tadmin), usage(crmProject.id, new Date()));
    expect(out).toMatchObject({ outcome: "rejected", code: "NOT_PROJECT_MEMBER" });
    const ok = await receiveMachineEvent(app, machine(m.tadmin), usage(project.id, new Date(), { weighted: 99 }));
    expect(ok).toMatchObject({ outcome: "accepted" });
  });

  it("viewer của đội gửi được; người ngoài đội, máy chưa có chủ, dự án khác tổ chức thì NOT_PROJECT_MEMBER", async () => {
    const ok = await receiveMachineEvent(app, machine(m.viewer), usage(project.id, new Date(), { weighted: 5000 }));
    expect(ok).toMatchObject({ outcome: "accepted" });
    for (const [id, projectId] of [
      [m.loner, project.id],
      [m.nobody, project.id],
      [m.member, otherProject.id],
    ] as const) {
      const out = await receiveMachineEvent(app, machine(id), usage(projectId, new Date()));
      expect(out).toMatchObject({ outcome: "rejected", code: "NOT_PROJECT_MEMBER" });
    }
    expect(await usageRows(m.loner)).toHaveLength(0);
    expect(await usageRows(m.nobody)).toHaveLength(0);
  });

  it("gửi lại cùng khoá thì duplicate, không ghi thêm", async () => {
    const e = usage(otherProject.id, new Date());
    const first = await receiveMachineEvent(app, machine(m.other, other), e);
    expect(first).toMatchObject({ outcome: "accepted" });
    const again = await receiveMachineEvent(app, machine(m.other, other), e);
    expect(again).toMatchObject({ outcome: "duplicate" });
    expect(await usageRows(m.other)).toHaveLength(1);
  });
});

describe("xem token theo dự án (projects.tokenUsage)", () => {
  const routerFor = (userId: string) =>
    catalogRouter({
      pool: app,
      auth: {
        api: { getSession: async () => ({ user: { id: userId, name: userId, email: `${userId}@seed.test` } }) },
      } as unknown as Auth,
      providerFactory: () => {
        throw new Error("không dùng");
      },
      publicUrl: "http://hub.test",
    } as unknown as Parameters<typeof catalogRouter>[0]);
  const read = (userId: string, key: string, orgId = org.orgId, days = 7) =>
    call(routerFor(userId).tokenUsage, { key, days }, { context: { headers: new Headers({ [ORG_HEADER]: orgId }) } });

  beforeAll(async () => {
    // Máy của loner gửi trước khi rời đội: dòng cũ 20 ngày, chỉ hiện khi xem 30 ngày.
    await admin.query(
      `insert into hive.project_token_usage (org_id, team_id, project_id, machine_id, user_id, period_start, period_end,
         tokens, sessions, score, policy_drift, received_at)
       values ($1, $2, $3, $4, $5, now() - interval '20 days 1 hour', now() - interval '20 days',
         '{"claude": {"input": 1, "output": 1, "cacheRead": 0, "weighted": 10}}', 1, null, '{}', now() - interval '20 days')`,
      [org.orgId, org.teamId, project.id, m.loner, org.user("loner")],
    );
  });

  it("người có vai trò ở đội xem được: mỗi máy một dòng mới nhất, token quy đổi, xếp nhiều trước", async () => {
    const { rows } = await read(org.user("tviewer"), project.key);
    expect(rows.map((r) => [r.machineId, r.userId, r.tokens])).toEqual([
      [m.viewer, org.user("tviewer"), 5300],
      [m.member, org.user("tmember"), 2000],
      [m.tadmin, org.user("tadmin"), 399],
    ]);
    expect(rows[0]).toMatchObject({
      userName: org.user("tviewer"),
      machineName: `viewer-${tag}`,
      sessions: 3,
      score: 72,
      policyDrift: ["rtk"],
    });
    const wider = await read(org.user("tadmin"), project.key, org.orgId, 30);
    expect(wider.rows.map((r) => r.machineId)).toContain(m.loner);
  });

  it("người ngoài đội của dự án, hay tổ chức khác, không thấy dự án", async () => {
    await expect(read(org.user("loner"), project.key)).rejects.toThrow("Không tìm thấy dự án trong tổ chức.");
    await expect(read(org.user("oadmin"), project.key)).rejects.toThrow("Không tìm thấy dự án trong tổ chức.");
    // Quản trị tổ chức khác dùng tổ chức của mình: RLS giấu dự án và số liệu của tổ chức này.
    await expect(read(other.user("owner"), project.key, other.orgId)).rejects.toThrow(
      "Không tìm thấy dự án trong tổ chức.",
    );
    const own = await read(other.user("tmember"), otherProject.key, other.orgId);
    expect(own.rows.map((r) => r.machineId)).toEqual([m.other]);
  });
});

describe("chủ máy xoá số liệu đã gửi, job dọn 90 ngày", () => {
  it("chỉ chủ máy xoá được; xoá thì mất hết dòng của máy và có audit", async () => {
    const as = (who: string, machineId: string) =>
      withTenant(app, { userId: org.user(who), orgId: org.orgId }, (tx) =>
        deleteMyProjectUsage(tx, org.user(who), machineId),
      );
    expect(await errorCode(() => as("tadmin", m.viewer))).toBe("NOT_MACHINE_OWNER");
    expect(await errorCode(() => as("tviewer", randomUUID()))).toBe("MACHINE_NOT_FOUND");
    // Máy của tổ chức khác: RLS giấu, như không tồn tại.
    expect(await errorCode(() => as("tmember", m.other))).toBe("MACHINE_NOT_FOUND");
    expect(await usageRows(m.viewer)).toHaveLength(1);

    expect(await as("tviewer", m.viewer)).toEqual({ deleted: 1 });
    expect(await usageRows(m.viewer)).toHaveLength(0);
    expect(await usageRows(m.member)).toHaveLength(1);
    const audit = await admin.query(
      "select actor_user_id, data from hive.audit_log where org_id = $1 and action = 'machine.project_usage_delete'",
      [org.orgId],
    );
    expect(audit.rows).toEqual([{ actor_user_id: org.user("tviewer"), data: { name: `viewer-${tag}`, deleted: 1 } }]);
  });

  it("job dọn xoá dòng quá 90 ngày, giữ dòng mới", async () => {
    await admin.query(
      `insert into hive.project_token_usage (org_id, team_id, project_id, machine_id, user_id, period_start, period_end,
         tokens, sessions, score, policy_drift, received_at)
       values ($1, $2, $3, $4, $5, now() - interval '100 days 1 hour', now() - interval '100 days', '{}', 0, null, '{}',
         now() - interval '100 days')`,
      [org.orgId, org.teamId, project.id, m.tadmin, org.user("tadmin")],
    );
    expect(await usageRows(m.tadmin)).toHaveLength(2);
    expect(await purgeProjectUsage(app)).toBeGreaterThanOrEqual(1);
    expect(await usageRows(m.tadmin)).toHaveLength(1);
  });
});
