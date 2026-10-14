import { randomBytes, randomUUID } from "node:crypto";
import {
  DEFAULT_AGENT_POLICY,
  defaultProjectSettings,
  orgSdlcPolicy,
  projectSdlcSettings,
  SDLC_PRESETS,
  type SdlcMode,
  sdlcMode,
} from "@xdev-hive/contracts";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { errorCode, type OrgFixture, seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import {
  applyAiResult,
  attachGateRun,
  createProposal,
  decideReview,
  type ReviewDeps,
  startReview,
} from "../knowledge/index.ts";
import { createPool, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import { autoDecide, listAutoApprovals, revokeAutoApproval } from "./autoapprove.ts";
import { codeRunGate } from "./gate.ts";
import { createItem } from "./items.ts";
import { saveMode } from "./modes.ts";
import { onBaseline, workflowFor } from "./phases.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);
const custom = `auto-${tag}`;

let org: OrgFixture & { user: (n: string) => string };
let projectId = "";

const as = <T>(who: string, fn: (tx: Tx) => Promise<T>) =>
  withTenant(app, { userId: org.user(who), orgId: org.orgId }, fn);

const reviewDeps: ReviewDeps = {
  workflowFor,
  onBaseline: (tx, event) => onBaseline(tx, event),
  autoDecide: (tx, request) => autoDecide(tx, request),
};

/** Speckit với cổng Plan rút gọn: AI chấm trước (đạt 8), rồi tech lead được tự duyệt từ 8 điểm, thu hồi trong 24 giờ. */
function autoMode(): SdlcMode {
  const m = structuredClone(SDLC_PRESETS.speckit as SdlcMode);
  m.id = custom;
  m.name = "Tự duyệt Plan";
  const plan = m.phases.find((p) => p.id === "plan");
  if (!plan) throw new Error("speckit đổi cấu trúc");
  plan.gate = [
    {
      name: "Duyệt plan",
      outputs: [],
      gates: [
        {
          id: "ai-plan",
          name: "AI chấm plan",
          kind: "ai",
          ai: { checks: ["Plan đủ ý"], passScore: 8 },
        },
        { id: "lead", name: "Tech lead duyệt", kind: "human", reviewers: { roles: ["team-admin"] } },
      ],
    },
  ] as unknown as SdlcMode["phases"][number]["gate"];
  plan.perProjectGates = [];
  plan.autoApprove = { gates: ["lead"], minScore: 8, revokeHours: 24 };
  return sdlcMode.parse(m);
}

const PLAN = "# Plan\n\nExport reports through a background queue.\n";

/** Hạng mục mới, rồi đề xuất plan và mở phiên duyệt như `knowledge.proposeDoc`. */
async function proposePlan(content = PLAN) {
  const item = await as("tadmin", (tx) =>
    createItem(tx, org.user("tadmin"), {
      projectId,
      title: "Xuất báo cáo",
      idea: "Xuất báo cáo doanh thu theo tháng ra file CSV cho kế toán.",
      modeRef: custom,
      size: "M",
    }),
  );
  const plan = item.artifacts.find((a) => a.artifactId === "plan");
  if (!plan) throw new Error("thiếu plan");
  const inst = await as("tadmin", async (tx) => {
    const p = await createProposal(
      tx,
      { kind: "user", userId: org.user("tadmin") },
      { kind: "doc", key: plan.docKey, content, baseVersion: 0 },
    );
    return startReview(tx, p.id, reviewDeps);
  });
  if (!inst) throw new Error("không mở được phiên");
  return { item, plan, reviewId: inst.id };
}

/** Run review giả của checkpoint AI rồi báo điểm, như job review của knowledge. */
async function aiScores(reviewId: string, score: number) {
  const { rows } = await admin.query(
    `insert into hive.runs (org_id, team_id, project_id, kind, state, branch, policy_snapshot, created_by, cli, model)
     values ($1, $2, $3, 'review', 'succeeded', 'ai/review', '[]', 'seed', 'codex', 'gpt-5') returning id`,
    [org.orgId, org.teamId, projectId],
  );
  const runId = rows[0].id as string;
  await as("tadmin", async (tx) => {
    await attachGateRun(tx, reviewId, runId);
    await applyAiResult(
      tx,
      {
        kind: "ai-result",
        orgId: org.orgId,
        instanceId: reviewId,
        runId,
        score,
        checklist: [],
        error: null,
        summary: null,
      },
      reviewDeps,
    );
  });
}

const artifactRow = async (id: string) =>
  (
    await admin.query(`select baseline_version as "baselineVersion", approval from hive.sdlc_artifacts where id = $1`, [
      id,
    ])
  ).rows[0] as { baselineVersion: number | null; approval: string };

const approvals = async (itemId: string) =>
  (
    await admin.query(
      `select id, version, score::float as score, threshold::float as threshold, revoked_at as "revokedAt",
         rereview_id as "rereviewId" from hive.sdlc_auto_approvals where item_id = $1`,
      [itemId],
    )
  ).rows as {
    id: string;
    version: number | null;
    score: number;
    threshold: number;
    revokedAt: Date | null;
    rereviewId: string | null;
  }[];

const gateNote = async (reviewId: string, gateId: string) =>
  (
    await admin.query(
      "select note from hive.review_gate_runs where instance_id = $1 and gate_id = $2 order by started_at desc limit 1",
      [reviewId, gateId],
    )
  ).rows[0]?.note as string | null;

const audits = async (action: string, itemId: string) =>
  (await admin.query("select data from hive.audit_log where action = $1 and target_id = $2", [action, itemId])).rows;

async function setOrgPolicy(policy: unknown) {
  await admin.query(
    `insert into hive.agent_policies (org_id, policy) values ($1, $2)
     on conflict (org_id) do update set policy = excluded.policy`,
    [org.orgId, JSON.stringify(policy)],
  );
}

beforeAll(async () => {
  org = await seedOrg(admin, `sda-${tag}`);
  // Người duyệt thứ hai của đội: người mở phiên duyệt lại (tadmin) không tự duyệt phiên của mình.
  await admin.query("insert into hive.team_members (team_id, org_id, user_id, role) values ($1, $2, $3, 'admin')", [
    org.teamId,
    org.orgId,
    org.user("loner"),
  ]);
  projectId = (
    await seedProject(admin, app, {
      orgId: org.orgId,
      teamId: org.teamId,
      systemId: org.systemId,
      adminUserId: org.user("admin"),
      masterKey,
      key: `sa${tag}`,
      settings: {
        ...defaultProjectSettings(),
        sdlc: projectSdlcSettings.parse({
          enabled: true,
          defaultMode: custom,
          modes: [custom],
          autoApprove: { enabled: true },
        }),
      },
    })
  ).projectId;
  await as("tadmin", (tx) =>
    saveMode(tx, org.user("tadmin"), {
      teamId: org.teamId,
      slug: custom,
      basePreset: "speckit",
      definition: autoMode(),
    }),
  );
});

beforeEach(async () => {
  await admin.query("delete from hive.sdlc_items where org_id = $1", [org.orgId]);
  await admin.query("delete from hive.agent_policies where org_id = $1", [org.orgId]);
  for (const table of ["review_instances", "proposals", "doc_drafts", "docs"])
    await admin.query(`delete from hive.${table} where org_id = $1`, [org.orgId]);
});

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

describe("tự duyệt", () => {
  it("AI đạt ngưỡng thì hub thay tech lead: baseline `auto`, ghi lần tự duyệt, audit, thông báo", async () => {
    const { item, plan, reviewId } = await proposePlan();
    await aiScores(reviewId, 9);
    expect(await artifactRow(plan.id)).toEqual({ baselineVersion: 1, approval: "auto" });
    const [row] = await approvals(item.id);
    expect(row).toMatchObject({ version: 1, score: 9, threshold: 8, revokedAt: null });
    expect((await audits("sdlc.auto_approve", item.id))[0]?.data).toMatchObject({
      gateId: "lead",
      score: 9,
      reviewer: { cli: "codex", model: "gpt-5" },
    });
    const { rows } = await admin.query(
      "select user_id from hive.inbox_items where event = 'sdlc.auto_approved' and org_id = $1",
      [org.orgId],
    );
    expect(rows.map((r) => r.user_id)).toContain(org.user("tadmin"));
    const [view] = await as("tadmin", (tx) => listAutoApprovals(tx, org.user("tadmin"), item.id));
    expect(view).toMatchObject({ gateName: "Tech lead duyệt", version: 1, canRevoke: true });
    expect(view?.reasons.every((r) => r.passed)).toBe(true);
  });

  it("dưới ngưỡng hiệu lực (sàn của tổ chức) thì để người duyệt và ghi lý do", async () => {
    await setOrgPolicy({ ...DEFAULT_AGENT_POLICY, sdlc: orgSdlcPolicy.parse({ autoApprove: { minScoreFloor: 9 } }) });
    const { item, plan, reviewId } = await proposePlan();
    await aiScores(reviewId, 8.5);
    expect(await artifactRow(plan.id)).toMatchObject({ baselineVersion: null, approval: "none" });
    expect(await gateNote(reviewId, "lead")).toContain("Không tự duyệt: Điểm 8.5 < ngưỡng 9.");
    expect(await approvals(item.id)).toEqual([]);
  });

  it("có từ khoá nhạy cảm trong phần đổi thì để người duyệt", async () => {
    const { item, plan, reviewId } = await proposePlan(`${PLAN}\nRotate the payment gateway keys.\n`);
    await aiScores(reviewId, 9.5);
    expect(await artifactRow(plan.id)).toMatchObject({ baselineVersion: null, approval: "none" });
    expect(await gateNote(reviewId, "lead")).toContain("Từ khoá nhạy cảm 'payment'.");
    expect(await approvals(item.id)).toEqual([]);
  });

  it("tổ chức tắt tự duyệt giữa chừng thì checkpoint chờ người", async () => {
    const { plan, reviewId } = await proposePlan();
    await setOrgPolicy({ ...DEFAULT_AGENT_POLICY, sdlc: orgSdlcPolicy.parse({ autoApprove: { allowed: false } }) });
    await aiScores(reviewId, 9.5);
    expect(await artifactRow(plan.id)).toMatchObject({ baselineVersion: null });
    expect(await gateNote(reviewId, "lead")).toContain("Tổ chức đã tắt tự duyệt.");
  });
});

describe("thu hồi", () => {
  async function autoApproved() {
    const r = await proposePlan();
    await aiScores(r.reviewId, 9);
    const [row] = await approvals(r.item.id);
    if (!row) throw new Error("chưa tự duyệt");
    return { ...r, approvalId: row.id };
  }

  it("thu hồi: tài liệu `revoked`, giai đoạn về duyệt, run code bị chặn, phiên duyệt lại không tự duyệt (SC-015)", async () => {
    const { item, plan, approvalId } = await autoApproved();
    const view = await as("tadmin", (tx) =>
      revokeAutoApproval(
        tx,
        org.user("tadmin"),
        { id: approvalId, reason: "Plan thiếu phần di chuyển dữ liệu." },
        {
          review: reviewDeps,
        },
      ),
    );
    expect(view).toMatchObject({ revokeReason: "Plan thiếu phần di chuyển dữ liệu.", canRevoke: false });
    expect(view.rereviewId).not.toBeNull();
    expect(await artifactRow(plan.id)).toMatchObject({ baselineVersion: 1, approval: "revoked" });
    const { rows: phase } = await admin.query(
      "select status from hive.sdlc_item_phases where item_id = $1 and phase_id = 'plan'",
      [item.id],
    );
    expect(phase[0]?.status).toBe("in_review");
    expect(await audits("sdlc.auto_revoke", item.id)).toHaveLength(1);

    const { rows: task } = await admin.query(
      `insert into hive.tasks (org_id, team_id, project_id, number, key, title, status, created_by)
       values ($1, $2, $3, 1, $4, 'Task', 'todo', 'seed') returning id`,
      [org.orgId, org.teamId, projectId, `T-${tag}-1`],
    );
    await admin.query(
      `insert into hive.sdlc_item_tasks (org_id, item_id, task_id, project_id, slice_key, wave, breakdown_version)
       values ($1, $2, $3, $4, 'T001', 1, 1)`,
      [org.orgId, item.id, task[0].id, projectId],
    );
    const gate = await as("tadmin", (tx) => codeRunGate(tx, { taskId: task[0].id, kind: "code" }));
    expect(gate.block && gate.missing).toContainEqual(
      expect.objectContaining({ docKey: plan.docKey, reason: "revoked" }),
    );

    // Duyệt lại: AI chấm lại, hub không tự duyệt bản đã bị bác; người duyệt (khác người mở phiên) xác nhận thì
    // baseline `reaffirmed`.
    const rereviewId = view.rereviewId as string;
    await aiScores(rereviewId, 9.5);
    expect(await gateNote(rereviewId, "lead")).toContain("đã bị thu hồi");
    await as("loner", (tx) => decideReview(tx, org.user("loner"), { id: rereviewId, decision: "approve" }, reviewDeps));
    expect(await artifactRow(plan.id)).toEqual({ baselineVersion: 1, approval: "reaffirmed" });
  });

  it("thu hồi hai lần, quá hạn, người không có quyền đều bị từ chối", async () => {
    const { approvalId } = await autoApproved();
    const revoke = (who: string) =>
      as(who, (tx) =>
        revokeAutoApproval(
          tx,
          org.user(who),
          { id: approvalId, reason: "Cần người xem lại plan này." },
          { review: reviewDeps },
        ),
      );
    expect(await errorCode(() => revoke("tmember"))).toBe("SDLC_REVOKE_FORBIDDEN");
    await admin.query(
      "update hive.sdlc_auto_approvals set revocable_until = now() - interval '1 minute' where id = $1",
      [approvalId],
    );
    expect(await errorCode(() => revoke("tadmin"))).toBe("SDLC_REVOKE_EXPIRED");
    await admin.query("update hive.sdlc_auto_approvals set revocable_until = now() + interval '1 hour' where id = $1", [
      approvalId,
    ]);
    await revoke("tadmin");
    expect(await errorCode(() => revoke("tadmin"))).toBe("SDLC_AUTO_APPROVAL_REVOKED");
  });
});
