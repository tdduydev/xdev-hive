import {
  type AssistStartInput,
  type ChecklistItem,
  type JobMcpServer,
  type JobPolicy,
  type OutcomeCheck,
  type PlanApproveInput,
  type PlanDecision,
  type PlanRejectInput,
  type RunStartInput,
  type SandboxJobConfig,
  type TaskStatus,
  TERMINAL_RUN_STATES,
} from "@xdev-hive/contracts";
import { type DiffStats, diffStats, steerResultData } from "@xdev-hive/contracts/worker-protocol";
import { and, asc, desc, eq, gt, inArray, notInArray, or, sql } from "drizzle-orm";
import type pg from "pg";
import { recordAudit } from "../audit/index.ts";
import { enqueueMerge, latestActiveProject, loadProject, type ProjectRow, projectFor } from "../catalog/index.ts";
import {
  type AuthedMachine,
  findMachine,
  isConnected,
  listOnlineMachines,
  machineIsPaused,
  type OutgoingMessage,
  type RunHandlers,
  type RunMessage,
  sendToMachine,
} from "../fleet/index.ts";
import {
  clampBudget,
  jobPolicyOf,
  loadPolicy,
  machineSlots,
  type Policy,
  resolveModel,
  resolvePermission,
} from "../governance/index.ts";
import { authUser } from "../identity/index.ts";
import { aiGateContext, applyAiResult, attachGateRun, completeWaitingGate } from "../knowledge/index.ts";
import { mcpServersForProject } from "../mcp/index.ts";
import { notify } from "../notify/index.ts";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  type Jobs,
  type MasterKey,
  NotFoundError,
  type Tx,
  withTenant,
} from "../platform/index.ts";
import { loadSandboxJobConfig } from "../sandbox/index.ts";
import {
  isGitProviderError,
  loadConnection,
  type ProviderFactory,
  type ScmEventRegistry,
  scmEvents,
} from "../scm/index.ts";
import {
  approvedPlanOf,
  decidePlan,
  findPlan,
  latestPlanOf,
  loadTask,
  lockAwaitingPlan,
  type PlanRow,
  planMarkdown,
  recordPlan,
  setTaskStatus,
  supersedePlans,
  type TaskRow,
  taskForUser,
  toPlan,
} from "../tasks/index.ts";
import {
  applyCost,
  assertTaskBudget,
  type JobBudget,
  jobBudget,
  orgSpentTodayUsd,
  parseCostData,
  taskSpentUsd,
} from "./cost.ts";
import { assistTargets, createAssistRun, listAssists } from "./docassist.ts";
import { docCheckPrompt } from "./doccheck.ts";
import { approvedPlanPrompt, parsePlanReport, planPrompt } from "./plan.ts";
import {
  evaluatePlanRun,
  evaluatePolicy,
  evaluateReviewRun,
  type Outcome,
  type ReviewEvidence,
  reviewSkipReason,
} from "./policy.ts";
import { parseReviewReport, prNumberOf, type ReviewReport, reviewComment, reviewPrompt } from "./review.ts";
import { createMcpRunTokens } from "./run-tokens.ts";
import { type RunResult, runEvents, runLeases, runLogs, runs } from "./schema.ts";
import { registerScmHandlers } from "./scm-events.ts";
import {
  hubEvent,
  lockRun,
  notifyRun,
  ON_MACHINE,
  projectReady,
  RUNS_CHANNEL,
  type RunRow,
  toRun,
  transition,
} from "./state.ts";
import { runTokenKey, signRunToken } from "./token.ts";

/** Hẹn giờ của run (hết hạn đề nghị job, kiểm lease, chạy lại verifying) đi qua một queue pg-boss. */
export const RUNS_TIMER_QUEUE = "runs-timer";
export const runsTimerQueue = {
  name: RUNS_TIMER_QUEUE,
  retryLimit: 5,
  retryDelay: 10,
  retryBackoff: true,
  expireInSeconds: 5 * 60,
} as const;

export type RunTimer =
  | { kind: "offer"; orgId: string; runId: string; attempt: number; machineId: string }
  | { kind: "lease"; orgId: string; runId: string; leaseId: string }
  | { kind: "verify"; orgId: string; runId: string };

