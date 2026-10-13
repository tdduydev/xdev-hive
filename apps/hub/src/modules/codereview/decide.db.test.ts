import { randomBytes, randomUUID } from "node:crypto";
import { defaultProjectSettings, type ProjectSettings, workflowInput } from "@xdev-hive/contracts";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import type { z } from "zod";
import { errorCode, type OrgFixture, seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { createPool, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import { createMemoryProvider, type MemoryProvider } from "../scm/index.ts";
import {
  type DecideDeps,
  decideCodeReview,
  enqueueCodeReview,
  overrideCodeReview,
  recheckCodeReview,
} from "./decide.ts";
import { getCodeReview } from "./queries.ts";
import { type CodeReviewRun, type RunEvidence, startCodeReview } from "./service.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);

let org: OrgFixture & { user: (n: string) => string };
let provider: MemoryProvider;

const evidence = new Map<string, RunEvidence>();
const cancelled: string[] = [];
// Không có hàng đợi: phiên đi tiếp ngay trong transaction, test thấy kết quả không cần chạy job.
const deps: DecideDeps = {
  masterKey,
  providerFactory: () => provider,
  publicUrl: "https://hive.example.com",
  runEvidence: async (_tx, runId) => evidence.get(runId) ?? null,
  startReviewRuns: async (_tx, input) =>
    input.reviewers.map((r) => ({ runId: randomUUID(), cli: r.cli, model: r.model, state: "queued" })),
  cancelRun: async (_tx, runId) => {
    cancelled.push(runId);
  },
};

const sys = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(app, { orgId: org.orgId }, fn);
const u = (n: string) => org.user(n);

// ---- Dữ liệu -------------------------------------------------------------------------------------------------------

interface P {
  projectId: string;
  key: string;
  ref: { owner: string; name: string };
}

let seq = 0;
async function newProject(settings?: ProjectSettings): Promise<P> {
  seq += 1;
  const key = `crd${seq}-${tag}`;
  const p = await seedProject(admin, app, {
    orgId: org.orgId,
    teamId: org.teamId,
    systemId: org.systemId,
    adminUserId: u("admin"),
    masterKey,
    key,
    ...(settings ? { settings } : {}),
  });
  const ref = { owner: p.owner, name: p.repo };
  provider.seedRepo(ref);
  return { projectId: p.projectId, key, ref };
}

type Gate = z.input<typeof workflowInput>["phases"][number]["gates"][number];
type CodeOpts = NonNullable<z.input<typeof workflowInput>["code"]>;

async function saveWorkflow(p: P, gates: Gate[], code: Partial<CodeOpts> = {}) {
  const w = workflowInput.parse({
    name: `Code ${randomUUID().slice(0, 4)}`,
    preset: "custom",
    subject: "code",
    teamId: org.teamId,
    docPrefixes: [],
    code: { projects: [p.key], ...code },
    phases: [{ name: "Review", gates }],
    enabled: true,
  });
  await admin.query(
    `insert into hive.review_workflows (org_id, team_id, name, preset, subject, doc_prefixes, code, phases, enabled)
     values ($1, $2, $3, 'custom', 'code', '{}', $4, $5, true)`,
    [org.orgId, w.teamId, w.name, JSON.stringify(w.code), JSON.stringify(w.phases)],
  );
}

/** Run code thật (hàng merge có khoá ngoại tới runs). */
async function realRun(p: P, branch: string): Promise<string> {
  const { rows } = await admin.query(
    `insert into hive.runs (org_id, team_id, project_id, branch, policy_snapshot, created_by, state)
     values ($1, $2, $3, $4, '[]', $5, 'succeeded') returning id`,
    [org.orgId, org.teamId, p.projectId, branch, u("tmember")],
  );
  return rows[0].id as string;
}

/** Mở PR, mở phiên theo quy trình đã lưu; trả phiên và PR. */
async function openReview(p: P, o: { requester?: string | null; runId?: string } = {}) {
  const branch = `ai/${randomUUID().slice(0, 6)}`;
  await provider.commitFiles(p.ref, {
    branch,
    fromBranch: "main",
    message: "agent",
    files: [{ path: "src/pay.ts", content: `export const v = "${branch}";\n` }],
  });
  const { number, url } = await provider.openPR(p.ref, { head: branch, base: "main", title: branch, body: "" });
  const headSha = (await provider.getPR(p.ref, number))?.headSha ?? "";
  const run: CodeReviewRun = {
    id: o.runId ?? randomUUID(),
    teamId: org.teamId,
    projectId: p.projectId,
    taskId: null,
    ownerUserId: o.requester === undefined ? u("tmember") : o.requester,
    taskType: "feature",
    headSha,
    pr: { number, url, branch, baseBranch: "main" },
    stats: { addedLines: 3, deletedLines: 1, changedFiles: ["src/pay.ts"] },
    reasons: [],
  };
  evidence.set(run.id, { headSha, taskType: "feature", stats: run.stats, commands: null, hasAgentReport: true });
  const row = await sys((tx) => startCodeReview(tx, run, deps));
  if (!row) throw new Error("không mở được phiên");
  return { id: row.id, headSha, pr: { number, branch } };
}

const human = (reviewers: Record<string, unknown>, extra: Partial<Gate> = {}): Gate =>
  ({
    id: "reviewer",
    name: "Người duyệt",
    kind: "human",
    reviewers: { users: [], roles: [], quorum: 1, ...reviewers },
    slaHours: 24,
    ...extra,
  }) as Gate;
const AI: Gate = {
  id: "ai",
  name: "Review AI",
  kind: "ai",
  ai: { checks: ["Đúng yêu cầu"], passScore: 7, reviewers: [{ cli: "claude" }, { cli: "codex" }] },
  slaHours: null,
  onReject: "agent",
};
const COMMAND: Gate = {
  id: "tests",
  name: "Test",
  kind: "rule",
  rules: ["command"],
  commands: [{ run: "pnpm test", timeoutSec: 600 }],
  slaHours: null,
};

const decide = (who: string, input: Parameters<typeof decideCodeReview>[2]) =>
  sys((tx) => decideCodeReview(tx, u(who), input, deps));
const detail = (who: string, id: string) => sys((tx) => getCodeReview(tx, u(who), id, deps));
const reviewRow = async (id: string) =>
  (await admin.query("select * from hive.code_reviews where id = $1", [id])).rows[0];
const gateRuns = async (id: string) =>
  (
    await admin.query(
      "select gate_index, gate_id, status, note, approvals, decided_by, overridden, run_ids from hive.code_review_gate_runs where review_id = $1 order by started_at",
      [id],
    )
  ).rows;
const audits = async (id: string) =>
  (
    await admin.query(
      "select action, actor_user_id, data from hive.audit_log where target_id = $1 order by created_at",
      [id],
    )
  ).rows;

beforeAll(async () => {
  org = await seedOrg(admin, `crd-${tag}`);
  provider = createMemoryProvider("gitlab", ["xdev-team"]);
});

beforeEach(() => {
  cancelled.splice(0);
});

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

// ---- Test ----------------------------------------------------------------------------------------------------------

describe("duyệt ở checkpoint người duyệt (FR-020)", () => {
  it("người được chỉ định ngoài đội thấy và duyệt được; người xem đội không quyết được; đội khác không thấy", async () => {
    const p = await newProject();
    await saveWorkflow(p, [human({ users: [u("loner")] })]);
    const r = await openReview(p);

    const seen = await detail("loner", r.id);
    expect(seen).toMatchObject({ canDecide: true, awaitingMe: true, canOverride: false, canEnqueue: false });
    expect(await detail("tviewer", r.id)).toMatchObject({ canDecide: false, awaitingMe: false });
    expect(await errorCode(() => detail("oadmin", r.id))).toBe("CODE_REVIEW_NOT_FOUND");
    expect(await errorCode(() => decide("tviewer", { id: r.id, headSha: r.headSha, decision: "approve" }))).toBe(
      "CODE_REVIEW_NOT_REVIEWER",
    );
    expect(await errorCode(() => decide("oadmin", { id: r.id, headSha: r.headSha, decision: "approve" }))).toBe(
      "CODE_REVIEW_NOT_FOUND",
    );

    const out = await decide("loner", { id: r.id, headSha: r.headSha, decision: "approve", note: "Ổn" });
    expect(out.status).toBe("approved");
    expect(out.gates[0]).toMatchObject({ status: "passed", decidedBy: u("loner"), note: "Ổn", overridden: false });
    expect(out.gates[0]?.approvals.map((a) => a.userId)).toEqual([u("loner")]);
    const actions = await audits(r.id);
    expect(actions.find((a) => a.action === "codereview.approve" && a.actor_user_id === u("loner"))?.data).toMatchObject(
      { gateId: "reviewer", done: true },
    );
  });

  it("người giao việc không quyết được trừ khi checkpoint cho; quản trị tổ chức luôn quyết được (Q2)", async () => {
    const p = await newProject();
    await saveWorkflow(p, [human({ roles: ["team-member"] })]);
    const r = await openReview(p, { requester: u("tmember") });
    expect((await detail("tmember", r.id)).canDecide).toBe(false);
    expect(await errorCode(() => decide("tmember", { id: r.id, headSha: r.headSha, decision: "approve" }))).toBe(
      "CODE_REVIEW_NOT_REVIEWER",
    );
    // Quản trị tổ chức là người giao việc vẫn quyết được.
    const own = await openReview(p, { requester: u("admin") });
    expect((await decide("admin", { id: own.id, headSha: own.headSha, decision: "approve" })).status).toBe(
      "approved",
    );

    const p2 = await newProject();
    await saveWorkflow(p2, [human({ roles: ["team-member"], allowRequester: true })]);
    const r2 = await openReview(p2, { requester: u("tmember") });
    expect((await decide("tmember", { id: r2.id, headSha: r2.headSha, decision: "approve" })).status).toBe(
      "approved",
    );
  });

  it("quorum 2: một người chưa đủ, không duyệt lại được; người thứ hai duyệt thì đi tiếp", async () => {
    const p = await newProject();
    await saveWorkflow(p, [human({ roles: ["team-member"], quorum: 2 }), human({ users: [u("loner")] }, { id: "lead" })]);
    const r = await openReview(p, { requester: null });

    const first = await decide("tmember", { id: r.id, headSha: r.headSha, decision: "approve" });
    expect(first).toMatchObject({ status: "in_review", canDecide: false });
    expect(first.gate).toMatchObject({ id: "reviewer", index: 0 });
    expect(first.gates[0]).toMatchObject({ status: "waiting" });
    expect(first.gates[0]?.approvals).toHaveLength(1);
    expect(await errorCode(() => decide("tmember", { id: r.id, headSha: r.headSha, decision: "approve" }))).toBe(
      "CODE_REVIEW_ALREADY_APPROVED",
    );

    const second = await decide("tadmin", { id: r.id, headSha: r.headSha, decision: "approve" });
    expect(second.gate).toMatchObject({ id: "lead", index: 1 });
    expect(second.gates[0]?.approvals.map((a) => a.userId)).toEqual([u("tmember"), u("tadmin")]);
    expect(second.previousGate).toBe("reviewer");
    expect(await gateRuns(r.id)).toMatchObject([
      { gate_id: "reviewer", status: "passed", decided_by: u("tadmin") },
      { gate_id: "lead", status: "waiting" },
    ]);
  });

  it("hai người cùng quyết checkpoint quorum 1: một người được, người kia nhận “Checkpoint đã được quyết.”", async () => {
    const p = await newProject();
    await saveWorkflow(p, [human({ roles: ["team-member"] })]);
    const r = await openReview(p, { requester: null });
    const results = await Promise.allSettled([
      decide("tmember", { id: r.id, headSha: r.headSha, decision: "approve" }),
      decide("tadmin", { id: r.id, headSha: r.headSha, decision: "changes", note: "Thiếu test" }),
    ]);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((x) => x.status === "rejected");
    expect(lost?.reason).toMatchObject({ code: "CODE_REVIEW_DECIDED", message: "Checkpoint đã được quyết." });
    expect(await gateRuns(r.id)).toHaveLength(1);
  });

  it("headSha cũ bị từ chối; commit mới trên PR mà webhook chưa tới cũng bị từ chối (FR-021)", async () => {
    const p = await newProject();
    await saveWorkflow(p, [human({ roles: ["team-member"] })]);
    const r = await openReview(p, { requester: null });
    expect(
      await errorCode(() => decide("tmember", { id: r.id, headSha: "a".repeat(40), decision: "approve" })),
    ).toBe("CODE_REVIEW_HEAD_MOVED");

    await provider.commitFiles(p.ref, {
      branch: r.pr.branch,
      message: "push tay",
      files: [{ path: "src/other.ts", content: "export {}\n" }],
    });
    expect(await errorCode(() => decide("tmember", { id: r.id, headSha: r.headSha, decision: "approve" }))).toBe(
      "CODE_REVIEW_HEAD_MOVED",
    );
    expect((await reviewRow(r.id)).status).toBe("in_review");
    expect((await gateRuns(r.id))[0]).toMatchObject({ status: "waiting", approvals: [] });
  });

  it("trả lại: checkpoint không đạt kèm góp ý, phiên về người giao việc, báo họ, audit hướng xin", async () => {
    const p = await newProject();
    await saveWorkflow(p, [human({ roles: ["team-member"] })]);
    const r = await openReview(p, { requester: u("tadmin") });
    const out = await decide("tmember", {
      id: r.id,
      headSha: r.headSha,
      decision: "changes",
      note: "Thiếu test cho hoàn tiền",
      route: "agent",
    });
    expect(out).toMatchObject({ status: "changes_requested", route: "author", canDecide: false });
    expect(out.gate).toMatchObject({ id: "reviewer" });
    expect(out.gates[0]).toMatchObject({ status: "failed", note: "Thiếu test cho hoàn tiền", decidedBy: u("tmember") });

    const inbox = await admin.query("select user_id, event, link from hive.inbox_items where event_key like $1", [
      "code_review_returned:%",
    ]);
    expect(inbox.rows).toContainEqual({
      user_id: u("tadmin"),
      event: "code_review.returned",
      link: `https://hive.example.com/knowledge/reviews?tab=code&id=${r.id}`,
    });
    const changes = (await audits(r.id)).find((a) => a.action === "codereview.changes");
    expect(changes).toMatchObject({
      actor_user_id: u("tmember"),
      data: { gateId: "reviewer", requestedRoute: "agent", route: "author" },
    });
  });
});

describe("quyết thay checkpoint tự động (FR-022)", () => {
  it("cần reviews.override; cho đạt thì huỷ run review, ghi người quyết thay và đi tiếp", async () => {
    const p = await newProject();
    await saveWorkflow(p, [AI, human({ roles: ["team-member"] })]);
    const r = await openReview(p, { requester: u("tmember") });
    const before = await detail("tadmin", r.id);
    expect(before).toMatchObject({ canOverride: true, canRecheck: true, canDecide: false });
    expect(before.gate).toMatchObject({ id: "ai", kind: "ai" });
    expect((await detail("tmember", r.id)).canOverride).toBe(false);

    const input = { id: r.id, headSha: r.headSha, passed: true, note: "Máy codex hỏng, đã xem tay" };
    expect(await errorCode(() => sys((tx) => overrideCodeReview(tx, u("tmember"), input, deps)))).toBe(
      "TEAM_ROLE_REQUIRED",
    );
    await expect(
      sys((tx) => overrideCodeReview(tx, u("tadmin"), { id: r.id, headSha: r.headSha, passed: true }, deps)),
    ).rejects.toThrow("Ghi lý do khi quyết thay checkpoint tự động.");

    const runIds = (await gateRuns(r.id))[0].run_ids as string[];
    const out = await sys((tx) => overrideCodeReview(tx, u("tadmin"), input, deps));
    expect(out.gate).toMatchObject({ id: "reviewer" });
    expect(out.gates[0]).toMatchObject({
      status: "passed",
      overridden: true,
      decidedBy: u("tadmin"),
      note: "Máy codex hỏng, đã xem tay",
    });
    expect(cancelled.sort()).toEqual([...runIds].sort());
    expect((await audits(r.id)).find((a) => a.action === "codereview.override")).toMatchObject({
      actor_user_id: u("tadmin"),
      data: { gateId: "ai", passed: true, note: "Máy codex hỏng, đã xem tay" },
    });

    // Checkpoint người duyệt không quyết thay được.
    expect(await errorCode(() => sys((tx) => overrideCodeReview(tx, u("tadmin"), input, deps)))).toBe(
      "CODE_REVIEW_NOT_OVERRIDABLE",
    );
  });

  it("cho không đạt thì trả lại; checkpoint đã không đạt chỉ quyết thay cho đạt được", async () => {
    const p = await newProject();
    await saveWorkflow(p, [COMMAND, human({ roles: ["team-member"] })]);
    const r = await openReview(p, { requester: u("tmember") });
    expect((await gateRuns(r.id))[0]).toMatchObject({ gate_id: "tests", status: "waiting" });

    const fail = { id: r.id, headSha: r.headSha, passed: false, note: "Lệnh test đỏ trên máy tôi" };
    const failed = await sys((tx) => overrideCodeReview(tx, u("admin"), fail, deps));
    expect(failed).toMatchObject({ status: "changes_requested", route: "author", canOverride: true });
    expect(failed.gates[0]).toMatchObject({ status: "failed", overridden: true });
    expect(await errorCode(() => sys((tx) => overrideCodeReview(tx, u("admin"), fail, deps)))).toBe(
      "CODE_REVIEW_ALREADY_FAILED",
    );

    const passed = await sys((tx) => overrideCodeReview(tx, u("admin"), { ...fail, passed: true }, deps));
    expect(passed).toMatchObject({ status: "in_review" });
    expect(passed.gate).toMatchObject({ id: "reviewer" });
  });
});

describe("chạy lại checkpoint tự động", () => {
  it("người giao việc chạy lại được; người khác cần reviews.override; checkpoint người duyệt thì không", async () => {
    const p = await newProject();
    await saveWorkflow(p, [COMMAND, human({ roles: ["team-member"] })]);
    const r = await openReview(p, { requester: u("tmember") });
    expect((await detail("tmember", r.id)).canRecheck).toBe(true);
    expect((await detail("tviewer", r.id)).canRecheck).toBe(false);
    expect(await errorCode(() => sys((tx) => recheckCodeReview(tx, u("tviewer"), r.id, deps)))).toBe(
      "TEAM_ROLE_REQUIRED",
    );

    // Worker vừa báo kết quả lệnh: chạy lại thì checkpoint đạt và phiên tới người duyệt.
    const ev = evidence.get((await reviewRow(r.id)).run_id);
    if (ev) ev.commands = [{ run: "pnpm test", exit: 0, durationMs: 1200, tail: "ok" }];
    const out = await sys((tx) => recheckCodeReview(tx, u("tmember"), r.id, deps));
    expect(out.gate).toMatchObject({ id: "reviewer" });
    expect(out.gates[0]?.commands).toEqual([{ run: "pnpm test", exit: 0, durationMs: 1200, tail: "ok" }]);
    expect(await gateRuns(r.id)).toMatchObject([
      { gate_id: "tests", status: "skipped", note: "Đã chạy lại theo yêu cầu.", decided_by: u("tmember") },
      { gate_id: "tests", status: "passed" },
      { gate_id: "reviewer", status: "waiting" },
    ]);
    expect((await audits(r.id)).some((a) => a.action === "codereview.recheck")).toBe(true);
    expect(await errorCode(() => sys((tx) => recheckCodeReview(tx, u("tmember"), r.id, deps)))).toBe(
      "CODE_REVIEW_NOT_RECHECKABLE",
    );
  });
});

describe("đưa PR đã duyệt vào hàng merge (FR-027)", () => {
  it("chờ người: thành viên đội đưa vào được, người xem thì không; phiên chưa duyệt thì từ chối", async () => {
    const s = defaultProjectSettings();
    const p = await newProject({ ...s, features: { ...s.features, mergeQueue: true } });
    await saveWorkflow(p, [human({ roles: ["team-admin"] })], { merge: "manual" });
    const r = await openReview(p, { requester: u("tmember"), runId: await realRun(p, "ai/merge") });
    expect(await errorCode(() => sys((tx) => enqueueCodeReview(tx, u("tmember"), r.id, deps)))).toBe(
      "CODE_REVIEW_NOT_APPROVED",
    );

    const approved = await decide("tadmin", { id: r.id, headSha: r.headSha, decision: "approve" });
    expect(approved).toMatchObject({ status: "approved", mergeMode: "manual", inMergeQueue: false, canEnqueue: true });
    expect((await detail("tviewer", r.id)).canEnqueue).toBe(false);
    expect(await errorCode(() => sys((tx) => enqueueCodeReview(tx, u("tviewer"), r.id, deps)))).toBe(
      "TEAM_ROLE_REQUIRED",
    );

    const out = await sys((tx) => enqueueCodeReview(tx, u("tmember"), r.id, deps));
    expect(out).toMatchObject({ inMergeQueue: true, canEnqueue: false });
    const entry = await admin.query("select state, enqueued_by from hive.merge_queue_entries where project_id = $1", [
      p.projectId,
    ]);
    expect(entry.rows).toEqual([expect.objectContaining({ enqueued_by: u("tmember") })]);
    expect((await audits(r.id)).find((a) => a.action === "codereview.enqueue")?.actor_user_id).toBe(u("tmember"));
  });
});
