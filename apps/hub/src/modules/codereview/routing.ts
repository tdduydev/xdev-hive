import {
  type AiReviewerResult,
  aiReviewerResult,
  type CodeOptions,
  type RejectRoute,
  type ReviewGate,
} from "@xdev-hive/contracts";
import type { CheckCommandResult, DiffStats } from "@xdev-hive/contracts/worker-protocol";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { recordAudit } from "../audit/index.ts";
import { flatGates } from "../knowledge/index.ts";
import { notify } from "../notify/index.ts";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  type Jobs,
  NotFoundError,
  type Tx,
} from "../platform/index.ts";
import { setTaskStatus } from "../tasks/index.ts";
import { codeReviewGateRuns, codeReviews } from "./schema.ts";

// File này không import `service.ts`: `service.ts` gọi vào đây khi checkpoint tự động không đạt và khi mở vòng mới,
// mà `pnpm deps` cấm vòng (kể cả import kiểu). Bước "đi tiếp từ checkpoint" vì thế do người gọi truyền vào (`Resume`).

type ReviewRow = typeof codeReviews.$inferSelect;
type GateRunRow = typeof codeReviewGateRuns.$inferSelect;

/** Trạng thái còn mở: mỗi PR tối đa một phiên ở các trạng thái này (chỉ mục `code_reviews_open_pr`). */
const OPEN = ["in_review", "changes_requested", "approved"];

/** Chỉ dẫn cho run sửa tối đa chừng này ký tự (FR-024), bằng giới hạn của sự kiện `steer`. */
export const FIX_INSTRUCTIONS_MAX = 16_000;
/** Đuôi output của mỗi lệnh lỗi; nhiều lệnh lỗi vẫn còn chỗ cho góp ý và phát hiện AI. */
const TAIL_MAX = 4_000;
const FINDINGS_MAX = 50;
const DEFAULT_MAX_AGENT_REVISIONS = 2;

/** Run code sửa theo góp ý (D6); dùng ở hướng trả lại `agent`. */
export interface QueueFixRunInput {
  reviewId: string;
  workflowId: string | null;
  /** Run code của vòng bị trả lại: run sửa cùng task, nhánh, CLI, chủ. */
  runId: string;
  instructions: string;
}

export interface RoutingDeps {
  jobs?: Jobs | undefined;
  publicUrl?: string | undefined;
  /** Tạo run sửa (module `runs` cài vào). Không có thì hướng `agent` chuyển về người giao việc. */
  queueFixRun?: ((tx: Tx, input: QueueFixRunInput) => Promise<{ runId: string }>) | undefined;
  /** Đọc kết quả lệnh kiểm của run code để đưa đuôi lệnh lỗi vào chỉ dẫn. */
  runEvidence?:
    | ((tx: Tx, runId: string) => Promise<{ headSha: string | null; commands: CheckCommandResult[] | null } | null>)
    | undefined;
  /** Huỷ run review của vòng bị thay; không có thì run chạy nốt và kết quả tới muộn bị bỏ qua. */
  cancelRun?: ((tx: Tx, runId: string, reason: string) => Promise<void>) | undefined;
}

/** Đặt phiên ở checkpoint `index` (trạng thái `in_review`) rồi đi tiếp; người gọi cấp vì máy trạng thái ở `service.ts`. */
export type Resume = (tx: Tx, review: ReviewRow, index: number) => Promise<void>;

const reviewLink = (publicUrl: string | undefined, id: string) =>
  publicUrl ? `${publicUrl.replace(/\/+$/, "")}/knowledge/reviews?tab=code&id=${id}` : null;

const auditReview = (
  tx: Tx,
  action: string,
  review: ReviewRow,
  data: Record<string, unknown>,
  actorUserId: string | null = null,
) =>
  recordAudit(tx, {
    action,
    actorUserId,
    targetType: "code_review",
    targetId: review.id,
    data: { projectId: review.projectId, prNumber: review.prNumber, headSha: review.headSha, ...data },
  });

const optionsOf = (review: ReviewRow) => review.options as Partial<CodeOptions>;

// ---- Chỉ dẫn cho run sửa -------------------------------------------------------------------------------------------

export interface FixContext {
  prNumber: number;
  workflowName: string;
  gateName: string;
  note: string;
  findings: { file: string; line: number | null; severity: string; message: string }[];
  /** Mục không đạt của checkpoint quy tắc: nhãn và ghi chú. */
  failedRules: { label: string; note: string | null }[];
  failedCommands: CheckCommandResult[];
}

