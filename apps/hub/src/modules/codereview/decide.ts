import {
  type CodeReviewDecideInput,
  type CodeReviewDetail,
  type CodeReviewOverrideInput,
  codeReviewDecideInput,
  codeReviewOverrideInput,
  type RejectRoute,
  type ReviewGate,
} from "@xdev-hive/contracts";
import { eq, sql } from "drizzle-orm";
import { recordAudit } from "../audit/index.ts";
import { enqueueMerge } from "../catalog/index.ts";
import { flatGates, requiredApprovals } from "../knowledge/index.ts";
import { ConflictError, ForbiddenError, type Tx } from "../platform/index.ts";
import { isGitProviderError } from "../scm/index.ts";
import { allowWith, requireTeamRole } from "../tenancy/index.ts";
import {
  autoGateOpen,
  type CodeReviewReadDeps,
  canDecideAt,
  detailOf,
  isOrgAdmin,
  repoOf,
  type UserReader,
  userReader,
  visibleReview,
} from "./queries.ts";
import { routeReturn } from "./routing.ts";
import { codeReviewGateRuns, codeReviews } from "./schema.ts";
import {
  advanceReview,
  CODE_REVIEW_QUEUE,
  type CodeReviewDeps,
  type CodeReviewGateRunRow,
  type CodeReviewJob,
  type CodeReviewRow,
  currentGateRun,
} from "./service.ts";

import { publishReviewStatus } from "./status.ts";

export interface DecideDeps extends CodeReviewDeps, CodeReviewReadDeps {
  /**
   * Huỷ run review của checkpoint AI bị quyết thay hoặc chạy lại (module `runs` cài vào qua main.ts như
   * `EndedDeps.cancelRun`). Không có thì run chạy nốt và kết quả tới muộn bị bỏ qua.
   */
  cancelRun?: ((tx: Tx, runId: string, reason: string) => Promise<void>) | undefined;
}

const auditReview = (tx: Tx, action: string, review: CodeReviewRow, actor: string, data: Record<string, unknown>) =>
  recordAudit(tx, {
    action,
    actorUserId: actor,
    targetType: "code_review",
    targetId: review.id,
    data: { projectId: review.projectId, prNumber: review.prNumber, headSha: review.headSha, ...data },
  });

const headMoved = () =>
  new ConflictError("CODE_REVIEW_HEAD_MOVED", "PR đã có commit mới. Tải lại để xem rồi quyết định lại.");

/**
 * Quyết định phải nói tới đúng commit người duyệt đã xem (FR-021). Repo không có webhook thì hub chưa biết commit mới,
 * nên hỏi đầu PR thật ở nhà cung cấp (Edge Cases). Gọi trước khi khoá hàng phiên để không giữ khoá qua mạng. Nhà cung
 * cấp lỗi tạm thì không chặn người duyệt: hàng merge còn so `head_sha` lần nữa trước khi merge (`reviewGate`).
 */
async function checkHead(tx: Tx, review: CodeReviewRow, headSha: string, deps: DecideDeps): Promise<void> {
  if (headSha !== review.headSha) throw headMoved();
  const repo = await repoOf(tx, review, deps);
  if (!repo) return;
  try {
    const pr = await repo.provider.getPR(repo.ref, review.prNumber);
    if (pr?.state === "open" && pr.headSha !== review.headSha) throw headMoved();
  } catch (e) {
    if (!isGitProviderError(e)) throw e;
  }
}

/** Lý do người gọi không quyết được, theo thứ tự người duyệt dễ hiểu nhất. */
function decideRefusal(
  reader: UserReader,
  review: CodeReviewRow,
  gate: ReviewGate | undefined,
  run: CodeReviewGateRunRow | null,
): Error {
  if (review.status !== "in_review" || (gate?.kind === "human" && run?.status !== "waiting"))
    return new ConflictError("CODE_REVIEW_DECIDED", "Checkpoint đã được quyết.");
  if (gate?.kind !== "human")
    return new ConflictError("CODE_REVIEW_NOT_HUMAN", "Phiên đang ở checkpoint tự động, chưa tới lượt người duyệt.");
  if (run?.approvals.some((a) => a.userId === reader.principal.userId))
    return new ConflictError("CODE_REVIEW_ALREADY_APPROVED", "Bạn đã duyệt checkpoint này, đang chờ người duyệt khác.");
  return new ForbiddenError("CODE_REVIEW_NOT_REVIEWER", "Bạn không phải người duyệt ở checkpoint này.");
}

/**
 * Đặt phiên ở checkpoint `index` rồi đi tiếp qua job như `service.ts`: checkpoint quy tắc cần diff từ nhà cung cấp Git,
 * không gọi mạng trong transaction của người duyệt. Không có hàng đợi (test, công cụ) thì chạy ngay.
 */
