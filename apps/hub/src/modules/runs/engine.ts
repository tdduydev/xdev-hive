import {
  type AgentMemoryPolicy,
  type AssistStartInput,
  type ChecklistItem,
  defaultRouting,
  defaultTokenSaving,
  type JobMcpServer,
  type JobPolicy,
  type OutcomeCheck,
  type PlanApproveInput,
  type PlanDecision,
  type PlanRejectInput,
  type RunExplore,
  type RunRtk,
  type RunStartInput,
  type RunTokenGuard,
  type SandboxJobConfig,
  type TaskStatus,
  TERMINAL_RUN_STATES,
} from "@xdev-hive/contracts";
import {
  type CheckCommand,
  checkCommandResult,
  type DiffStats,
  diffStats,
  reportRepo,
  type SdlcJobSpec,
  sdlcJobSpec,
  sdlcReportArtifacts,
  steerResultData,
} from "@xdev-hive/contracts/worker-protocol";
import { and, asc, desc, eq, gt, inArray, ne, notInArray, or, sql } from "drizzle-orm";
import type pg from "pg";
import { recordAudit } from "../audit/index.ts";
import {
  enqueueMerge,
  findProject,
  latestActiveProject,
  loadProject,
  type ProjectRow,
  projectFor,
} from "../catalog/index.ts";
import {
  type CodeReviewDeps,
  type CodeReviewRun,
  type FinishedReviewRun,
  matchFor,
  onReviewRunFinished,
  type QueueFixRunInput,
  type RunEvidence,
  type StartedReviewRun,
  type StartReviewRunsInput,
  startCodeReview,
} from "../codereview/index.ts";
import {
  type AuthedMachine,
  findMachine,
  isConnected,
  listOnlineMachines,
  type MachineProjects,
  machineIsPaused,
  machinesGrantingFull,
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
import {
  aiGateContext,
  applyAiResult,
  attachGateRun,
  type BriefStaleness,
  briefStaleness,
  completeWaitingGate,
  loadBrief,
  recordBriefDrift,
  submitBrief,
} from "../knowledge/index.ts";
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
  codeRunGate,
  onCodeRunSettled,
  onSdlcRunFinished,
  type SdlcDeps,
  type SdlcRunRequest,
  type SdlcTaskRunRequest,
  specContextFor,
  withStepRuns,
} from "../sdlc/index.ts";
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
import { teamRoleOf } from "../tenancy/index.ts";
import { type BriefForPrompt, briefBlock, briefBranch, briefRunPrompt } from "./brief.ts";
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
import { type RoutedRun, routeRun } from "./routing.ts";
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
  | { kind: "verify"; orgId: string; runId: string }
  // Run tạo trong transaction của module khác (run review, run sửa của quy trình review code): chỉ giao sau commit.
  | { kind: "dispatch"; orgId: string; runId: string };

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

/** Nhãn issue ghi vào source.labels lúc tạo task (scm-events.ts); task tạo từ web không có. */
function taskLabels(task: TaskRow): string[] {
  const labels = task.source.labels;
  return Array.isArray(labels) ? labels.filter((l): l is string => typeof l === "string") : [];
}

/** Số run code đã thất bại của task, ngoài run đang xét: tín hiệu "thử lại sau lỗi" để nâng cấp model. */
async function failedCodeRuns(tx: Tx, taskId: string, exceptRunId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(runs)
    .where(and(eq(runs.taskId, taskId), eq(runs.kind, "code"), eq(runs.state, "failed"), ne(runs.id, exceptRunId)));
  return row?.n ?? 0;
}

/**
 * Worker chỉ cấu hình MCP của Hive cho Claude và Codex. Run plan phải gọi plan_submit, nên run không chọn CLI thì
 * không giao cho CLI khác (Gemini, Antigravity) để khỏi chắc chắn thất bại.
 */
const SUBMIT_CLIS: readonly string[] = ["claude", "codex"];
/**
 * CLI không gọi được tool MCP khi chạy chỉ đọc: `agy -p` (1.3.3) tự từ chối mọi lời gọi MCP nếu thiếu
 * --dangerously-skip-permissions, mà cờ đó lại bỏ qua chế độ plan và sandbox nên worker không dùng ở run chỉ đọc. Run
 * plan, leader của các CLI này chắc chắn không nộp được kết quả.
 */
const NO_READONLY_MCP_CLIS: readonly string[] = ["antigravity"];
/**
 * CLI không giới hạn được trong thư mục làm việc khi chạy run code (agy 1.3.3: sandbox chặn cả ghi file trong worktree
 * và git commit, nên phải chạy với --dangerously-skip-permissions). Chỉ giao run code cho chúng khi dự án cho toàn quyền.
 */
const FULL_ONLY_CLIS: readonly string[] = ["antigravity"];
/**
 * Run không có task. Lời nhắc lấy từ sự kiện `<kind>_prompt` của hub: leader (trò chuyện), doccheck (gate AI của quy
 * trình duyệt), docassist (trợ lý của trình soạn tài liệu); riêng brief dựng lúc giao từ brief hiện tại (ADR 0022).
 */
const PROMPT_KINDS: readonly RunRow["kind"][] = ["leader", "doccheck", "docassist", "brief", "skill_proposal", "sdlc"];
/** Run phải nộp kết quả qua tool MCP nên chỉ giao cho CLI gọi được tool khi chạy không tương tác. */
const SUBMIT_KINDS: readonly RunRow["kind"][] = ["plan", "leader", "doccheck", "docassist", "brief", "skill_proposal"];
/** Worker cũ không biết các kind này sẽ chạy chúng như run code (có quyền ghi): chỉ giao cho máy đã khai kind đó. */
const CAPABILITY_KINDS: readonly RunRow["kind"][] = ["doccheck", "docassist", "brief", "skill_proposal", "sdlc"];
/** Run được ghi memory trong lúc chạy (tool memory_write mở cho các kind này, ADR 0022). */
const MEMORY_WRITE_KINDS: readonly RunRow["kind"][] = ["code", "review"];
/**
 * Brief làm mới tự động và run đề xuất skill (specs/014) dùng model rẻ: chỉ đọc và tóm tắt, không cần model mạnh
 * nhất. Run đề xuất skill thêm effort medium (buildSpec).
 */
const BRIEF_MODELS: Partial<Record<string, string>> = { claude: "sonnet" };
const promptEvent = (kind: RunRow["kind"]) => (kind === "leader" ? "leader_prompt" : `${kind}_prompt`);

/**
 * Nhãn máy (specs/011 D13): run có `required_labels` chỉ giao cho máy có đủ nhãn; máy `labels_only` chỉ nhận run có
 * nhãn mà nó có, để máy dành cho AI SDLC không bị run thường chiếm slot.
 */
export function labelsMatch(
  m: { labels: readonly string[]; labelsOnly: boolean },
  required: readonly string[],
): boolean {
  if (m.labelsOnly && required.length === 0) return false;
  return required.every((l) => m.labels.includes(l));
}

/**
 * Lý do chờ máy của run AI SDLC hay run có nhãn: chưa máy nào có worker mới (capability `sdlc`) hoặc có đủ nhãn. null
 * thì dùng lý do chung (máy cá nhân, máy dùng chung).
 */
async function sdlcWaitingReason(tx: Tx, run: RunRow, sandboxed: boolean): Promise<string | null> {
  if (run.kind !== "sdlc" && run.requiredLabels.length === 0) return null;
  const online = (await listOnlineMachines(tx, run.teamId, sandboxed ? "host" : "worker")).filter((m) =>
    usableBy(m, run, sandboxed),
  );
  if (run.kind === "sdlc" && !online.some((m) => m.capabilities.includes("sdlc")))
    return "Cần worker mới: chưa máy online nào của đội chạy được bước AI SDLC. Cập nhật worker trên máy dùng chung của đội.";
  if (run.requiredLabels.length && !online.some((m) => labelsMatch(m, run.requiredLabels))) {
    const missing = run.requiredLabels.filter((l) => !online.some((m) => m.labels.includes(l)));
    return `Chờ máy có nhãn ${run.requiredLabels.join(", ")}${missing.length ? ` (chưa máy online nào có ${missing.join(", ")})` : ""}. Quản trị đội gắn nhãn cho máy ở trang Máy.`;
  }
  return null;
}

function reviewEvidence(child: RunRow, report: ReviewReport | null): ReviewEvidence {
  if (child.state === "succeeded" && report) return { status: "done", score: report.score, by: child.cli };
  if (child.state === "cancelled") return { status: "failed", reason: "run review đã bị huỷ." };
  const why = child.result?.reasons[0];
  return { status: "failed", reason: why ?? `run review kết thúc ở trạng thái ${child.state}.` };
}