const tailOf = (s: string, max: number) => (s.length > max ? `…${s.slice(s.length - max + 1)}` : s);

/**
 * Chỉ dẫn cho agent (FR-024): góp ý trước vì là phần người duyệt viết, rồi phát hiện AI mức chặn, mục quy tắc không đạt
 * và đuôi lệnh lỗi. Cắt ở `FIX_INSTRUCTIONS_MAX` để không vượt giới hạn của `steer`.
 */
export function fixInstructions(c: FixContext): string {
  const parts = [
    `PR #${c.prNumber} bị trả lại ở checkpoint “${c.gateName}” của quy trình ${c.workflowName}. Sửa theo góp ý dưới đây trên nhánh hiện tại, commit và đẩy lên; PR sẽ tự mở vòng review mới.`,
    `Góp ý:\n${c.note}`,
  ];
  if (c.findings.length) {
    const shown = c.findings.slice(0, FINDINGS_MAX);
    const more = c.findings.length - shown.length;
    parts.push(
      `Phát hiện của reviewer AI cần sửa:\n${shown
        .map((f) => `- [${f.severity}] ${f.file}${f.line ? `:${f.line}` : ""}: ${f.message}`)
        .join("\n")}${more > 0 ? `\n- … và ${more} phát hiện khác.` : ""}`,
    );
  }
  if (c.failedRules.length)
    parts.push(
      `Quy tắc không đạt:\n${c.failedRules.map((r) => `- ${r.label}${r.note ? `: ${r.note}` : ""}`).join("\n")}`,
    );
  for (const cmd of c.failedCommands)
    parts.push(
      `Lệnh \`${cmd.run}\` lỗi (mã thoát ${cmd.exit ?? "không có"}), đuôi output:\n\`\`\`\n${tailOf(cmd.tail, TAIL_MAX)}\n\`\`\``,
    );
  const text = parts.join("\n\n");
  return text.length > FIX_INSTRUCTIONS_MAX ? `${text.slice(0, FIX_INSTRUCTIONS_MAX - 1)}…` : text;
}

const BLOCKING = { critical: ["critical"], major: ["critical", "major"] } as const;

/** Phát hiện AI mức chặn và kết quả quy tắc không đạt của vòng này, để agent sửa đúng chỗ. */
async function fixContext(
  tx: Tx,
  review: ReviewRow,
  gate: ReviewGate,
  note: string,
  deps: RoutingDeps,
): Promise<FixContext> {
  const flat = flatGates(review.phases);
  const runs = await tx
    .select()
    .from(codeReviewGateRuns)
    .where(and(eq(codeReviewGateRuns.reviewId, review.id), eq(codeReviewGateRuns.headSha, review.headSha)))
    .orderBy(desc(codeReviewGateRuns.startedAt));
  const latest = new Map<number, GateRunRow>();
  for (const r of runs) if (!latest.has(r.gateIndex)) latest.set(r.gateIndex, r);

  const findings: FixContext["findings"] = [];
  const failedRules: FixContext["failedRules"] = [];
  let wantCommands = false;
  for (const { gate: g, index } of flat) {
    const r = latest.get(index);
    if (!r) continue;
    if (g.kind === "ai") {
      // Checkpoint không chặn theo mức thì vẫn đưa phát hiện nghiêm trọng/lớn: agent sửa luôn đỡ một vòng.
      const levels: readonly string[] = BLOCKING[g.ai?.blockOn ?? "major"];
      for (const d of r.details) {
        const parsed = aiReviewerResult.safeParse(d);
        const result: AiReviewerResult | null = parsed.success ? parsed.data : null;
        for (const f of result?.findings ?? []) if (levels.includes(f.severity)) findings.push(f);
      }
    }
    if (g.kind === "rule" && r.status === "failed") {
      for (const item of r.checklist) if (!item.passed) failedRules.push({ label: item.label, note: item.note });
      if (g.rules?.includes("command")) wantCommands = true;
    }
  }
  let failedCommands: CheckCommandResult[] = [];
  if (wantCommands) {
    const ev = await deps.runEvidence?.(tx, review.runId);
    if (ev?.commands && ev.headSha === review.headSha) failedCommands = ev.commands.filter((c) => c.exit !== 0);
  }
  return {
    prNumber: review.prNumber,
    workflowName: review.workflowName,
    gateName: gate.name,
    note,
    findings,
    failedRules,
    failedCommands,
  };
}

