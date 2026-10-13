import type { AiReviewerResult, ChecklistItem, CodeReviewFinding, ReviewerCli, ReviewGate } from "@xdev-hive/contracts";
import { eq, sql } from "drizzle-orm";
import type { Tx } from "../platform/index.ts";
import { codeReviewGateRuns, type codeReviews } from "./schema.ts";

type ReviewRow = typeof codeReviews.$inferSelect;
type GateRunRow = typeof codeReviewGateRuns.$inferSelect;

/** Một run review cần tạo cho checkpoint AI: mỗi reviewer một run, chạy song song (FR-014). */
export interface StartReviewRunsInput {
  reviewId: string;
  /** `created_by = workflow:<id>`; null khi quy trình đã bị xoá sau khi mở phiên. */
  workflowId: string | null;
  projectId: string;
  taskId: string | null;
  /** Run code tạo ra `headSha`: run review là con của nó (D5). */
  parentRunId: string;
  branch: string;
  headSha: string;
  prNumber: number;
  /** null là run của đội trên máy dùng chung (FR-015); khác null là chủ run code gốc (`runner: requester`). */
  ownerUserId: string | null;
  reviewers: { cli: ReviewerCli; model: string | null }[];
  rubric: string[];
  passScore: number;
  blockOn: "critical" | "major" | null;
  /** Đường dẫn trọng tâm của checkpoint; rỗng là cả diff. */
  focusPaths: string[];
}

export interface StartedReviewRun {
  runId: string;
  cli: ReviewerCli;
  model: string | null;
  /** `waiting_machine`: chưa có máy dùng chung có CLI này (ADR 0017). */
  state: "queued" | "waiting_machine";
}

/** Run review đã kết thúc, do `runs.verifyReview` báo về. */
export interface FinishedReviewRun {
  id: string;
  /** Trạng thái cuối của run (`succeeded`, `failed`, `cancelled`…). */
  state: string;
  /** Kết quả `review_submit`; null khi agent không nộp. */
  review: {
    score: number;
    summary: string | null;
    findings: CodeReviewFinding[];
    checklist?: ChecklistItem[] | undefined;
  } | null;
  error: string | null;
}

export interface AiGateDeps {
  /**
   * Tạo run review (module `runs` cài vào qua main.ts vì `runs` import `codereview`). Không có thì checkpoint AI chờ
   * người quyết thay.
   */
  startReviewRuns?: ((tx: Tx, input: StartReviewRunsInput) => Promise<StartedReviewRun[]>) | undefined;
}

/** Kết luận của checkpoint AI; `service.ts` ghi kết quả và đi tiếp hoặc trả lại. */
export interface AiGateVerdict {
  status: "passed" | "failed";
  score: number | null;
  checklist: ChecklistItem[];
  note: string | null;
}

/**
 * Run review thuộc một checkpoint AI. `verdict` null là checkpoint còn chờ reviewer khác (hoặc đã được quyết thay),
 * service không làm gì thêm.
 */
export interface AiRunOutcome {
  reviewId: string;
  gateIndex: number;
  verdict: AiGateVerdict | null;
}

const NO_RUNNER = "Hub chưa nối lõi giao run review; cần người quyết thay checkpoint này.";

/** Tạo run review cho từng reviewer và ghi vào lượt checkpoint đang chờ. */
export async function startAiGate(
  tx: Tx,
  review: ReviewRow,
  gateRun: GateRunRow,
  gate: ReviewGate,
  deps: AiGateDeps,
): Promise<void> {
  const ai = gate.ai;
  if (!deps.startReviewRuns || !ai) {
    await tx
      .update(codeReviewGateRuns)
      .set({ note: ai ? NO_RUNNER : "Checkpoint AI thiếu cấu hình reviewer; cần người quyết thay." })
      .where(eq(codeReviewGateRuns.id, gateRun.id));
    return;
  }
  const reviewers = (ai.reviewers ?? [{ cli: "claude" as const, model: ai.model }]).map((r) => ({
    cli: r.cli,
    model: r.model ?? null,
  }));
  const started = await deps.startReviewRuns(tx, {
    reviewId: review.id,
    workflowId: review.workflowId,
    projectId: review.projectId,
    taskId: review.taskId,
    parentRunId: review.runId,
    branch: review.branch,
    headSha: review.headSha,
    prNumber: review.prNumber,
    // Run gốc không có chủ thì về đội, kể cả khi checkpoint chọn `requester` (FR-015).
    ownerUserId: ai.runner === "requester" ? review.requesterUserId : null,
    reviewers,
    rubric: ai.checks,
    passScore: ai.passScore,
    blockOn: ai.blockOn ?? null,
    focusPaths: gate.conditions.paths ?? [],
  });
  const details: AiReviewerResult[] = started.map((s) => ({
    cli: s.cli,
    model: s.model,
    runId: s.runId,
    state: s.state,
    score: null,
    passed: null,
    summary: null,
    findings: [],
    checklist: [],
    error: null,
  }));
  await tx
    .update(codeReviewGateRuns)
    .set({ runIds: started.map((s) => s.runId), details })
    .where(eq(codeReviewGateRuns.id, gateRun.id));
}

/**
 * Run review xong: tìm lượt checkpoint chứa nó. null khi run không thuộc phiên nào (review chéo cũ), để `runs` xử lý
 * như trước. Chưa gộp kết quả: checkpoint vẫn chờ tới khi T022 thay phần thân này.
 */
export async function onReviewRunFinished(tx: Tx, run: FinishedReviewRun): Promise<AiRunOutcome | null> {
  const [gateRun] = await tx
    .select({ reviewId: codeReviewGateRuns.reviewId, gateIndex: codeReviewGateRuns.gateIndex })
    .from(codeReviewGateRuns)
    .where(sql`${codeReviewGateRuns.runIds} @> array[${run.id}]::uuid[]`)
    .limit(1);
  if (!gateRun) return null;
  return { reviewId: gateRun.reviewId, gateIndex: gateRun.gateIndex, verdict: null };
}
