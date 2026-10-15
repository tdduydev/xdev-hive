import { randomBytes, randomUUID } from "node:crypto";
import { defaultProjectSettings, projectSdlcSettings, type SdlcItemDetail } from "@xdev-hive/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { errorCode, type OrgFixture, seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { AI_AUTO_ACTOR, saveDoc } from "../knowledge/index.ts";
import { createPool, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import { createItem } from "./items.ts";
import { type MetricsInput, sdlcMetrics } from "./metrics.ts";
import { onBaseline } from "./phases.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);
const key = (k: string) => `m${k}${tag}`;

let org: OrgFixture & { user: (n: string) => string };
const p = { a: "", b: "" };
let main: SdlcItemDetail;
let phaseKind = "";

const as = <T>(who: string, fn: (tx: Tx) => Promise<T>) =>
  withTenant(app, { userId: org.user(who), orgId: org.orgId }, fn);
const range = {
  from: new Date(Date.now() - 30 * 86_400_000).toISOString(),
  to: new Date(Date.now() + 3_600_000).toISOString(),
};
const metrics = (who: string, over: Partial<MetricsInput> = {}) =>
  as(who, (tx) => sdlcMetrics(tx, org.user(who), { ...range, ...over }));

const PHASES = JSON.stringify([
  {
    name: "Duyệt spec",
    gates: [
      { id: "ai", name: "AI chấm", kind: "ai", ai: { checks: ["Đủ ý"], passScore: 8 } },
      { id: "lead", name: "Tech lead", kind: "human", reviewers: { users: [], roles: ["team-admin"], quorum: 1 } },
    ],
  },
]);

async function seedSdlcProject(k: string, teamId: string, systemId: string) {
  return (
    await seedProject(admin, app, {
      orgId: org.orgId,
      teamId,
      systemId,
      adminUserId: org.user("admin"),
      masterKey,
      key: key(k),
      settings: {
        ...defaultProjectSettings(),
        sdlc: projectSdlcSettings.parse({ enabled: true, defaultMode: "speckit", modes: ["speckit"] }),
      },
    })
  ).projectId;
}

const newItem = (projectId: string, participants: string[] = []) =>
  as("admin", (tx) =>
    createItem(tx, org.user("admin"), {
      projectId,
      participants,
      title: "Xuất báo cáo",
      idea: "Xuất báo cáo doanh thu theo tháng ra file CSV cho kế toán.",
      modeRef: "speckit",
      size: "M",
    }),
  );

async function saveBaseline(docKey: string, content: string) {
  return as("admin", (tx) =>
    saveDoc(tx, { kind: "user", userId: org.user("admin") }, { key: docKey, content, baseVersion: 0 }),
  );
}

async function run(costUsd: number, taskId: string | null = null) {
  const { rows } = await admin.query(
    `insert into hive.runs (org_id, team_id, project_id, task_id, kind, state, branch, policy_snapshot, created_by, cost_usd)
     values ($1, $2, $3, $4, 'code', 'succeeded', 'ai/x', '[]', 'seed', $5) returning id`,
    [org.orgId, org.teamId, p.a, taskId, costUsd],
  );
  return rows[0].id as string;
}

/** Phiên duyệt tài liệu với một lượt cổng người (chỉ số 1) đã kết thúc sau `hours` giờ. */
async function review(docKey: string, status: string, gate: { status: string; decidedBy: string; hours: number }) {
  const proposalId = (
    await admin.query(
      `insert into hive.proposals (org_id, team_id, project_id, kind, target, base_version, content, status, author_user_id)
       values ($1, $2, $3, 'doc', $4, 0, 'x', $5, $6) returning id`,
      [org.orgId, org.teamId, p.a, docKey, status === "approved" ? "approved" : "rejected", org.user("admin")],
    )
  ).rows[0].id;
  const instanceId = (
    await admin.query(
      `insert into hive.review_instances (org_id, team_id, project_id, proposal_id, workflow_name, phases, doc_key, doc_title, gate_index, status, author_user_id)
       values ($1, $2, $3, $4, 'SDLC', $5, $6, 'Spec', 1, $7, $8) returning id`,
      [org.orgId, org.teamId, p.a, proposalId, PHASES, docKey, status, org.user("admin")],
    )
  ).rows[0].id as string;
  await admin.query(
    `insert into hive.review_gate_runs (org_id, instance_id, gate_index, gate_id, status, decided_by, started_at, finished_at)
     values ($1, $2, 1, 'lead', $3, $4, now() - make_interval(hours => $5), now())`,
    [org.orgId, instanceId, gate.status, gate.decidedBy, gate.hours],
  );
  return instanceId;
}

beforeAll(async () => {
  org = await seedOrg(admin, `smx-${tag}`);
  p.a = await seedSdlcProject("a", org.teamId, org.systemId);
  p.b = await seedSdlcProject("b", org.otherTeamId, org.otherSystemId);

  // Hạng mục chính ở dự án a, dự án b tham gia; một hạng mục của đội kia; một hạng mục cũ ngoài khoảng.
  main = await newItem(p.a, [p.b]);
  const other = await newItem(p.b);
  const old = await newItem(p.a);
  await admin.query("update hive.sdlc_items set created_at = now() - interval '60 days' where id = $1", [old.id]);

  const spec = main.artifacts.find((a) => a.artifactId === "spec");
  const tasks = main.artifacts.find((a) => a.artifactId === "tasks");
  if (!spec || !tasks) throw new Error("speckit đổi cấu trúc");
  const specDoc = await saveBaseline(
    spec.docKey,
    "# Spec\n\n- **FR-001**: Bảng\n- **FR-002**: Hàm\n- **FR-003**: Lịch\n",
  );
  await admin.query("update hive.sdlc_artifacts set baseline_version = $2 where doc_key = $1", [
    spec.docKey,
    specDoc.version,
  ]);
  const tasksDoc = await saveBaseline(
    tasks.docKey,
    "# Tasks\n\n## Phase 1: A\n\n- [ ] T001 Bảng (FR-001)\n\n## Phase 2: B\n\n- [ ] T002 Hàm (FR-002)\n",
  );
  await as("admin", (tx) =>
    onBaseline(tx, {
      docKey: tasks.docKey,
      version: tasksDoc.version,
      proposalId: randomUUID(),
      reviewId: randomUUID(),
    }),
  );
  const { rows: links } = await admin.query(
    "select task_id, requirement_ids from hive.sdlc_item_tasks where item_id = $1",
    [main.id],
  );
  const t1 = links.find((l) => l.requirement_ids.includes("FR-001"))?.task_id as string;
  // FR-001 xong và có test; FR-002 có task chưa xong; FR-003 chưa có task.
  await admin.query("update hive.tasks set status = 'done' where id = $1", [t1]);
  await admin.query(
    `insert into hive.sdlc_trace_links (org_id, item_id, requirement_id, kind, ref, project_id, task_id)
     values ($1, $2, 'FR-001', 'test', 'report.test.ts', $3, $4)`,
    [org.orgId, main.id, p.a, t1],
  );

  // Lead time: giai đoạn đầu 3 giờ ở hạng mục chính, 7 giờ ở hạng mục của đội kia.
  await admin.query(
    "update hive.sdlc_item_phases set status = 'pending', started_at = null, approved_at = null where item_id = any($1)",
    [[main.id, other.id, old.id]],
  );
  for (const [id, h] of [
    [main.id, 3],
    [other.id, 7],
    [old.id, 50],
  ] as const)
    await admin.query(
      `update hive.sdlc_item_phases set status = 'approved', started_at = now() - make_interval(hours => $2 + 1),
         approved_at = now() - interval '1 hour' where item_id = $1 and phase_index = 0`,
      [id, h],
    );
  phaseKind = (
    await admin.query("select kind from hive.sdlc_item_phases where item_id = $1 and phase_index = 0", [main.id])
  ).rows[0].kind;
  await admin.query("update hive.sdlc_items set converge_round = 2 where id = $1", [main.id]);

  await admin.query(
    `insert into hive.sdlc_questions (org_id, item_id, phase_id, round, position, text, status)
     values ($1, $2, 'specify', 1, 1, 'Xuất theo múi giờ nào?', 'answered'),
            ($1, $2, 'specify', 1, 2, 'Có cần PDF?', 'withdrawn'),
            ($1, $3, 'specify', 1, 1, 'Ai được xem?', 'open'),
            ($1, $4, 'specify', 1, 1, 'Câu cũ?', 'open')`,
    [org.orgId, main.id, other.id, old.id],
  );

  // Một lần bị trả lại sau 2 giờ chờ; lần sau được tự duyệt rồi bị thu hồi.
  await review(spec.docKey, "changes_requested", { status: "failed", decidedBy: org.user("tadmin"), hours: 2 });
  const approved = await review(spec.docKey, "approved", { status: "passed", decidedBy: AI_AUTO_ACTOR, hours: 0 });
  const aiRun = await run(0.5);
  await admin.query(
    `insert into hive.review_gate_runs (org_id, instance_id, gate_index, gate_id, status, run_id, finished_at)
     values ($1, $2, 0, 'ai', 'passed', $3, now())`,
    [org.orgId, approved, aiRun],
  );
  await admin.query(
    `insert into hive.sdlc_auto_approvals (org_id, item_id, artifact_id, review_id, gate_id, score, threshold, reasons,
       revocable_until, revoked_at, revoked_by, revoke_reason)
     values ($1, $2, $3, $4, 'lead', 9, 8, '{}', now() + interval '1 day', now(), $5, 'Sai phạm vi của yêu cầu')`,
    [org.orgId, main.id, spec.id, approved, org.user("tadmin")],
  );

  // Chi phí: run AI chấm 0,5 + run bước soạn 1,25 + run code của task 2 = 3,75 USD.
  await admin.query(
    `insert into hive.sdlc_steps (org_id, item_id, phase_id, step_id, action, run_id, status, created_by)
     values ($1, $2, 'specify', 'draft-spec', 'draft', $3, 'succeeded', 'seed')`,
    [org.orgId, main.id, await run(1.25)],
  );
  const codeRun = await run(2, t1);
  for (const [round, status] of [
    [1, "superseded"],
    [2, "approved"],
  ] as const)
    await admin.query(
      `insert into hive.code_reviews (org_id, team_id, project_id, task_id, run_id, workflow_name, phases, options,
         pr_number, pr_url, branch, base_branch, head_sha, round, status)
       values ($1, $2, $3, $4, $5, 'Code', '[]', '{}', 7, 'https://github.com/acme/x/pull/7', 'ai/t1', 'main', 'abc', $6, $7)`,
      [org.orgId, org.teamId, p.a, t1, codeRun, round, status],
    );
});

afterAll(async () => {
  await admin.query("delete from hive.code_reviews where org_id = $1", [org.orgId]);
  await Promise.all([admin.end(), app.end()]);
});

describe("sdlc.metrics", () => {
  it("quản trị tổ chức: mọi hạng mục trong khoảng, đủ các chỉ số", async () => {
    const m = await metrics("admin");
    expect(m.items).toBe(2);
    expect(m.leadTimeHours.find((l) => l.kind === phaseKind)?.duration).toEqual({ p50: 5, p90: 6.6, count: 2 });
    expect(m.questionsPerItem).toBe(1);
    expect(m.returnRate).toBe(0.5);
    expect(m.gateWaitHours).toMatchObject({ count: 1, p50: 2 });
    expect(m.autoApproval).toEqual([{ modeRef: "speckit", projectKey: key("a"), autoRate: 1, revokeRate: 1 }]);
    expect(m.coverage).toEqual({ requirements: 3, planned: 66.7, done: 33.3, verified: 33.3 });
    expect(m.convergeRounds).toBe(2);
    expect(m.codeReviewRoundsPerPr).toBe(2);
    expect(m.costUsdPerItem).toBe(1.875);
  });

  it("chỉ thấy hạng mục của đội mình; chi phí chỉ cho quản trị đội", async () => {
    const lead = await metrics("tadmin");
    expect(lead.items).toBe(1);
    expect(lead.costUsdPerItem).toBe(3.75);
    const member = await metrics("tmember");
    expect(member.items).toBe(1);
    expect(member.questionsPerItem).toBe(1);
    expect(member.costUsdPerItem).toBeNull();
    expect((await metrics("loner")).items).toBe(0);
  });

  it("lọc dự án gồm hạng mục chỉ tham gia; lọc chế độ; khoảng sai bị từ chối", async () => {
    const a = await metrics("admin", { projectId: p.a });
    expect(a.items).toBe(1);
    const b = await metrics("admin", { projectId: p.b });
    expect(b.items).toBe(2);
    // Tài liệu và task đều ở dự án a: dự án b chưa phủ requirement nào, không có tự duyệt.
    expect(b.coverage).toEqual({ requirements: 3, planned: 0, done: 0, verified: 0 });
    expect(b.autoApproval).toEqual([]);
    expect(b.codeReviewRoundsPerPr).toBeNull();
    expect((await metrics("admin", { modeRef: "kiro-requirements" })).items).toBe(0);
    const empty = await metrics("admin", { modeRef: "kiro-requirements" });
    expect(empty.leadTimeHours.every((l) => l.duration.count === 0)).toBe(true);
    expect(await errorCode(() => metrics("admin", { from: range.to, to: range.from }))).toBe("SDLC_METRICS_RANGE");
  });
});