// ---- Trả lại -------------------------------------------------------------------------------------------------------

export interface ReturnInput {
  /** Checkpoint trả lại và lượt chạy của nó (đã ghi `failed`). */
  gateIndex: number;
  gate: ReviewGate;
  gateRunId: string;
  /** Hướng xin; checkpoint tự động không đạt dùng `gate.onReject` (FR-023). */
  route: RejectRoute;
  note: string;
  /** null khi checkpoint tự động trả lại. */
  actorUserId: string | null;
}

export interface Routed {
  review: ReviewRow;
  route: RejectRoute;
  /** Vì sao hướng thật khác hướng xin; null khi đúng hướng xin. */
  reason: string | null;
  fixRunId: string | null;
}

const isBusinessError = (e: unknown) =>
  e instanceof BadRequestError ||
  e instanceof ConflictError ||
  e instanceof NotFoundError ||
  e instanceof ForbiddenError;

/**
 * Tạo run sửa trong savepoint: `queueRun` có thể vướng chỉ mục "một run đang chạy mỗi task" (lỗi Postgres), mà lỗi
 * Postgres làm hỏng cả transaction của người duyệt nếu không lùi về savepoint.
 */
async function tryFixRun(
  tx: Tx,
  input: QueueFixRunInput,
  deps: RoutingDeps,
): Promise<{ runId: string } | { error: string }> {
  if (!deps.queueFixRun) return { error: "Hub chưa nối được run sửa." };
  await tx.execute(sql`savepoint code_review_fix_run`);
  try {
    const out = await deps.queueFixRun(tx, input);
    await tx.execute(sql`release savepoint code_review_fix_run`);
    return out;
  } catch (e) {
    await tx.execute(sql`rollback to savepoint code_review_fix_run`);
    await tx.execute(sql`release savepoint code_review_fix_run`);
    if (!isBusinessError(e)) throw e;
    const code = (e as { code?: string }).code;
    if (code === "TASK_BUDGET_EXHAUSTED") return { error: "Task đã dùng hết ngân sách." };
    return { error: `Không tạo được run sửa: ${(e as Error).message}` };
  }
}

/** Hướng `agent`: tạo run sửa nếu còn lượt và còn ngân sách; trả lý do khi phải về người giao việc (FR-025). */
async function toAgent(
  tx: Tx,
  review: ReviewRow,
  input: ReturnInput,
  deps: RoutingDeps,
): Promise<{ runId: string } | { error: string }> {
  const max = optionsOf(review).maxAgentRevisions ?? DEFAULT_MAX_AGENT_REVISIONS;
  if (review.agentRevisions >= max)
    return {
      error: max === 0 ? "Quy trình không cho agent tự sửa." : `Đã dùng hết ${max} lượt agent sửa của PR này.`,
    };
  if (!review.taskId) return { error: "PR không gắn task nên agent không sửa được." };
  const instructions = fixInstructions(await fixContext(tx, review, input.gate, input.note, deps));
  return tryFixRun(tx, { reviewId: review.id, workflowId: review.workflowId, runId: review.runId, instructions }, deps);
}

/** Checkpoint người duyệt gần nhất phía trước `index`; null khi không có. */
export function previousHumanGate(review: ReviewRow, index: number): number | null {
  return (
    flatGates(review.phases)
      .slice(0, index)
      .reverse()
      .find((f) => f.gate.kind === "human")?.index ?? null
  );
}

async function notifyReturned(
  tx: Tx,
  review: ReviewRow,
  gateName: string,
  note: string,
  reason: string | null,
  eventKey: string,
  deps: RoutingDeps,
) {
  if (!review.requesterUserId) return;
  await notify(
    tx,
    {
      orgId: review.orgId,
      event: "code_review.returned",
      title: `PR #${review.prNumber} bị trả lại`,
      body: [
        `Checkpoint “${gateName}” của quy trình ${review.workflowName} trả lại PR #${review.prNumber} (${review.branch}) cho bạn sửa.`,
        reason ? `Không giao agent sửa: ${reason}` : null,
        `Góp ý:\n${note}`,
        "Đẩy commit mới lên nhánh PR (hoặc giao lại task) để mở vòng review mới.",
      ]
        .filter(Boolean)
        .join("\n\n"),
      eventKey,
      recipientIds: [review.requesterUserId],
      link: reviewLink(deps.publicUrl, review.id),
    },
    { jobs: deps.jobs },
  );
}