export interface RunsDeps {
  /** Pool của hive_app. */
  pool: pg.Pool;
  publicUrl: string;
  /** HIVE_AUTH_SECRET: suy ra khoá ký run token. */
  authSecret: string;
  /** Giải mã kết nối Git để mở PR. */
  masterKey?: MasterKey | undefined;
  providerFactory: ProviderFactory;
  /**
   * Hẹn giờ bền qua pg-boss (sống qua lúc hub khởi động lại). Không có thì dùng setTimeout trong tiến trình, đủ cho
   * test và hub chạy một tiến trình không có hàng đợi.
   */
  jobs?: Jobs | undefined;
  /** Hạn của lease; worker gia hạn bằng heartbeat. Mặc định 90 giây (ba chu kỳ heartbeat). */
  leaseSec?: number | undefined;
  /** Thời gian máy có để trả lời job_offer. */
  offerTtlSec?: number | undefined;
  /** Thời gian worker có để dừng agent êm trước khi kill. */
  cancelGraceSec?: number | undefined;
  /** Chờ bao lâu rồi chạy lại verifying nếu hub chết giữa chừng. */
  verifyRetrySec?: number | undefined;
  send?: ((machineId: string, msg: OutgoingMessage) => boolean) | undefined;
  isConnected?: ((machineId: string) => boolean) | undefined;
  logger?: Pick<Console, "warn" | "error"> | undefined;
  leaderMessage?: ((tx: Tx, threadId: string, content: string) => Promise<void>) | undefined;
  leaderQueuedPrompt?:
    | ((tx: Tx, threadId: string, after: Date) => Promise<{ userId: string; projectId: string; prompt: string } | null>)
    | undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PHASE_STATE: Record<string, "preparing" | "running"> = {
  prepare: "preparing",
  preparing: "preparing",
  running: "running",
};
const pgError = (e: unknown) => ((e as { cause?: unknown }).cause ?? e) as { code?: string; constraint?: string };

const runNotFound = () => new NotFoundError("RUN_NOT_FOUND", "Không tìm thấy run trong tổ chức.");

type ReviewCheck = Extract<OutcomeCheck, { check: "review" }>;
const reviewCheckOf = (policy: OutcomeCheck[], stats?: DiffStats) =>
  policy.find((c): c is ReviewCheck => c.check === "review" && !reviewSkipReason(c, stats));
const exitOf = (data: Record<string, unknown>) => (typeof data.exit === "number" ? data.exit : null);

/** Gói run_result sau cùng của lần thử hiện tại. */
async function resultOf(tx: Tx, run: RunRow): Promise<Record<string, unknown>> {
  const [row] = await tx
    .select({ data: runEvents.data })
    .from(runEvents)
    .where(and(eq(runEvents.runId, run.id), eq(runEvents.attempt, run.attempt), eq(runEvents.type, "result")))
    .orderBy(desc(runEvents.id))
    .limit(1);
  return row?.data ?? {};
}

/** Run con (review hoặc plan) mới nhất của run code. Lọc theo loại: run code đã lập kế hoạch có cả hai loại con. */
async function childRunOf(tx: Tx, parentId: string, kind: "review" | "plan"): Promise<RunRow | null> {
  const [row] = await tx
    .select()
    .from(runs)
    .where(and(eq(runs.parentRunId, parentId), eq(runs.kind, kind)))
    .orderBy(desc(runs.createdAt))
    .limit(1);
  return row ?? null;
}

/** Báo cáo review_submit sau cùng của lần thử hiện tại: agent gọi lại thì lần sau thay lần trước. */
async function reviewReportOf(tx: Tx, run: RunRow): Promise<ReviewReport | null> {
  const [row] = await tx
    .select({ data: runEvents.data })
    .from(runEvents)
    .where(and(eq(runEvents.runId, run.id), eq(runEvents.attempt, run.attempt), eq(runEvents.type, "review_report")))
    .orderBy(desc(runEvents.id))
    .limit(1);
  return row ? parseReviewReport(row.data) : null;
}

/** Kế hoạch plan_submit sau cùng của lần thử hiện tại, như reviewReportOf. */
async function planReportOf(tx: Tx, run: RunRow) {
  const [row] = await tx
    .select({ data: runEvents.data })
    .from(runEvents)
    .where(and(eq(runEvents.runId, run.id), eq(runEvents.attempt, run.attempt), eq(runEvents.type, "plan_report")))
    .orderBy(desc(runEvents.id))
    .limit(1);
  return row ? parsePlanReport(row.data) : null;
}

/** Kế hoạch đang có hiệu lực: bản người duyệt sửa nếu có. */
const planInForce = (p: PlanRow) => p.editedContent ?? p.content;

/**
 * Worker chỉ cấu hình MCP của Hive cho Claude và Codex. Run plan phải gọi plan_submit, nên run không chọn CLI thì
 * không giao cho CLI khác (Gemini) để khỏi chắc chắn thất bại.
 */
const SUBMIT_CLIS: readonly string[] = ["claude", "codex"];
/**
 * Run không có task, lời nhắc lấy từ sự kiện `<kind>_prompt` của hub: leader (trò chuyện), doccheck (gate AI của quy
 * trình duyệt), docassist (trợ lý của trình soạn tài liệu).
 */
const PROMPT_KINDS: readonly RunRow["kind"][] = ["leader", "doccheck", "docassist"];
/** Run phải nộp kết quả qua tool MCP nên chỉ giao cho CLI gọi được tool khi chạy không tương tác. */
const SUBMIT_KINDS: readonly RunRow["kind"][] = ["plan", "leader", "doccheck", "docassist"];
/** Worker cũ không biết các kind này sẽ chạy chúng như run code (có quyền ghi): chỉ giao cho máy đã khai kind đó. */
const CAPABILITY_KINDS: readonly RunRow["kind"][] = ["doccheck", "docassist"];
const promptEvent = (kind: RunRow["kind"]) => (kind === "leader" ? "leader_prompt" : `${kind}_prompt`);

function reviewEvidence(child: RunRow, report: ReviewReport | null): ReviewEvidence {
  if (child.state === "succeeded" && report) return { status: "done", score: report.score, by: child.cli };
  if (child.state === "cancelled") return { status: "failed", reason: "run review đã bị huỷ." };
  const why = child.result?.reasons[0];
  return { status: "failed", reason: why ?? `run review kết thúc ở trạng thái ${child.state}.` };
}

/** Chỉ dẫn đã ghi cho run (mọi lần thử): run giao lại sau khi mất máy vẫn mang theo chỉ dẫn người review đã gửi. */
async function instructionsOf(tx: Tx, runId: string): Promise<string[]> {
  const rows = await tx
    .select({ data: runEvents.data })
    .from(runEvents)
    .where(and(eq(runEvents.runId, runId), eq(runEvents.type, "steer")))
    .orderBy(asc(runEvents.id));
  return rows.map((r) => r.data.input).filter((i): i is string => typeof i === "string");
}

/** Ghi sự kiện của hub một lần cho lần thử này: dispatch chạy lại mỗi heartbeat, không lặp cùng một thông báo. */
async function noteOnce(tx: Tx, run: RunRow, type: string, data: { message: string }): Promise<void> {
  const [seen] = await tx
    .select({ id: runEvents.id })
    .from(runEvents)
    .where(
      and(
        eq(runEvents.runId, run.id),
        eq(runEvents.attempt, run.attempt),
        eq(runEvents.type, type),
        sql`${runEvents.data}->>'message' = ${data.message}`,
      ),
    )
    .limit(1);
  if (!seen) await hubEvent(tx, run, type, data);
}

/** Trạng thái task theo kết quả run: có PR thì chờ người review, không có gì để nộp hay lỗi thì quay về todo. */
function taskStatusFor(outcome: Outcome | "cancelled", prUrl: string | null): TaskStatus {
  if (outcome === "succeeded") return prUrl ? "review" : "done";
  if (outcome === "needs_review") return "review";
  return "todo";
}

interface SpecContext {
  instructions: string[];
  budget: JobBudget | undefined;
  /** Model và quyền CLI sau khi áp Chính sách agent của tổ chức. */
  model: string | null;
  runPermissions: "workspace" | "full";
  /** Hook bắt buộc của tổ chức, worker chạy ở các mốc của CLI. */
  policy: JobPolicy;
  parentPrUrl: string | null;
  /** Run code: kế hoạch đã duyệt mà run phải làm theo. */
  approvedPlan: PlanRow | null;
  /** Run plan: kế hoạch lần trước của task nếu bị từ chối. */
  rejectedPlan: PlanRow | null;
  /** Dự án bật sandbox: cấu hình image và allowlist cho runner host. */
  sandbox?: SandboxJobConfig | undefined;
  leaderPrompt: string | null;
  /** MCP server ngoài được phép (MCP-06); chỉ run code nhận, xem dispatch. */
  mcpServers: JobMcpServer[];
}

function promptOf(run: RunRow, task: TaskRow, project: ProjectRow, ctx: SpecContext): string {
  const baseBranch = project.defaultBranch ?? "main";
  // Run review đọc nhánh của run cha (run.branch) so với nhánh chính; worker không push và không đòi commit.
  if (run.kind === "review") {
    return reviewPrompt({
      taskKey: task.key,
      title: task.title,
      body: task.body,
      branch: run.branch,
      baseBranch,
      prUrl: ctx.parentPrUrl,
    });
  }
  // Run plan đọc nhánh chính ở chế độ chỉ đọc; worker không push.
  if (run.kind === "plan") {
    const rejected = ctx.rejectedPlan;
    return planPrompt({
      taskKey: task.key,
      title: task.title,
      body: task.body,
      baseBranch,
      rejected: rejected ? { plan: planMarkdown(planInForce(rejected)), reason: rejected.note } : null,
    });
  }
  if (run.kind === "leader") return ctx.leaderPrompt ?? "Hãy trả lời người dùng qua công cụ MCP leader_reply.";
  if (run.kind === "doccheck") return ctx.leaderPrompt ?? "Hãy kiểm tài liệu rồi gọi công cụ MCP doc_check_submit.";
  if (run.kind === "docassist") return ctx.leaderPrompt ?? "Hãy đọc bản nháp bằng doc_draft_get rồi góp ý.";
  const prompt = task.body ? `${task.title}\n\n${task.body}` : task.title;
  const plan = ctx.approvedPlan;
  return plan ? `${prompt}\n\n${approvedPlanPrompt(planMarkdown(planInForce(plan)), plan.note)}` : prompt;
}

/**
 * Máy cá nhân chỉ chạy run của người đã đăng ký máy, vì CLI trên máy đăng nhập bằng tài khoản của họ; run của đội
 * (ownerUserId null: Leader, gate AI, webhook) chỉ chạy trên máy dùng chung hoặc runner host (ADR 0017).
 */
export function usableBy(
  m: { shared: boolean; registeredBy: string | null },
  run: Pick<RunRow, "ownerUserId">,
  sandboxed: boolean,
): boolean {
  if (sandboxed || m.shared) return true;
  return run.ownerUserId !== null && m.registeredBy === run.ownerUserId;
}

/**
 * Run chạy trong sandbox: dự án bật sandbox (mọi loại run), hoặc tổ chức bắt buộc sandbox cho run code (Chính sách
 * agent). Run chỉ đọc (plan, review, leader) không sửa code nên theo cấu hình của dự án.
 */
export function sandboxedRun(project: ProjectRow, policy: Policy, kind: RunRow["kind"]): boolean {
  // Trợ lý tài liệu chạy trên máy của chính người nhờ (gói thuê bao CLI của họ), không qua runner host.
  if (kind === "docassist") return false;
  return project.settings.features.sandbox || (policy.requireSandbox && kind === "code");
}

function buildSpec(
  run: RunRow,
  task: TaskRow | null,
  project: ProjectRow,
  cli: string,
  ctx: SpecContext,
): Record<string, unknown> {
  const taskPrompt = task ?? ({ id: "", key: "leader", title: "Trao đổi với leader", body: "" } as TaskRow);
  const prompt = promptOf(run, taskPrompt, project, ctx);
  const { instructions, budget, sandbox, mcpServers } = ctx;
  return {
    kind: run.kind,
    execution: sandbox ? "sandbox" : "worker",
    ...(sandbox ? { sandbox } : {}),
    taskId: task?.id ?? null,
    taskKey: task?.key ?? null,
    projectId: project.id,
    projectKey: project.key,
    title: task?.title ?? "Trao đổi với leader",
    prompt: instructions.length
      ? `${prompt}\n\nChỉ dẫn thêm từ người review:\n${instructions.map((i) => `- ${i}`).join("\n")}`
      : prompt,
    instructions,
    cli,
    model: ctx.model,
    runPermissions: ctx.runPermissions,
    // Bỏ khi không có gì để worker cũ (chưa biết trường này) và worker mới nhận cùng một spec như trước.
    ...(ctx.policy.hooks.length || ctx.policy.managedHooksOnly ? { policy: ctx.policy } : {}),
    repoUrl: project.repoHttpUrl,
    baseBranch: project.defaultBranch,
    branch: run.branch,
    timeoutSec: run.timeoutSec,
    ...(budget ? { budget } : {}),
    ...(mcpServers.length ? { mcpServers } : {}),
  };
}

function prBody(task: TaskRow, run: RunRow, checks: RunResult["checks"]): string {
  const lines = [
    task.body ? task.body.slice(0, 4000) : "",
    "",
    `Task: ${task.key} · Run: ${run.id} (lần thử ${run.attempt})`,
    "",
    "Kiểm tra của hub:",
    ...checks.map(
      (c) => `- ${c.skipped ? "⏭" : c.passed ? "✅" : c.passed === null ? "⏸" : "❌"} ${c.check}: ${c.message}`,
    ),
  ];
  return lines.join("\n").trim();
}

/**
 * Lõi của module runs: giao job cho máy, lease, nhận gói của worker (fencing theo attempt), verifying và các hẹn giờ.
 * Gửi gói tới máy luôn làm sau khi transaction commit, để máy không nhận lệnh cho thay đổi đã rollback.
 */
export function createRunsEngine(deps: RunsDeps) {
  const leaseSec = deps.leaseSec ?? 90;
  const offerTtlSec = deps.offerTtlSec ?? 30;
  const graceSec = deps.cancelGraceSec ?? 30;
  const verifyRetrySec = deps.verifyRetrySec ?? 5 * 60;
  const send = deps.send ?? sendToMachine;
  const connected = deps.isConnected ?? isConnected;
  const log = deps.logger ?? console;
  const tokenKey = runTokenKey(deps.authSecret);
  const tenant = <T>(orgId: string, fn: (tx: Tx) => Promise<T>) => withTenant(deps.pool, { orgId }, fn);
  // Web chưa có trang task; đường dẫn này sẽ là trang task khi web có (cùng quy ước với bình luận trên issue).
  const taskLink = (task: TaskRow | null) => (task ? `${deps.publicUrl.replace(/\/+$/, "")}/tasks/${task.key}` : null);
  const timers = new Set<NodeJS.Timeout>();
  const pendingNotify = new Map<string, NodeJS.Timeout>();
  let stopped = false;

  const background = (p: Promise<unknown>, what: string) => {
    p.catch((e: unknown) => log.error(what, e));
  };

  /** Hẹn giờ trong transaction khi có pg-boss: job chỉ thành hình khi transaction commit. */
  async function schedule(t: RunTimer, at: Date, tx?: Tx): Promise<void> {
    if (deps.jobs) {
      await deps.jobs.enqueue(RUNS_TIMER_QUEUE, t, { startAfter: at, tx });
      return;
    }
    if (stopped) return;
    const h = setTimeout(
      () => {
        timers.delete(h);
        background(fire(t), `Hẹn giờ ${t.kind} của run ${t.runId} lỗi`);
      },
      Math.max(0, at.getTime() - Date.now()),
    );
    h.unref();
    timers.add(h);
  }

  /**
   * Gom NOTIFY cho log: worker có thể gửi nhiều đoạn log mỗi giây, mà NOTIFY lấy khoá toàn cục lúc commit
   * (docs/architecture.md mục 9). Mỗi run nhiều nhất một NOTIFY mỗi 200 ms.
   */
  function notifyLater(runId: string) {
    if (pendingNotify.has(runId) || stopped) return;
    const h = setTimeout(() => {
      pendingNotify.delete(runId);
      background(deps.pool.query("select pg_notify($1, $2)", [RUNS_CHANNEL, runId]), "Không NOTIFY được log");
    }, 200);
    h.unref();
    pendingNotify.set(runId, h);
  }

  // ---- Giao job ----------------------------------------------------------------------------------------------

  /**
   * Máy online, nối vào tiến trình này, có CLI phù hợp, chưa từ chối lần thử này và còn slot. `contended`: có máy phù
   * hợp bị bỏ qua chỉ vì giao dịch giao run khác đang giữ khoá của nó, nên chưa biết máy đó còn slot hay không.
   */
  async function pickMachine(tx: Tx, run: RunRow, sandboxed: boolean, policy: Policy) {
    const online = await listOnlineMachines(tx, run.teamId, sandboxed ? "host" : "worker");
    const candidates = online.filter(
      (m) =>
        usableBy(m, run, sandboxed) &&
        machineSlots(policy, m.capacity) > 0 &&
        connected(m.id) &&
        !run.rejectedBy.includes(m.id) &&
        (!run.pinnedMachineId || m.id === run.pinnedMachineId) &&
        (!CAPABILITY_KINDS.includes(run.kind) || m.capabilities.includes(run.kind)) &&
        (run.cli
          ? m.clis.includes(run.cli)
          : SUBMIT_KINDS.includes(run.kind)
            ? m.clis.some((c) => SUBMIT_CLIS.includes(c))
            : m.clis.length > 0),
    );
    let contended = false;
    for (const m of candidates) {
      // Khoá theo máy tới hết transaction để hai run không cùng lấy slot cuối của một máy. Thử khoá (không chờ):
      // máy đang được giao run khác thì xét máy kế tiếp, không xếp hàng chờ.
      const res = await tx.execute<{ locked: boolean }>(
        sql`select pg_try_advisory_xact_lock(hashtextextended(${`runs:machine:${m.id}`}, 0)) as locked`,
      );
      if (!res.rows[0]?.locked) {
        contended = true;
        continue;
      }
      const [busy] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(runs)
        .where(
          or(
            and(eq(runs.machineId, m.id), inArray(runs.state, [...ON_MACHINE])),
            and(eq(runs.offerMachineId, m.id), eq(runs.state, "queued"), gt(runs.offerExpiresAt, new Date())),
          ),
        );
      if ((busy?.n ?? 0) < machineSlots(policy, m.capacity)) return { machine: m, contended };
    }
    return { machine: null, contended };
  }

  /**
   * Thử giao lại sau khi giao dịch đang giữ khoá máy commit (thường vài chục ms). Không thử thì run nằm queued tới
   * heartbeat kế tiếp dù máy còn slot: hai run được giao cùng lúc, run sau chờ tới 30 giây.
   */
  const CONTENDED_RETRIES = 5;
  function dispatchLater(orgId: string, runId: string, retry: number) {
    if (stopped || retry > CONTENDED_RETRIES) return;
    const h = setTimeout(() => {
      timers.delete(h);
      background(dispatch(orgId, runId, retry), "Không giao được run");
    }, 50 * retry);
    h.unref();
    timers.add(h);
  }

  /** Đề nghị run `queued` cho một máy. Không có máy phù hợp thì giữ queued; máy rảnh ra sẽ gọi lại. */
  async function dispatch(orgId: string, runId: string, retry = 0): Promise<boolean> {
    const offer = await tenant(orgId, async (tx) => {
      const run = await lockRun(tx, runId);
      if (run?.state !== "queued") return null;
      if (run.offerMachineId && run.offerExpiresAt && run.offerExpiresAt > new Date()) return null;
      const task = PROMPT_KINDS.includes(run.kind) ? null : run.taskId ? await loadTask(tx, run.taskId) : null;
      const project = await loadProject(tx, run.projectId);
      if ((!task && !PROMPT_KINDS.includes(run.kind)) || !project) return null;
      const policy = await loadPolicy(tx);
      // Tổ chức chạm trần chi phí ngày: run chờ tới ngày sau (UTC); heartbeat của máy sẽ gọi giao lại.
      const dailyCap = policy.limits.dailyUsd;
      if (dailyCap !== null && (await orgSpentTodayUsd(tx)) >= dailyCap) {
        await noteOnce(tx, run, "policy_daily_cap", {
          message: `Tổ chức đã dùng hết trần ${dailyCap} USD của hôm nay; run chờ tới ngày sau (UTC).`,
        });
        return null;
      }
      const sandboxed = sandboxedRun(project, policy, run.kind);
      const { machine, contended } = await pickMachine(tx, run, sandboxed, policy);
      if (!machine && contended) return "contended" as const;
      if (!machine) {
        if (!sandboxed) {
          await noteOnce(tx, run, "waiting_machine", {
            message: run.ownerUserId
              ? "Chờ máy của người giao việc hoặc máy dùng chung của đội online; máy cá nhân của người khác không chạy run này."
              : "Run của đội chỉ chạy trên máy dùng chung; đội chưa có máy dùng chung nào sẵn sàng. Quản trị đội bật Dùng chung cho một máy ở trang Máy.",
          });
        }
        return null;
      }
      // Run plan làm cho run code cha: chỉ dẫn đã gửi cho run cha (vd. bình luận nhắc bot) cũng là yêu cầu của kế hoạch.
      const instructions = [
        ...(run.kind === "plan" && run.parentRunId ? await instructionsOf(tx, run.parentRunId) : []),
        ...(await instructionsOf(tx, run.id)),
      ];
      const sandbox = sandboxed ? await loadSandboxJobConfig(tx, project.id) : undefined;
      const budget = jobBudget(
        clampBudget(policy, project.settings.budget),
        task ? await taskSpentUsd(tx, task.id) : 0,
      );
      // Run review, plan, leader là run chỉ đọc: server ngoài (vd. GitHub) có tool ghi mà chế độ chỉ đọc của CLI không
      // chặn hết, nên chỉ run code nhận.
      const mcpServers = run.kind === "code" ? await mcpServersForProject(tx, project.id) : [];
      const [parent] = run.parentRunId
        ? await tx.select({ prUrl: runs.prUrl }).from(runs).where(eq(runs.id, run.parentRunId))
        : [];
      const approvedPlan = run.kind === "code" ? await approvedPlanOf(tx, run.id) : null;
      const latest = run.kind === "plan" && task ? await latestPlanOf(tx, task.id) : null;
      const [leaderContext] = PROMPT_KINDS.includes(run.kind)
        ? await tx
            .select({ prompt: runEvents.data })
            .from(runEvents)
            .where(and(eq(runEvents.runId, run.id), eq(runEvents.type, promptEvent(run.kind))))
            .orderBy(desc(runEvents.id))
            .limit(1)
        : [];
      const expiresAt = new Date(Date.now() + offerTtlSec * 1000);
      await tx
        .update(runs)
        .set({ offerMachineId: machine.id, offerExpiresAt: expiresAt, updatedAt: sql`now()` })
        .where(eq(runs.id, run.id));
      const cli =
        run.cli ??
        (SUBMIT_KINDS.includes(run.kind) ? machine.clis.find((c) => SUBMIT_CLIS.includes(c)) : machine.clis[0]) ??
        "claude";
      // Ghi CLI thực giao: run không chọn CLI thì chỉ sự kiện này biết agent nào chạy (costs.summary nhóm theo CLI).
      await hubEvent(tx, run, "offer", { machineId: machine.id, machine: machine.name, cli });
      const requested =
        run.model ??
        project.settings.models?.[cli as "claude" | "codex" | "gemini"]?.[
          run.kind === "doccheck" || run.kind === "docassist" ? "review" : run.kind
        ] ??
        null;
      const model = resolveModel(policy, cli, requested);
      const permission = resolvePermission(policy, project.settings.runPermissions?.mode ?? "workspace");
      for (const notice of [model.notice, permission.notice]) {
        if (notice) await noteOnce(tx, run, "policy", { message: notice });
      }
      const jobPolicy = jobPolicyOf(policy);
      // Bản chụp chính sách đã áp cho lần thử này (FR-006): đổi chính sách sau đó không làm đổi run đã giao.
      await tx
        .update(runs)
        .set({
          agentPolicySnapshot: {
            model: model.model,
            requestedModel: requested,
            runPermissions: permission.mode,
            sandbox: sandboxed,
            budget: budget ?? null,
            ...jobPolicy,
          },
        })
        .where(eq(runs.id, run.id));
      await notifyRun(tx, run.id);
      await schedule({ kind: "offer", orgId, runId, attempt: run.attempt, machineId: machine.id }, expiresAt, tx);
      return {
        machineId: machine.id,
        msg: {
          type: "job_offer",
          runId: run.id,
          attempt: run.attempt,
          ttl: offerTtlSec,
          spec: buildSpec(run, task, project, cli, {
            instructions,
            budget,
            model: model.model,
            runPermissions: permission.mode,
            policy: jobPolicy,
            parentPrUrl: parent?.prUrl ?? null,
            approvedPlan,
            rejectedPlan: latest?.status === "rejected" ? latest : null,
            sandbox,
            leaderPrompt: typeof leaderContext?.prompt.prompt === "string" ? leaderContext.prompt.prompt : null,
            mcpServers,
          }),
        } satisfies OutgoingMessage,
      };
    });
    if (offer === "contended") {
      dispatchLater(orgId, runId, retry + 1);
      return false;
    }
    if (!offer) return false;
    // Máy vừa rớt kết nối: hẹn giờ hết hạn đề nghị sẽ chuyển sang máy khác.
    if (!send(offer.machineId, offer.msg)) log.warn(`Không gửi được job_offer tới máy ${offer.machineId}`);
    return true;
  }

  /** Giao các run đang chờ của đội, cũ trước. Gọi khi máy vừa nối, vừa heartbeat hoặc vừa xong một run. */
  async function dispatchTeam(orgId: string, teamId: string): Promise<void> {
    const queued = await tenant(orgId, (tx) =>
      tx
        .select({ id: runs.id })
        .from(runs)
        .where(and(eq(runs.teamId, teamId), eq(runs.state, "queued")))
        .orderBy(asc(runs.createdAt))
        .limit(20),
    );
    for (const { id } of queued) await dispatch(orgId, id);
  }

  // ---- Gói của worker ----------------------------------------------------------------------------------------

  async function onAccept(machine: AuthedMachine, msg: Extract<RunMessage, { type: "job_accept" }>) {
    const out = await tenant(machine.orgId, async (tx) => {
      const run = await lockRun(tx, msg.runId);
      if (!run || run.attempt !== msg.attempt) return null;
      // job_accept gửi lại (worker nối lại trước khi nhận gói lease): gửi lại lease đang giữ.
      if (run.machineId === machine.id && ON_MACHINE.includes(run.state) && run.state !== "cancelling") {
        const [lease] = await tx.select().from(runLeases).where(eq(runLeases.runId, run.id));
        return lease ? { run, lease } : null;
      }
      if (run.state !== "queued" || run.offerMachineId !== machine.id) return null;
      if (await machineIsPaused(tx, machine.id)) {
        await tx
          .update(runs)
          .set({ offerMachineId: null, offerExpiresAt: null, updatedAt: sql`now()` })
          .where(eq(runs.id, run.id));
        await notifyRun(tx, run.id);
        return null;
      }
      await tx.delete(runLeases).where(eq(runLeases.runId, run.id));
      const expiresAt = new Date(Date.now() + leaseSec * 1000);
      const [lease] = await tx
        .insert(runLeases)
        .values({
          orgId: run.orgId,
          teamId: run.teamId,
          runId: run.id,
          attempt: run.attempt,
          machineId: machine.id,
          expiresAt,
        })
        .returning();
      if (!lease) throw new Error("Không ghi được lease.");
      const leased = await transition(
        tx,
        run,
        "leased",
        { machineId: machine.id, offerMachineId: null, offerExpiresAt: null, startedAt: run.startedAt ?? new Date() },
        { machineId: machine.id, leaseId: lease.id },
      );
      // Task của run review đã ở running theo run cha đang kiểm kết quả. Run plan là agent bắt đầu làm task.
      if (run.kind !== "review" && run.kind !== "leader" && run.taskId) await setTaskStatus(tx, run.taskId, "running");
      await schedule({ kind: "lease", orgId: run.orgId, runId: run.id, leaseId: lease.id }, expiresAt, tx);
      return { run: leased, lease };
    });
    if (!out) {
      // Máy đã tạm dừng hoặc đề nghị đã hết hạn: bảo worker không chạy offer cũ.
      send(machine.id, { type: "cancel", runId: msg.runId, graceSec: 0 });
      background(dispatchTeam(machine.orgId, machine.teamId), "Không giao được run sau khi máy từ chối offer");
      return;
    }
    const { token } = signRunToken(tokenKey, deps.publicUrl, {
      runId: out.run.id,
      taskId: out.run.taskId ?? out.run.id,
      orgId: out.run.orgId,
      attempt: out.run.attempt,
      ttlSec: out.run.timeoutSec,
    });
    send(machine.id, {
      type: "lease",
      runId: out.run.id,
      attempt: out.run.attempt,
      leaseId: out.lease.id,
      expiresAt: out.lease.expiresAt.toISOString(),
      runToken: token,
    });
  }

  async function onReject(machine: AuthedMachine, msg: Extract<RunMessage, { type: "job_reject" }>) {
    const moved = await tenant(machine.orgId, async (tx) => {
      const run = await lockRun(tx, msg.runId);
      if (run?.state !== "queued" || run.attempt !== msg.attempt || run.offerMachineId !== machine.id) {
        return false;
      }
      await tx
        .update(runs)
        .set({
          rejectedBy: [...run.rejectedBy, machine.id],
          offerMachineId: null,
          offerExpiresAt: null,
          updatedAt: sql`now()`,
        })
        .where(eq(runs.id, run.id));
      await hubEvent(tx, run, "offer_rejected", { machineId: machine.id, reason: msg.reason });
      await notifyRun(tx, run.id);
      return true;
    });
    if (moved) await dispatch(machine.orgId, msg.runId);
  }

  /**
   * Run nhận gói của máy này ở lần thử này. Gói của attempt cũ (worker treo rồi sống lại sau khi run đã giao lại)
   * hoặc của máy khác bị bỏ, để không ghi đè run đang chạy ở nơi khác (fencing, mục 4.1).
   */
  async function fenced(tx: Tx, machine: AuthedMachine, runId: string, attempt: number): Promise<RunRow | null> {
    const run = await lockRun(tx, runId);
    if (!run || run.attempt !== attempt || run.machineId !== machine.id || !ON_MACHINE.includes(run.state)) return null;
    return run;
  }

  async function onRunEvent(machine: AuthedMachine, msg: Extract<RunMessage, { type: "run_event" }>) {
    const accepted = await tenant(machine.orgId, async (tx) => {
      const run = await fenced(tx, machine, msg.runId, msg.attempt);
      if (!run) return false;
      const inserted = await tx
        .insert(runEvents)
        .values({
          orgId: run.orgId,
          runId: run.id,
          attempt: run.attempt,
          seq: msg.seq,
          type: msg.event,
          data: msg.data,
        })
        .onConflictDoNothing()
        .returning({ id: runEvents.id });
      const [event] = inserted;
      if (!event) return true;
      if (msg.event === "cost") {
        const cost = parseCostData(msg.data);
        if (cost) await applyCost(tx, run, event.id, cost);
        else log.warn(`Bỏ sự kiện cost sai dạng: run ${run.id}, seq ${msg.seq}`);
      }
      if (msg.event === "steer_result") await onSteerResult(tx, run, msg.data);
      const to = msg.event === "phase" ? PHASE_STATE[String(msg.data.phase)] : undefined;
      const forward =
        (to === "preparing" && run.state === "leased") ||
        (to === "running" && (run.state === "leased" || run.state === "preparing"));
      if (to && forward) await transition(tx, run, to);
      else await notifyRun(tx, run.id);
      return true;
    });
    if (!accepted) log.warn(`Bỏ run_event của lần thử cũ hoặc máy lạ: run ${msg.runId}, attempt ${msg.attempt}`);
    // Vẫn ack gói bị bỏ, để worker xoá khỏi bộ đệm thay vì gửi lại mãi.
    send(machine.id, { type: "ack", runId: msg.runId, uptoSeq: msg.seq });
  }

  /**
   * Worker báo chỉ dẫn đã vào agent hay chưa. Sự kiện `steer_result` đã nằm trong run_events (web ghép theo `steerId`);
   * ở đây chỉ ghi audit, với chỉ dẫn thật của run này để máy không ghi audit cho id bịa.
   */
  async function onSteerResult(tx: Tx, run: RunRow, data: Record<string, unknown>) {
    const parsed = steerResultData.safeParse(data);
    const steerId = parsed.success && /^\d{1,18}$/.test(parsed.data.steerId) ? Number(parsed.data.steerId) : null;
    const [steer] = steerId
      ? await tx
          .select({ id: runEvents.id })
          .from(runEvents)
          .where(and(eq(runEvents.id, steerId), eq(runEvents.runId, run.id), eq(runEvents.type, "steer")))
      : [];
    if (!parsed.success || !steer) {
      log.warn(`Bỏ sự kiện steer_result sai dạng hoặc không khớp chỉ dẫn nào: run ${run.id}`);
      return;
    }
    await recordAudit(tx, {
      action: parsed.data.applied ? "run.steer_applied" : "run.steer_not_applied",
      actorUserId: null,
      targetType: "run",
      targetId: run.id,
      data: { steerId: steer.id, attempt: run.attempt, ...(parsed.data.reason ? { reason: parsed.data.reason } : {}) },
    });
  }

  async function onLogChunk(machine: AuthedMachine, msg: Extract<RunMessage, { type: "log_chunk" }>) {
    const inserted = await tenant(machine.orgId, async (tx) => {
      const run = await fenced(tx, machine, msg.runId, msg.attempt);
      if (!run) return false;
      const rows = await tx
        .insert(runLogs)
        .values({
          orgId: run.orgId,
          runId: run.id,
          attempt: run.attempt,
          seq: msg.seq,
          offset: msg.offset,
          data: Buffer.from(msg.bytes, "base64"),
        })
        .onConflictDoNothing()
        .returning({ id: runLogs.id });
      return rows.length > 0;
    });
    if (inserted) notifyLater(msg.runId);
    send(machine.id, { type: "ack", runId: msg.runId, uptoSeq: msg.seq });
  }

  async function onRunResult(machine: AuthedMachine, msg: Extract<RunMessage, { type: "run_result" }>) {
    let cancelledRun: RunRow | null = null;
    const next = await tenant(machine.orgId, async (tx) => {
      const run = await lockRun(tx, msg.runId);
      if (!run || run.attempt !== msg.attempt || run.machineId !== machine.id) return null;
      const inserted = await tx
        .insert(runEvents)
        .values({
          orgId: run.orgId,
          runId: run.id,
          attempt: run.attempt,
          seq: msg.seq,
          type: "result",
          data: { exit: msg.exit, headSha: msg.headSha, report: msg.report, diffStats: msg.diffStats },
        })
        .onConflictDoNothing()
        .returning({ id: runEvents.id });
      // Gói gửi lại, hoặc run đã kết thúc theo đường khác (hết lease): chỉ ack.
      if (inserted.length === 0 || !ON_MACHINE.includes(run.state)) return null;
      // Agent đã xong: máy không cần giữ lease nữa, slot trống cho run khác.
      await tx.delete(runLeases).where(eq(runLeases.runId, run.id));
      if (run.state === "cancelling") {
        cancelledRun = await finishCancelled(tx, run, {});
        return "cancelled" as const;
      }
      await transition(tx, run, "verifying", { headSha: msg.headSha }, { exit: msg.exit });
      // Hub chết giữa verifying thì hẹn giờ này chạy lại; verify bỏ qua run không còn ở verifying.
      await schedule(
        { kind: "verify", orgId: run.orgId, runId: run.id },
        new Date(Date.now() + verifyRetrySec * 1000),
        tx,
      );
      return "verify" as const;
    });
    send(machine.id, { type: "ack", runId: msg.runId, uptoSeq: msg.seq });
    if (next === "verify") background(verify(machine.orgId, msg.runId), `verifying run ${msg.runId} lỗi`);
    if (next === "cancelled" && cancelledRun) verifyParent(cancelledRun);
    if (next) background(dispatchTeam(machine.orgId, machine.teamId), "Không giao được run đang chờ");
  }

  const handlers: Required<RunHandlers> = {
    async onHello(machine) {
      try {
        await dispatchTeam(machine.orgId, machine.teamId);
      } catch (e) {
        log.error("Không giao được run khi máy nối", e);
      }
    },

    async onHeartbeat(machine, msg) {
      const result = await tenant(machine.orgId, async (tx) => {
        const renewed: string[] = [];
        const cancel: string[] = [];
        const expiresAt = new Date(Date.now() + leaseSec * 1000);
        for (const r of msg.runs) {
          if (!UUID.test(r.leaseId) || !UUID.test(r.runId)) {
            cancel.push(r.runId);
            continue;
          }
          const [row] = await tx
            .select({ leaseAttempt: runLeases.attempt, state: runs.state, attempt: runs.attempt })
            .from(runLeases)
            .innerJoin(runs, eq(runs.id, runLeases.runId))
            .where(and(eq(runLeases.id, r.leaseId), eq(runLeases.runId, r.runId), eq(runLeases.machineId, machine.id)));
          const live =
            row && row.attempt === r.attempt && row.leaseAttempt === r.attempt && ON_MACHINE.includes(row.state);
          // Run đang huỷ không được gia hạn: hết lease là hạn cứng của lệnh huỷ.
          if (!live || row.state === "cancelling") {
            cancel.push(r.runId);
            continue;
          }
          await tx.update(runLeases).set({ expiresAt }).where(eq(runLeases.id, r.leaseId));
          renewed.push(r.leaseId);
        }
        return { renewed, cancel };
      });
      background(dispatchTeam(machine.orgId, machine.teamId), "Không giao được run đang chờ");
      return result;
    },

    async onMessage(machine, msg) {
      if (!UUID.test(msg.runId)) return;
      switch (msg.type) {
        case "job_accept":
          return onAccept(machine, msg);
        case "job_reject":
          return onReject(machine, msg);
        case "run_event":
          return onRunEvent(machine, msg);
        case "log_chunk":
          return onLogChunk(machine, msg);
        case "run_result":
          return onRunResult(machine, msg);
      }
    },
  };

  // ---- verifying ---------------------------------------------------------------------------------------------

  /**
   * Chạy chính sách kết quả của run đang verifying. Gọi ra nhà cung cấp Git ngoài transaction. Run code đang
   * `planning` thì kết luận theo run plan con (cùng hẹn giờ, như run cha chờ run review).
   */
  async function verify(orgId: string, runId: string): Promise<void> {
    const run = await tenant(orgId, async (tx) => {
      const [row] = await tx.select({ kind: runs.kind, state: runs.state }).from(runs).where(eq(runs.id, runId));
      return row ?? null;
    });
    if (run?.kind === "code" && run.state === "planning") return settlePlanning(orgId, runId);
    if (run?.state !== "verifying") return;
    if (run.kind === "code") await verifyCode(orgId, runId);
    else if (run.kind === "review") await verifyReview(orgId, runId);
    else if (run.kind === "plan") await verifyPlan(orgId, runId);
    else if (run.kind === "doccheck") await verifyDocCheck(orgId, runId);
    else if (run.kind === "docassist") await verifyDocAssist(orgId, runId);
    else await verifyLeader(orgId, runId);
  }

  /** Phiên duyệt mà run doccheck kiểm, ghi trong sự kiện lời nhắc lúc tạo run. */
  async function docCheckInstance(tx: Tx, runId: string): Promise<string | null> {
    const [ev] = await tx
      .select({ data: runEvents.data })
      .from(runEvents)
      .where(and(eq(runEvents.runId, runId), eq(runEvents.type, "doccheck_prompt")))
      .limit(1);
    return typeof ev?.data.instanceId === "string" ? ev.data.instanceId : null;
  }

  /** Chuyển kết quả (hoặc lỗi) của run doccheck cho gate AI của phiên duyệt, trong cùng transaction. */
  async function docCheckDone(
    tx: Tx,
    run: RunRow,
    result: { score: number; checklist: ChecklistItem[]; summary: string } | null,
    error: string | null,
  ): Promise<void> {
    const instanceId = await docCheckInstance(tx, run.id);
    if (!instanceId) return;
    await applyAiResult(
      tx,
      {
        kind: "ai-result",
        orgId: run.orgId,
        instanceId,
        runId: run.id,
        score: result?.score ?? null,
        checklist: result?.checklist ?? [],
        summary: result?.summary ?? null,
        error,
      },
      { jobs: deps.jobs, publicUrl: deps.publicUrl },
    );
  }

  /** Run doccheck: succeeded khi agent đã gọi doc_check_submit; kết quả đi tiếp tới gate AI của phiên duyệt. */
  async function verifyDocCheck(orgId: string, runId: string): Promise<void> {
    await tenant(orgId, async (tx) => {
      const run = await lockRun(tx, runId);
      if (run?.kind !== "doccheck" || run.state !== "verifying") return;
      const data = await resultOf(tx, run);
      const [ev] = await tx
        .select({ data: runEvents.data })
        .from(runEvents)
        .where(
          and(eq(runEvents.runId, run.id), eq(runEvents.attempt, run.attempt), eq(runEvents.type, "doccheck_result")),
        )
        .orderBy(desc(runEvents.id))
        .limit(1);
      const ok = exitOf(data) === 0 && Boolean(ev);
      const error = ok
        ? null
        : exitOf(data) === 0
          ? "Agent không nộp kết quả kiểm (doc_check_submit)."
          : "Run kiểm tài liệu lỗi hoặc hết thời gian.";
      await transition(
        tx,
        run,
        ok ? "succeeded" : "failed",
        { finishedAt: new Date() },
        { message: error ?? "Đã kiểm xong tài liệu." },
      );
      await recordAudit(tx, {
        action: "doccheck.run.finish",
        actorUserId: null,
        targetType: "run",
        targetId: run.id,
        data: { succeeded: ok },
      });
      await docCheckDone(
        tx,
        run,
        ok ? (ev?.data as { score: number; checklist: ChecklistItem[]; summary: string }) : null,
        error,
      );
    });
  }

  /** Run docassist: xong khi CLI thoát êm; đề xuất và bình luận agent để lại đã nằm trên bản nháp. */
  async function verifyDocAssist(orgId: string, runId: string): Promise<void> {
    await tenant(orgId, async (tx) => {
      const run = await lockRun(tx, runId);
      if (run?.kind !== "docassist" || run.state !== "verifying") return;
      const ok = exitOf(await resultOf(tx, run)) === 0;
      await transition(
        tx,
        run,
        ok ? "succeeded" : "failed",
        { finishedAt: new Date() },
        { message: ok ? "Trợ lý đã góp ý xong." : "Run trợ lý tài liệu lỗi hoặc hết thời gian." },
      );
    });
  }

  async function verifyLeader(orgId: string, runId: string): Promise<void> {
    const afterCommit = await tenant(orgId, async (tx) => {
      const run = await lockRun(tx, runId);
      if (run?.kind !== "leader" || run.state !== "verifying" || !run.leaderThreadId) return null;
      const data = await resultOf(tx, run);
      const [reply] = await tx
        .select({ id: runEvents.id })
        .from(runEvents)
        .where(and(eq(runEvents.runId, run.id), eq(runEvents.attempt, run.attempt), eq(runEvents.type, "leader_reply")))
        .limit(1);
      const succeeded = exitOf(data) === 0 && Boolean(reply);
      const message = succeeded
        ? "Leader đã hoàn tất lượt trả lời."
        : exitOf(data) === 0
          ? "Leader chưa gửi câu trả lời vào cuộc trò chuyện. Hãy thử gửi lại tin nhắn."
          : "Leader run gặp lỗi hoặc hết thời gian. Hãy thử gửi lại tin nhắn.";
      await transition(tx, run, succeeded ? "succeeded" : "failed", { finishedAt: new Date() }, { message });
      await recordAudit(tx, {
        action: "leader.run.finish",
        actorUserId: null,
        targetType: "run",
        targetId: run.id,
        data: { succeeded, threadId: run.leaderThreadId },
      });
      if (!succeeded) {
        await deps.leaderMessage?.(tx, run.leaderThreadId, message);
      }
      const queued = await deps.leaderQueuedPrompt?.(tx, run.leaderThreadId, run.createdAt);
      if (!queued) return undefined;
      const next = await startLeaderRun(tx, queued.userId, {
        threadId: run.leaderThreadId,
        projectId: queued.projectId,
        prompt: queued.prompt,
      });
      return next.afterCommit;
    });
    afterCommit?.();
  }

  /**
   * Run code: mở PR khi thành công. Chính sách có kiểm tra `review` và dự án bật review chéo thì chưa kết luận: mở PR,
   * tạo run review cho CLI `by`, giữ run ở verifying tới khi run review xong rồi chạy lại chính sách với điểm review.
   */
  async function verifyCode(orgId: string, runId: string): Promise<void> {
    const ctx = await tenant(orgId, async (tx) => {
      const [run] = await tx.select().from(runs).where(eq(runs.id, runId));
      if (run?.state !== "verifying") return null;
      const data = await resultOf(tx, run);
      const [report] = await tx
        .select({ id: runEvents.id })
        .from(runEvents)
        .where(and(eq(runEvents.runId, run.id), eq(runEvents.attempt, run.attempt), eq(runEvents.type, "agent_report")))
        .limit(1);
      const project = await loadProject(tx, run.projectId);
      const task = run.taskId ? await loadTask(tx, run.taskId) : null;
      const conn = project && deps.masterKey ? await loadConnection(tx, deps.masterKey, project.scmConnectionId) : null;
      // Đọc cờ lúc verify thay vì lúc giao: dự án tắt review chéo giữa chừng thì run đang chờ không tạo run review nữa.
      const stats = diffStats.safeParse(data.diffStats);
      const reviewCheck = project?.settings.features.crossReview
        ? reviewCheckOf(run.policySnapshot, stats.success ? stats.data : undefined)
        : undefined;
      const child = reviewCheck ? await childRunOf(tx, run.id, "review") : null;
      const childReport = child?.state === "succeeded" ? await reviewReportOf(tx, child) : null;
      return {
        run,
        data,
        hasAgentReport: Boolean(report),
        project,
        task,
        conn,
        reviewCheck,
        child,
        childReport,
        diffStats: stats.success ? stats.data : undefined,
      };
    });
    if (!ctx) return;
    const { run, data, project, task, reviewCheck, child } = ctx;
    if (child && !TERMINAL_RUN_STATES.includes(child.state)) {
      // Run review còn chạy: không kết luận. Run review xong sẽ gọi lại verify; hẹn lại ở đây chỉ là lưới an toàn khi
      // hub chết đúng lúc run review kết thúc.
      await schedule({ kind: "verify", orgId, runId }, new Date(Date.now() + verifyRetrySec * 1000));
      return;
    }
    let review: ReviewEvidence | undefined;
    if (reviewCheck) review = child ? reviewEvidence(child, ctx.childReport) : { status: "pending" };
    const report = (data.report ?? null) as Record<string, unknown> | null;
    const ev = evaluatePolicy(run.policySnapshot, {
      exit: exitOf(data) ?? 1,
      headSha: typeof data.headSha === "string" ? data.headSha : null,
      report,
      hasAgentReport: ctx.hasAgentReport,
      review,
      diffStats: ctx.diffStats,
    });
    let outcome = ev.outcome;
    let checks = ev.checks;
    let reasons = [...ev.reasons];
    let awaitingReview = ev.awaitingReview;
    // Lần chạy lại sau review: PR đã mở từ lần trước, số PR lấy lại từ URL để vẫn vào được hàng merge.
    let prUrl = run.prUrl;
    let prNumber = prNumberOf(prUrl);
    if ((outcome === "succeeded" || awaitingReview) && ev.hasChanges && !prUrl) {
      try {
        if (!project || !task) throw new Error("Dự án hoặc task không còn.");
        if (!ctx.conn) throw new Error("Hub chưa cấu hình HIVE_MASTER_KEY hoặc dự án mất kết nối Git.");
        const pr = await deps.providerFactory(ctx.conn).openPR(
          { owner: project.repoOwner, name: project.repoName },
          {
            head: run.branch,
            base: project.defaultBranch ?? "main",
            title: `${task.key}: ${task.title}`,
            body: prBody(task, run, checks),
          },
        );
        prUrl = pr.url;
        prNumber = pr.number;
      } catch (e) {
        // Lỗi tạm thời: để run ở verifying, hẹn giờ verify sẽ thử lại.
        if (isGitProviderError(e) && e.retryable) throw e;
        outcome = "needs_review";
        reasons.push(`Không mở được PR: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (awaitingReview && !prUrl) {
      // Review chéo đọc diff của PR; không có PR thì để người xem.
      awaitingReview = false;
      outcome = "needs_review";
      checks = checks.map((c) =>
        c.check === "review" && c.passed === null && !c.skipped
          ? { ...c, message: "Không có PR để review chéo; cần người xem." }
          : c,
      );
      reasons = [
        ...checks.filter((c) => !c.skipped && c.passed !== true).map((c) => c.message),
        ...reasons.slice(ev.reasons.length),
      ];
    }
    const result: RunResult = {
      exit: exitOf(data),
      commitCount: ev.commitCount,
      changedFiles: ev.changedFiles,
      checks,
      reasons,
      report,
    };
    const after = await tenant(orgId, async (tx) => {
      const locked = await lockRun(tx, runId);
      if (locked?.state !== "verifying") return null;
      if (awaitingReview && reviewCheck) {
        // Lần verify khác chạy chồng đã tạo run review.
        if (await childRunOf(tx, locked.id, "review")) return null;
        const child = await createReviewRun(tx, locked, reviewCheck.by);
        // Ghi kết quả tạm để người xem thấy run đang chờ review nào; trạng thái giữ verifying.
        await tx.update(runs).set({ prUrl, result, updatedAt: sql`now()` }).where(eq(runs.id, locked.id));
        await hubEvent(tx, locked, "review_requested", { reviewRunId: child.id, by: reviewCheck.by, prUrl });
        await notifyRun(tx, locked.id);
        return () => background(dispatch(orgId, child.id), "Không giao được run review");
      }
      await transition(tx, locked, outcome, { result, prUrl, finishedAt: new Date() }, { reasons, prUrl });
      if (locked.taskId) await setTaskStatus(tx, locked.taskId, taskStatusFor(outcome, prUrl));
      // Chế độ auto: PR của run đạt chính sách vào thẳng hàng merge, cùng transaction để không có run succeeded mà
      // PR bị bỏ quên ngoài hàng. Chế độ review chờ người đưa vào hàng.
      if (
        outcome === "succeeded" &&
        prNumber !== null &&
        project?.settings.merge.mode === "auto" &&
        project.settings.features.mergeQueue
      ) {
        await enqueueMerge(
          tx,
          {
            projectId: locked.projectId,
            prNumber,
            prUrl,
            branch: locked.branch,
            runId: locked.id,
            taskId: locked.taskId,
            by: locked.createdBy,
          },
          { jobs: deps.jobs },
        ).catch((e: unknown) => {
          // Vừa tắt merge queue sau lúc đọc dự án: run vẫn xong, PR chờ người như chế độ review.
          if (!(e instanceof BadRequestError)) throw e;
        });
      }
      await recordAudit(tx, {
        action: "run.finish",
        actorUserId: null,
        targetType: "run",
        targetId: locked.id,
        data: { outcome, prUrl, taskId: locked.taskId, checks },
      });
      await notifyOutcome(tx, locked, task, outcome, reasons, prUrl);
      return null;
    });
    after?.();
  }

  /**
   * Run review con của run code: cùng task, cùng nhánh, CLI là `by` của kiểm tra review (trùng CLI của run cha vẫn
   * cho, để dự án chỉ có một loại CLI vẫn dùng được). Chính sách cố định nên policy_snapshot rỗng.
   */
  async function createReviewRun(tx: Tx, parent: RunRow, by: ReviewCheck["by"]): Promise<RunRow> {
    const [row] = await tx
      .insert(runs)
      .values({
        orgId: parent.orgId,
        teamId: parent.teamId,
        taskId: parent.taskId,
        projectId: parent.projectId,
        kind: "review",
        parentRunId: parent.id,
        cli: by,
        branch: parent.branch,
        policySnapshot: [],
        timeoutSec: parent.timeoutSec,
        createdBy: parent.createdBy,
        ownerUserId: parent.ownerUserId,
      })
      .returning();
    if (!row) throw new Error("Không ghi được run review.");
    await hubEvent(tx, row, "state", { from: null, to: "queued", by: "review", parentRunId: parent.id });
    await notifyRun(tx, row.id);
    await recordAudit(tx, {
      action: "run.start",
      actorUserId: null,
      targetType: "run",
      targetId: row.id,
      data: { taskId: row.taskId, cli: by, kind: "review", parentRunId: parent.id },
    });
    return row;
  }

  /**
   * Run review: succeeded khi agent đã gọi review_submit (tương đương `agentReport` trên `review_report`). Xong thì
   * đăng nhận xét lên PR của run cha và chạy lại chính sách của run cha.
   */
  async function verifyReview(orgId: string, runId: string): Promise<void> {
    const ctx = await tenant(orgId, async (tx) => {
      const [run] = await tx.select().from(runs).where(eq(runs.id, runId));
      if (run?.state !== "verifying") return null;
      const data = await resultOf(tx, run);
      const review = await reviewReportOf(tx, run);
      const [parent] = run.parentRunId ? await tx.select().from(runs).where(eq(runs.id, run.parentRunId)) : [];
      const project = await loadProject(tx, run.projectId);
      const conn =
        review && project && deps.masterKey ? await loadConnection(tx, deps.masterKey, project.scmConnectionId) : null;
      return { run, data, review, parent: parent ?? null, project, conn };
    });
    if (!ctx) return;
    const { run, data, review } = ctx;
    const report = (data.report ?? null) as Record<string, unknown> | null;
    const ev = evaluateReviewRun({ exit: exitOf(data) ?? 1, report, score: review?.score ?? null });
    const finished = await tenant(orgId, async (tx) => {
      const locked = await lockRun(tx, runId);
      if (locked?.state !== "verifying") return false;
      const result: RunResult = {
        exit: exitOf(data),
        commitCount: null,
        changedFiles: [],
        checks: ev.checks,
        reasons: ev.reasons,
        report,
      };
      await transition(
        tx,
        locked,
        ev.outcome,
        { result, finishedAt: new Date() },
        { reasons: ev.reasons, score: review?.score ?? null },
      );
      await recordAudit(tx, {
        action: "run.finish",
        actorUserId: null,
        targetType: "run",
        targetId: locked.id,
        data: { outcome: ev.outcome, kind: "review", parentRunId: locked.parentRunId, score: review?.score ?? null },
      });
      await childFinished(tx, locked);
      return true;
    });
    if (!finished) return;
    if (ev.outcome === "succeeded" && review) {
      background(postReview(ctx, review), `Không đăng được review của run ${run.id} lên PR`);
    }
    if (run.parentRunId) background(verify(orgId, run.parentRunId), `verifying run ${run.parentRunId} lỗi`);
  }

  /**
   * Run review hay run plan kết thúc theo bất kỳ đường nào (xong, lỗi, hết lượt, bị huỷ): hẹn chạy lại verify của run
   * cha trong cùng transaction, để hub chết ngay sau commit thì hẹn giờ vẫn kết luận được run cha.
   */
  async function childFinished(tx: Tx, run: RunRow): Promise<void> {
    if (run.kind === "code" || !run.parentRunId) return;
    await schedule({ kind: "verify", orgId: run.orgId, runId: run.parentRunId }, new Date(Date.now() + 1000), tx);
  }

  /**
   * Kết luận run cha ngay sau commit khi run con kết thúc theo đường huỷ hay mất máy; hẹn giờ của childFinished chỉ là
   * đường dự phòng khi hub chết, chờ nó thì run cha treo thêm 1 giây (cộng chu kỳ quét của pg-boss).
   */
  function verifyParent(run: RunRow) {
    if (run.kind === "code" || !run.parentRunId) return;
    background(verify(run.orgId, run.parentRunId), `verifying run ${run.parentRunId} lỗi`);
  }

  /** Run plan: succeeded khi agent đã gọi plan_submit. Xong thì kết luận run code cha (chờ duyệt hay thất bại). */
  async function verifyPlan(orgId: string, runId: string): Promise<void> {
    const ctx = await tenant(orgId, async (tx) => {
      const [run] = await tx.select().from(runs).where(eq(runs.id, runId));
      if (run?.state !== "verifying") return null;
      return { run, data: await resultOf(tx, run), plan: await planReportOf(tx, run) };
    });
    if (!ctx) return;
    const { run, data, plan } = ctx;
    const report = (data.report ?? null) as Record<string, unknown> | null;
    const ev = evaluatePlanRun({ exit: exitOf(data) ?? 1, report, steps: plan?.steps.length ?? null });
    const finished = await tenant(orgId, async (tx) => {
      const locked = await lockRun(tx, runId);
      if (locked?.state !== "verifying") return false;
      const result: RunResult = {
        exit: exitOf(data),
        commitCount: null,
        changedFiles: [],
        checks: ev.checks,
        reasons: ev.reasons,
        report,
      };
      await transition(tx, locked, ev.outcome, { result, finishedAt: new Date() }, { reasons: ev.reasons });
      await recordAudit(tx, {
        action: "run.finish",
        actorUserId: null,
        targetType: "run",
        targetId: locked.id,
        data: { outcome: ev.outcome, kind: "plan", parentRunId: locked.parentRunId },
      });
      await childFinished(tx, locked);
      return true;
    });
    if (finished && run.parentRunId) background(verify(orgId, run.parentRunId), `verifying run ${run.parentRunId} lỗi`);
  }

  /**
   * Run code đang `planning` khi run plan con đã kết thúc: có kế hoạch thì ghi vào bảng plans, chờ duyệt và báo người
   * giao việc; không có (lỗi, hết giờ, hết lượt, bị huỷ, không gọi plan_submit) thì run code thất bại và task về todo
   * như run review lỗi làm run cha thất bại, để task không treo ở planning.
   */
  async function settlePlanning(orgId: string, runId: string): Promise<void> {
    await tenant(orgId, async (tx) => {
      const run = await lockRun(tx, runId);
      if (run?.state !== "planning") return;
      const child = await childRunOf(tx, run.id, "plan");
      // Run plan còn chạy: khi nó kết thúc, childFinished hẹn lại bước này.
      if (child && !TERMINAL_RUN_STATES.includes(child.state)) return;
      const content = child?.state === "succeeded" ? await planReportOf(tx, child) : null;
      if (!run.taskId) return;
      const task = await loadTask(tx, run.taskId);
      if (child && content) {
        const plan = await recordPlan(tx, {
          teamId: run.teamId,
          taskId: run.taskId,
          runId: run.id,
          planRunId: child.id,
          content,
        });
        await transition(tx, run, "awaiting_plan", {}, { planId: plan.id, planRunId: child.id });
        await setTaskStatus(tx, run.taskId, "awaiting_plan");
        await recordAudit(tx, {
          action: "plan.submit",
          actorUserId: null,
          targetType: "plan",
          targetId: plan.id,
          data: { taskId: run.taskId, runId: run.id, planRunId: child.id, revision: plan.revision },
        });
        await notifyPlan(tx, run, task, plan);
        return;
      }
      const why = !child
        ? "không có run lập kế hoạch."
        : child.state === "cancelled"
          ? "run lập kế hoạch đã bị huỷ."
          : (child.result?.reasons[0] ?? `run lập kế hoạch kết thúc ở trạng thái ${child.state}.`);
      const reasons = [`Không lập được kế hoạch: ${why}`];
      await transition(
        tx,
        run,
        "failed",
        {
          finishedAt: new Date(),
          result: { exit: null, commitCount: null, changedFiles: [], checks: [], reasons },
        },
        { reasons, planRunId: child?.id ?? null },
      );
      await setTaskStatus(tx, run.taskId, "todo");
      await recordAudit(tx, {
        action: "run.finish",
        actorUserId: null,
        targetType: "run",
        targetId: run.id,
        data: { outcome: "failed", reasons, planRunId: child?.id ?? null },
      });
      await notifyOutcome(tx, run, task, "failed", reasons, null);
    });
  }

  /** Đăng điểm, tóm tắt và tối đa 20 phát hiện lên PR của run cha. Lỗi chỉ ghi log: kết quả đã nằm trên hub. */
  async function postReview(
    ctx: {
      run: RunRow;
      parent: RunRow | null;
      project: ProjectRow | null;
      conn: Awaited<ReturnType<typeof loadConnection>> | null;
    },
    review: ReviewReport,
  ): Promise<void> {
    const number = prNumberOf(ctx.parent?.prUrl ?? null);
    if (!ctx.parent || !ctx.project || number === null) return;
    if (!ctx.conn) {
      log.warn(`Không đăng được review lên PR của run ${ctx.parent.id}: thiếu khoá chủ hoặc kết nối Git.`);
      return;
    }
    const body = reviewComment(review, {
      by: ctx.run.cli,
      minScore: reviewCheckOf(ctx.parent.policySnapshot)?.minScore ?? null,
    });
    await deps
      .providerFactory(ctx.conn)
      .commentOnIssue({ owner: ctx.project.repoOwner, name: ctx.project.repoName }, number, body, {
        pullRequest: true,
      });
  }

  /** Run kết thúc mà cần người (lỗi, hoặc cần review tay) thì báo nhóm quản trị, cùng transaction với kết quả. */
  async function notifyOutcome(
    tx: Tx,
    run: RunRow,
    task: TaskRow | null,
    outcome: string,
    reasons: string[],
    prUrl: string | null,
  ) {
    if (outcome !== "failed" && outcome !== "needs_review") return;
    const key = task?.key ?? run.taskId;
    const body = [task?.title ?? "", ...reasons.map((r) => `- ${r}`), prUrl ? `PR: ${prUrl}` : ""].filter(Boolean);
    await notify(
      tx,
      {
        orgId: run.orgId,
        event: outcome === "failed" ? "run.failed" : "run.needs_review",
        eventKey: `${run.id}:${run.attempt}:${outcome}`,
        recipientIds: [run.createdBy, ...(task ? [task.createdBy] : [])],
        title: outcome === "failed" ? `Run của ${key} thất bại` : `${key} cần người xem lại`,
        body: body.join("\n"),
        link: taskLink(task),
      },
      { jobs: deps.jobs },
    );
  }

  /**
   * Báo kế hoạch chờ duyệt, cùng transaction với kế hoạch. notify chỉ gửi tới kênh của nhóm quản trị, nên ghi tên người
   * giao việc trong nội dung để kênh biết ai cần duyệt.
   */
  async function notifyPlan(tx: Tx, run: RunRow, task: TaskRow | null, plan: PlanRow) {
    const [who] = await tx
      .select({ name: authUser.name, email: authUser.email })
      .from(authUser)
      .where(eq(authUser.id, run.createdBy));
    const assigner = who ? `${who.name} <${who.email}>` : run.createdBy;
    const key = task?.key ?? run.taskId;
    await notify(
      tx,
      {
        orgId: run.orgId,
        event: "plan.awaiting_approval",
        title: `Kế hoạch của ${key} chờ duyệt`,
        body: [
          task?.title ?? "",
          `Người giao việc: ${assigner}`,
          `Lần lập kế hoạch: ${plan.revision}`,
          "",
          planMarkdown(plan.content),
        ].join("\n"),
        link: taskLink(task),
      },
      { jobs: deps.jobs },
    );
  }

  // ---- Hẹn giờ ---------------------------------------------------------------------------------------------

  async function onOfferTimeout(t: Extract<RunTimer, { kind: "offer" }>) {
    const moved = await tenant(t.orgId, async (tx) => {
      const run = await lockRun(tx, t.runId);
      if (
        run?.state !== "queued" ||
        run.attempt !== t.attempt ||
        run.offerMachineId !== t.machineId ||
        (run.offerExpiresAt && run.offerExpiresAt > new Date())
      ) {
        return false;
      }
      // Máy im lặng được coi như từ chối, để lần sau đề nghị máy khác thay vì hỏi lại máy không trả lời.
      await tx
        .update(runs)
        .set({
          rejectedBy: [...run.rejectedBy, t.machineId],
          offerMachineId: null,
          offerExpiresAt: null,
          updatedAt: sql`now()`,
        })
        .where(eq(runs.id, run.id));
      await hubEvent(tx, run, "offer_expired", { machineId: t.machineId });
      await notifyRun(tx, run.id);
      return true;
    });
    if (moved) await dispatch(t.orgId, t.runId);
  }

  /** Lease hết hạn mà không có heartbeat: run sang lost rồi thử lại nếu còn lượt, hết lượt thì failed. */
  async function onLeaseTimeout(t: Extract<RunTimer, { kind: "lease" }>) {
    const out = await tenant(t.orgId, async (tx) => {
      const run = await lockRun(tx, t.runId);
      const [lease] = await tx.select().from(runLeases).where(eq(runLeases.id, t.leaseId));
      if (!run || !lease) return null;
      if (lease.expiresAt > new Date()) return { recheckAt: lease.expiresAt };
      await tx.delete(runLeases).where(eq(runLeases.id, lease.id));
      if (lease.attempt !== run.attempt || !ON_MACHINE.includes(run.state)) return null;
      if (run.state === "cancelling") {
        await finishCancelled(tx, run, { reason: "Máy không xác nhận lệnh huỷ trước khi hết lease." });
        return null;
      }
      const lost = await transition(tx, run, "lost", {}, { machineId: run.machineId, leaseId: lease.id });
      if (run.attempt < run.maxAttempts) {
        await transition(
          tx,
          lost,
          "queued",
          { attempt: run.attempt + 1, machineId: null, rejectedBy: [], offerMachineId: null, offerExpiresAt: null },
          { retry: run.attempt + 1 },
        );
        if (run.kind !== "review" && run.kind !== "leader" && run.taskId) await setTaskStatus(tx, run.taskId, "queued");
        return { requeued: true };
      }
      const reasons = [`Mất kết nối với máy; đã thử ${run.attempt}/${run.maxAttempts} lần.`];
      await transition(
        tx,
        lost,
        "failed",
        {
          finishedAt: new Date(),
          result: { exit: null, commitCount: null, changedFiles: [], checks: [], reasons },
        },
        { reasons },
      );
      await recordAudit(tx, {
        action: "run.finish",
        actorUserId: null,
        targetType: "run",
        targetId: run.id,
        data: { outcome: "failed", reasons },
      });
      if (run.kind === "code") {
        if (run.taskId) {
          await setTaskStatus(tx, run.taskId, "todo");
          await notifyOutcome(tx, run, await loadTask(tx, run.taskId), "failed", reasons, null);
        }
      } else {
        if (run.kind === "leader" && run.leaderThreadId) {
          await deps.leaderMessage?.(
            tx,
            run.leaderThreadId,
            "Leader run mất kết nối sau nhiều lần thử. Hãy thử gửi lại tin nhắn.",
          );
        }
        if (run.kind === "doccheck") await docCheckDone(tx, run, null, "Máy chạy run kiểm tài liệu mất kết nối.");
        await childFinished(tx, run);
        return { failed: run };
      }
      return null;
    });
    if (out && "recheckAt" in out) await schedule(t, out.recheckAt);
    else if (out && "failed" in out) verifyParent(out.failed);
    else if (out?.requeued) await dispatch(t.orgId, t.runId);
  }

  async function fire(t: RunTimer): Promise<void> {
    if (t.kind === "offer") return onOfferTimeout(t);
    if (t.kind === "lease") return onLeaseTimeout(t);
    return verify(t.orgId, t.runId);
  }

  // ---- Huỷ ---------------------------------------------------------------------------------------------------

  async function finishCancelled(tx: Tx, run: RunRow, data: Record<string, unknown>): Promise<RunRow> {
    await tx.delete(runLeases).where(eq(runLeases.runId, run.id));
    const row = await transition(
      tx,
      run,
      "cancelled",
      { finishedAt: new Date(), offerMachineId: null, offerExpiresAt: null },
      data,
    );
    if (run.kind === "code" && run.taskId) {
      await setTaskStatus(tx, run.taskId, "todo");
      // Huỷ khi kế hoạch còn chờ duyệt: không còn run nào chạy theo kế hoạch đó.
      await supersedePlans(tx, run.id);
    } else if (run.kind === "leader" && run.leaderThreadId) {
      await deps.leaderMessage?.(tx, run.leaderThreadId, "Leader run đã bị huỷ.");
    } else if (run.kind === "doccheck") {
      await docCheckDone(tx, run, null, "Run kiểm tài liệu đã bị huỷ.");
    } else await childFinished(tx, run);
    return row;
  }

  /** Huỷ run đã khoá. Trả việc gửi lệnh huỷ tới máy, làm sau khi commit. */
  async function cancelLocked(tx: Tx, run: RunRow, by: string): Promise<{ row: RunRow; after: () => void }> {
    const noop = () => {};
    if (run.state === "cancelling") return { row: run, after: noop };
    if (run.state === "verifying") {
      throw new ConflictError("RUN_VERIFYING", "Run đang kiểm kết quả, không huỷ được nữa.");
    }
    if (["succeeded", "no_changes", "needs_review", "failed", "cancelled"].includes(run.state)) {
      throw new ConflictError("RUN_FINISHED", "Run đã kết thúc.");
    }
    if (ON_MACHINE.includes(run.state) && run.machineId) {
      const row = await transition(tx, run, "cancelling", {}, { by });
      const machineId = run.machineId;
      return { row, after: () => send(machineId, { type: "cancel", runId: run.id, graceSec }) };
    }
    // Run code đang chờ run plan: huỷ cả run plan, không để agent lập kế hoạch cho run đã huỷ. Khoá run cha rồi mới
    // tới run con, cùng thứ tự với duyệt kế hoạch; run plan đang kiểm kết quả thì để nó tự kết thúc.
    let child: () => void = noop;
    if (run.state === "planning") {
      const found = await childRunOf(tx, run.id, "plan");
      const locked = found ? await lockRun(tx, found.id) : null;
      if (locked && !TERMINAL_RUN_STATES.includes(locked.state) && locked.state !== "verifying") {
        child = (await cancelLocked(tx, locked, by)).after;
      }
    }
    // Chưa máy nào giữ (queued, planning, chờ duyệt plan, lost): huỷ ngay; máy đang được đề nghị thì báo bỏ đề nghị.
    const offered = run.offerMachineId;
    const row = await finishCancelled(tx, run, { by });
    return {
      row,
      after: () => {
        child();
        if (offered) send(offered, { type: "cancel", runId: run.id, graceSec: 0 });
        verifyParent(run);
      },
    };
  }

  // ---- API cho người dùng ------------------------------------------------------------------------------------

  async function startRun(tx: Tx, userId: string, input: RunStartInput) {
    const task = await taskForUser(tx, userId, input.taskId, "member", "tasks.assign");
    const project = await loadProject(tx, task.projectId);
    if (input.machineId) {
      const m = await findMachine(tx, input.machineId);
      const sandboxed = !!project && sandboxedRun(project, await loadPolicy(tx), "code");
      if (!m || m.teamId !== task.teamId || m.revoked || m.kind !== (sandboxed ? "host" : "worker")) {
        throw new NotFoundError("MACHINE_NOT_FOUND", "Không tìm thấy máy của đội sở hữu dự án.");
      }
      if (!usableBy(m, { ownerUserId: userId }, sandboxed)) {
        throw new ForbiddenError(
          "MACHINE_NOT_YOURS",
          "Máy này là máy cá nhân của người khác; chọn máy của bạn hoặc máy dùng chung của đội.",
        );
      }
    }
    const { row, afterCommit } = await queueRun(tx, task, project, {
      cli: input.cli ?? task.preferredCli ?? null,
      model: input.model ?? null,
      machineId: input.machineId ?? null,
      createdBy: userId,
      ownerUserId: userId,
    });
    return { run: toRun(row), afterCommit };
  }

  async function startLeaderRun(
    tx: Tx,
    userId: string,
    input: { threadId: string; projectId: string; prompt: string; cli?: RunRow["cli"] },
  ) {
    const project = await projectFor(tx, userId, input.projectId, "member");
    if (!projectReady(project)) throw new ConflictError("PROJECT_NOT_READY", "Dự án chưa khởi tạo xong repo.");
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`runs:leader:${input.threadId}`}, 0))`);
    const [active] = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          eq(runs.leaderThreadId, input.threadId),
          eq(runs.kind, "leader"),
          notInArray(runs.state, [...TERMINAL_RUN_STATES]),
        ),
      )
      .limit(1);
    if (active) return { runId: active.id, afterCommit: () => undefined };
    const [row] = await tx
      .insert(runs)
      .values({
        orgId: sql`hive.ctx_org()`,
        teamId: project.teamId,
        taskId: null,
        projectId: project.id,
        leaderThreadId: input.threadId,
        kind: "leader",
        cli: input.cli ?? null,
        model: input.cli ? (project.settings.models?.[input.cli]?.leader ?? null) : null,
        branch: `leader/${input.threadId}`,
        policySnapshot: [],
        createdBy: userId,
      })
      .returning();
    if (!row) throw new Error("Không tạo được leader run.");
    await hubEvent(tx, row, "state", { from: null, to: "queued", by: userId });
    await hubEvent(tx, row, "leader_prompt", { prompt: input.prompt });
    await notifyRun(tx, row.id);
    await recordAudit(tx, {
      action: "leader.run.start",
      targetType: "run",
      targetId: row.id,
      data: { threadId: input.threadId, projectId: project.id, cli: row.cli },
    });
    const { orgId, id } = row;
    return { runId: id, afterCommit: () => background(dispatch(orgId, id), "Không giao được leader run") };
  }

  /**
   * Gate AI của phiên duyệt (module knowledge gọi qua job): tạo run doccheck chỉ đọc trên dự án của tài liệu, hoặc dự án
   * hoạt động gần nhất của đội/tổ chức khi tài liệu không thuộc dự án nào, rồi giao cho máy đã khai làm được doccheck.
   */
  async function startDocCheck(orgId: string, instanceId: string): Promise<void> {
    const runId = await tenant(orgId, async (tx) => {
      const ctx = await aiGateContext(tx, instanceId);
      if (!ctx) return null;
      const inst = ctx.instance;
      const project = inst.projectId
        ? await loadProject(tx, inst.projectId)
        : await latestActiveProject(tx, inst.teamId);
      if (!project || !projectReady(project)) {
        await completeWaitingGate(
          tx,
          instanceId,
          "ai",
          { passed: true, note: "Chưa có dự án nào có repo để agent kiểm; bỏ qua checkpoint AI." },
          { jobs: deps.jobs, publicUrl: deps.publicUrl },
        );
        return null;
      }
      const [row] = await tx
        .insert(runs)
        .values({
          orgId: sql`hive.ctx_org()`,
          teamId: project.teamId,
          taskId: null,
          projectId: project.id,
          kind: "doccheck",
          cli: null,
          model: ctx.model,
          branch: `doccheck/${instanceId}`,
          policySnapshot: [],
          createdBy: inst.authorUserId ?? "system",
        })
        .returning();
      if (!row) throw new Error("Không tạo được run kiểm tài liệu.");
      await hubEvent(tx, row, "state", { from: null, to: "queued", by: "review" });
      await hubEvent(tx, row, "doccheck_prompt", {
        instanceId,
        prompt: docCheckPrompt({
          docKey: inst.docKey,
          title: inst.docTitle,
          workflow: inst.workflowName,
          gate: ctx.gate.name,
          checks: ctx.checks,
          passScore: ctx.passScore,
          content: ctx.content,
          base: ctx.base,
        }),
      });
      await attachGateRun(tx, instanceId, row.id);
      await notifyRun(tx, row.id);
      await recordAudit(tx, {
        action: "doccheck.run.start",
        actorUserId: null,
        targetType: "run",
        targetId: row.id,
        data: { reviewId: instanceId, gate: ctx.gate.id, projectId: project.id },
      });
      return row.id;
    });
    if (runId) await dispatch(orgId, runId);
  }

  /**
   * Tạo run queued cho task, không kiểm quyền người dùng: startRun kiểm trước khi gọi, còn webhook (issue, bình luận
   * trên PR) là hệ thống tự giao. `instructions` là chỉ dẫn thêm, ghi thành sự kiện `steer` để dispatch đưa vào prompt.
   * Dự án bật plan mode thì run code sang `planning` ngay và một run plan con được giao thay nó (docs/architecture.md
   * mục 4.1); run code chỉ được giao sau khi người duyệt kế hoạch.
   */
  async function queueRun(
    tx: Tx,
    task: TaskRow,
    project: ProjectRow | null,
    opts: {
      cli: RunRow["cli"];
      model?: string | null;
      machineId?: string | null;
      createdBy: string;
      /** null: thao tác của hệ thống. Bỏ trống thì audit lấy người dùng trong context. */
      actorUserId?: string | null;
      /** Người được dùng máy cá nhân của mình cho run (ADR 0017); bỏ trống là run của đội, chỉ máy dùng chung nhận. */
      ownerUserId?: string | null;
      instructions?: string[];
      /** Lập kế hoạch trước; bỏ trống thì theo cờ `features.planMode` của dự án. */
      plan?: boolean;
    },
  ): Promise<{ row: RunRow; afterCommit: () => void }> {
    // Kiểm sớm image sandbox của dự án để người giao thấy lỗi ngay thay vì run nằm chờ mãi.
    if (project && sandboxedRun(project, await loadPolicy(tx), "code")) await loadSandboxJobConfig(tx, project.id);
    if (task.status === "cancelled" || task.status === "done") {
      throw new ConflictError("TASK_CLOSED", "Task đã xong hoặc đã huỷ, không giao được.");
    }
    if (!projectReady(project)) {
      throw new ConflictError("PROJECT_NOT_READY", "Dự án chưa khởi tạo xong repo, chưa giao task được.");
    }
    await assertTaskBudget(tx, task.id, project.settings.budget);
    const outcome = project.settings.outcome;
    const policy = (task.type ? outcome.byType[task.type] : undefined) ?? outcome.default;
    let row: RunRow | undefined;
    try {
      [row] = await tx
        .insert(runs)
        .values({
          orgId: sql`hive.ctx_org()`,
          teamId: task.teamId,
          taskId: task.id,
          projectId: project.id,
          cli: opts.cli,
          model:
            opts.model !== undefined
              ? opts.model
              : opts.cli
                ? (project.settings.models?.[opts.cli]?.code ?? null)
                : null,
          pinnedMachineId: opts.machineId ?? null,
          branch: `ai/${task.key}`,
          policySnapshot: policy,
          createdBy: opts.createdBy,
          ownerUserId: opts.ownerUserId ?? null,
        })
        .returning();
    } catch (e) {
      const pg = pgError(e);
      if (pg.code === "23505" && pg.constraint === "runs_task_active") {
        throw new ConflictError("RUN_ACTIVE", "Task đang có run chưa kết thúc.");
      }
      throw e;
    }
    if (!row) throw new Error("Không ghi được run.");
    await hubEvent(tx, row, "state", { from: null, to: "queued", by: opts.createdBy });
    for (const input of opts.instructions ?? []) {
      await hubEvent(tx, row, "steer", { input, by: opts.createdBy, delivered: false });
    }
    await notifyRun(tx, row.id);
    const planFirst = opts.plan ?? project.settings.features.planMode;
    let next = row;
    if (planFirst) {
      row = await transition(tx, row, "planning", {}, { by: opts.createdBy });
      next = await createPlanRun(tx, row, opts.model);
    }
    await setTaskStatus(tx, task.id, "queued");
    await recordAudit(tx, {
      action: "run.start",
      actorUserId: opts.actorUserId,
      targetType: "run",
      targetId: row.id,
      data: { taskId: task.id, cli: row.cli, machineId: row.pinnedMachineId, by: opts.createdBy, plan: planFirst },
    });
    const { orgId, id } = next;
    return { row, afterCommit: () => background(dispatch(orgId, id), "Không giao được run") };
  }

  /**
   * Run plan con của run code: cùng task, cùng CLI và máy chỉ định, nhánh của run cha chỉ để xem (worker đọc nhánh
   * chính). Model chỉ chép khi người giao chọn tay; không thì dispatch lấy model `plan` của dự án.
   */
  async function createPlanRun(tx: Tx, parent: RunRow, model: string | null | undefined): Promise<RunRow> {
    const [row] = await tx
      .insert(runs)
      .values({
        orgId: parent.orgId,
        teamId: parent.teamId,
        taskId: parent.taskId,
        projectId: parent.projectId,
        kind: "plan",
        parentRunId: parent.id,
        cli: parent.cli,
        model: model ?? null,
        pinnedMachineId: parent.pinnedMachineId,
        branch: parent.branch,
        policySnapshot: [],
        timeoutSec: parent.timeoutSec,
        createdBy: parent.createdBy,
        ownerUserId: parent.ownerUserId,
      })
      .returning();
    if (!row) throw new Error("Không ghi được run lập kế hoạch.");
    await hubEvent(tx, row, "state", { from: null, to: "queued", by: "plan", parentRunId: parent.id });
    await notifyRun(tx, row.id);
    await recordAudit(tx, {
      action: "run.start",
      actorUserId: null,
      targetType: "run",
      targetId: row.id,
      data: { taskId: row.taskId, cli: row.cli, kind: "plan", parentRunId: parent.id },
    });
    return row;
  }

  /**
   * Kế hoạch còn chờ của task kèm run code đang chờ nó, đã khoá (run trước, kế hoạch sau). Quyền như người giao việc:
   * thành viên đội sở hữu dự án.
   */
  async function lockPlanDecision(tx: Tx, userId: string, taskId: string, planId: string) {
    const task = await taskForUser(tx, userId, taskId, "member", "plans.decide");
    const found = await findPlan(tx, task.id, planId);
    const run = await lockRun(tx, found.runId);
    const plan = await lockAwaitingPlan(tx, task.id, planId);
    if (run?.state !== "awaiting_plan") {
      throw new ConflictError("PLAN_DECIDED", "Kế hoạch không còn chờ duyệt.");
    }
    return { task, run, plan };
  }

  /** Duyệt kế hoạch: run code quay về queued và được giao với kế hoạch đã duyệt trong prompt. */
  async function approvePlan(
    tx: Tx,
    userId: string,
    input: PlanApproveInput,
  ): Promise<{ result: PlanDecision; afterCommit: () => void }> {
    const { task, run, plan } = await lockPlanDecision(tx, userId, input.id, input.planId);
    const project = await loadProject(tx, run.projectId);
    if (!projectReady(project)) {
      throw new ConflictError("PROJECT_NOT_READY", "Dự án chưa khởi tạo xong repo, chưa giao task được.");
    }
    // Run plan đã tốn tiền: task có thể vừa chạm trần trong lúc chờ duyệt.
    await assertTaskBudget(tx, task.id, project.settings.budget);
    // Chỉ giữ bản sửa khi khác bản agent nộp, để biết người duyệt đã đổi kế hoạch hay chỉ bấm duyệt.
    const edited =
      input.content && JSON.stringify(input.content) !== JSON.stringify(plan.content) ? input.content : null;
    const note = input.note || null;
    const decided = await decidePlan(tx, plan.id, { status: "approved", by: userId, note, editedContent: edited });
    const queued = await transition(tx, run, "queued", {}, { by: userId, planId: plan.id });
    await setTaskStatus(tx, task.id, "queued");
    await recordAudit(tx, {
      action: "plan.approve",
      targetType: "plan",
      targetId: plan.id,
      data: {
        taskId: task.id,
        runId: run.id,
        revision: plan.revision,
        edited: edited !== null,
        note,
      },
    });
    const { orgId, id } = queued;
    return {
      result: { plan: toPlan(decided), run: toRun(queued) },
      afterCommit: () => background(dispatch(orgId, id), "Không giao được run theo kế hoạch đã duyệt"),
    };
  }

  /**
   * Từ chối kế hoạch: run code chờ nó bị huỷ (awaiting_plan → cancelled). Chọn lập lại thì một run code mới đi lại từ
   * queued → planning; run plan mới đọc kế hoạch bị từ chối và lý do trong prompt.
   */
  async function rejectPlan(
    tx: Tx,
    userId: string,
    input: PlanRejectInput,
  ): Promise<{ result: PlanDecision; afterCommit: () => void }> {
    const { task, run, plan } = await lockPlanDecision(tx, userId, input.id, input.planId);
    const decided = await decidePlan(tx, plan.id, { status: "rejected", by: userId, note: input.reason });
    // Chỉ dẫn đã gửi cho run cũ (vd. bình luận nhắc bot) vẫn là yêu cầu của lần lập lại.
    const instructions = await instructionsOf(tx, run.id);
    const cancelled = await finishCancelled(tx, run, { by: userId, planId: plan.id, reason: input.reason });
    let next = cancelled;
    let afterCommit = () => {};
    if (input.replan) {
      ({ row: next, afterCommit } = await queueRun(tx, task, await loadProject(tx, run.projectId), {
        cli: run.cli,
        machineId: run.pinnedMachineId,
        createdBy: userId,
        instructions,
        plan: true,
      }));
    }
    await recordAudit(tx, {
      action: "plan.reject",
      targetType: "plan",
      targetId: plan.id,
      data: {
        taskId: task.id,
        runId: run.id,
        revision: plan.revision,
        reason: input.reason,
        replan: input.replan,
        nextRunId: input.replan ? next.id : null,
      },
    });
    return { result: { plan: toPlan(decided), run: toRun(next) }, afterCommit };
  }

  /**
   * Thêm chỉ dẫn cho run chưa kết thúc. Máy đang chạy agent thì gửi gói `steer` sau commit; run chưa tới máy thì chỉ
   * ghi lại, dispatch đưa vào prompt. Run đang kiểm kết quả hay đang huỷ thì không nhận nữa (`closing`).
   *
   * Sự kiện `steer` luôn ghi `delivered: false`: gửi tới máy chưa có nghĩa agent đã nhận (codex exec, worker cũ bỏ qua
   * gói). Worker báo lại bằng sự kiện `steer_result` mang `steerId` là id sự kiện này; chỉ dẫn vẫn nằm trong prompt của
   * lần thử sau như trước.
   */
  async function steerRun(
    tx: Tx,
    runId: string,
    input: string,
    by: string,
  ): Promise<{ status: "sent" | "pending" | "closing"; afterCommit: () => void }> {
    const noop = () => {};
    const run = await lockRun(tx, runId);
    if (!run) throw runNotFound();
    const onMachine = ON_MACHINE.includes(run.state) && run.state !== "cancelling" && run.machineId;
    if (!onMachine && !["queued", "planning", "awaiting_plan", "lost"].includes(run.state)) {
      return { status: "closing", afterCommit: noop };
    }
    const steerId = await hubEvent(tx, run, "steer", { input, by, delivered: false, sent: Boolean(onMachine) });
    await notifyRun(tx, run.id);
    if (!onMachine || !run.machineId) return { status: "pending", afterCommit: noop };
    const machineId = run.machineId;
    const msg = { type: "steer", runId: run.id, attempt: run.attempt, steerId: String(steerId), input } as const;
    return {
      status: "sent",
      afterCommit: () => {
        if (!send(machineId, msg)) {
          log.warn(`Không gửi được chỉ dẫn tới máy ${machineId} của run ${run.id}`);
        }
      },
    };
  }

  async function cancelRun(tx: Tx, userId: string, id: string) {
    const found = await runForUser(tx, userId, id, "member");
    const run = await lockRun(tx, found.id);
    if (!run) throw runNotFound();
    const { row, after } = await cancelLocked(tx, run, userId);
    await recordAudit(tx, { action: "run.cancel", targetType: "run", targetId: run.id, data: { from: run.state } });
    return { run: toRun(row), afterCommit: after };
  }

  /** Huỷ mọi run chưa kết thúc của task (tasks.cancel). */
  async function cancelRunsOfTask(tx: Tx, taskId: string): Promise<() => void> {
    // Khoá cả loạt theo thứ tự tạo: run cha (code) trước run con (plan, review), cùng thứ tự với cancelLocked và kết
    // luận run cha. Khoá lần lượt theo thứ tự trả về bất kỳ từng gây deadlock với vòng kiểm kết quả của run cha.
    const active = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          eq(runs.taskId, taskId),
          notInArray(runs.state, ["succeeded", "no_changes", "needs_review", "failed", "cancelled"]),
        ),
      )
      .orderBy(asc(runs.createdAt), asc(runs.id))
      .for("update");
    const afters: Array<() => void> = [];
    for (const { id } of active) {
      const run = await lockRun(tx, id);
      // Huỷ run code đang lập kế hoạch đã huỷ luôn run plan của nó, có thể trước khi vòng lặp tới run plan.
      if (!run || run.state === "verifying" || TERMINAL_RUN_STATES.includes(run.state)) continue;
      afters.push((await cancelLocked(tx, run, "task.cancel")).after);
    }
    return () => {
      for (const a of afters) a();
    };
  }

  return {
    handlers,
    dispatch,
    dispatchTeam,
    verify,
    fire,
    startRun,
    startLeaderRun,
    startDocCheck,
    /** Trợ lý của trình soạn tài liệu; router của knowledge gọi qua đây (knowledge không import runs). */
    docAssist: {
      targets: assistTargets,
      list: listAssists,
      async start(tx: Tx, userId: string, input: AssistStartInput) {
        const { assist, orgId } = await createAssistRun(tx, userId, input);
        return {
          assist,
          afterCommit: () => background(dispatch(orgId, assist.runId), "Không giao được run trợ lý tài liệu"),
        };
      },
    },
    queueRun,
    steerRun,
    cancelRun,
    cancelRunsOfTask,
    /** Duyệt và từ chối kế hoạch; router của tasks gọi qua đây (tasks không import runs). */
    planActions: { approve: approvePlan, reject: rejectPlan },
    /** Đăng ký handler sự kiện Git (PR merge/đóng, issue có nhãn, bình luận nhắc bot) vào registry của scm. */
    registerScmHandlers(registry: Pick<ScmEventRegistry, "on"> = scmEvents) {
      return registerScmHandlers(registry, {
        queueRun,
        steerRun,
        cancelRunsOfTask,
        providerFactory: deps.providerFactory,
        masterKey: deps.masterKey,
        publicUrl: deps.publicUrl,
        logger: log,
      });
    },
    /** Kiểm HIVE_RUN_TOKEN cho cổng /mcp; cùng khoá với token engine ký khi giao lease. */
    mcpRunTokens: createMcpRunTokens({ pool: deps.pool, authSecret: deps.authSecret, publicUrl: deps.publicUrl }),
    /** Xử lý hẹn giờ trên pg-boss; chỉ gọi ở tiến trình có vai trò `jobs` (cùng tiến trình với gateway). */
    async registerJobs(jobs: Jobs) {
      await jobs.work<RunTimer>(RUNS_TIMER_QUEUE, (job) => fire(job.data), { pollingIntervalSeconds: 1 });
    },
    stop() {
      stopped = true;
      for (const h of timers) clearTimeout(h);
      for (const h of pendingNotify.values()) clearTimeout(h);
      timers.clear();
      pendingNotify.clear();
    },
  };
}

export type RunsEngine = ReturnType<typeof createRunsEngine>;

/** Run mà người dùng có ít nhất vai trò `min` trong đội sở hữu; không thấy được thì báo như không tồn tại. */
export async function runForUser(
  tx: Tx,
  userId: string,
  id: string,
  min: "viewer" | "member" | "admin",
): Promise<RunRow> {
  const [row] = await tx.select().from(runs).where(eq(runs.id, id));
  if (!row) throw runNotFound();
  if (row.kind === "leader") {
    await projectFor(tx, userId, row.projectId, min).catch((e: unknown) => {
      if (e instanceof NotFoundError) throw runNotFound();
      throw e;
    });
  } else if (row.taskId) {
    await taskForUser(tx, userId, row.taskId, min).catch((e: unknown) => {
      if (e instanceof NotFoundError) throw runNotFound();
      throw e;
    });
  } else throw runNotFound();
  return row;
}
