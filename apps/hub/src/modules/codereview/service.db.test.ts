import { randomBytes, randomUUID } from "node:crypto";
import { workflowInput } from "@xdev-hive/contracts";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import type { z } from "zod";
import type { OrgFixture } from "../../../test/org-fixture.ts";
import { seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { createPool, type Jobs, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import { createMemoryProvider, type MemoryProvider } from "../scm/index.ts";
import type { StartReviewRunsInput } from "./ai.ts";
import { CI_MAX_CHECKS, type CodeReviewWorkerDeps, handleCodeReviewJob } from "./jobs.ts";
import {
  advanceReview,
  type CodeReviewJob,
  type CodeReviewRun,
  cancelCodeReview,
  matchFor,
  onReviewRunFinished,
  type RunEvidence,
  startCodeReview,
} from "./service.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);

type Fixture = OrgFixture & { user: (n: string) => string };
let org: Fixture;
let provider: MemoryProvider;

// ---- Hàng đợi và cổng giả ------------------------------------------------------------------------------------------

const queued: { data: CodeReviewJob; startAfter: Date | undefined }[] = [];
const jobs: Jobs = {
  start: async () => {},
  stop: async () => {},
  enqueue: async (_queue, data, opts) => {
    queued.push({ data: data as CodeReviewJob, startAfter: opts?.startAfter });
    return randomUUID();
  },
  schedule: async () => {},
  work: async () => {},
};
const evidence = new Map<string, RunEvidence>();
const reviewRuns: StartReviewRunsInput[] = [];
const deps: CodeReviewWorkerDeps = {
  pool: app,
  jobs,
  masterKey,
  providerFactory: () => provider,
  publicUrl: "https://hive.example.com",
  runEvidence: async (_tx, runId) => evidence.get(runId) ?? null,
  startReviewRuns: async (_tx, input) => {
    reviewRuns.push(input);
    return input.reviewers.map((r) => ({ runId: randomUUID(), cli: r.cli, model: r.model, state: "queued" }));
  },
};

/** Chạy các job đang có trong hàng (không chạy job mới sinh ra trong lúc chạy, để CI chờ không lặp mãi). */
async function drain(): Promise<CodeReviewJob[]> {
  const batch = queued.splice(0);
  for (const j of batch) await handleCodeReviewJob(deps, j.data);
  return batch.map((j) => j.data);
}

/** Chạy hết hàng tới khi không còn job, trừ job CI hẹn giờ. */
async function settle() {
  for (let n = 0; n < 20 && queued.some((j) => !j.startAfter); n++) {
    const now = queued.filter((j) => !j.startAfter);
    queued.splice(0, queued.length, ...queued.filter((j) => j.startAfter));
    for (const j of now) await handleCodeReviewJob(deps, j.data);
  }
}

const sys = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(app, { orgId: org.orgId }, fn);

// ---- Dữ liệu -------------------------------------------------------------------------------------------------------

interface P {
  projectId: string;
  key: string;
  ref: { owner: string; name: string };
}

let seq = 0;
async function newProject(): Promise<P> {
  seq += 1;
  const key = `cr${seq}-${tag}`;
  const p = await seedProject(admin, app, {
    orgId: org.orgId,
    teamId: org.teamId,
    systemId: org.systemId,
    adminUserId: org.user("admin"),
    masterKey,
    key,
  });
  const ref = { owner: p.owner, name: p.repo };
  provider.seedRepo(ref);
  return { projectId: p.projectId, key, ref };
}

async function openPR(p: P, branch: string, files: Record<string, string> = { "src/pay.ts": "export {}\n" }) {
  await provider.commitFiles(p.ref, {
    branch,
    fromBranch: "main",
    message: "agent",
    files: Object.entries(files).map(([path, content]) => ({ path, content })),
  });
  const { number, url } = await provider.openPR(p.ref, { head: branch, base: "main", title: branch, body: "" });
  const pr = await provider.getPR(p.ref, number);
  return { number, url, headSha: pr?.headSha ?? "" };
}

type Gate = z.input<typeof workflowInput>["phases"][number]["gates"][number];

async function saveWorkflow(p: P, gates: Gate[], name = `Code ${randomUUID().slice(0, 4)}`) {
  const w = workflowInput.parse({
    name,
    preset: "custom",
    subject: "code",
    teamId: org.teamId,
    docPrefixes: [],
    code: { projects: [p.key] },
    phases: [{ name: "Review", gates }],
    enabled: true,
  });
  const { rows } = await admin.query(
    `insert into hive.review_workflows (org_id, team_id, name, preset, subject, doc_prefixes, code, phases, enabled)
     values ($1, $2, $3, 'custom', 'code', '{}', $4, $5, true) returning id`,
    [org.orgId, w.teamId, w.name, JSON.stringify(w.code), JSON.stringify(w.phases)],
  );
  return rows[0].id as string;
}

const STATS = { addedLines: 40, deletedLines: 10, changedFiles: ["src/pay.ts", "src/pay.test.ts"] };

function codeRun(p: P, pr: { number: number; url: string; headSha: string }, extra: Partial<CodeReviewRun> = {}) {
  const run: CodeReviewRun = {
    id: randomUUID(),
    teamId: org.teamId,
    projectId: p.projectId,
    taskId: null,
    ownerUserId: org.user("tadmin"),
    taskType: "feature",
    headSha: pr.headSha,
    pr: { number: pr.number, url: pr.url, branch: `ai/${pr.number}`, baseBranch: "main" },
    stats: STATS,
    reasons: [],
    ...extra,
  };
  evidence.set(run.id, {
    headSha: run.headSha,
    taskType: run.taskType,
    stats: run.stats,
    commands: null,
    hasAgentReport: true,
  });
  return run;
}

const reviewRow = async (id: string) =>
  (await admin.query("select * from hive.code_reviews where id = $1", [id])).rows[0];
const gateRuns = async (id: string) =>
  (
    await admin.query(
      "select gate_index, gate_id, status, note, checklist, details, run_ids, due_at, finished_at from hive.code_review_gate_runs where review_id = $1 order by gate_index, started_at",
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

const RULES: Gate = {
  id: "rules",
  name: "Quy tắc",
  kind: "rule",
  rules: ["no-secrets", "max-diff", "max-files"],
  maxDiffLines: 500,
  maxFiles: 10,
  slaHours: null,
};
const CI: Gate = { id: "ci", name: "CI", kind: "ext", ext: { check: "ci", whenNone: "fail" }, slaHours: null };
const HUMAN: Gate = {
  id: "reviewer",
  name: "Người duyệt",
  kind: "human",
  reviewers: { users: [], roles: ["team-member"], quorum: 1 },
  slaHours: 24,
};

beforeAll(async () => {
  org = await seedOrg(admin, `crs-${tag}`);
  provider = createMemoryProvider("gitlab", ["xdev-team"]);
});

beforeEach(() => {
  queued.splice(0);
  reviewRuns.splice(0);
});

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

// ---- Test ----------------------------------------------------------------------------------------------------------

describe("mở phiên", () => {
  it("không có quy trình khớp: không mở phiên, không gửi job (FR-030)", async () => {
    const p = await newProject();
    const pr = await openPR(p, "ai/none");
    const run = codeRun(p, pr);
    expect(await sys((tx) => matchFor(tx, run))).toBeNull();
    expect(await sys((tx) => startCodeReview(tx, run, deps))).toBeNull();
    expect(queued).toEqual([]);
  });

  it("run không có PR hoặc không có commit: không mở phiên", async () => {
    const p = await newProject();
    await saveWorkflow(p, [HUMAN]);
    const pr = await openPR(p, "ai/nopr");
    expect(await sys((tx) => startCodeReview(tx, codeRun(p, pr, { pr: null }), deps))).toBeNull();
    expect(await sys((tx) => startCodeReview(tx, codeRun(p, pr, { headSha: null }), deps))).toBeNull();
  });

  it("chụp quy trình, head_sha, số liệu, lý do needs_review; ghi audit codereview.start", async () => {
    const p = await newProject();
    const wf = await saveWorkflow(p, [HUMAN], "Cơ bản");
    const pr = await openPR(p, "ai/start");
    const run = codeRun(p, pr, { reasons: ["Thiếu báo cáo agent."] });
    const match = await sys((tx) => matchFor(tx, run));
    expect(match?.workflow).toMatchObject({ id: wf, name: "Cơ bản" });
    const row = await sys((tx) => startCodeReview(tx, run, deps, match));
    expect(row).toMatchObject({
      status: "in_review",
      round: 1,
      gateIndex: 0,
      workflowId: wf,
      workflowName: "Cơ bản",
      headSha: pr.headSha,
      prNumber: pr.number,
      runId: run.id,
      requesterUserId: org.user("tadmin"),
      addedLines: 40,
      deletedLines: 10,
      changedFiles: 2,
      runReasons: ["Thiếu báo cáo agent."],
    });
    expect(row?.options).toEqual({ merge: "project", maxAgentRevisions: 2, dismissStaleApprovals: false });
    expect(queued.map((j) => j.data.kind)).toEqual(["advance"]);
    const log = await audits(row?.id ?? "");
    expect(log[0]).toMatchObject({ action: "codereview.start", actor_user_id: null });
    expect(log[0].data).toMatchObject({ runId: run.id, workflow: "Cơ bản", round: 1 });
  });

  it("verifyCode chạy lại cùng commit thì giữ phiên; commit mới thì vòng sau theo bản chụp cũ", async () => {
    const p = await newProject();
    const wf = await saveWorkflow(p, [HUMAN], "Bản đầu");
    const pr = await openPR(p, "ai/round");
    const first = await sys((tx) => startCodeReview(tx, codeRun(p, pr), deps));
    const again = await sys((tx) => startCodeReview(tx, codeRun(p, pr), deps));
    expect(again?.id).toBe(first?.id);

    // Quy trình bị sửa giữa chừng: vòng sau vẫn theo bản chụp của vòng đầu (FR-031).
    await admin.query("update hive.review_workflows set name = 'Đã sửa', phases = $2 where id = $1", [
      wf,
      JSON.stringify([{ name: "Khác", gates: [CI] }]),
    ]);
    const next = await sys((tx) => startCodeReview(tx, codeRun(p, { ...pr, headSha: "f".repeat(40) }), deps));
    expect(next).toMatchObject({ round: 2, previousId: first?.id, workflowName: "Bản đầu", status: "in_review" });
    expect(next?.phases[0]?.gates[0]?.id).toBe("reviewer");
    expect((await reviewRow(first?.id ?? "")).status).toBe("superseded");
    expect((await audits(first?.id ?? "")).map((a) => a.action)).toContain("codereview.supersede");
  });
});

describe("đi qua checkpoint", () => {
  it("quy tắc đạt → CI pending → success → dừng ở người duyệt, đặt hạn, báo người đủ điều kiện", async () => {
    const p = await newProject();
    await saveWorkflow(p, [RULES, CI, HUMAN]);
    const pr = await openPR(p, "ai/flow");
    provider.setChecks(p.ref, pr.headSha, "pending");
    const row = await sys((tx) => startCodeReview(tx, codeRun(p, pr), deps));
    const id = row?.id ?? "";

    await drain(); // advance: quy tắc đạt, tới CI
    let runs = await gateRuns(id);
    expect(runs.map((r) => [r.gate_id, r.status])).toEqual([
      ["rules", "passed"],
      ["ci", "waiting"],
    ]);
    expect(runs[0].checklist.every((c: { passed: boolean }) => c.passed)).toBe(true);
    expect(queued.map((j) => j.data.kind)).toEqual(["ci"]);

    await drain(); // CI còn chạy: hẹn hỏi lại sau 2 phút
    expect(queued).toHaveLength(1);
    expect(queued[0]?.startAfter?.getTime()).toBeGreaterThan(Date.now() + 60_000);
    expect(queued[0]?.data).toMatchObject({ kind: "ci", attempt: 1 });

    provider.setChecks(p.ref, pr.headSha, "success");
    await drain(); // CI xanh → advance
    await settle();
    runs = await gateRuns(id);
    expect(runs.map((r) => [r.gate_id, r.status])).toEqual([
      ["rules", "passed"],
      ["ci", "passed"],
      ["reviewer", "waiting"],
    ]);
    expect(runs[1].details[0]).toMatchObject({ ci: "success", sha: pr.headSha });
    const due = new Date(runs[2].due_at).getTime() - Date.now();
    expect(due).toBeGreaterThan(23 * 3_600_000);
    expect(due).toBeLessThanOrEqual(24 * 3_600_000);
    expect(await reviewRow(id)).toMatchObject({ status: "in_review", gate_index: 2 });

    // Thành viên đội được báo; người giao việc (tadmin) thì không (Q2).
    const { rows: inbox } = await admin.query(
      "select user_id, link from hive.inbox_items where org_id = $1 and event = 'code_review.awaiting' and link like $2",
      [org.orgId, `%id=${id}`],
    );
    const users = inbox.map((r) => r.user_id);
    expect(users).toContain(org.user("tmember"));
    expect(users).not.toContain(org.user("tadmin"));
    expect(inbox[0]?.link).toBe(`https://hive.example.com/knowledge/reviews?tab=code&id=${id}`);

    const gates = (await audits(id)).filter((a) => a.action === "codereview.gate").map((a) => a.data);
    expect(gates).toEqual([
      expect.objectContaining({ gateId: "rules", status: "passed", passed: true }),
      expect.objectContaining({ gateId: "ci", status: "passed", passed: true }),
    ]);
  });

  it("checkpoint bật allowRequester thì người giao việc cũng được báo", async () => {
    const p = await newProject();
    await saveWorkflow(p, [
      { ...HUMAN, reviewers: { users: [org.user("tadmin")], roles: [], quorum: 1, allowRequester: true } },
    ]);
    const pr = await openPR(p, "ai/self");
    const row = await sys((tx) => startCodeReview(tx, codeRun(p, pr), deps));
    await settle();
    const { rows } = await admin.query(
      "select user_id from hive.inbox_items where org_id = $1 and event = 'code_review.awaiting' and link like $2",
      [org.orgId, `%id=${row?.id}`],
    );
    expect(rows.map((r) => r.user_id)).toEqual([org.user("tadmin")]);
  });

  it("quy tắc không đạt (đường dẫn cấm) → changes_requested theo hướng của checkpoint, audit passed=false", async () => {
    const p = await newProject();
    await saveWorkflow(p, [
      {
        id: "deny",
        name: "Cấm",
        kind: "rule",
        rules: ["deny-paths"],
        denyPaths: ["src/**"],
        onReject: "agent",
        slaHours: null,
      },
      HUMAN,
    ]);
    const pr = await openPR(p, "ai/deny");
    const row = await sys((tx) => startCodeReview(tx, codeRun(p, pr), deps));
    await settle();
    // Test không cài run sửa nên hướng `agent` về người giao việc (routing.db.test.ts kiểm run sửa).
    expect(await reviewRow(row?.id ?? "")).toMatchObject({
      status: "changes_requested",
      route: "author",
      gate_index: 0,
    });
    const changes = (await audits(row?.id ?? "")).find((a) => a.action === "codereview.changes");
    expect(changes?.data).toMatchObject({ gateId: "deny", requestedRoute: "agent", route: "author" });
    const [g] = await gateRuns(row?.id ?? "");
    expect(g).toMatchObject({ gate_id: "deny", status: "failed" });
    expect(g.note).toContain("src/pay.ts");
    expect(g.finished_at).not.toBeNull();
    const gate = (await audits(row?.id ?? "")).find((a) => a.action === "codereview.gate");
    expect(gate?.data).toMatchObject({ gateId: "deny", passed: false });
  });

  it("no-secrets quét patch của PR từ nhà cung cấp Git", async () => {
    const p = await newProject();
    await saveWorkflow(p, [{ id: "secrets", name: "Bí mật", kind: "rule", rules: ["no-secrets"], slaHours: null }]);
    const pr = await openPR(p, "ai/secret");
    provider.setPull(p.ref, pr.number, {
      files: [
        {
          path: "src/config.ts",
          status: "modified",
          additions: 1,
          deletions: 0,
          patch: `@@ -1 +1,2 @@\n+const t = "ghp_${"a".repeat(36)}";`,
          truncated: false,
        },
      ],
    });
    const row = await sys((tx) => startCodeReview(tx, codeRun(p, pr), deps));
    await settle();
    expect((await reviewRow(row?.id ?? "")).status).toBe("changes_requested");
    expect((await gateRuns(row?.id ?? ""))[0].note).toContain("token GitHub trong src/config.ts");
  });

  it("quy tắc lệnh mà worker cũ không báo kết quả → checkpoint chờ người, phiên dừng ở đó", async () => {
    const p = await newProject();
    await saveWorkflow(p, [
      {
        id: "tests",
        name: "Test",
        kind: "rule",
        rules: ["command"],
        commands: [{ run: "pnpm test", timeoutSec: 600 }],
        slaHours: null,
      },
      HUMAN,
    ]);
    const pr = await openPR(p, "ai/cmd");
    const row = await sys((tx) => startCodeReview(tx, codeRun(p, pr), deps));
    await settle();
    expect(await reviewRow(row?.id ?? "")).toMatchObject({ status: "in_review", gate_index: 0 });
    const runs = await gateRuns(row?.id ?? "");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ gate_id: "tests", status: "waiting", finished_at: null });
    expect(runs[0].note).toContain("Máy chưa hỗ trợ chạy lệnh kiểm; cần người xem.");

    // Job chạy lại không ghi thêm lượt.
    await sys((tx) => advanceReview(tx, row?.id ?? "", deps, { files: null }));
    expect(await gateRuns(row?.id ?? "")).toHaveLength(1);
  });

  it("quy tắc lệnh có kết quả của worker: mã thoát 0 thì đạt", async () => {
    const p = await newProject();
    await saveWorkflow(p, [
      {
        id: "tests",
        name: "Test",
        kind: "rule",
        rules: ["command"],
        commands: [{ run: "pnpm test", timeoutSec: 600 }],
        slaHours: null,
      },
    ]);
    const pr = await openPR(p, "ai/cmd-ok");
    const run = codeRun(p, pr);
    evidence.set(run.id, {
      ...(evidence.get(run.id) as RunEvidence),
      commands: [{ run: "pnpm test", exit: 0, durationMs: 1200, tail: "ok" }],
    });
    const row = await sys((tx) => startCodeReview(tx, run, deps));
    await settle();
    expect((await reviewRow(row?.id ?? "")).status).toBe("approved");
  });

  it("điều kiện đường dẫn không thoả → bỏ qua kèm lý do; qua hết checkpoint thì phiên đạt", async () => {
    const p = await newProject();
    await saveWorkflow(p, [{ ...HUMAN, id: "pay", conditions: { paths: ["src/payments/**"] } }]);
    const pr = await openPR(p, "ai/skip");
    const row = await sys((tx) => startCodeReview(tx, codeRun(p, pr), deps));
    await settle();
    const [g] = await gateRuns(row?.id ?? "");
    expect(g).toMatchObject({ gate_id: "pay", status: "skipped" });
    expect(g.note).toContain("src/payments/**");
    expect(await reviewRow(row?.id ?? "")).toMatchObject({ status: "approved", gate_index: 1 });
  });

  it("CI không đạt → trả lại; repo không có CI mà whenNone=fail cũng không đạt", async () => {
    const p = await newProject();
    await saveWorkflow(p, [CI, HUMAN]);
    const red = await openPR(p, "ai/red");
    provider.setChecks(p.ref, red.headSha, "failure");
    const a = await sys((tx) => startCodeReview(tx, codeRun(p, red), deps));
    const none = await openPR(p, "ai/noci", { "src/x.ts": "x\n" });
    const b = await sys((tx) => startCodeReview(tx, codeRun(p, none), deps));
    await settle();
    await settle();
    expect(await reviewRow(a?.id ?? "")).toMatchObject({ status: "changes_requested", route: "author" });
    expect((await gateRuns(a?.id ?? ""))[0].note).toContain("không đạt");
    expect((await reviewRow(b?.id ?? "")).status).toBe("changes_requested");
    expect((await gateRuns(b?.id ?? ""))[0].note).toContain("không có CI");
  });

  it("CI chờ quá 60 lần → không đạt", async () => {
    const p = await newProject();
    await saveWorkflow(p, [CI]);
    const pr = await openPR(p, "ai/slow");
    provider.setChecks(p.ref, pr.headSha, "pending");
    const row = await sys((tx) => startCodeReview(tx, codeRun(p, pr), deps));
    await drain();
    const job = queued.splice(0)[0]?.data as Extract<CodeReviewJob, { kind: "ci" }>;
    await handleCodeReviewJob(deps, { ...job, attempt: CI_MAX_CHECKS - 1 });
    expect((await reviewRow(row?.id ?? "")).status).toBe("changes_requested");
    expect((await gateRuns(row?.id ?? ""))[0].note).toBe("CI chạy quá lâu, chưa có kết quả.");
  });

  it("checkpoint AI tạo một run review mỗi reviewer, của đội, con của run code; run xong thì phiên vẫn chờ", async () => {
    const p = await newProject();
    await saveWorkflow(p, [
      {
        id: "ai",
        name: "Review AI",
        kind: "ai",
        ai: {
          checks: ["Đúng yêu cầu", "Có test"],
          passScore: 8,
          reviewers: [{ cli: "claude" }, { cli: "codex", model: "gpt-5" }],
          blockOn: "major",
        },
        conditions: { paths: ["src/**"] },
        slaHours: null,
      },
    ]);
    const pr = await openPR(p, "ai/ai");
    const run = codeRun(p, pr);
    const row = await sys((tx) => startCodeReview(tx, run, deps));
    await settle();
    expect(reviewRuns).toHaveLength(1);
    expect(reviewRuns[0]).toMatchObject({
      reviewId: row?.id,
      parentRunId: run.id,
      ownerUserId: null,
      headSha: pr.headSha,
      reviewers: [
        { cli: "claude", model: null },
        { cli: "codex", model: "gpt-5" },
      ],
      rubric: ["Đúng yêu cầu", "Có test"],
      passScore: 8,
      blockOn: "major",
      focusPaths: ["src/**"],
    });
    const [g] = await gateRuns(row?.id ?? "");
    expect(g).toMatchObject({ gate_id: "ai", status: "waiting" });
    expect(g.run_ids).toHaveLength(2);
    expect(g.details.map((d: { cli: string; state: string }) => [d.cli, d.state])).toEqual([
      ["claude", "queued"],
      ["codex", "queued"],
    ]);

    const finished = { state: "succeeded", review: null, error: null };
    expect(await sys((tx) => onReviewRunFinished(tx, { id: g.run_ids[0], ...finished }, deps))).toBe(true);
    expect(await sys((tx) => onReviewRunFinished(tx, { id: randomUUID(), ...finished }, deps))).toBe(false);
    expect((await gateRuns(row?.id ?? ""))[0].status).toBe("waiting");
  });

  it("runner requester: run review do chủ run code sở hữu", async () => {
    const p = await newProject();
    await saveWorkflow(p, [
      {
        id: "ai",
        name: "AI",
        kind: "ai",
        ai: { checks: ["x"], passScore: 7, reviewers: [{ cli: "claude" }], runner: "requester" },
        slaHours: null,
      },
    ]);
    const pr = await openPR(p, "ai/req");
    await sys((tx) => startCodeReview(tx, codeRun(p, pr), deps));
    await settle();
    expect(reviewRuns[0]?.ownerUserId).toBe(org.user("tadmin"));
  });

  it("hai job advance cùng lúc chỉ ghi mỗi checkpoint một lần", async () => {
    const p = await newProject();
    await saveWorkflow(p, [RULES, HUMAN]);
    const pr = await openPR(p, "ai/race");
    const row = await sys((tx) => startCodeReview(tx, codeRun(p, pr), deps));
    const [job] = queued.splice(0);
    await Promise.all([
      handleCodeReviewJob(deps, job?.data as CodeReviewJob),
      handleCodeReviewJob(deps, job?.data as CodeReviewJob),
    ]);
    expect((await gateRuns(row?.id ?? "")).map((r) => r.gate_id)).toEqual(["rules", "reviewer"]);
  });
});

describe("huỷ phiên", () => {
  it("đóng lượt đang chờ, ghi audit; phiên đã kết thúc thì không đổi", async () => {
    const p = await newProject();
    await saveWorkflow(p, [HUMAN]);
    const pr = await openPR(p, "ai/cancel");
    const row = await sys((tx) => startCodeReview(tx, codeRun(p, pr), deps));
    await settle();
    const id = row?.id ?? "";
    const done = await sys((tx) => cancelCodeReview(tx, id, "PR đã đóng."));
    expect(done?.status).toBe("cancelled");
    expect((await gateRuns(id))[0]).toMatchObject({ status: "skipped", note: "PR đã đóng." });
    const log = (await audits(id)).find((a) => a.action === "codereview.cancel");
    expect(log?.data).toMatchObject({ reason: "PR đã đóng.", from: "in_review" });

    const again = await sys((tx) => cancelCodeReview(tx, id, "Lần nữa."));
    expect(again?.status).toBe("cancelled");
    expect((await audits(id)).filter((a) => a.action === "codereview.cancel")).toHaveLength(1);

    // Job tới muộn không làm gì với phiên đã huỷ.
    await sys((tx) => advanceReview(tx, id, deps, { files: null }));
    expect(await gateRuns(id)).toHaveLength(1);
  });
});