async function resumeAt(tx: Tx, review: CodeReviewRow, index: number, deps: DecideDeps): Promise<void> {
  const [row] = await tx
    .update(codeReviews)
    .set({ gateIndex: index, status: "in_review", updatedAt: sql`now()` })
    .where(eq(codeReviews.id, review.id))
    .returning();
  if (!row) return;
  await publishReviewStatus(tx, row, deps);
  if (deps.jobs)
    await deps.jobs.enqueue(
      CODE_REVIEW_QUEUE,
      { kind: "advance", orgId: row.orgId, reviewId: row.id, gateIndex: index } satisfies CodeReviewJob,
      { tx },
    );
  else await advanceReview(tx, row.id, deps, { files: null, gateIndex: index });
}

/**
 * Trả lại PR (FR-023) theo hướng xin, mặc định là hướng của checkpoint. `routing.ts` tạo run sửa, về người giao việc
 * hoặc về checkpoint trước, và ghi audit cả hướng xin lẫn hướng thật.
 */
function sendBack(
  tx: Tx,
  review: CodeReviewRow,
  index: number,
  gate: ReviewGate,
  gateRunId: string,
  note: string,
  route: RejectRoute,
  actorUserId: string,
  deps: DecideDeps,
) {
  return routeReturn(
    tx,
    review,
    { gateIndex: index, gate, gateRunId, route, note, actorUserId },
    deps,
    (tx2, row, at) => resumeAt(tx2, row, at, deps),
  );
}

async function cancelReviewRuns(tx: Tx, run: CodeReviewGateRunRow, reason: string, deps: DecideDeps) {
  for (const id of run.runIds) await deps.cancelRun?.(tx, id, reason);
}

async function fresh(tx: Tx, reader: UserReader, id: string, deps: DecideDeps): Promise<CodeReviewDetail> {
  return detailOf(tx, reader, await visibleReview(tx, reader, id), deps);
}

/**
 * Duyệt hoặc trả lại ở checkpoint người duyệt (FR-020, FR-021). Khoá hàng phiên: hai người cùng quyết một checkpoint
 * quorum 1 thì người sau thấy checkpoint đã xong và nhận "Checkpoint đã được quyết.".
 */
export async function decideCodeReview(
  tx: Tx,
  userId: string,
  raw: CodeReviewDecideInput,
  deps: DecideDeps,
): Promise<CodeReviewDetail> {
  const input = codeReviewDecideInput.parse(raw);
  const reader = await userReader(tx, userId);
  await checkHead(tx, await visibleReview(tx, reader, input.id), input.headSha, deps);
  const review = await visibleReview(tx, reader, input.id, true);
  if (input.headSha !== review.headSha) throw headMoved();
  const cur = flatGates(review.phases)[review.gateIndex];
  const run = await currentGateRun(tx, review);
  if (!cur || !run || !canDecideAt(reader, review, cur.gate, run)) throw decideRefusal(reader, review, cur?.gate, run);
  const gate = cur.gate;

  if (input.decision === "approve") {
    const approvals = [...run.approvals, { userId, at: new Date().toISOString() }];
    // Quản trị tổ chức duyệt là đủ, như quy trình tài liệu.
    const done = approvals.length >= requiredApprovals(gate) || isOrgAdmin(reader);
    await tx
      .update(codeReviewGateRuns)
      .set({
        approvals,
        ...(done ? { status: "passed", decidedBy: userId, note: input.note ?? null, finishedAt: sql`now()` } : {}),
      })
      .where(eq(codeReviewGateRuns.id, run.id));
    await auditReview(tx, "codereview.approve", review, userId, {
      gateId: gate.id,
      approvals: approvals.length,
      required: requiredApprovals(gate),
      done,
    });
    if (done) await resumeAt(tx, review, review.gateIndex + 1, deps);
  } else {
    const note = input.note ?? "";
    await tx
      .update(codeReviewGateRuns)
      .set({ status: "failed", decidedBy: userId, note, finishedAt: sql`now()` })
      .where(eq(codeReviewGateRuns.id, run.id));
    await sendBack(tx, review, review.gateIndex, gate, run.id, note, input.route ?? gate.onReject, userId, deps);
  }
  return fresh(tx, reader, review.id, deps);
}

const requireOverride = (tx: Tx, userId: string, teamId: string) =>
  allowWith(tx, userId, "reviews.override", () => requireTeamRole(tx, userId, teamId, "admin"), teamId);

/**
 * Quyết thay checkpoint tự động đang chờ hoặc không đạt (FR-022): AI không có máy, CI treo, worker cũ không chạy lệnh.
 * Cần `reviews.override` ở đội của dự án và lý do (contract đã bắt buộc).
 */
