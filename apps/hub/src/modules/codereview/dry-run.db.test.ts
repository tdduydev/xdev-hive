import { randomBytes, randomUUID } from "node:crypto";
import {
  CODE_WORKFLOW_PRESETS,
  type CodeDryRunInput,
  defaultProjectSettings,
  type ProjectSettings,
  type WorkflowInput,
  workflowInput,
} from "@xdev-hive/contracts";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { errorCode, type OrgFixture, seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { createPool, NotFoundError, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import { type CodeRunPort, dryRunCodeWorkflow, workflowFromProject } from "./dry-run.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);

type Fixture = OrgFixture & { user: (n: string) => string };
let org: Fixture;
let projectKey = "";
let projectId = "";
let runId = "";

const as = <T>(who: string, fn: (tx: Tx) => Promise<T>) =>
  withTenant(app, { userId: org.user(who), orgId: org.orgId }, fn);

/**
 * Cách `runs` đọc run cho chạy thử, viết lại bằng SQL để test không phải kéo cả lõi run: run + dự án + loại task, và
 * `diffStats` trong sự kiện `result` của worker. Bảng chạy qua hive_app nên RLS vẫn áp dụng.
 */
const runs: CodeRunPort = {
  async load(tx, _userId, id) {
    const { rows } = await tx.execute<{
      id: string;
      kind: string;
      pr_url: string | null;
      project_id: string;
      team_id: string;
      key: string;
      name: string;
      default_branch: string;
      task_type: string | null;
    }>(
      sql`select r.id, r.kind, r.pr_url, r.project_id, r.team_id, p.key, p.name, p.default_branch, t.type as task_type
          from hive.runs r join hive.projects p on p.id = r.project_id left join hive.tasks t on t.id = r.task_id
          where r.id = ${id}`,
    );
    const r = rows[0];
    if (!r) throw new NotFoundError("RUN_NOT_FOUND", "Không tìm thấy run.");
    const ev = await tx.execute<{ stats: unknown }>(
      sql`select data->'diffStats' as stats from hive.run_events where run_id = ${r.id} and type = 'result' limit 1`,
    );
    const m = r.pr_url ? /\/(\d+)$/.exec(r.pr_url) : null;
    return {
      id: r.id,
      kind: r.kind,
      project: { id: r.project_id, key: r.key, name: r.name, teamId: r.team_id, defaultBranch: r.default_branch },
      taskType: r.task_type,
      pr: r.pr_url && m ? { number: Number(m[1]), url: r.pr_url } : null,
      baseBranch: r.default_branch,
      stats: (ev.rows[0]?.stats as never) ?? null,
    };
  },
};

function codeWorkflow(extra: Partial<WorkflowInput> & { code?: Partial<NonNullable<WorkflowInput["code"]>> } = {}) {
  const { code, ...rest } = extra;
  return workflowInput.parse({
    name: `Code ${randomUUID().slice(0, 4)}`,
    preset: "code-basic",
    subject: "code",
    teamId: org.teamId,
    docPrefixes: [],
    code: { projects: [projectKey], ...code },
    phases: CODE_WORKFLOW_PRESETS["code-basic"],
    enabled: true,
    ...rest,
  });
}

const dryRun = (who: string, workflow: WorkflowInput, id = runId) =>
  as(who, (tx) => dryRunCodeWorkflow(tx, org.user(who), { workflow, runId: id } as CodeDryRunInput, runs));

async function seedRun(opts: { taskType?: string | null; diffStats?: unknown; kind?: string; prUrl?: string | null }) {
  const num = Math.floor(Math.random() * 1e6);
  const task = await admin.query(
    `insert into hive.tasks (org_id, team_id, project_id, number, key, title, type, created_by)
     values ($1, $2, $3, $4, $5, 'Sửa làm tròn', $6, $7) returning id`,
    [org.orgId, org.teamId, projectId, num, `DR${tag}-${num}`, opts.taskType ?? null, org.user("tmember")],
  );
  const run = await admin.query(
    `insert into hive.runs (org_id, team_id, task_id, project_id, kind, state, branch, policy_snapshot, pr_url, created_by)
     values ($1, $2, $3, $4, $5, 'needs_review', $6, '[]'::jsonb, $7, $8) returning id`,
    [
      org.orgId,
      org.teamId,
      task.rows[0].id,
      projectId,
      opts.kind ?? "code",
      `ai/DR${tag}-${num}`,
      opts.prUrl === undefined ? "https://gitlab.com/xdev-team/repo/-/merge_requests/42" : opts.prUrl,
      org.user("tmember"),
    ],
  );
  const id = run.rows[0].id as string;
  if (opts.diffStats !== undefined)
    await admin.query(
      `insert into hive.run_events (org_id, run_id, attempt, seq, type, data) values ($1, $2, 1, 1, 'result', $3)`,
      [org.orgId, id, JSON.stringify({ exit: 0, headSha: null, report: null, diffStats: opts.diffStats })],
    );
  return id;
}

async function saveRaw(w: WorkflowInput, updatedAt?: string) {
  const { rows } = await admin.query(
    `insert into hive.review_workflows (org_id, team_id, name, preset, subject, doc_prefixes, code, phases, enabled, updated_at)
     values ($1, $2, $3, $4, 'code', '{}', $5, $6, $7, coalesce($8::timestamptz, now())) returning id`,
    [
      org.orgId,
      w.teamId,
      w.name,
      w.preset,
      JSON.stringify(w.code),
      JSON.stringify(w.phases),
      w.enabled,
      updatedAt ?? null,
    ],
  );
  return rows[0].id as string;
}

async function setSettings(settings: ProjectSettings) {
  await admin.query("update hive.projects set settings = $2 where id = $1", [projectId, JSON.stringify(settings)]);
}

const STATS = { addedLines: 120, deletedLines: 30, changedFiles: ["src/pay.ts", "src/pay.test.ts"] };

beforeAll(async () => {
  org = await seedOrg(admin, `cd-${tag}`);
  projectKey = `pay-${tag}`;
  projectId = (
    await seedProject(admin, app, {
      orgId: org.orgId,
      teamId: org.teamId,
      systemId: org.systemId,
      adminUserId: org.user("admin"),
      masterKey,
      key: projectKey,
    })
  ).projectId;
  runId = await seedRun({ taskType: "feature", diffStats: STATS });
});

beforeEach(async () => {
  await admin.query("delete from hive.review_workflows where org_id = $1", [org.orgId]);
  await setSettings(defaultProjectSettings());
});

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

describe("chạy thử quy trình code", () => {
  it("khớp run có diffStats; checkpoint bỏ qua theo số dòng đổi và đường dẫn, kèm lý do", async () => {
    const w = codeWorkflow({
      phases: [
        {
          name: "Máy kiểm",
          gates: [
            { id: "rules", name: "Quy tắc", kind: "rule", rules: ["no-secrets"], slaHours: null },
            {
              id: "big",
              name: "Review diff lớn",
              kind: "human",
              reviewers: { users: [], roles: ["team-member"], quorum: 1 },
              conditions: { minChangedLines: 500 },
              slaHours: 24,
            },
            {
              id: "docs",
              name: "Duyệt tài liệu",
              kind: "human",
              reviewers: { users: [], roles: ["team-member"], quorum: 1 },
              conditions: { paths: ["docs/**"] },
              slaHours: 24,
            },
            {
              id: "src",
              name: "Duyệt mã nguồn",
              kind: "human",
              reviewers: { users: [], roles: ["team-member"], quorum: 1 },
              conditions: { paths: ["src/**"], minChangedLines: 100 },
              slaHours: 24,
            },
          ],
        },
      ],
    });
    const r = await dryRun("tmember", w);
    expect(r).toMatchObject({
      runId,
      matched: true,
      reason: "Khớp phạm vi.",
      project: { id: projectId, key: projectKey },
      pr: { number: 42 },
      chosen: { id: null, name: w.name },
      outranked: [],
    });
    const by = Object.fromEntries(r.gates.map((g) => [g.gateId, g]));
    expect(by.rules).toMatchObject({ runs: true, phase: "Máy kiểm" });
    expect(by.big).toMatchObject({ runs: false, reason: "Đổi 150 dòng, dưới ngưỡng 500." });
    expect(by.docs?.runs).toBe(false);
    expect(by.docs?.reason).toContain("docs/**");
    expect(by.src?.runs).toBe(true);
  });

  it("không ghi dữ liệu: không tạo quy trình, run hay phiên", async () => {
    const count = async () =>
      (
        await admin.query(
          `select (select count(*) from hive.review_workflows where org_id = $1) as w,
                  (select count(*) from hive.runs where org_id = $1) as r,
                  (select count(*) from hive.code_reviews where org_id = $1) as c`,
          [org.orgId],
        )
      ).rows[0];
    const before = await count();
    await dryRun("tmember", codeWorkflow());
    expect(await count()).toEqual(before);
  });

  it("không khớp: nói rõ vì sao (dự án, loại task, đường dẫn) và không checkpoint nào chạy", async () => {
    const other = await dryRun("tmember", codeWorkflow({ code: { projects: ["khac"] } }));
    expect(other).toMatchObject({ matched: false, chosen: null });
    expect(other.reason).toContain(`Dự án ${projectKey}`);
    expect(other.gates.every((g) => !g.runs)).toBe(true);

    expect((await dryRun("tmember", codeWorkflow({ code: { taskTypes: ["bugfix"] } }))).reason).toContain(
      "Loại task feature",
    );
    expect((await dryRun("tmember", codeWorkflow({ code: { paths: ["docs/**"] } }))).reason).toContain("docs/**");
    expect((await dryRun("tmember", codeWorkflow({ code: { baseBranches: ["release/*"] } }))).reason).toContain(
      "Nhánh đích main",
    );
  });

  it("run worker cũ không có diffStats: điều kiện đường dẫn coi như khớp, checkpoint vẫn chạy", async () => {
    const old = await seedRun({ taskType: null });
    const r = await dryRun("tmember", codeWorkflow({ code: { paths: ["docs/**"] } }), old);
    expect(r.matched).toBe(true);
    expect(r.gates.every((g) => g.runs)).toBe(true);
  });

  it("quy trình khác cũng khớp: bản nháp cụ thể hơn thắng, bản đã lưu bị lấn; bản nháp thay bản lưu cùng id", async () => {
    const orgWide = await saveRaw(codeWorkflow({ teamId: null, name: "Của tổ chức", code: { projects: [] } }));
    const forTeam = await saveRaw(codeWorkflow({ name: "Của dự án", code: { projects: [projectKey] } }));

    // Bản nháp chỉ của đội (không liệt kê dự án) kém cụ thể hơn quy trình liệt kê dự án.
    const plain = codeWorkflow({ name: "Nháp của đội", code: { projects: [] } });
    const lost = await dryRun("tmember", plain);
    expect(lost.chosen).toEqual({ id: forTeam, name: "Của dự án" });
    expect(lost.outranked.map((o) => o.name)).toEqual(["Nháp của đội", "Của tổ chức"]);
    expect(lost.matched).toBe(true);

    // Sửa chính quy trình đã lưu: bản nháp đứng thay bản lưu, không tự lấn mình.
    const edited = { ...codeWorkflow({ name: "Của dự án (sửa)" }), id: forTeam };
    const same = await dryRun("tmember", edited);
    expect(same.chosen).toEqual({ id: forTeam, name: "Của dự án (sửa)" });
    expect(same.outranked.map((o) => o.name)).toEqual(["Của tổ chức"]);
    expect(orgWide).toBeTruthy();
  });

  it("quy trình tắt không chạy cho run nào; quy trình của đội khác không bị tính là lấn", async () => {
    await saveRaw(codeWorkflow({ teamId: org.otherTeamId, name: "Đội CRM", code: { projects: [] } }));
    const off = await dryRun("tmember", codeWorkflow({ enabled: false }));
    expect(off).toMatchObject({ matched: false, chosen: null, outranked: [] });
    expect(off.reason).toContain("đang tắt");
  });

  it("từ chối run không phải run code, run không thấy, bản nháp tài liệu", async () => {
    const review = await seedRun({ kind: "review" });
    expect(await errorCode(() => dryRun("tmember", codeWorkflow(), review))).toBe("RUN_NOT_CODE");
    expect(await errorCode(() => dryRun("tmember", codeWorkflow(), randomUUID()))).toBe("RUN_NOT_FOUND");
    const doc = workflowInput.parse({
      name: "Tài liệu",
      preset: "custom",
      teamId: org.teamId,
      docPrefixes: ["project/x/prd"],
      enabled: true,
      phases: [{ name: "P", gates: [{ id: "g", name: "G", kind: "rule", rules: ["no-secrets"], slaHours: null }] }],
    });
    await expect(
      as("tmember", (tx) =>
        dryRunCodeWorkflow(tx, org.user("tmember"), { workflow: doc, runId } as CodeDryRunInput, runs),
      ),
    ).rejects.toThrow("chỉ dành cho quy trình code");
  });
});

describe("tạo quy trình từ cấu hình dự án", () => {
  const from = (who: string, key = projectKey) => as(who, (tx) => workflowFromProject(tx, org.user(who), key));

  it("dự án bật review chéo, CI và hai người duyệt → bản nháp đúng, gắn đội, chưa lưu", async () => {
    const s = defaultProjectSettings(2);
    s.features.crossReview = true;
    s.merge.requireCi = true;
    s.outcome.default = [{ check: "review", required: true, by: "codex", minScore: 8, when: { minChangedLines: 50 } }];
    await setSettings(s);

    const w = await from("tadmin");
    expect(w).toMatchObject({
      subject: "code",
      teamId: org.teamId,
      enabled: true,
      code: { projects: [projectKey], taskTypes: [] },
    });
    const gates = w.phases.flatMap((p) => p.gates);
    expect(gates.map((g) => g.kind)).toEqual(["ai", "ext", "human"]);
    expect(gates[0]).toMatchObject({
      ai: { passScore: 8, reviewers: [{ cli: "codex" }] },
      conditions: { minChangedLines: 50 },
    });
    expect(gates[1]).toMatchObject({ ext: { check: "ci" } });
    expect(gates[2]?.reviewers?.quorum).toBe(2);
    const { rows } = await admin.query("select count(*)::int as n from hive.review_workflows where org_id = $1", [
      org.orgId,
    ]);
    expect(rows[0].n).toBe(0);
  });

  it("dự án không có gì để chuyển → chỉ quét bí mật", async () => {
    await setSettings(defaultProjectSettings(0));
    const w = await from("admin");
    expect(w.phases.flatMap((p) => p.gates.map((g) => g.kind))).toEqual(["rule"]);
  });

  it("cần quyền sửa quy trình của đội; không thấy dự án thì như không có", async () => {
    expect(await errorCode(() => from("tmember"))).toBe("TEAM_ROLE_REQUIRED");
    expect(await errorCode(() => from("oadmin"))).toBe("PROJECT_NOT_FOUND");
    expect(await errorCode(() => from("tadmin", "khong-co"))).toBe("PROJECT_NOT_FOUND");
  });
});