/** Hướng `author`: phiên chờ commit mới, task về `todo`, người giao việc được báo kèm góp ý (US4 kịch bản 3). */
async function toAuthor(
  tx: Tx,
  review: ReviewRow,
  gateName: string,
  note: string,
  reason: string | null,
  eventKey: string,
  deps: RoutingDeps,
): Promise<ReviewRow> {
  const [row] = await tx
    .update(codeReviews)
    .set({ status: "changes_requested", route: "author", updatedAt: sql`now()` })
    .where(eq(codeReviews.id, review.id))
    .returning();
  if (review.taskId) await setTaskStatus(tx, review.taskId, "todo");
  await notifyReturned(tx, row ?? review, gateName, note, reason, eventKey, deps);
  return row ?? review;
}

/**
 * Trả lại PR theo hướng (FR-023–FR-025). Lượt checkpoint đã được người gọi ghi `failed`. `agent` tạo run sửa và đếm một
 * lượt; hết lượt, hết ngân sách hay không tạo được run thì về `author` kèm lý do. `previous` quay về checkpoint người
 * duyệt gần nhất phía trước: lượt mới của checkpoint đó bắt đầu không có phê duyệt và người duyệt ở đó được báo; không có
 * checkpoint người duyệt phía trước thì về `author`. Vị trí trả lại được nhớ (`resume_gate_index`) để vòng sau dừng đúng
 * ở đây.
 */
export async function routeReturn(
  tx: Tx,
  review: ReviewRow,
  input: ReturnInput,
  deps: RoutingDeps,
  resume: Resume,
): Promise<Routed> {
  const eventKey = `code_review_returned:${input.gateRunId}`;
  // Vị trí trả lại chung cho mọi hướng: commit mới (run sửa, push) mở vòng sau và dừng lại ở đây.
  const [marked] = await tx
    .update(codeReviews)
    .set({ gateIndex: input.gateIndex, resumeGateIndex: input.gateIndex, updatedAt: sql`now()` })
    .where(eq(codeReviews.id, review.id))
    .returning();
  let current = marked ?? review;
  let route: RejectRoute = input.route;
  let reason: string | null = null;
  let fixRunId: string | null = null;

  if (route === "previous") {
    const prev = previousHumanGate(current, input.gateIndex);
    if (prev === null) {
      route = "author";
      reason = "Không có checkpoint người duyệt nào phía trước.";
    } else {
      const [row] = await tx
        .update(codeReviews)
        .set({ route: "previous", updatedAt: sql`now()` })
        .where(eq(codeReviews.id, current.id))
        .returning();
      current = row ?? current;
      await resume(tx, current, prev);
    }
  }

  if (route === "agent") {
    const fix = await toAgent(tx, current, input, deps);
    if ("runId" in fix) {
      fixRunId = fix.runId;
      const [row] = await tx
        .update(codeReviews)
        .set({
          status: "changes_requested",
          route: "agent",
          agentRevisions: sql`${codeReviews.agentRevisions} + 1`,
          updatedAt: sql`now()`,
        })
        .where(eq(codeReviews.id, current.id))
        .returning();
      current = row ?? current;
      await auditReview(tx, "codereview.fix_run", current, {
        runId: fix.runId,
        revision: current.agentRevisions,
        gateId: input.gate.id,
      });
    } else {
      route = "author";
      reason = fix.error;
    }
  }

  if (route === "author") current = await toAuthor(tx, current, input.gate.name, input.note, reason, eventKey, deps);

  await auditReview(
    tx,
    "codereview.changes",
    current,
    {
      gateId: input.gate.id,
      kind: input.gate.kind,
      requestedRoute: input.route,
      route,
      ...(reason ? { reason } : {}),
      ...(fixRunId ? { runId: fixRunId } : {}),
    },
    input.actorUserId,
  );
  return { review: current, route, reason, fixRunId };
}