export async function overrideCodeReview(
  tx: Tx,
  userId: string,
  raw: CodeReviewOverrideInput,
  deps: DecideDeps,
): Promise<CodeReviewDetail> {
  const input = codeReviewOverrideInput.parse(raw);
  const reader = await userReader(tx, userId);
  const seen = await visibleReview(tx, reader, input.id);
  await requireOverride(tx, userId, seen.teamId);
  await checkHead(tx, seen, input.headSha, deps);
  const review = await visibleReview(tx, reader, input.id, true);
  if (input.headSha !== review.headSha) throw headMoved();
  const cur = flatGates(review.phases)[review.gateIndex];
  const run = await currentGateRun(tx, review);
  if (!cur || !run || !autoGateOpen(review, cur.gate, run))
    throw new ConflictError(
      "CODE_REVIEW_NOT_OVERRIDABLE",
      "Chỉ quyết thay được checkpoint tự động đang chờ hoặc không đạt.",
    );
  if (!input.passed && run.status === "failed")
    throw new ConflictError("CODE_REVIEW_ALREADY_FAILED", "Checkpoint này đã không đạt; chỉ quyết thay cho đạt được.");
  const gate = cur.gate;

  await tx
    .update(codeReviewGateRuns)
    .set({
      status: input.passed ? "passed" : "failed",
      overridden: true,
      decidedBy: userId,
      note: input.note,
      finishedAt: sql`now()`,
    })
    .where(eq(codeReviewGateRuns.id, run.id));
  if (run.status === "waiting") await cancelReviewRuns(tx, run, "Checkpoint AI đã được quyết thay.", deps);
  await auditReview(tx, "codereview.override", review, userId, {
    gateId: gate.id,
    kind: gate.kind,
    passed: input.passed,
    note: input.note,
  });
  if (input.passed) await resumeAt(tx, review, review.gateIndex + 1, deps);
  else await sendBack(tx, review, review.gateIndex, gate, run.id, input.note, gate.onReject, userId, deps);
  return fresh(tx, reader, review.id, deps);
}

/** Đưa PR đã duyệt vào hàng merge khi chế độ merge chờ người (FR-027, US5 kịch bản 3). */
export async function enqueueCodeReview(
  tx: Tx,
  userId: string,
  id: string,
  deps: DecideDeps,
): Promise<CodeReviewDetail> {
  const reader = await userReader(tx, userId);
  const review = await visibleReview(tx, reader, id, true);
  await allowWith(
    tx,
    userId,
    "merge.enqueue",
    () => requireTeamRole(tx, userId, review.teamId, "member"),
    review.teamId,
  );
  if (review.status !== "approved")
    throw new ConflictError(
      "CODE_REVIEW_NOT_APPROVED",
      "PR chưa qua hết quy trình duyệt nên chưa vào hàng merge được.",
    );
  const entry = await enqueueMerge(
    tx,
    {
      projectId: review.projectId,
      prNumber: review.prNumber,
      prUrl: review.prUrl,
      branch: review.branch,
      runId: review.runId,
      taskId: review.taskId,
      by: userId,
    },
    { jobs: deps.jobs },
  );
  await auditReview(tx, "codereview.enqueue", review, userId, { entryId: entry.id });
  return fresh(tx, reader, review.id, deps);
}

/**
 * Chạy lại checkpoint tự động hiện tại (CI chập chờn, máy vừa có CLI, worker vừa nâng cấp): người giao việc hoặc người
 * có `reviews.override`. Lượt đang chờ đóng lại kèm ghi chú; lượt đã không đạt giữ nguyên làm lịch sử.
 */
export async function recheckCodeReview(
  tx: Tx,
  userId: string,
  id: string,
  deps: DecideDeps,
): Promise<CodeReviewDetail> {
  const reader = await userReader(tx, userId);
  const review = await visibleReview(tx, reader, id, true);
  if (userId !== review.requesterUserId) await requireOverride(tx, userId, review.teamId);
  const cur = flatGates(review.phases)[review.gateIndex];
  const run = await currentGateRun(tx, review);
  if (!cur || !run || !autoGateOpen(review, cur.gate, run))
    throw new ConflictError(
      "CODE_REVIEW_NOT_RECHECKABLE",
      "Chỉ chạy lại được checkpoint tự động đang chờ hoặc không đạt.",
    );
  if (run.status === "waiting") {
    const note = "Đã chạy lại theo yêu cầu.";
    await tx
      .update(codeReviewGateRuns)
      .set({ status: "skipped", note, decidedBy: userId, finishedAt: sql`now()` })
      .where(eq(codeReviewGateRuns.id, run.id));
    await cancelReviewRuns(tx, run, note, deps);
  }
  await auditReview(tx, "codereview.recheck", review, userId, { gateId: cur.gate.id, kind: cur.gate.kind });
  await resumeAt(tx, review, review.gateIndex, deps);
  return fresh(tx, reader, review.id, deps);
}
