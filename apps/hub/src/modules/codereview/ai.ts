import {
  type AiReviewerResult,
  aiReviewerResult,
  type ChecklistItem,
  type CodeReviewFinding,
  type ReviewerCli,
  type ReviewGate,
} from "@xdev-hive/contracts";
import { eq, sql } from "drizzle-orm";
import { loadProject } from "../catalog/index.ts";
import { flatGates } from "../knowledge/index.ts";
import type { MasterKey, Tx } from "../platform/index.ts";
import { loadConnection, type ProviderFactory } from "../scm/index.ts";
import { aggregateAi } from "./gates.ts";
import { aiGateComment, reviewFocus, reviewGuidance, reviewRubric } from "./prompt.ts";
import { codeReviewGateRuns, codeReviews } from "./schema.ts";

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
  /** Quy tắc chấm của checkpoint (ngưỡng, mức chặn) để thêm vào lời nhắc, mỗi phần tử một dòng. */
  guidance: string[];
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
  /** Đăng bình luận tổng hợp lên PR; thiếu một trong hai thì chỉ ghi kết quả trên hub. */
  providerFactory?: ProviderFactory | undefined;
  masterKey?: MasterKey | undefined;
  publicUrl?: string | undefined;
  logger?: Pick<Console, "warn"> | undefined;
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
    rubric: reviewRubric(ai),
    passScore: ai.passScore,
    blockOn: ai.blockOn ?? null,
    focusPaths: reviewFocus(gate),
    guidance: reviewGuidance(ai),
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
    .set({
      runIds: started.map((s) => s.runId),
      details,
      // Đội không có máy dùng chung có CLI của reviewer: checkpoint hiện lý do để quản trị quyết thay (Edge Cases).
      note: aggregateAi(ai, details).note,
    })
    .where(eq(codeReviewGateRuns.id, gateRun.id));
}

/** Kết quả của một reviewer từ run review vừa kết thúc; run lỗi, bị huỷ hay không nộp đều là `error` kèm lý do. */
function reviewerResult(prev: AiReviewerResult, run: FinishedReviewRun): AiReviewerResult {
  if (run.state === "succeeded" && run.review)
    return {
      ...prev,
      state: "done",
      score: run.review.score,
      summary: run.review.summary,
      findings: run.review.findings,
      checklist: run.review.checklist ?? [],
      error: null,
    };
  const why =
    run.error ??
    (run.state === "cancelled"
      ? "run review đã bị huỷ."
      : run.state === "succeeded"
        ? "agent không nộp kết quả qua review_submit."
        : `run review kết thúc ở trạng thái ${run.state}.`);
  return { ...prev, state: "error", score: null, summary: null, findings: [], checklist: [], error: why };
}

const reviewerLabel = (r: AiReviewerResult) => `Reviewer ${r.model ? `${r.cli} (${r.model})` : r.cli}`;

/** Checklist của checkpoint: mỗi reviewer một dòng; rubric từng reviewer nằm trong `details`. */
function gateChecklist(results: AiReviewerResult[]): ChecklistItem[] {
  return results.map((r) => ({
    label: reviewerLabel(r),
    passed: r.passed === true,
    note: r.state === "error" ? r.error : r.score === null ? null : `${r.score}/10`,
  }));
}

/**
 * Run review xong: ghi kết quả của reviewer vào lượt checkpoint chứa nó, rồi gộp theo `gates.ts` khi mọi reviewer đã
 * xong (FR-016). null khi run không thuộc phiên nào (review chéo cũ), để `runs` xử lý như trước. Khoá hàng phiên trước
 * rồi tới lượt checkpoint (cùng thứ tự với `completeAutoGate`), vì hai reviewer thường xong gần nhau và cùng ghi
 * `details`.
 */