/**
 * Run code kết thúc mà không mở được vòng mới (`no_changes`, `failed`, bị huỷ, mất máy): nếu phiên của task đang chờ
 * run sửa của agent thì chuyển về người giao việc kèm lý do (Edge Cases). Run xong có commit thì `runs` gọi
 * `startCodeReview` và vòng mới mở như thường, không qua đây. Một task chỉ có một run đang chạy nên run kết thúc lúc
 * phiên chờ agent chính là run sửa.
 */
export async function onCodeRunEnded(
  tx: Tx,
  run: { id: string; taskId: string | null; state: string; reasons: string[] },
  deps: RoutingDeps,
): Promise<ReviewRow | null> {
  if (!run.taskId || run.state === "succeeded" || run.state === "needs_review") return null;
  const [review] = await tx
    .select()
    .from(codeReviews)
    .where(
      and(
        eq(codeReviews.taskId, run.taskId),
        eq(codeReviews.status, "changes_requested"),
        eq(codeReviews.route, "agent"),
      ),
    )
    .limit(1)
    .for("update");
  if (!review) return null;
  const reason =
    run.state === "no_changes"
      ? "Run sửa của agent không tạo commit nào."
      : `Run sửa của agent kết thúc ${run.state}${run.reasons[0] ? `: ${run.reasons[0]}` : "."}`;
  const gate = review.resumeGateIndex === null ? undefined : flatGates(review.phases)[review.resumeGateIndex]?.gate;
  const [failed] = await tx
    .select({ note: codeReviewGateRuns.note })
    .from(codeReviewGateRuns)
    .where(
      and(
        eq(codeReviewGateRuns.reviewId, review.id),
        eq(codeReviewGateRuns.gateIndex, review.resumeGateIndex ?? review.gateIndex),
        eq(codeReviewGateRuns.status, "failed"),
      ),
    )
    .orderBy(desc(codeReviewGateRuns.startedAt))
    .limit(1);
  const row = await toAuthor(
    tx,
    review,
    gate?.name ?? "trả lại",
    failed?.note ?? "",
    reason,
    `code_review_returned:fix:${run.id}`,
    deps,
  );
  await auditReview(tx, "codereview.changes", row, { route: "author", requestedRoute: "agent", reason, runId: run.id });
  return row;
}

// ---- Vòng mới ------------------------------------------------------------------------------------------------------

export interface NextRound {
  /** Run code tạo ra commit mới; push ngoài Hive thì giữ run của vòng trước (plan, luồng bước 4). */
  runId: string;
  headSha: string;
  ownerUserId: string | null;
  stats: DiffStats | null;
  reasons: string[];
  /** Run hay push: ghi vào audit. */
  source: "run" | "push";
}

/**
 * Vòng sau dừng ở đâu: checkpoint đã trả lại; phiên đang chờ thì checkpoint đang chờ; phiên đã đạt thì checkpoint người
 * duyệt cuối, để commit sau khi duyệt xong vẫn có ít nhất một người xem (SC-004).
 */
function resumeIndexOf(open: ReviewRow): number {
  if (open.status === "changes_requested") return open.resumeGateIndex ?? open.gateIndex;
  if (open.status === "approved") {
    const flat = flatGates(open.phases);
    return previousHumanGate(open, flat.length) ?? flat.length;
  }
  return open.gateIndex;
}

/**
 * Commit mới trên nhánh PR (D8, FR-026): phiên đang mở thành `superseded`, lượt checkpoint đang chờ đóng lại (run review
 * bị huỷ nếu có `cancelRun`), rồi mở vòng `n+1` với bản chụp quy trình của vòng trước (FR-031), số lượt agent đã dùng và
 * vị trí dừng. Vòng mới bắt đầu ở `gate_index` 0: checkpoint tự động chạy lại; người gọi lên lịch đi tiếp.
 */