/**
 * Sự kiện ghi lúc tạo run review cho checkpoint AI của quy trình review code: dispatch đọc lại để dựng lời nhắc. Run
 * này không có run cha (xem startReviewRuns) nên PR cũng lấy từ đây.
 */
const REVIEW_PROMPT_EVENT = "review_prompt";
const stringsOf = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
function parseWorkflowReview(data: Record<string, unknown>) {
  return {
    rubric: stringsOf(data.rubric),
    focusPaths: stringsOf(data.focusPaths),
    guidance: stringsOf(data.guidance),
    specContext: stringsOf(data.specContext),
    prUrl: typeof data.prUrl === "string" ? data.prUrl : null,
  };
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

/** Chọn quy trình review code trước khi mở PR: `matchFor` chỉ cần nhánh đích, là nhánh chính như lúc mở PR. */
const PR_TO_OPEN = { number: 0, url: "" };

/** Run code dưới dạng module `codereview` nhận; `pr` null khi run không có PR (không mở phiên). */
function codeReviewRunOf(
  run: RunRow,
  task: TaskRow | null,
  project: ProjectRow,
  stats: DiffStats | null,
  pr: { number: number; url: string } | null,
  reasons: string[] = [],
): CodeReviewRun {
  return {
    id: run.id,
    teamId: run.teamId,
    projectId: run.projectId,
    taskId: run.taskId,
    ownerUserId: run.ownerUserId,
    taskType: task?.type ?? null,
    headSha: run.headSha,
    pr: pr && { ...pr, branch: run.branch, baseBranch: project.defaultBranch ?? "main" },
    stats,
    reasons,
  };
}

/** Trạng thái task theo kết quả run: có PR thì chờ người review, không có gì để nộp hay lỗi thì quay về todo. */
function taskStatusFor(outcome: Outcome | "cancelled", prUrl: string | null): TaskStatus {
  if (outcome === "succeeded") return prUrl ? "review" : "done";
  if (outcome === "needs_review") return "review";
  return "todo";
}

interface SpecContext {
  commands: CheckCommand[];
  instructions: string[];
  budget: JobBudget | undefined;
  /** Model và quyền CLI sau khi áp Chính sách agent của tổ chức. */
  model: string | null;
  /** Effort và cố vấn của định tuyến theo cấp độ task; null khi run không qua định tuyến. */
  routing: RoutedRun | null;
  /** Quyền theo dự án sau chính sách; máy đã gắn dự án tự tính lại theo công tắc của máy (ADR 0020). */
  runPermissions: "workspace" | "full";
  /** Chính sách tổ chức cho toàn quyền: worker cần để áp công tắc toàn quyền của máy. */
  fullAllowed: boolean;
  /** Hook bắt buộc của tổ chức, worker chạy ở các mốc của CLI. */
  policy: JobPolicy;
  parentPrUrl: string | null;
  /** Run review của checkpoint AI trong quy trình review code: mục kiểm, đường dẫn trọng tâm, quy tắc chấm, ngữ cảnh spec. */
  reviewRubric: ReturnType<typeof parseWorkflowReview> | null;
  /** Run code: kế hoạch đã duyệt mà run phải làm theo. */
  approvedPlan: PlanRow | null;
  /** Run plan: kế hoạch lần trước của task nếu bị từ chối. */
  rejectedPlan: PlanRow | null;
  /** Dự án bật sandbox: cấu hình image và allowlist cho runner host. */
  sandbox?: SandboxJobConfig | undefined;
  leaderPrompt: string | null;
  /** MCP server ngoài được phép (MCP-06); chỉ run code nhận, xem dispatch. */
  mcpServers: JobMcpServer[];
  /** Brief của dự án lúc giao (ADR 0022); null khi chưa có. */
  brief: BriefForPrompt | null;
  /** Chính sách memory của agent; null khi run này không được ghi memory. */
  memoryWrite: AgentMemoryPolicy | null;
  /** Máy chạy run có CodeGraph và dự án để mục này bật: prompt nhắc agent dùng `codegraph_explore`. */
  codegraph: boolean;
  /** Run `sdlc`: seed và collect của bước, tiêu đề bước (ghi lúc tạo run). */
  sdlc?: { job: SdlcJobSpec; title: string } | null | undefined;
  /** Run code của task hạng mục AI SDLC: ngữ cảnh spec (`sdlc.specContextFor`). */
  sdlcContext?: string | null | undefined;
}

const CODEGRAPH_HINT =
  "Máy chạy run có CodeGraph: dùng tool MCP `codegraph_explore` để tìm symbol, caller và phạm vi ảnh hưởng trước khi grep hay đọc file.";

/**
 * Worker chỉ gắn CodeGraph khi máy khai capability, công tắc tổng và mục codegraph của dự án đều bật; prompt nhắc dùng
 * tool thì phải khớp đúng điều kiện đó, nếu không agent được bảo gọi một tool không có. Run trong sandbox chạy trên
 * runner host không có chỉ mục của repo trên máy dev nên không nhắc.
 */
export function codegraphAvailable(
  machine: { capabilities: readonly string[] },
  project: Pick<ProjectRow, "settings">,
  sandboxed: boolean,
): boolean {
  if (sandboxed || !machine.capabilities.includes("codegraph")) return false;
  const saving = project.settings.tokenSaving ?? defaultTokenSaving;
  return saving.enabled && saving.codegraph !== false;
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
      rubric: ctx.reviewRubric?.rubric,
      focusPaths: ctx.reviewRubric?.focusPaths,
      guidance: ctx.reviewRubric?.guidance,
      specContext: ctx.reviewRubric?.specContext,
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
  if (run.kind === "brief") {
    return briefRunPrompt({ projectKey: project.key, baseBranch, current: ctx.brief });
  }
  if (run.kind === "skill_proposal")
    return ctx.leaderPrompt ?? "Hãy xem các run khó rồi gọi công cụ MCP skill_proposal_submit.";
  if (run.kind === "leader") return ctx.leaderPrompt ?? "Hãy trả lời người dùng qua công cụ MCP leader_reply.";
  if (run.kind === "doccheck") return ctx.leaderPrompt ?? "Hãy kiểm tài liệu rồi gọi công cụ MCP doc_check_submit.";
  if (run.kind === "docassist") return ctx.leaderPrompt ?? "Hãy đọc bản nháp bằng doc_draft_get rồi góp ý.";
  if (run.kind === "sdlc") return ctx.leaderPrompt ?? "Hãy soạn tài liệu của bước AI SDLC theo sdlc_context.";
  const base = task.body ? `${task.title}\n\n${task.body}` : task.title;
  // Task của hạng mục AI SDLC: tài liệu đã duyệt và requirement đi cùng đề bài để agent làm đúng phạm vi.
  const prompt = ctx.sdlcContext ? `${base}\n\n${ctx.sdlcContext}` : base;
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
 * Quyền CLI của run trên một máy (ADR 0020): máy đã gắn dự án với repo trên máy thì toàn quyền khi và chỉ khi máy bật
 * cho dự án đó và tổ chức cho phép; chưa gắn (máy dùng chung, worker cũ) thì theo quyền của dự án sau chính sách.
 * Worker tính lại đúng như vậy lúc chạy từ projects.json; hub dùng để chọn máy và CLI.
 */
export function machinePermission(
  m: MachineProjects,
  projectId: string,
  projectMode: "workspace" | "full",
  fullAllowed: boolean,
): "workspace" | "full" {
  if (!m.boundProjects.includes(projectId)) return projectMode;
  return fullAllowed && m.fullProjects.includes(projectId) ? "full" : "workspace";
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
  const own = promptOf(run, taskPrompt, project, ctx);
  // Leader chỉ có leader_reply, leader_propose nên không nhắc memory_search; run brief tự đọc repo để viết brief; run
  // đề xuất skill đã có tóm tắt run và danh sách skill sẵn trong lời nhắc nên không cần khối brief (tiết kiệm token).
  const hint = ctx.codegraph ? `${CODEGRAPH_HINT}\n\n` : "";
  const prompt =
    run.kind === "brief" || run.kind === "skill_proposal"
      ? `${hint}${own}`
      : `${briefBlock(ctx.brief, { memorySearch: run.kind !== "leader", memoryWrite: ctx.memoryWrite })}\n\n${hint}---\n\n${own}`;
  const { instructions, budget, sandbox, mcpServers } = ctx;
  return {
    kind: run.kind,
    execution: sandbox ? "sandbox" : "worker",
    ...(sandbox ? { sandbox } : {}),
    taskId: task?.id ?? null,
    taskKey: task?.key ?? null,
    projectId: project.id,
    projectKey: project.key,
    title: task?.title ?? ctx.sdlc?.title ?? "Trao đổi với leader",
    prompt: instructions.length
      ? `${prompt}\n\nChỉ dẫn thêm từ người review:\n${instructions.map((i) => `- ${i}`).join("\n")}`
      : prompt,
    instructions,
    cli,
    model: ctx.model,
    // Bỏ khi không định tuyến để worker cũ (bỏ qua trường lạ) và worker mới nhận cùng một spec như trước.
    ...(ctx.routing
      ? {
          effort: ctx.routing.effort,
          ...(ctx.routing.advisor ? { advisor: ctx.routing.advisor } : {}),
          tier: ctx.routing.tier,
        }
      : run.kind === "skill_proposal"
        ? { effort: "medium" }
        : {}),
    // Run sdlc chỉ ghi tài liệu trong worktree tạm: không cần toàn quyền dù dự án cho (plan.md "Worker impact").
    runPermissions: run.kind === "sdlc" ? "workspace" : ctx.runPermissions,
    fullAllowed: ctx.fullAllowed,
    // Bỏ khi không có gì để worker cũ (chưa biết trường này) và worker mới nhận cùng một spec như trước.
    ...(ctx.policy.hooks.length || ctx.policy.managedHooksOnly ? { policy: ctx.policy } : {}),
    repoUrl: project.repoHttpUrl,
    baseBranch: project.defaultBranch,
    branch: run.branch,
    timeoutSec: run.timeoutSec,
    ...(budget ? { budget } : {}),
    // Dự án tạo trước khi có mục này chưa lưu tokenSaving: gửi mặc định để worker mới và cũ cùng thấy một giá trị.
    tokenSaving: project.settings.tokenSaving ?? defaultTokenSaving,
    ...(mcpServers.length ? { mcpServers } : {}),
    ...(ctx.commands.length ? { checks: { commands: ctx.commands } } : {}),
    // Worker cũ không biết trường này: hub chỉ giao run sdlc cho máy khai capability `sdlc` (CAPABILITY_KINDS).
    ...(ctx.sdlc ? { sdlc: ctx.sdlc.job } : {}),
    // Worker đếm nhánh chính đi trước commit này bao nhiêu commit và báo lại trong run_result.report.repo.
    ...(ctx.brief?.commitSha ? { brief: { sha: ctx.brief.commitSha } } : {}),
    // Nguồn từ khoá của context pack (worker): chỉ phần của task, không lẫn brief hay hướng dẫn chung trong prompt.
    ...(task && (run.kind === "code" || run.kind === "plan")
      ? { taskText: run.kind === "code" ? own : task.body ? `${task.title}\n\n${task.body}` : task.title }
      : {}),
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
  async function pickMachine(
    tx: Tx,
    run: RunRow,
    sandboxed: boolean,
    policy: Policy,
    permissionOn: (m: MachineProjects) => "workspace" | "full",
  ) {
    const online = await listOnlineMachines(tx, run.teamId, sandboxed ? "host" : "worker");
    // Run code của CLI cần toàn quyền chỉ giao cho máy mà quyền thực dùng là full (dự án, hoặc công tắc của máy).
    const runsCli = (m: MachineProjects, c: string) =>
      run.kind !== "code" || !FULL_ONLY_CLIS.includes(c) || permissionOn(m) === "full";
    const candidates = online.filter(
      (m) =>
        usableBy(m, run, sandboxed) &&
        machineSlots(policy, m.capacity) > 0 &&
        connected(m.id) &&
        !run.rejectedBy.includes(m.id) &&
        (!run.pinnedMachineId || m.id === run.pinnedMachineId) &&
        (!CAPABILITY_KINDS.includes(run.kind) || m.capabilities.includes(run.kind)) &&
        labelsMatch(m, run.requiredLabels) &&
        (run.cli
          ? m.clis.includes(run.cli) && runsCli(m, run.cli)
          : SUBMIT_KINDS.includes(run.kind)
            ? m.clis.some((c) => SUBMIT_CLIS.includes(c))
            : m.clis.some((c) => runsCli(m, c))),
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
      const permission = resolvePermission(policy, project.settings.runPermissions?.mode ?? "workspace");
      const permissionOn = (m: MachineProjects) =>
        machinePermission(m, project.id, permission.mode, policy.allowFullPermission);
      const { machine, contended } = await pickMachine(tx, run, sandboxed, policy, permissionOn);
      if (!machine && contended) return "contended" as const;
      if (!machine) {
        if (!sandboxed) {
          const special = await sdlcWaitingReason(tx, run, sandboxed);
          await noteOnce(tx, run, "waiting_machine", {
            message:
              special ??
              (run.kind === "code" && run.cli && FULL_ONLY_CLIS.includes(run.cli)
                ? "Antigravity cần toàn quyền: chờ một máy được dùng cho run này có toàn quyền với dự án (dự án cho toàn quyền, hoặc bật “Cho toàn quyền trên máy này” ở màn Dự án trên máy của app desktop)."
                : run.ownerUserId
                  ? "Chờ máy của người giao việc hoặc máy dùng chung của đội online; máy cá nhân của người khác không chạy run này."
                  : "Run của đội chỉ chạy trên máy dùng chung; đội chưa có máy dùng chung nào sẵn sàng. Quản trị đội bật Dùng chung cho một máy ở trang Máy."),
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
      const baseBudget = clampBudget(policy, project.settings.budget);
      const taskSpent = task ? await taskSpentUsd(tx, task.id) : 0;
      // Run review, plan, leader là run chỉ đọc: server ngoài (vd. GitHub) có tool ghi mà chế độ chỉ đọc của CLI không
      // chặn hết, nên chỉ run code nhận.
      const mcpServers = run.kind === "code" ? await mcpServersForProject(tx, project.id) : [];
      const [parent] = run.parentRunId
        ? await tx.select({ prUrl: runs.prUrl }).from(runs).where(eq(runs.id, run.parentRunId))
        : [];
      const [reviewContext] =
        run.kind === "review"
          ? await tx
              .select({ data: runEvents.data })
              .from(runEvents)
              .where(and(eq(runEvents.runId, run.id), eq(runEvents.type, REVIEW_PROMPT_EVENT)))
              .limit(1)
          : [];
      const workflowReview = reviewContext ? parseWorkflowReview(reviewContext.data) : null;
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
      const sdlcJob = run.kind === "sdlc" ? sdlcJobSpec.safeParse(leaderContext?.prompt.sdlc) : null;
      const sdlcContext = run.kind === "code" && task ? await specContextFor(tx, task.id) : null;
      const expiresAt = new Date(Date.now() + offerTtlSec * 1000);
      await tx
        .update(runs)
        .set({ offerMachineId: machine.id, offerExpiresAt: expiresAt, updatedAt: sql`now()` })
        .where(eq(runs.id, run.id));
      // Quyền máy này sẽ áp; worker tự tính lại từ projects.json lúc chạy.
      const effective = sandboxed ? permission.mode : permissionOn(machine);
      const cli =
        run.cli ??
        (SUBMIT_KINDS.includes(run.kind)
          ? machine.clis.find((c) => SUBMIT_CLIS.includes(c))
          : machine.clis.find((c) => effective === "full" || !FULL_ONLY_CLIS.includes(c))) ??
        "claude";
      // Ghi CLI thực giao: run không chọn CLI thì chỉ sự kiện này biết agent nào chạy (costs.summary nhóm theo CLI).
      await hubEvent(tx, run, "offer", { machineId: machine.id, machine: machine.name, cli });
      const explicitModel =
        run.model ??
        (run.kind === "brief" || run.kind === "skill_proposal"
          ? (BRIEF_MODELS[cli] ?? null)
          : project.settings.models?.[cli as NonNullable<RunRow["cli"]>]?.[
              run.kind === "doccheck" || run.kind === "docassist"
                ? "review"
                : // Run sdlc soạn tài liệu như run plan; worker cũng chọn tài khoản vai trò plan cho nó.
                  run.kind === "sdlc"
                  ? "plan"
                  : run.kind
            ]) ??
        null;
      // Định tuyến theo cấp độ task chỉ cho run code; run review, plan, brief giữ model theo loại run.
      const routed =
        run.kind === "code" && task
          ? routeRun(cli, project.settings.routing ?? defaultRouting, {
              manual: run.tier,
              type: task.type,
              labels: taskLabels(task),
              title: task.title,
              body: task.body,
              plan: approvedPlan ? planInForce(approvedPlan) : null,
              retried: run.attempt > 1 || (await failedCodeRuns(tx, task.id, run.id)) > 0,
            })
          : null;
      const requested = explicitModel ?? routed?.model ?? null;
      const budget = jobBudget(
        // Số lượt tối đa của cấp độ chỉ là mặc định: dự án đã đặt budget.maxTurns thì giá trị đó thắng.
        routed?.maxTurns != null ? { ...baseBudget, maxTurns: baseBudget?.maxTurns ?? routed.maxTurns } : baseBudget,
        taskSpent,
      );
      const model = resolveModel(policy, cli, requested);
      const routing: RoutedRun | null = routed && {
        ...routed,
        model: model.model,
        maxTurns: budget?.maxTurns ?? null,
        reasons: [
          ...routed.reasons,
          ...(explicitModel
            ? [`Model ${explicitModel} do người giao việc hay cấu hình dự án chọn; định tuyến chỉ chọn effort.`]
            : []),
          ...(model.notice ? [model.notice] : []),
        ],
      };
      for (const notice of [model.notice, permission.notice]) {
        if (notice) await noteOnce(tx, run, "policy", { message: notice });
      }
      if (run.kind === "code" && effective !== permission.mode) {
        await noteOnce(tx, run, "policy", {
          message:
            effective === "full"
              ? `Máy ${machine.name} đã bật toàn quyền cho dự án này: CLI chạy không sandbox, không hỏi duyệt.`
              : `Máy ${machine.name} đã gắn dự án nhưng chưa bật toàn quyền: run chạy trong worktree.`,
        });
      }
      const jobPolicy = jobPolicyOf(policy);
      const workflow =
        run.kind === "code" ? await matchFor(tx, codeReviewRunOf(run, task, project, null, PR_TO_OPEN)) : null;
      const commands: CheckCommand[] = [];
      if (run.kind === "code") {
        for (const check of run.policySnapshot) {
          if (check.check !== "command") continue;
          const amount = Number.parseInt(check.timeout, 10);
          const unit = check.timeout.slice(-1);
          commands.push({
            run: check.run.trim(),
            timeoutSec: Math.max(10, Math.min(3600, amount * (unit === "h" ? 3600 : unit === "m" ? 60 : 1))),
          });
        }
        // Chưa biết diff lúc giao job: chạy cả lệnh của checkpoint có điều kiện để không bỏ sót bằng chứng.
        for (const phase of workflow?.workflow.phases ?? []) {
          for (const gate of phase.gates) {
            if (gate.kind === "rule" && gate.rules?.includes("command")) commands.push(...(gate.commands ?? []));
          }
        }
      }
      // Một lệnh dùng ở nhiều cổng chỉ cần chạy một lần, với thời hạn chặt nhất.
      const uniqueCommands = new Map<string, CheckCommand>();
      for (const command of commands) {
        const run = command.run.trim();
        const previous = uniqueCommands.get(run);
        uniqueCommands.set(run, { run, timeoutSec: Math.min(previous?.timeoutSec ?? Infinity, command.timeoutSec) });
      }
      const briefRow = await loadBrief(tx, project.id);
      const brief: BriefForPrompt | null = briefRow
        ? {
            content: briefRow.content,
            commitSha: briefRow.commitSha,
            source: briefRow.source,
            headSha: briefRow.headSha,
            commitsBehind: briefRow.commitsBehind,
          }
        : null;
      // Bản chụp chính sách đã áp cho lần thử này (FR-006): đổi chính sách sau đó không làm đổi run đã giao.
      await tx
        .update(runs)
        .set({
          agentPolicySnapshot: {
            model: model.model,
            requestedModel: requested,
            routing,
            runPermissions: effective,
            sandbox: sandboxed,
            budget: budget ?? null,
            // Commit của brief worker sẽ so với nhánh chính; run_result báo độ lệch theo đúng commit này.
            briefSha: brief?.commitSha ?? null,
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
            commands: [...uniqueCommands.values()],
            instructions,
            budget,
            model: model.model,
            routing,
            runPermissions: permission.mode,
            fullAllowed: policy.allowFullPermission,
            policy: jobPolicy,
            parentPrUrl: parent?.prUrl ?? workflowReview?.prUrl ?? null,
            reviewRubric: workflowReview,
            approvedPlan,
            rejectedPlan: latest?.status === "rejected" ? latest : null,
            sandbox,
            leaderPrompt: typeof leaderContext?.prompt.prompt === "string" ? leaderContext.prompt.prompt : null,
            mcpServers,
            brief,
            memoryWrite:
              MEMORY_WRITE_KINDS.includes(run.kind) && policy.agentMemory.mode !== "off" ? policy.agentMemory : null,
            codegraph: codegraphAvailable(machine, project, sandboxed),
            sdlc: sdlcJob?.success
              ? { job: sdlcJob.data, title: String(leaderContext?.prompt.title ?? "Bước AI SDLC") }
              : null,
            sdlcContext,
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
        if (cost?.explore) await applyExplore(tx, run, cost.explore);
        if (cost?.rtk) await applyRtk(tx, run, cost.rtk);
        if (cost?.guard) await applyTokenGuard(tx, run, cost.guard);
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
    // Gán trong callback của transaction; ép kiểu để TypeScript không thu hẹp về null.
    let briefRun = null as { orgId: string; id: string } | null;
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
      briefRun = await onRepoReport(tx, run, msg.report);
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
    if (briefRun) background(dispatch(briefRun.orgId, briefRun.id), "Không giao được run brief");
  }

  /**
   * Khảo sát trước khi sửa của lần thử hiện tại. Gói cost có thể tới lệch thứ tự: không để số cũ (ít lượt hơn, hay
   * chưa sửa) ghi đè số mới của cùng lần thử; lần thử mới thì ghi đè.
   */
  async function applyExplore(tx: Tx, run: RunRow, explore: RunExplore): Promise<void> {
    const prev = run.explore;
    if (
      prev?.attempt === run.attempt &&
      ((prev.edited && !explore.edited) || (prev.edited === explore.edited && prev.turns > explore.turns))
    ) {
      return;
    }
    await tx
      .update(runs)
      .set({ explore: { ...explore, attempt: run.attempt } })
      .where(eq(runs.id, run.id));
  }

  /** Số RTK luỹ kế của lần thử: gói cost tới lệch thứ tự thì không để số nhỏ hơn ghi đè số đã lưu của cùng lần thử. */
  async function applyRtk(tx: Tx, run: RunRow, rtk: RunRtk): Promise<void> {
    const prev = run.rtk;
    if (prev?.attempt === run.attempt && (prev.commands > rtk.commands || prev.savedTokens > rtk.savedTokens)) return;
    await tx
      .update(runs)
      .set({ rtk: { ...rtk, attempt: run.attempt } })
      .where(eq(runs.id, run.id));
  }

  /** Như applyRtk: số luỹ kế của cùng lần thử không lùi khi gói cost tới lệch thứ tự. */
  async function applyTokenGuard(tx: Tx, run: RunRow, guard: RunTokenGuard): Promise<void> {
    const prev = run.tokenGuard;
    if (
      prev?.attempt === run.attempt &&
      (prev.exploreBlocked > guard.exploreBlocked || prev.truncatedChars > guard.truncatedChars)
    )
      return;
    await tx
      .update(runs)
      .set({ tokenGuard: { ...guard, attempt: run.attempt } })
      .where(eq(runs.id, run.id));
  }

  /**
   * `report.repo` của worker (ADR 0022): ghi độ lệch của brief và, khi nhánh chính đã đi quá xa, xếp run làm mới.
   * Trả run brief mới để giao sau khi commit.
   */
  async function onRepoReport(
    tx: Tx,
    run: RunRow,
    report: Record<string, unknown> | null,
  ): Promise<{ orgId: string; id: string } | null> {
    const parsed = reportRepo.safeParse(report?.repo);
    const briefSha = run.agentPolicySnapshot?.briefSha;
    if (!parsed.success || !parsed.data.baseSha || parsed.data.briefBehind === null || typeof briefSha !== "string")
      return null;
    await recordBriefDrift(tx, run.projectId, {
      briefSha,
      headSha: parsed.data.baseSha,
      behind: parsed.data.briefBehind,
    });
    if (run.kind === "brief" || run.kind === "skill_proposal") return null;
    const project = await loadProject(tx, run.projectId);
    if (!project) return null;
    const queued = await queueBriefIfStale(tx, project, { ownerUserId: run.ownerUserId, by: "drift" });
    return queued ? { orgId: queued.orgId, id: queued.id } : null;
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
    else if (run.kind === "brief") await verifyBrief(orgId, runId);
    else if (run.kind === "skill_proposal") await verifySkillProposal(orgId, runId);
    else if (run.kind === "sdlc") await verifySdlc(orgId, runId);
    else await verifyLeader(orgId, runId);
  }

  /**
   * Run sdlc: file agent ghi (`report.artifacts`) vào bản nháp tài liệu, câu hỏi mở chờ người; module sdlc quyết run
   * đạt hay không (không ghi tài liệu nào và không hỏi gì là lỗi của bước).
   */
  async function verifySdlc(orgId: string, runId: string): Promise<void> {
    await tenant(orgId, async (tx) => {
      const run = await lockRun(tx, runId);
      if (run?.kind !== "sdlc" || run.state !== "verifying") return;
      const data = await resultOf(tx, run);
      const report = (data.report ?? null) as Record<string, unknown> | null;
      const artifacts = sdlcReportArtifacts.safeParse(report?.artifacts ?? []);
      const workerError = typeof report?.error === "string" && report.error ? report.error : null;
      const ok = exitOf(data) === 0 && report?.status !== "failed" && !workerError && artifacts.success;
      const error = ok
        ? null
        : (workerError ??
          (artifacts.success ? "Run soạn tài liệu lỗi hoặc hết thời gian." : "Worker trả tài liệu sai dạng."));
      const out = await onSdlcRunFinished(
        tx,
        { runId: run.id, ok, artifacts: artifacts.success ? artifacts.data : null, error },
        sdlcDeps,
      );
      const succeeded = out ? out.succeeded : ok;
      await transition(
        tx,
        run,
        succeeded ? "succeeded" : "failed",
        { finishedAt: new Date() },
        { message: out?.message ?? error ?? "Run soạn tài liệu đã xong." },
      );
      await recordAudit(tx, {
        action: "sdlc.run.finish",
        actorUserId: null,
        targetType: "run",
        targetId: run.id,
        data: { succeeded, itemId: out?.itemId ?? null },
      });
    });
  }

  /** Run brief: succeeded khi agent đã gọi brief_submit; brief lưu trong cùng transaction với kết luận của run. */
  async function verifyBrief(orgId: string, runId: string): Promise<void> {
    await tenant(orgId, async (tx) => {
      const run = await lockRun(tx, runId);
      if (run?.kind !== "brief" || run.state !== "verifying") return;
      const data = await resultOf(tx, run);
      const [ev] = await tx
        .select({ data: runEvents.data })
        .from(runEvents)
        .where(and(eq(runEvents.runId, run.id), eq(runEvents.attempt, run.attempt), eq(runEvents.type, "brief_report")))
        .orderBy(desc(runEvents.id))
        .limit(1);
      const report = ev?.data as { content: string; commitSha: string } | undefined;
      const ok = exitOf(data) === 0 && Boolean(report);
      if (ok && report) {
        await submitBrief(tx, { kind: "run", runId: run.id, projectId: run.projectId }, report);
      }
      await transition(
        tx,
        run,
        ok ? "succeeded" : "failed",
        { finishedAt: new Date() },
        {
          message: ok
            ? "Đã cập nhật brief của dự án."
            : exitOf(data) === 0
              ? "Agent không nộp brief (brief_submit)."
              : "Run viết brief lỗi hoặc hết thời gian.",
        },
      );
    });
  }

  /**
   * Run đề xuất skill: succeeded khi agent đã gọi skill_proposal_submit (kể cả mảng rỗng). Đề xuất không ghi ở đây:
   * module skilllearn đọc sự kiện `skill_proposal_report` khi run đã kết thúc (nó phụ thuộc runs, không ngược lại).
   */
  async function verifySkillProposal(orgId: string, runId: string): Promise<void> {
    await tenant(orgId, async (tx) => {
      const run = await lockRun(tx, runId);
      if (run?.kind !== "skill_proposal" || run.state !== "verifying") return;
      const data = await resultOf(tx, run);
      const [ev] = await tx
        .select({ data: runEvents.data })
        .from(runEvents)
        .where(
          and(
            eq(runEvents.runId, run.id),
            eq(runEvents.attempt, run.attempt),
            eq(runEvents.type, "skill_proposal_report"),
          ),
        )
        .orderBy(desc(runEvents.id))
        .limit(1);
      const ok = exitOf(data) === 0 && Boolean(ev);
      const count = Array.isArray(ev?.data.proposals) ? ev.data.proposals.length : 0;
      await transition(
        tx,
        run,
        ok ? "succeeded" : "failed",
        { finishedAt: new Date() },
        {
          message: ok
            ? `Agent nộp ${count} đề xuất skill.`
            : exitOf(data) === 0
              ? "Agent không nộp đề xuất (skill_proposal_submit)."
              : "Run đề xuất skill lỗi hoặc hết thời gian.",
        },
      );
    });
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
   * Run khớp quy trình review code (D3): bỏ kiểm tra `review`, kết luận ngay và mở phiên review code thay cho review
   * chéo và hàng merge.
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
      // Run review chéo đã tạo trước khi quy trình được bật thì đi tiếp đường cũ, không bỏ dở run review đó.
      const workflow =
        project && !child
          ? await matchFor(tx, codeReviewRunOf(run, task, project, stats.success ? stats.data : null, PR_TO_OPEN))
          : null;
      return {
        run,
        data,
        hasAgentReport: Boolean(report),
        project,
        task,
        conn,
        reviewCheck: workflow ? undefined : reviewCheck,
        child,
        childReport,
        diffStats: stats.success ? stats.data : undefined,
        workflow,
      };
    });
    if (!ctx) return;
    const { run, data, project, task, reviewCheck, child, workflow } = ctx;
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
      reviewWorkflow: workflow?.workflow.name,
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
      const finished = await transition(
        tx,
        locked,
        outcome,
        { result, prUrl, finishedAt: new Date() },
        { reasons, prUrl },
      );
      if (locked.taskId) await setTaskStatus(tx, locked.taskId, taskStatusFor(outcome, prUrl));
      // Quy trình mở phiên cùng transaction kết luận run: không có PR nào của run khớp quy trình mà không có phiên.
      // Phiên đạt mới vào hàng merge (codereview), nên không vào thẳng ở đây.
      const codeReview =
        workflow && project && (outcome === "succeeded" || outcome === "needs_review")
          ? await startCodeReview(
              tx,
              codeReviewRunOf(
                finished,
                task,
                project,
                ctx.diffStats ?? null,
                prUrl && prNumber !== null ? { number: prNumber, url: prUrl } : null,
                reasons,
              ),
              codeReviewDeps,
              workflow,
            )
          : null;
      if (codeReview) {
        await hubEvent(tx, finished, "code_review", {
          reviewId: codeReview.id,
          workflowId: codeReview.workflowId,
          workflow: codeReview.workflowName,
          round: codeReview.round,
        });
      }
      // Chế độ auto: PR của run đạt chính sách vào thẳng hàng merge, cùng transaction để không có run succeeded mà
      // PR bị bỏ quên ngoài hàng. Chế độ review chờ người đưa vào hàng.
      if (
        !workflow &&
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
        data: {
          outcome,
          prUrl,
          taskId: locked.taskId,
          checks,
          ...(workflow ? { workflowId: workflow.workflow.id, codeReviewId: codeReview?.id ?? null } : {}),
        },
      });
      await notifyOutcome(tx, locked, task, outcome, reasons, prUrl);
      await onCodeRunSettled(tx, finished);
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

  // ---- Quy trình review code (specs/009-code-review-workflows) ------------------------------------------------

  const workflowActor = (workflowId: string | null) => (workflowId ? `workflow:${workflowId}` : "workflow");
  // Không có pg-boss thì hẹn giờ là setTimeout, chạy được trước khi transaction của người gọi commit (run chưa thấy).
  const afterCommitSoon = () => new Date(Date.now() + 1000);

  /**
   * Run review cho checkpoint AI (D4/D5), mỗi reviewer một run chạy song song. Không đặt `parent_run_id`: chỉ mục
   * `runs_review_active` chỉ cho một run con đang sống mỗi run cha, mà một checkpoint có nhiều reviewer; phiên nối với
   * run review qua `code_review_gate_runs.run_ids`, run code của vòng ghi trong sự kiện lời nhắc. Gọi trong transaction
   * của `codereview` nên chỉ giao sau commit (hẹn giờ `dispatch`).
   */
  async function startReviewRuns(tx: Tx, input: StartReviewRunsInput): Promise<StartedReviewRun[]> {
    const project = await loadProject(tx, input.projectId);
    if (!project) throw new NotFoundError("PROJECT_NOT_FOUND", "Không tìm thấy dự án của phiên review code.");
    const [code] = await tx
      .select({ timeoutSec: runs.timeoutSec, prUrl: runs.prUrl })
      .from(runs)
      .where(eq(runs.id, input.parentRunId));
    const sandboxed = sandboxedRun(project, await loadPolicy(tx), "review");
    const online = await listOnlineMachines(tx, project.teamId, sandboxed ? "host" : "worker");
    const by = workflowActor(input.workflowId);
    const started: StartedReviewRun[] = [];
    for (const reviewer of input.reviewers) {
      const [row] = await tx
        .insert(runs)
        .values({
          orgId: sql`hive.ctx_org()`,
          teamId: project.teamId,
          taskId: input.taskId,
          projectId: project.id,
          kind: "review",
          cli: reviewer.cli,
          model: reviewer.model,
          branch: input.branch,
          policySnapshot: [],
          ...(code ? { timeoutSec: code.timeoutSec } : {}),
          createdBy: by,
          ownerUserId: input.ownerUserId,
        })
        .returning();
      if (!row) throw new Error("Không ghi được run review của quy trình.");
      await hubEvent(tx, row, "state", { from: null, to: "queued", by: "workflow", reviewId: input.reviewId });
      await hubEvent(tx, row, REVIEW_PROMPT_EVENT, {
        reviewId: input.reviewId,
        workflowId: input.workflowId,
        codeRunId: input.parentRunId,
        prNumber: input.prNumber,
        prUrl: code?.prUrl ?? null,
        headSha: input.headSha,
        rubric: input.rubric,
        focusPaths: input.focusPaths,
        guidance: input.guidance,
        specContext: input.specContext,
      });
      await notifyRun(tx, row.id);
      await recordAudit(tx, {
        action: "run.start",
        actorUserId: null,
        targetType: "run",
        targetId: row.id,
        data: { taskId: row.taskId, cli: row.cli, kind: "review", by, reviewId: input.reviewId },
      });
      await schedule({ kind: "dispatch", orgId: row.orgId, runId: row.id }, afterCommitSoon(), tx);
      const ready = online.some((m) => m.clis.includes(reviewer.cli) && usableBy(m, row, sandboxed));
      started.push({
        runId: row.id,
        cli: reviewer.cli,
        model: reviewer.model,
        state: ready ? "queued" : "waiting_machine",
      });
    }
    return started;
  }

  /**
   * Run sửa theo góp ý khi phiên trả lại cho agent (D6): run code mới của cùng task, nhánh, CLI và chủ như run của vòng,
   * không lập kế hoạch lại. Gọi trong transaction của `codereview` nên chỉ giao sau commit.
   */
  async function queueFixRun(tx: Tx, input: QueueFixRunInput): Promise<{ runId: string }> {
    const [run] = await tx.select().from(runs).where(eq(runs.id, input.runId));
    const task = run?.taskId ? await loadTask(tx, run.taskId) : null;
    if (!run || !task) throw new NotFoundError("RUN_NOT_FOUND", "Không tìm thấy run code hay task của phiên review.");
    const { row } = await queueRun(tx, task, await loadProject(tx, run.projectId), {
      cli: run.cli,
      model: run.model,
      createdBy: workflowActor(input.workflowId),
      actorUserId: null,
      ownerUserId: run.ownerUserId,
      instructions: [input.instructions],
      plan: false,
    });
    await schedule({ kind: "dispatch", orgId: row.orgId, runId: row.id }, afterCommitSoon(), tx);
    return { runId: row.id };
  }

  /** Bằng chứng của run code cho checkpoint quy tắc: kết quả của lần thử cuối, đọc lại mỗi lần phiên đi tiếp. */
  async function runEvidence(tx: Tx, runId: string): Promise<RunEvidence | null> {
    const [run] = await tx.select().from(runs).where(eq(runs.id, runId));
    if (!run) return null;
    const data = await resultOf(tx, run);
    const [report] = await tx
      .select({ id: runEvents.id })
      .from(runEvents)
      .where(and(eq(runEvents.runId, run.id), eq(runEvents.attempt, run.attempt), eq(runEvents.type, "agent_report")))
      .limit(1);
    const task = run.taskId ? await loadTask(tx, run.taskId) : null;
    const stats = diffStats.safeParse(data.diffStats);
    const commands = checkCommandResult.array().safeParse((data.report as Record<string, unknown> | null)?.commands);
    return {
      headSha: typeof data.headSha === "string" ? data.headSha : run.headSha,
      taskType: task?.type ?? null,
      stats: stats.success ? stats.data : null,
      // Worker cũ không có `commands`: null để checkpoint chờ người thay vì coi như mọi lệnh đạt.
      commands: commands.success ? commands.data : null,
      hasAgentReport: Boolean(report),
    };
  }

  /** Bước của run sdlc thành lỗi (mất máy, huỷ) để giai đoạn không đứng chờ một run đã chết. */
  async function sdlcFailed(tx: Tx, run: RunRow, error: string, cancelled = false): Promise<void> {
    await onSdlcRunFinished(tx, { runId: run.id, ok: false, artifacts: null, error, cancelled }, sdlcDeps);
  }

  /**
   * Run sdlc cho một bước agent (D5): như doccheck, không có task, lời nhắc và seed/collect ghi ở sự kiện `sdlc_prompt`.
   * Gọi trong transaction của `sdlc` (job advance, route, kết luận run trước) nên chỉ giao sau commit.
   */
  async function startSdlcRun(tx: Tx, req: SdlcRunRequest): Promise<{ runId: string } | null> {
    const project = await loadProject(tx, req.projectId);
    if (!project || !projectReady(project)) return null;
    const [row] = await tx
      .insert(runs)
      .values({
        orgId: sql`hive.ctx_org()`,
        teamId: project.teamId,
        taskId: null,
        projectId: project.id,
        kind: "sdlc",
        cli: req.cli,
        model: req.model,
        branch: `sdlc/${req.stepRowId}`,
        policySnapshot: [],
        requiredLabels: req.requiredLabels,
        createdBy: req.createdBy,
        ownerUserId: req.ownerUserId,
      })
      .returning();
    if (!row) throw new Error("Không ghi được run soạn tài liệu.");
    await hubEvent(tx, row, "state", { from: null, to: "queued", by: req.createdBy });
    await hubEvent(tx, row, "sdlc_prompt", {
      itemId: req.itemId,
      stepRowId: req.stepRowId,
      title: req.title,
      prompt: req.prompt,
      sdlc: req.job,
    });
    await notifyRun(tx, row.id);
    await recordAudit(tx, {
      action: "run.start",
      actorUserId: null,
      targetType: "run",
      targetId: row.id,
      data: {
        kind: "sdlc",
        itemId: req.itemId,
        stepRowId: req.stepRowId,
        labels: req.requiredLabels,
        by: req.createdBy,
      },
    });
    await schedule({ kind: "dispatch", orgId: row.orgId, runId: row.id }, afterCommitSoon(), tx);
    return { runId: row.id };
  }

  /** Cổng `sdlc`: bước kế tự chạy sau khi run soạn xong tạo run sdlc mới qua chính engine này. */
  const sdlcDeps: SdlcDeps = withStepRuns({
    jobs: deps.jobs,
    publicUrl: deps.publicUrl,
    providerFactory: deps.providerFactory,
    masterKey: deps.masterKey,
    createSdlcRun: startSdlcRun,
    startTaskRun: startSdlcTaskRun,
  });

  /** Đợt AI SDLC: run code của task như người giao tay, chủ và nhãn máy theo cài đặt dự án của task (D24). */
  async function startSdlcTaskRun(tx: Tx, req: SdlcTaskRunRequest) {
    const task = await loadTask(tx, req.taskId);
    if (!task) throw new NotFoundError("TASK_NOT_FOUND", "Không tìm thấy task.");
    const { row, afterCommit } = await queueRun(tx, task, await loadProject(tx, task.projectId), {
      cli: task.preferredCli ?? null,
      createdBy: req.createdBy,
      actorUserId: req.actorUserId,
      ownerUserId: req.ownerUserId,
      requiredLabels: req.requiredLabels,
    });
    return { runId: row.id, afterCommit };
  }

  /** Cổng `codereview` dùng khi `runs` mở phiên hay báo run review xong trong transaction của mình. */
  const codeReviewDeps: CodeReviewDeps = {
    jobs: deps.jobs,
    publicUrl: deps.publicUrl,
    providerFactory: deps.providerFactory,
    masterKey: deps.masterKey,
    startReviewRuns,
    queueFixRun,
    runEvidence,
  };

  /**
   * Run review: succeeded khi agent đã gọi review_submit (tương đương `agentReport` trên `review_report`). Xong thì
   * đăng nhận xét lên PR của run cha và chạy lại chính sách của run cha. Run review của checkpoint AI trong quy trình
   * review code thì báo phiên; phiên gộp kết quả các reviewer và tự đăng một bình luận tổng hợp.
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
      if (locked?.state !== "verifying") return null;
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
      const workflow = await childFinished(tx, locked, {
        state: ev.outcome,
        review: review && {
          score: review.score,
          summary: review.summary,
          findings: review.findings.map((f) => ({ ...f, line: f.line ?? null })),
          checklist: review.checklist?.map((c) => ({ ...c, note: c.note ?? null })),
        },
        error: ev.outcome === "succeeded" ? null : (ev.reasons[0] ?? null),
      });
      return { workflow };
    });
    if (!finished || finished.workflow) return;
    if (ev.outcome === "succeeded" && review) {
      background(postReview(ctx, review), `Không đăng được review của run ${run.id} lên PR`);
    }
    if (run.parentRunId) background(verify(orgId, run.parentRunId), `verifying run ${run.parentRunId} lỗi`);
  }

  /**
   * Run review hay run plan kết thúc theo bất kỳ đường nào (xong, lỗi, hết lượt, bị huỷ): hẹn chạy lại verify của run
   * cha trong cùng transaction, để hub chết ngay sau commit thì hẹn giờ vẫn kết luận được run cha. Run review thuộc
   * phiên review code thì báo phiên trong cùng transaction thay vì run cha, và trả true.
   */
  async function childFinished(tx: Tx, run: RunRow, ended?: Omit<FinishedReviewRun, "id">): Promise<boolean> {
    if (run.kind === "review" && ended && (await onReviewRunFinished(tx, { id: run.id, ...ended }, codeReviewDeps))) {
      return true;
    }
    if (run.kind === "code" || !run.parentRunId) return false;
    await schedule({ kind: "verify", orgId: run.orgId, runId: run.parentRunId }, new Date(Date.now() + 1000), tx);
    return false;
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
        // Người giao việc là người duyệt: vào hộp thư của họ và tới chat của họ (nếu đã liên kết) kèm nút Duyệt/Trả lại.
        recipientIds: [run.createdBy],
        actions: task
          ? [
              { kind: "plan.approve", taskId: task.id, planId: plan.id },
              { kind: "plan.reject", taskId: task.id, planId: plan.id },
            ]
          : [],
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
          await onCodeRunSettled(tx, { ...run, state: "failed" });
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
        if (run.kind === "sdlc") await sdlcFailed(tx, run, "Máy chạy bước AI SDLC mất kết nối.");
        await childFinished(tx, run, { state: "failed", review: null, error: reasons[0] ?? null });
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
    if (t.kind === "dispatch") {
      await dispatch(t.orgId, t.runId);
      return;
    }
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
      await onCodeRunSettled(tx, row);
    } else if (run.kind === "sdlc") {
      await sdlcFailed(tx, run, "Run soạn tài liệu đã bị huỷ.", true);
    } else if (run.kind === "leader" && run.leaderThreadId) {
      await deps.leaderMessage?.(tx, run.leaderThreadId, "Leader run đã bị huỷ.");
    } else if (run.kind === "doccheck") {
      await docCheckDone(tx, run, null, "Run kiểm tài liệu đã bị huỷ.");
    } else await childFinished(tx, run, { state: "cancelled", review: null, error: "Run review đã bị huỷ." });
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
    const cli = input.cli ?? task.preferredCli ?? null;
    if (cli && FULL_ONLY_CLIS.includes(cli) && project) {
      const policy = await loadPolicy(tx);
      const mode = resolvePermission(policy, project.settings.runPermissions?.mode ?? "workspace").mode;
      // Dự án không cho toàn quyền vẫn chạy được trên máy người dùng được dùng đã bật toàn quyền cho dự án (ADR 0020).
      const machineFull =
        policy.allowFullPermission &&
        (await machinesGrantingFull(tx, task.teamId, project.id)).some(
          (m) => usableBy(m, { ownerUserId: userId }, false) && (!input.machineId || m.id === input.machineId),
        );
      if (mode !== "full" && !machineFull) {
        throw new ConflictError(
          "CLI_NEEDS_FULL_PERMISSIONS",
          "Antigravity chỉ chạy run code khi có toàn quyền: agy không giới hạn được trong thư mục làm việc. Chọn CLI khác, đổi quyền run của dự án, hoặc bật “Cho toàn quyền trên máy này” cho dự án ở màn Dự án trên máy của app desktop.",
        );
      }
    }
    const { row, afterCommit } = await queueRun(tx, task, project, {
      cli,
      model: input.model ?? null,
      tier: input.tier ?? null,
      machineId: input.machineId ?? null,
      createdBy: userId,
      ownerUserId: userId,
    });
    return { run: toRun(row), afterCommit };
  }

  async function startLeaderRun(
    tx: Tx,
    userId: string,
    input: { threadId: string; projectId: string; prompt: string; cli?: RunRow["cli"]; model?: string | null },
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
    if (input.cli && NO_READONLY_MCP_CLIS.includes(input.cli)) {
      throw new BadRequestError(
        "CLI_CANNOT_SUBMIT",
        `${input.cli} chưa gọi được tool MCP khi chạy chỉ đọc nên không trả lời được trong chat; chọn Claude hoặc Codex.`,
      );
    }
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
        model: input.model ?? (input.cli ? (project.settings.models?.[input.cli]?.leader ?? null) : null),
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
      /** Cấp độ task do người đặt tay; bỏ trống thì hub suy lúc giao (routing.ts). */
      tier?: RunRow["tier"];
      machineId?: string | null;
      createdBy: string;
      /** null: thao tác của hệ thống. Bỏ trống thì audit lấy người dùng trong context. */
      actorUserId?: string | null;
      /** Người được dùng máy cá nhân của mình cho run (ADR 0017); bỏ trống là run của đội, chỉ máy dùng chung nhận. */
      ownerUserId?: string | null;
      instructions?: string[];
      /** Lập kế hoạch trước; bỏ trống thì theo cờ `features.planMode` của dự án. */
      plan?: boolean;
      /** Nhãn máy bắt buộc (đợt AI SDLC truyền theo dự án của task); bỏ trống thì task hạng mục lấy nhãn của dự án. */
      requiredLabels?: string[];
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
    // Mọi đường tạo run code (web, app, Leader, @bot, issue, run sửa của review code) đều qua đây (D10).
    const gate = await codeRunGate(tx, { taskId: task.id, kind: "code" });
    if (gate.block) throw new ConflictError(gate.code, gate.message, { itemId: gate.itemId, missing: gate.missing });
    await assertTaskBudget(tx, task.id, project.settings.budget);
    const requiredLabels = opts.requiredLabels ?? (gate.itemId ? (project.settings.sdlc?.labels ?? []) : []);
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
          tier: opts.tier ?? null,
          pinnedMachineId: opts.machineId ?? null,
          branch: `ai/${task.key}`,
          policySnapshot: policy,
          requiredLabels,
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
    if (!gate.block && gate.warn)
      await hubEvent(tx, row, "sdlc_gate_warn", { message: gate.warn, itemId: gate.itemId });
    if (!gate.block && gate.overrideId)
      await hubEvent(tx, row, "sdlc.override_used", { overrideId: gate.overrideId, itemId: gate.itemId });
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
    const brief = await queueBriefIfStale(tx, project, { ownerUserId: opts.ownerUserId ?? null, by: opts.createdBy });
    return {
      row,
      afterCommit: () => {
        background(dispatch(orgId, id), "Không giao được run");
        if (brief) background(dispatch(brief.orgId, brief.id), "Không giao được run brief");
      },
    };
  }

  /**
   * Xếp run viết lại brief khi dự án bật làm mới tự động và brief chưa có, đã cũ theo số commit hay số ngày (ADR 0022).
   * Run brief đi bằng máy của người giao run gây ra nó khi có, để dự án không có máy dùng chung vẫn có brief.
   */
  async function queueBriefIfStale(
    tx: Tx,
    project: ProjectRow,
    opts: { ownerUserId: string | null; by: string },
  ): Promise<RunRow | null> {
    const settings = project.settings.brief;
    if (!settings.auto || !projectReady(project)) return null;
    const reason = briefStaleness(await loadBrief(tx, project.id), settings);
    if (!reason) return null;
    // Không máy nào chạy được (worker cũ, chỉ có máy cá nhân của người khác) thì không xếp: run nằm chờ mãi chỉ làm
    // rối danh sách run; lần giao sau sẽ thử lại.
    const sandboxed = sandboxedRun(project, await loadPolicy(tx), "brief");
    const online = await listOnlineMachines(tx, project.teamId, sandboxed ? "host" : "worker");
    const owner = { ownerUserId: opts.ownerUserId };
    if (!online.some((m) => m.capabilities.includes("brief") && usableBy(m, owner, sandboxed))) return null;
    return createBriefRun(tx, project, { ...opts, reason });
  }

  /** Run brief của dự án; đã có run đang sống thì trả null (index runs_brief_active giữ mỗi dự án một run). */
  async function createBriefRun(
    tx: Tx,
    project: ProjectRow,
    opts: { ownerUserId: string | null; by: string; reason: BriefStaleness | "manual" },
  ): Promise<RunRow | null> {
    if (await activeBriefRun(tx, project.id)) return null;
    const [row] = await tx
      .insert(runs)
      .values({
        orgId: sql`hive.ctx_org()`,
        teamId: project.teamId,
        taskId: null,
        projectId: project.id,
        kind: "brief",
        cli: null,
        model: null,
        branch: briefBranch(project.key),
        policySnapshot: [],
        // Chỉ đọc và tóm tắt: không cần thời hạn một giờ của run code.
        timeoutSec: 20 * 60,
        createdBy: opts.by,
        ownerUserId: opts.ownerUserId,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) return null;
    await hubEvent(tx, row, "state", { from: null, to: "queued", by: opts.by });
    await notifyRun(tx, row.id);
    await recordAudit(tx, {
      action: "brief.run.start",
      actorUserId: opts.reason === "manual" ? undefined : null,
      targetType: "run",
      targetId: row.id,
      data: { projectId: project.id, reason: opts.reason },
    });
    return row;
  }

  /**
   * Run đề xuất skill của một lô (specs/014), module skilllearn gọi trong transaction của nó. Chỉ chạy trên máy dùng
   * chung đã khai `skill_proposal`: không ai bấm nên không có máy cá nhân nào để dùng. Không có máy thì trả lý do để lô
   * thử lại sau, thay vì xếp một run nằm chờ mãi.
   */
  async function createSkillProposalRun(
    tx: Tx,
    input: { projectId: string; batchId: string; prompt: string },
  ): Promise<
    { ok: true; runId: string; afterCommit: () => void } | { ok: false; reason: "project_not_ready" | "no_machine" }
  > {
    const project = await loadProject(tx, input.projectId);
    if (!project || !projectReady(project)) return { ok: false, reason: "project_not_ready" };
    const sandboxed = sandboxedRun(project, await loadPolicy(tx), "skill_proposal");
    const online = await listOnlineMachines(tx, project.teamId, sandboxed ? "host" : "worker");
    const owner = { ownerUserId: null };
    if (!online.some((m) => m.capabilities.includes("skill_proposal") && usableBy(m, owner, sandboxed)))
      return { ok: false, reason: "no_machine" };
    const [row] = await tx
      .insert(runs)
      .values({
        orgId: sql`hive.ctx_org()`,
        teamId: project.teamId,
        taskId: null,
        projectId: project.id,
        kind: "skill_proposal",
        cli: null,
        model: null,
        branch: `skill-learning/${input.batchId}`,
        policySnapshot: [],
        // Chỉ đọc bản tóm tắt: không cần thời hạn một giờ của run code.
        timeoutSec: 20 * 60,
        createdBy: "system",
        ownerUserId: null,
      })
      .returning();
    if (!row) throw new Error("Không tạo được run đề xuất skill.");
    await hubEvent(tx, row, "state", { from: null, to: "queued", by: "skill-learning" });
    await hubEvent(tx, row, "skill_proposal_prompt", { batchId: input.batchId, prompt: input.prompt });
    await notifyRun(tx, row.id);
    await recordAudit(tx, {
      action: "skill_learning.run.start",
      actorUserId: null,
      targetType: "run",
      targetId: row.id,
      data: { projectId: project.id, batchId: input.batchId },
    });
    const { orgId, id } = row;
    return {
      ok: true,
      runId: id,
      afterCommit: () => background(dispatch(orgId, id), "Không giao được run đề xuất skill"),
    };
  }

  async function activeBriefRun(tx: Tx, projectId: string): Promise<string | null> {
    const [active] = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(eq(runs.projectId, projectId), eq(runs.kind, "brief"), notInArray(runs.state, [...TERMINAL_RUN_STATES])),
      )
      .limit(1);
    return active?.id ?? null;
  }

  /** "Làm mới" trên web: thành viên đội của dự án; run đi bằng máy của người bấm hoặc máy dùng chung. */
  async function refreshBrief(tx: Tx, userId: string, ref: string) {
    const found = await findProject(tx, ref);
    if (!found) throw new NotFoundError("PROJECT_NOT_FOUND", "Không tìm thấy dự án trong tổ chức.");
    const project = await projectFor(tx, userId, found.id, "member");
    if (!projectReady(project)) throw new ConflictError("PROJECT_NOT_READY", "Dự án chưa khởi tạo xong repo.");
    const active = await activeBriefRun(tx, project.id);
    if (active) return { runId: active, afterCommit: () => undefined };
    const row = await createBriefRun(tx, project, { ownerUserId: userId, by: userId, reason: "manual" });
    if (!row) throw new ConflictError("BRIEF_RUN_ACTIVE", "Dự án đang có run viết brief.");
    const { orgId, id } = row;
    return { runId: id, afterCommit: () => background(dispatch(orgId, id), "Không giao được run brief") };
  }

  /**
   * Run plan con của run code: cùng task, cùng CLI và máy chỉ định, nhánh của run cha chỉ để xem (worker đọc nhánh
   * chính). Model chỉ chép khi người giao chọn tay; không thì dispatch lấy model `plan` của dự án.
   */
  async function createPlanRun(tx: Tx, parent: RunRow, model: string | null | undefined): Promise<RunRow> {
    // CLI của run cha không nộp được kế hoạch thì để dispatch chọn Claude hoặc Codex; model chọn tay là của CLI cha.
    const keep = !parent.cli || !NO_READONLY_MCP_CLIS.includes(parent.cli);
    const [row] = await tx
      .insert(runs)
      .values({
        orgId: parent.orgId,
        teamId: parent.teamId,
        taskId: parent.taskId,
        projectId: parent.projectId,
        kind: "plan",
        parentRunId: parent.id,
        cli: keep ? parent.cli : null,
        model: keep ? (model ?? null) : null,
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
    // Bản sửa và ghi chú đi thẳng vào prompt của agent như một chỉ dẫn, nên chịu cùng luật với steer. Duyệt nguyên bản
    // kế hoạch agent nộp thì không đưa chữ mới vào run của người khác.
    if (run.ownerUserId && (edited || note)) await assertRunActor(tx, run, userId, "admin-or-owner");
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
        tier: run.tier,
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
    // Run của đội (không chủ) chạy trên máy dùng chung nên thành viên huỷ được; run của người khác trên máy cá nhân của
    // họ thì chỉ chủ hoặc quản trị đội huỷ.
    if (run.ownerUserId) await assertRunActor(tx, run, userId, "admin-or-owner");
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
      .for("no key update");
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
    /** Run sdlc của bước agent; main.ts cài vào `SdlcDeps.createSdlcRun` (sdlc không import runs). */
    startSdlcRun,
    sdlcDeps,
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
    /** Run đề xuất skill của lô hằng ngày; main.ts đưa vào module skilllearn (nó phụ thuộc runs, không ngược lại). */
    skillLearning: { createRun: createSkillProposalRun },
    /**
     * Cổng cho `codereview` (CodeReviewDeps): main.ts cài vào worker của hàng đợi `codereview`, vì `codereview` không
     * import `runs`.
     */
    startReviewRuns,
    queueFixRun,
    runEvidence,
    /** Brief của dự án; router của knowledge gọi qua đây (knowledge không import runs). */
    briefs: { activeRun: activeBriefRun, refresh: refreshBrief },
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

/**
 * Ai được tác động vào run đã có chủ (ADR 0017: máy cá nhân chỉ chạy việc của chủ, nên chỉ dẫn gửi vào run đó là chạy
 * lệnh trên máy và tài khoản CLI của chủ).
 * - `owner`: chỉ chủ run; run của đội (không chủ) thì quản trị đội sở hữu hoặc quản trị tổ chức.
 * - `admin-or-owner`: chủ run hoặc quản trị đội; dùng cho thao tác không đưa chữ vào agent (huỷ).
 * Run tạo trước ADR 0017 cũng không có chủ nên xử lý như run của đội.
 */
export async function assertRunActor(
  tx: Tx,
  run: Pick<RunRow, "ownerUserId" | "teamId">,
  userId: string,
  rule: "owner" | "admin-or-owner",
): Promise<void> {
  if (run.ownerUserId === userId) return;
  if (run.ownerUserId === null || rule === "admin-or-owner") {
    if ((await teamRoleOf(tx, userId, run.teamId)) === "admin") return;
  }
  throw new ForbiddenError(
    "RUN_NOT_YOURS",
    run.ownerUserId === null
      ? "Run của đội: chỉ quản trị đội hoặc quản trị tổ chức mới thao tác được."
      : "Run này chạy trên máy cá nhân của người khác; chỉ người giao run mới thao tác được.",
  );
}
