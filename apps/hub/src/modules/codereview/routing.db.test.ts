import { randomBytes, randomUUID } from "node:crypto";
import { type AiReviewerResult, workflowInput } from "@xdev-hive/contracts";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import type { z } from "zod";
import { type OrgFixture, seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { BadRequestError, ConflictError, createPool, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import { createMemoryProvider, type MemoryProvider } from "../scm/index.ts";
import { type DecideDeps, decideCodeReview } from "./decide.ts";
import { FIX_INSTRUCTIONS_MAX, fixInstructions, onCodeRunEnded, type QueueFixRunInput } from "./routing.ts";
import { onBranchPushed } from "./scm.ts";
import { type CodeReviewRun, completeAutoGate, type RunEvidence, startCodeReview } from "./service.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);

let org: OrgFixture & { user: (n: string) => string };
let provider: MemoryProvider;

// ---- Cổng giả ------------------------------------------------------------------------------------------------------

const evidence = new Map<string, RunEvidence>();
const fixRuns: (QueueFixRunInput & { id: string })[] = [];
const cancelled: string[] = [];
let fixMode: "ok" | "budget" | "conflict" = "ok";

// Không có hàng đợi: phiên đi tiếp ngay trong transaction, test thấy kết quả không cần chạy job.
const deps: DecideDeps = {
  masterKey,
  providerFactory: () => provider,
  publicUrl: "https://hive.example.com",
  runEvidence: async (_tx, runId) => evidence.get(runId) ?? null,
  startReviewRuns: async (_tx, input) =>
    input.reviewers.map((r) => ({ runId: randomUUID(), cli: r.cli, model: r.model, state: "queued" })),
  queueFixRun: async (tx, input) => {
    if (fixMode === "budget") throw new BadRequestError("TASK_BUDGET_EXHAUSTED", "Task đã dùng hết ngân sách");
    if (fixMode === "conflict") {
      // Như `queueRun` vướng chỉ mục một run đang chạy mỗi task: lỗi Postgres rồi đổi thành ConflictError.
      try {
        await tx.execute(sql`select 1 / 0`);
      } catch {
        throw new ConflictError("RUN_ACTIVE", "Task đang có run chưa kết thúc.");
      }
    }
    const id = randomUUID();
    fixRuns.push({ ...input, id });
    return { runId: id };
  },
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
async function newProject(): Promise<P> {
  seq += 1;
  const key = `crr${seq}-${tag}`;
  const p = await seedProject(admin, app, {
    orgId: org.orgId,
    teamId: org.teamId,
    systemId: org.systemId,
    adminUserId: u("admin"),
    masterKey,
    key,
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

let taskSeq = 0;
async function newTask(p: P): Promise<string> {
  taskSeq += 1;
  const { rows } = await admin.query(
    `insert into hive.tasks (org_id, team_id, project_id, number, key, title, status, created_by)
     values ($1, $2, $3, $4, $5, 'Hoàn tiền', 'review', $6) returning id`,
    [org.orgId, org.teamId, p.projectId, taskSeq, `${p.key}-${taskSeq}`, u("tadmin")],
  );
  return rows[0].id as string;
}

interface Opened {
  id: string;
  headSha: string;
  branch: string;
  number: number;
  url: string;
  taskId: string;
}

const STATS = { addedLines: 3, deletedLines: 1, changedFiles: ["src/pay.ts", "src/pay.test.ts"] };

/** Commit mới lên nhánh, trả SHA đầu PR. */
async function commit(p: P, branch: string, number: number, content = randomUUID()): Promise<string> {
  const { sha } = await provider.commitFiles(p.ref, {
    branch,
    message: "sửa",
    files: [{ path: "src/pay.ts", content: `export const v = "${content}";\n` }],
  });
  // Nhà cung cấp giả không dời đầu PR khi commit vào nhánh head.
  provider.setPull(p.ref, number, { headSha: sha });
  return sha;
}

/** Run code (gốc hoặc run sửa) xong ở commit `headSha`: `runs.verifyCode` gọi `startCodeReview`. */
function runDone(
  p: P,
  o: Omit<Opened, "id">,
  extra: Partial<CodeReviewRun> = {},
  commands: RunEvidence["commands"] = null,
) {
  const run: CodeReviewRun = {
    id: randomUUID(),
    teamId: org.teamId,
    projectId: p.projectId,
    taskId: o.taskId,
    ownerUserId: u("tadmin"),
    taskType: "feature",
    headSha: o.headSha,
    pr: { number: o.number, url: o.url, branch: o.branch, baseBranch: "main" },
    stats: STATS,
    reasons: [],
    ...extra,
  };
  evidence.set(run.id, { headSha: run.headSha, taskType: "feature", stats: run.stats, commands, hasAgentReport: true });
  return sys((tx) => startCodeReview(tx, run, deps));
}

async function openReview(p: P, commands: RunEvidence["commands"] = null): Promise<Opened> {
  const branch = `ai/${randomUUID().slice(0, 6)}`;
  await provider.commitFiles(p.ref, {
    branch,
    fromBranch: "main",
    message: "agent",
    files: [{ path: "src/pay.ts", content: `export const v = "${branch}";\n` }],
  });
  const { number, url } = await provider.openPR(p.ref, { head: branch, base: "main", title: branch, body: "" });
  const headSha = (await provider.getPR(p.ref, number))?.headSha ?? "";
  const taskId = await newTask(p);
  const base = { headSha, branch, number, url, taskId };
  const row = await runDone(p, base, {}, commands);
  if (!row) throw new Error("không mở được phiên");
  return { ...base, id: row.id };
}

const human = (id: string, users: string[]): Gate =>
  ({
    id,
    name: `Duyệt ${id}`,
    kind: "human",
    reviewers: { users, roles: [], quorum: 1 },
    slaHours: 24,
  }) as Gate;
const AI: Gate = {
  id: "ai",
  name: "Review AI",
  kind: "ai",
  ai: { checks: ["Đúng yêu cầu"], passScore: 7, reviewers: [{ cli: "claude" }] },
  slaHours: null,
  onReject: "agent",
};
const MAX_FILES: Gate = {
  id: "files",
  name: "Số file",
  kind: "rule",
  rules: ["max-files"],
  maxFiles: 1,
  slaHours: null,
  onReject: "agent",
};
const TESTS: Gate = {
  id: "tests",
  name: "Test",
  kind: "rule",
  rules: ["command"],
  commands: [{ run: "pnpm test", timeoutSec: 600 }],
  slaHours: null,
  onReject: "agent",
};

const decide = (who: string, input: Parameters<typeof decideCodeReview>[2]) =>
  sys((tx) => decideCodeReview(tx, u(who), input, deps));
const reviewRow = async (id: string) =>
  (await admin.query("select * from hive.code_reviews where id = $1", [id])).rows[0];
const openRow = async (p: P, number: number) =>
  (
    await admin.query(
      "select * from hive.code_reviews where project_id = $1 and pr_number = $2 and status in ('in_review', 'changes_requested', 'approved')",
      [p.projectId, number],
    )
  ).rows[0];
const gateRuns = async (id: string) =>
  (
    await admin.query(
      "select id, gate_index, gate_id, status, note, approvals, decided_by, run_ids from hive.code_review_gate_runs where review_id = $1 order by started_at, gate_index",
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
const inbox = async (event: string, keyLike: string) =>
  (
    await admin.query("select user_id, body, event_key from hive.inbox_items where event = $1 and event_key like $2", [
      event,
      keyLike,
    ])
  ).rows;
const taskStatus = async (id: string) =>
  (await admin.query("select status from hive.tasks where id = $1", [id])).rows[0]?.status as string;

const finding = (severity: string, message: string) => ({ file: "src/pay.ts", line: 12, severity, message });
const aiResult = (findings: ReturnType<typeof finding>[]): AiReviewerResult =>
  ({
    cli: "claude",
    model: null,
    runId: randomUUID(),
    state: "done",
    score: 8,
    passed: true,
    summary: "Ổn",
    findings,
    checklist: [],
    error: null,
  }) as AiReviewerResult;

/** Kết luận checkpoint AI đang chờ như khi run review xong (T022 gộp kết quả). */
const finishAi = (reviewId: string, gateIndex: number, details: AiReviewerResult[], passed = true) =>
  sys((tx) =>
    completeAutoGate(
      tx,
      {
        reviewId,
        gateIndex,
        kind: "ai",
        status: passed ? "passed" : "failed",
        score: 8,
        checklist: [],
        note: passed ? null : "Điểm thấp",
        details,
      },
      deps,
    ),
  );

beforeAll(async () => {
  org = await seedOrg(admin, `crr-${tag}`);
  provider = createMemoryProvider("github", ["xdev-team"]);
});

beforeEach(() => {
  fixRuns.splice(0);
  cancelled.splice(0);
  fixMode = "ok";
});

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

// ---- Chỉ dẫn -------------------------------------------------------------------------------------------------------

describe("chỉ dẫn cho run sửa (FR-024)", () => {
  it("góp ý trước, rồi phát hiện, quy tắc, đuôi lệnh; cắt ở 16 000 ký tự", () => {
    const text = fixInstructions({
      prNumber: 7,
      workflowName: "Cơ bản",
      gateName: "Người duyệt",
      note: "Thiếu test cho hoàn tiền",
      findings: [{ file: "src/a.ts", line: 3, severity: "major", message: "Không kiểm số âm" }],
      failedRules: [{ label: "Lệnh `pnpm test` thoát với mã 0", note: "Mã thoát 1." }],
      failedCommands: [{ run: "pnpm test", exit: 1, durationMs: 10, tail: "FAIL refund.test.ts" }],
    });
    expect(text.indexOf("Thiếu test cho hoàn tiền")).toBeLessThan(text.indexOf("Không kiểm số âm"));
    expect(text).toContain("- [major] src/a.ts:3: Không kiểm số âm");
    expect(text).toContain("FAIL refund.test.ts");

    const long = fixInstructions({
      prNumber: 7,
      workflowName: "Cơ bản",
      gateName: "Test",
      note: "Sửa test",
      findings: [],
      failedRules: [],
      failedCommands: Array.from({ length: 6 }, (_, i) => ({
        run: `cmd${i}`,
        exit: 1,
        durationMs: 1,
        tail: `${"x".repeat(9_000)}END${i}`,
      })),
    });
    expect(long.length).toBeLessThanOrEqual(FIX_INSTRUCTIONS_MAX);
    expect(long).toContain("Sửa test");
    // Đuôi output giữ phần cuối, nơi có lỗi.
    expect(long).toContain("END0");
  });
});

// ---- Ba hướng ------------------------------------------------------------------------------------------------------

describe("trả lại hướng agent", () => {
  it("tạo run sửa với góp ý và phát hiện mức chặn, đếm lượt; commit của run sửa mở vòng 2 dừng đúng checkpoint", async () => {
    const p = await newProject();
    await saveWorkflow(p, [AI, human("lead", [u("loner")])]);
    const r = await openReview(p);
    await finishAi(r.id, 0, [aiResult([finding("major", "Không kiểm số âm"), finding("minor", "Đặt tên biến")])]);

    const out = await decide("loner", {
      id: r.id,
      headSha: r.headSha,
      decision: "changes",
      note: "Thiếu test cho hoàn tiền",
      route: "agent",
    });
    expect(out).toMatchObject({ status: "changes_requested", route: "agent", agentRevisions: 1 });
    expect(fixRuns).toHaveLength(1);
    const fix = fixRuns[0];
    expect(fix).toMatchObject({ reviewId: r.id, runId: (await reviewRow(r.id)).run_id });
    expect(fix?.instructions).toContain("Thiếu test cho hoàn tiền");
    expect(fix?.instructions).toContain("Không kiểm số âm");
    expect(fix?.instructions).not.toContain("Đặt tên biến");
    expect(await reviewRow(r.id)).toMatchObject({ resume_gate_index: 1, gate_index: 1, agent_revisions: 1 });
    const log = await audits(r.id);
    expect(log.find((a) => a.action === "codereview.fix_run")?.data).toMatchObject({ runId: fix?.id, revision: 1 });
    expect(log.find((a) => a.action === "codereview.changes")).toMatchObject({
      actor_user_id: u("loner"),
      data: { requestedRoute: "agent", route: "agent", runId: fix?.id },
    });
    // Agent đang sửa: webhook của chính lần đẩy đó không tranh mở vòng.
    const pushed = await commit(p, r.branch, r.number);
    expect(
      await sys((tx) => onBranchPushed(tx, { projectId: p.projectId, branch: r.branch, headSha: pushed }, deps)),
    ).toBeNull();

    // Run sửa xong: verifyCode mở vòng 2 theo bản chụp cũ, AI chạy lại, rồi dừng ở checkpoint đã trả lại.
    const next = await runDone(p, { ...r, headSha: pushed }, { id: fix?.id ?? "" });
    expect(next).toMatchObject({ round: 2, previousId: r.id, agentRevisions: 1, resumeGateIndex: 1 });
    expect((await reviewRow(r.id)).status).toBe("superseded");
    expect(await gateRuns(next?.id ?? "")).toMatchObject([{ gate_id: "ai", status: "waiting" }]);
    await finishAi(next?.id ?? "", 0, [aiResult([])]);
    expect(await gateRuns(next?.id ?? "")).toMatchObject([
      { gate_id: "ai", status: "passed" },
      { gate_id: "lead", status: "waiting", approvals: [] },
    ]);
    expect(await reviewRow(next?.id ?? "")).toMatchObject({ status: "in_review", gate_index: 1 });
  });

  it("checkpoint tự động không đạt đi hướng mặc định; hết lượt thì về người giao việc kèm lý do (FR-025)", async () => {
    const p = await newProject();
    await saveWorkflow(p, [MAX_FILES, human("lead", [u("loner")])], { maxAgentRevisions: 1 });
    const r = await openReview(p);
    expect(await reviewRow(r.id)).toMatchObject({ status: "changes_requested", route: "agent", agent_revisions: 1 });
    expect(fixRuns[0]?.instructions).toContain("Đổi không quá 1 file: Đổi 2 file.");
    expect((await audits(r.id)).find((a) => a.action === "codereview.changes")).toMatchObject({
      actor_user_id: null,
      data: { gateId: "files", requestedRoute: "agent", route: "agent" },
    });

    const head2 = await commit(p, r.branch, r.number);
    const r2 = await runDone(p, { ...r, headSha: head2 }, { id: fixRuns[0]?.id ?? "" });
    expect(await reviewRow(r2?.id ?? "")).toMatchObject({
      round: 2,
      status: "changes_requested",
      route: "author",
      agent_revisions: 1,
    });
    expect(fixRuns).toHaveLength(1);
    expect(await taskStatus(r.taskId)).toBe("todo");
    const sent = await inbox("code_review.returned", "code_review_returned:%");
    expect(sent.find((m) => m.body.includes("Đã dùng hết 1 lượt agent sửa"))).toMatchObject({ user_id: u("tadmin") });
    expect((await audits(r2?.id ?? "")).find((a) => a.action === "codereview.changes")?.data).toMatchObject({
      requestedRoute: "agent",
      route: "author",
      reason: "Đã dùng hết 1 lượt agent sửa của PR này.",
    });
  });

  it("đuôi lệnh kiểm lỗi của run vào chỉ dẫn", async () => {
    const p = await newProject();
    await saveWorkflow(p, [TESTS]);
    await openReview(p, [{ run: "pnpm test", exit: 1, durationMs: 900, tail: "FAIL src/refund.test.ts > âm" }]);
    expect(fixRuns[0]?.instructions).toContain("FAIL src/refund.test.ts > âm");
    expect(fixRuns[0]?.instructions).toContain("Lệnh `pnpm test` lỗi (mã thoát 1)");
  });

  it("hết ngân sách hay task đang có run: không tạo run sửa, về người giao việc; transaction vẫn dùng được", async () => {
    const p = await newProject();
    await saveWorkflow(p, [human("lead", [u("loner")])]);

    fixMode = "budget";
    const a = await openReview(p);
    const out = await decide("loner", {
      id: a.id,
      headSha: a.headSha,
      decision: "changes",
      note: "Sửa",
      route: "agent",
    });
    expect(out).toMatchObject({ status: "changes_requested", route: "author", agentRevisions: 0 });
    expect((await audits(a.id)).find((x) => x.action === "codereview.changes")?.data).toMatchObject({
      reason: "Task đã dùng hết ngân sách.",
    });

    fixMode = "conflict";
    const b = await openReview(p);
    const out2 = await decide("loner", {
      id: b.id,
      headSha: b.headSha,
      decision: "changes",
      note: "Sửa",
      route: "agent",
    });
    expect(out2).toMatchObject({ status: "changes_requested", route: "author" });
    expect(await gateRuns(b.id)).toMatchObject([{ status: "failed", note: "Sửa", decided_by: u("loner") }]);
    expect(fixRuns).toHaveLength(0);
  });

  it("run sửa no_changes hoặc failed: phiên giữ changes_requested, về người giao việc kèm lý do run", async () => {
    const p = await newProject();
    await saveWorkflow(p, [human("lead", [u("loner")])]);
    for (const [state, reasons, expected] of [
      ["no_changes", [], "Run sửa của agent không tạo commit nào."],
      ["failed", ["Hết thời gian"], "Run sửa của agent kết thúc failed: Hết thời gian"],
    ] as const) {
      const r = await openReview(p);
      await decide("loner", { id: r.id, headSha: r.headSha, decision: "changes", note: "Sửa đi", route: "agent" });
      const fix = fixRuns.at(-1);
      // Run xong có commit không qua đây.
      expect(
        await sys((tx) =>
          onCodeRunEnded(tx, { id: randomUUID(), taskId: r.taskId, state: "succeeded", reasons: [] }, deps),
        ),
      ).toBeNull();
      const row = await sys((tx) =>
        onCodeRunEnded(tx, { id: fix?.id ?? "", taskId: r.taskId, state, reasons: [...reasons] }, deps),
      );
      expect(row).toMatchObject({ status: "changes_requested", route: "author" });
      expect(await taskStatus(r.taskId)).toBe("todo");
      const [mail] = await inbox("code_review.returned", `code_review_returned:fix:${fix?.id}`);
      expect(mail?.body).toContain(expected);
      expect(mail?.body).toContain("Sửa đi");
      // Gọi lại (job chạy lại) không làm gì.
      expect(
        await sys((tx) => onCodeRunEnded(tx, { id: fix?.id ?? "", taskId: r.taskId, state, reasons: [] }, deps)),
      ).toBeNull();
    }
  });
});

describe("trả lại hướng author và previous", () => {
  it("author: task về todo, báo người giao việc; push mở vòng mới, giữ phê duyệt trước chỗ trả lại (D8)", async () => {
    const p = await newProject();
    await saveWorkflow(p, [human("lead", [u("loner")]), human("arch", [u("tmember")])]);
    const r = await openReview(p);
    await decide("loner", { id: r.id, headSha: r.headSha, decision: "approve" });
    const out = await decide("tmember", {
      id: r.id,
      headSha: r.headSha,
      decision: "changes",
      note: "Đổi tên hàm",
      route: "author",
    });
    expect(out).toMatchObject({ status: "changes_requested", route: "author" });
    expect(await taskStatus(r.taskId)).toBe("todo");
    expect(
      (await inbox("code_review.returned", "code_review_returned:%")).find((m) => m.body.includes("Đổi tên hàm")),
    ).toMatchObject({ user_id: u("tadmin") });

    // Người giao việc push tay: vòng 2 giữ run cũ, giữ phê duyệt của "lead", dừng ở "arch".
    const head2 = await commit(p, r.branch, r.number);
    const r2 = await sys((tx) =>
      onBranchPushed(tx, { projectId: p.projectId, branch: r.branch, headSha: head2 }, deps),
    );
    expect(r2).toMatchObject({ round: 2, runId: (await reviewRow(r.id)).run_id, headSha: head2, resumeGateIndex: 1 });
    expect(await gateRuns(r2?.id ?? "")).toMatchObject([
      { gate_id: "lead", status: "passed", approvals: [{ userId: u("loner") }], note: "Giữ phê duyệt của vòng 1." },
      { gate_id: "arch", status: "waiting" },
    ]);
    expect((await audits(r2?.id ?? "")).find((a) => a.action === "codereview.start")?.data).toMatchObject({
      source: "push",
      round: 2,
    });
    // Webhook giao lại cùng SHA không mở thêm vòng.
    expect(
      await sys((tx) => onBranchPushed(tx, { projectId: p.projectId, branch: r.branch, headSha: head2 }, deps)),
    ).toBeNull();
    // Nhánh không có phiên mở: không làm gì.
    expect(
      await sys((tx) => onBranchPushed(tx, { projectId: p.projectId, branch: "feat/x", headSha: head2 }, deps)),
    ).toBeNull();
  });

  it("dismissStaleApprovals: vòng mới bắt mọi checkpoint người duyệt duyệt lại", async () => {
    const p = await newProject();
    await saveWorkflow(p, [human("lead", [u("loner")]), human("arch", [u("tmember")])], {
      dismissStaleApprovals: true,
    });
    const r = await openReview(p);
    await decide("loner", { id: r.id, headSha: r.headSha, decision: "approve" });
    await decide("tmember", { id: r.id, headSha: r.headSha, decision: "changes", note: "Sửa", route: "author" });
    const head2 = await commit(p, r.branch, r.number);
    const r2 = await sys((tx) =>
      onBranchPushed(tx, { projectId: p.projectId, branch: r.branch, headSha: head2 }, deps),
    );
    expect(await gateRuns(r2?.id ?? "")).toMatchObject([{ gate_id: "lead", status: "waiting", approvals: [] }]);
  });

  it("previous: về checkpoint người duyệt trước, xoá phê duyệt ở đó, báo lại; không có thì về người giao việc", async () => {
    const p = await newProject();
    await saveWorkflow(p, [human("lead", [u("loner")]), human("arch", [u("tmember")])]);
    const r = await openReview(p);
    await decide("loner", { id: r.id, headSha: r.headSha, decision: "approve" });
    const out = await decide("tmember", {
      id: r.id,
      headSha: r.headSha,
      decision: "changes",
      note: "Lead xem lại phần hoàn tiền",
      route: "previous",
    });
    expect(out).toMatchObject({ status: "in_review", route: "previous" });
    expect(out.gate).toMatchObject({ id: "lead" });
    const runs = await gateRuns(r.id);
    expect(runs).toMatchObject([
      { gate_id: "lead", status: "passed" },
      { gate_id: "arch", status: "failed", note: "Lead xem lại phần hoàn tiền" },
      { gate_id: "lead", status: "waiting", approvals: [] },
    ]);
    const awaiting = await inbox("code_review.awaiting", `code_review:${runs[2]?.id ?? ""}`);
    expect(awaiting).toMatchObject([{ user_id: u("loner") }]);
    expect(await taskStatus(r.taskId)).toBe("review");

    // Lead duyệt lại thì "arch" chờ lần nữa.
    const again = await decide("loner", { id: r.id, headSha: r.headSha, decision: "approve" });
    expect(again.gate).toMatchObject({ id: "arch" });

    // Checkpoint đầu tiên trả "về checkpoint trước": không có nơi về, nên về người giao việc.
    const q = await newProject();
    await saveWorkflow(q, [human("lead", [u("loner")])]);
    const s = await openReview(q);
    const first = await decide("loner", {
      id: s.id,
      headSha: s.headSha,
      decision: "changes",
      note: "Sửa",
      route: "previous",
    });
    expect(first).toMatchObject({ status: "changes_requested", route: "author" });
    expect((await audits(s.id)).find((a) => a.action === "codereview.changes")?.data).toMatchObject({
      requestedRoute: "previous",
      route: "author",
      reason: "Không có checkpoint người duyệt nào phía trước.",
    });
  });
});

describe("commit mới ngoài Hive", () => {
  it("phiên đang chờ AI: lượt chờ đóng lại, run review bị huỷ, vòng mới chạy lại AI; lệnh kiểm chờ người", async () => {
    const p = await newProject();
    await saveWorkflow(p, [AI, TESTS]);
    const r = await openReview(p, [{ run: "pnpm test", exit: 0, durationMs: 5, tail: "ok" }]);
    const [ai] = await gateRuns(r.id);
    expect(ai).toMatchObject({ gate_id: "ai", status: "waiting" });

    const head2 = await commit(p, r.branch, r.number);
    const r2 = await sys((tx) =>
      onBranchPushed(tx, { projectId: p.projectId, branch: r.branch, headSha: head2 }, deps),
    );
    expect(await gateRuns(r.id)).toMatchObject([{ gate_id: "ai", status: "skipped" }]);
    expect(cancelled).toEqual(ai?.run_ids);
    expect((await audits(r.id)).find((a) => a.action === "codereview.supersede")?.data).toMatchObject({
      newHeadSha: head2,
      source: "push",
      from: "in_review",
    });

    await finishAi(r2?.id ?? "", 0, [aiResult([])]);
    // Kết quả lệnh của run cũ gắn với commit cũ: checkpoint lệnh chờ người (FR-017).
    expect(await gateRuns(r2?.id ?? "")).toMatchObject([
      { gate_id: "ai", status: "passed" },
      { gate_id: "tests", status: "waiting" },
    ]);
    expect(await openRow(p, r.number)).toMatchObject({ id: r2?.id, round: 2 });
  });

  it("phiên đã đạt: commit mới bắt người duyệt cuối duyệt lại, người trước giữ phê duyệt", async () => {
    const p = await newProject();
    await saveWorkflow(p, [human("lead", [u("loner")]), human("arch", [u("tmember")])]);
    const r = await openReview(p);
    await decide("loner", { id: r.id, headSha: r.headSha, decision: "approve" });
    await decide("tmember", { id: r.id, headSha: r.headSha, decision: "approve" });
    expect((await reviewRow(r.id)).status).toBe("approved");

    const head2 = await commit(p, r.branch, r.number);
    const r2 = await sys((tx) =>
      onBranchPushed(tx, { projectId: p.projectId, branch: r.branch, headSha: head2 }, deps),
    );
    expect(r2).toMatchObject({ status: "in_review", resumeGateIndex: 1 });
    expect(await gateRuns(r2?.id ?? "")).toMatchObject([
      { gate_id: "lead", status: "passed" },
      { gate_id: "arch", status: "waiting" },
    ]);
  });
});