export async function openNextRound(tx: Tx, open: ReviewRow, next: NextRound, deps: RoutingDeps): Promise<ReviewRow> {
  const note = "PR đã có commit mới, mở vòng review sau.";
  const waiting = await tx
    .update(codeReviewGateRuns)
    .set({ status: "skipped", note, finishedAt: sql`now()` })
    .where(and(eq(codeReviewGateRuns.reviewId, open.id), eq(codeReviewGateRuns.status, "waiting")))
    .returning({ runIds: codeReviewGateRuns.runIds });
  for (const id of waiting.flatMap((w) => w.runIds)) await deps.cancelRun?.(tx, id, note);
  await tx.update(codeReviews).set({ status: "superseded", updatedAt: sql`now()` }).where(eq(codeReviews.id, open.id));
  await auditReview(tx, "codereview.supersede", open, {
    runId: next.runId,
    newHeadSha: next.headSha,
    source: next.source,
    from: open.status,
  });

  const [row] = await tx
    .insert(codeReviews)
    .values({
      orgId: open.orgId,
      teamId: open.teamId,
      projectId: open.projectId,
      taskId: open.taskId,
      runId: next.runId,
      workflowId: open.workflowId,
      workflowName: open.workflowName,
      phases: open.phases,
      options: open.options,
      prNumber: open.prNumber,
      prUrl: open.prUrl,
      branch: open.branch,
      baseBranch: open.baseBranch,
      headSha: next.headSha,
      round: open.round + 1,
      previousId: open.id,
      resumeGateIndex: resumeIndexOf(open),
      requesterUserId: open.requesterUserId ?? next.ownerUserId,
      agentRevisions: open.agentRevisions,
      addedLines: next.stats?.addedLines ?? 0,
      deletedLines: next.stats?.deletedLines ?? 0,
      changedFiles: next.stats?.changedFiles.length ?? 0,
      runReasons: next.reasons,
    })
    .returning();
  if (!row) throw new Error("Không mở được vòng review mới.");
  await auditReview(tx, "codereview.start", row, {
    runId: next.runId,
    workflowId: row.workflowId,
    workflow: row.workflowName,
    round: row.round,
    source: next.source,
    resumeGateIndex: row.resumeGateIndex,
  });
  return row;
}

/**
 * Checkpoint người duyệt trước chỗ vòng trước dừng giữ phê duyệt của vòng trước (D8), trừ khi quy trình bật "Bỏ phê
 * duyệt cũ khi có commit mới". Giữ được thì ghi lượt `passed` chép phê duyệt cũ và trả true; service đi tiếp.
 */
export async function keepApprovals(tx: Tx, review: ReviewRow, index: number, gate: ReviewGate): Promise<boolean> {
  if (gate.kind !== "human" || !review.previousId || review.resumeGateIndex === null) return false;
  if (index >= review.resumeGateIndex || optionsOf(review).dismissStaleApprovals) return false;
  // Chỉ lượt đầu của checkpoint trong vòng: bị trả về checkpoint này ("về checkpoint trước") thì phải duyệt lại.
  const [seen] = await tx
    .select({ id: codeReviewGateRuns.id })
    .from(codeReviewGateRuns)
    .where(and(eq(codeReviewGateRuns.reviewId, review.id), eq(codeReviewGateRuns.gateIndex, index)))
    .limit(1);
  if (seen) return false;
  const [prev] = await tx
    .select()
    .from(codeReviewGateRuns)
    .where(and(eq(codeReviewGateRuns.reviewId, review.previousId), eq(codeReviewGateRuns.gateIndex, index)))
    .orderBy(desc(codeReviewGateRuns.startedAt))
    .limit(1);
  if (prev?.status !== "passed") return false;
  await tx.insert(codeReviewGateRuns).values({
    orgId: review.orgId,
    reviewId: review.id,
    gateIndex: index,
    gateId: gate.id,
    headSha: review.headSha,
    status: "passed",
    approvals: prev.approvals,
    decidedBy: prev.decidedBy,
    note: `Giữ phê duyệt của vòng ${review.round - 1}.`,
    finishedAt: sql`now()`,
  });
  await auditReview(tx, "codereview.gate", review, {
    gateId: gate.id,
    kind: gate.kind,
    status: "passed",
    kept: true,
    approvals: prev.approvals.length,
  });
  return true;
}

/** Phiên còn mở của PR trên nhánh này (push chỉ nói nhánh, không nói số PR). */
export async function openReviewOnBranch(tx: Tx, projectId: string, branch: string): Promise<ReviewRow | null> {
  const [found] = await tx
    .select({ id: codeReviews.id })
    .from(codeReviews)
    .where(and(eq(codeReviews.projectId, projectId), eq(codeReviews.branch, branch), inArray(codeReviews.status, OPEN)))
    .orderBy(desc(codeReviews.createdAt))
    .limit(1);
  if (!found) return null;
  const [row] = await tx.select().from(codeReviews).where(eq(codeReviews.id, found.id)).for("update");
  return row && OPEN.includes(row.status) ? row : null;
}