export async function onReviewRunFinished(
  tx: Tx,
  run: FinishedReviewRun,
  deps: AiGateDeps = {},
): Promise<AiRunOutcome | null> {
  const [found] = await tx
    .select({ id: codeReviewGateRuns.id, reviewId: codeReviewGateRuns.reviewId })
    .from(codeReviewGateRuns)
    .where(sql`${codeReviewGateRuns.runIds} @> array[${run.id}]::uuid[]`)
    .limit(1);
  if (!found) return null;
  const [review] = await tx.select().from(codeReviews).where(eq(codeReviews.id, found.reviewId)).for("update");
  const [gateRun] = await tx.select().from(codeReviewGateRuns).where(eq(codeReviewGateRuns.id, found.id)).for("update");
  if (!review || !gateRun) return null;
  const outcome: AiRunOutcome = { reviewId: review.id, gateIndex: gateRun.gateIndex, verdict: null };

  const parsed = aiReviewerResult.array().safeParse(gateRun.details);
  const results = parsed.success ? parsed.data : [];
  const at = results.findIndex((r) => r.runId === run.id);
  const prev = results[at];
  // Run đã báo rồi (verify chạy lại) thì giữ kết quả đầu, không gộp lần nữa.
  if (!prev || prev.state === "done" || prev.state === "error") return outcome;
  results[at] = reviewerResult(prev, run);

  const gate = flatGates(review.phases)[gateRun.gateIndex]?.gate;
  const verdict = gate?.ai ? aggregateAi(gate.ai, results) : null;
  verdict?.passed.forEach((p, i) => {
    const r = results[i];
    if (r) r.passed = p;
  });
  // Checkpoint đã được quyết thay, phiên đã sang commit khác hay đã huỷ: vẫn lưu kết quả để người xem thấy, không kết luận.
  const live =
    gateRun.status === "waiting" &&
    review.status === "in_review" &&
    review.gateIndex === gateRun.gateIndex &&
    review.headSha === gateRun.headSha;
  await tx
    .update(codeReviewGateRuns)
    .set({ details: results, ...(live && verdict?.status === "waiting" ? { note: verdict.note } : {}) })
    .where(eq(codeReviewGateRuns.id, gateRun.id));
  if (!live || !gate?.ai || !verdict || verdict.status === "waiting") return outcome;
  const ai = gate.ai;

  await postComment(tx, review, deps, {
    gateName: gate.name,
    workflowName: review.workflowName,
    round: review.round,
    headSha: review.headSha,
    passScore: ai.passScore,
    aggregate: ai.aggregate ?? "all",
    status: verdict.status,
    score: verdict.score,
    note: verdict.note,
    reviewers: results,
    link: deps.publicUrl ? `${deps.publicUrl.replace(/\/+$/, "")}/knowledge/reviews?tab=code&id=${review.id}` : null,
  });
  return {
    ...outcome,
    verdict: { status: verdict.status, score: verdict.score, checklist: gateChecklist(results), note: verdict.note },
  };
}

/**
 * Đăng bình luận tổng hợp lên PR. Đọc kết nối trong transaction nhưng không chờ lời gọi mạng: kết quả đã nằm trên hub,
 * bình luận chỉ là bản sao cho người xem PR, nên lỗi nhà cung cấp chỉ ghi log và không giữ transaction kết luận run.
 */
async function postComment(
  tx: Tx,
  review: ReviewRow,
  deps: AiGateDeps,
  input: Parameters<typeof aiGateComment>[0],
): Promise<void> {
  const log = deps.logger ?? console;
  if (!deps.providerFactory || !deps.masterKey) return;
  const factory = deps.providerFactory;
  try {
    const project = await loadProject(tx, review.projectId);
    const conn = project && (await loadConnection(tx, deps.masterKey, project.scmConnectionId));
    if (!project || !conn) {
      log.warn(`Không đăng được kết quả review AI lên PR #${review.prNumber}: thiếu dự án hoặc kết nối Git.`);
      return;
    }
    const ref = { owner: project.repoOwner, name: project.repoName };
    void factory(conn)
      .commentOnIssue(ref, review.prNumber, aiGateComment(input), { pullRequest: true })
      .catch((e: unknown) =>
        log.warn(`Không đăng được kết quả review AI lên PR #${review.prNumber}: ${(e as Error).message}`),
      );
  } catch (e) {
    log.warn(`Không đăng được kết quả review AI lên PR #${review.prNumber}: ${(e as Error).message}`);
  }
}
