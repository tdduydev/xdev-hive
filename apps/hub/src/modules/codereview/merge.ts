import { and, eq, inArray, sql } from "drizzle-orm";
import { recordAudit } from "../audit/index.ts";
import { enqueueMerge, loadProject } from "../catalog/index.ts";
import { flatGates } from "../knowledge/index.ts";
import { notify } from "../notify/index.ts";
import { BadRequestError, type Jobs, type Tx } from "../platform/index.ts";
import { codeReviewGateRuns, codeReviews } from "./schema.ts";

type ReviewRow = typeof codeReviews.$inferSelect;

/** Trạng thái còn mở: mỗi PR tối đa một phiên ở các trạng thái này (chỉ mục `code_reviews_open_pr`). */
const OPEN = ["in_review", "changes_requested", "approved"];

export interface ApprovedDeps {
  jobs?: Jobs | undefined;
  publicUrl?: string | undefined;
}

const reviewLink = (publicUrl: string | undefined, id: string) =>
  publicUrl ? `${publicUrl.replace(/\/+$/, "")}/knowledge/reviews?tab=code&id=${id}` : null;

const auditReview = (tx: Tx, action: string, review: ReviewRow, data: Record<string, unknown>) =>
  recordAudit(tx, {
    action,
    actorUserId: null,
    targetType: "code_review",
    targetId: review.id,
    data: { projectId: review.projectId, prNumber: review.prNumber, headSha: review.headSha, ...data },
  });

/**
 * Hàng merge hỏi: PR này còn phiên review code chưa duyệt xong không (FR-028)? Không có phiên mở thì không chặn
 * (FR-030). Phiên `approved` cho commit khác đầu PR hiện tại cũng chưa tính: webhook push có thể chưa tới, mà SC-004
 * cấm merge commit chưa ai duyệt.
 */
export async function reviewGate(tx: Tx, projectId: string, prNumber: number, headSha: string): Promise<boolean> {
  const [review] = await tx
    .select({ status: codeReviews.status, headSha: codeReviews.headSha })
    .from(codeReviews)
    .where(
      and(eq(codeReviews.projectId, projectId), eq(codeReviews.prNumber, prNumber), inArray(codeReviews.status, OPEN)),
    )
    .limit(1);
  if (!review) return false;
  return review.status !== "approved" || review.headSha !== headSha;
}

/**
 * Phiên qua hết checkpoint. Chế độ merge hiệu lực (FR-027): `project` theo `merge.mode` của dự án, `auto` và `manual`
 * ghi đè. Tự động mà dự án bật merge queue thì vào hàng ngay trong transaction này; không thì báo người giao việc
 * `code_review.approved` để đưa vào hàng hoặc merge tay.
 */
export async function onApproved(tx: Tx, review: ReviewRow, deps: ApprovedDeps): Promise<ReviewRow> {
  const [row] = await tx
    .update(codeReviews)
    .set({ status: "approved", gateIndex: flatGates(review.phases).length, updatedAt: sql`now()` })
    .where(eq(codeReviews.id, review.id))
    .returning();
  const approved = row ?? review;
  const project = await loadProject(tx, approved.projectId);
  const mode =
    approved.options.merge === "project" ? project?.settings.merge.mode === "auto" : approved.options.merge === "auto";
  const queueOn = project?.settings.features.mergeQueue === true;
  const enqueue = mode && queueOn;
  await auditReview(tx, "codereview.approve", approved, { merge: enqueue ? "enqueue" : "manual" });

  if (enqueue) {
    try {
      await enqueueMerge(
        tx,
        {
          projectId: approved.projectId,
          prNumber: approved.prNumber,
          prUrl: approved.prUrl,
          branch: approved.branch,
          runId: approved.runId,
          taskId: approved.taskId,
          // Run của đội không có chủ: ghi theo quy trình để mục hàng có người đưa vào, không phải người thật.
          by: approved.requesterUserId ?? `workflow:${approved.workflowId ?? "code-review"}`,
        },
        { jobs: deps.jobs },
      );
      return approved;
    } catch (e) {
      // Vừa tắt merge queue sau lúc đọc dự án: phiên vẫn đạt, PR chờ người như chế độ manual.
      if (!(e instanceof BadRequestError)) throw e;
    }
  }

  if (approved.requesterUserId) {
    await notify(
      tx,
      {
        orgId: approved.orgId,
        event: "code_review.approved",
        title: `PR #${approved.prNumber} đã duyệt, cần merge tay`,
        body: `Quy trình ${approved.workflowName} đã duyệt PR #${approved.prNumber} (${approved.branch} → ${approved.baseBranch}). Đưa PR vào hàng merge hoặc merge tay.`,
        // Theo vòng: commit mới mở vòng khác thì duyệt xong báo lại.
        eventKey: `code_review_approved:${approved.id}`,
        recipientIds: [approved.requesterUserId],
        link: reviewLink(deps.publicUrl, approved.id),
      },
      { jobs: deps.jobs },
    );
  }
  return approved;
}

export interface PullRequestEnded {
  projectId: string;
  prNumber: number;
  /** `merged` là PR đã merge (ngoài Hive hoặc hàng merge), `closed` là đóng không merge. */
  outcome: "merged" | "closed";
}

export interface EndedDeps {
  /**
   * Huỷ run review đang chạy của phiên (module `runs` cài vào qua main.ts vì `runs` import `codereview`). Không có thì
   * run review chạy nốt rồi `onReviewRunFinished` thấy phiên đã đóng và bỏ qua.
   */
  cancelRun?: ((tx: Tx, runId: string, reason: string) => Promise<void>) | undefined;
}

/**
 * Webhook `pull_request.merged|closed` (FR-029): kết thúc phiên còn mở của PR thành `merged` hoặc `cancelled`, đóng lượt
 * checkpoint đang chờ và huỷ run review chưa xong. Idempotent: webhook giao lại không tìm thấy phiên mở nên không làm gì.
 */
export async function onPullRequestEnded(
  tx: Tx,
  input: PullRequestEnded,
  deps: EndedDeps = {},
): Promise<ReviewRow | null> {
  const [found] = await tx
    .select({ id: codeReviews.id })
    .from(codeReviews)
    .where(
      and(
        eq(codeReviews.projectId, input.projectId),
        eq(codeReviews.prNumber, input.prNumber),
        inArray(codeReviews.status, OPEN),
      ),
    )
    .limit(1);
  if (!found) return null;
  const [review] = await tx.select().from(codeReviews).where(eq(codeReviews.id, found.id)).for("update");
  if (!review || !OPEN.includes(review.status)) return null;

  const reason = input.outcome === "merged" ? "PR đã được merge." : "PR đã bị đóng.";
  const waiting = await tx
    .update(codeReviewGateRuns)
    .set({ status: "skipped", note: reason, finishedAt: sql`now()` })
    .where(and(eq(codeReviewGateRuns.reviewId, review.id), eq(codeReviewGateRuns.status, "waiting")))
    .returning({ runIds: codeReviewGateRuns.runIds });
  for (const runId of waiting.flatMap((g) => g.runIds)) await deps.cancelRun?.(tx, runId, reason);

  const status = input.outcome === "merged" ? "merged" : "cancelled";
  const [row] = await tx
    .update(codeReviews)
    .set({ status, updatedAt: sql`now()` })
    .where(eq(codeReviews.id, review.id))
    .returning();
  await auditReview(tx, status === "merged" ? "codereview.merged" : "codereview.cancel", review, {
    reason,
    from: review.status,
  });
  return row ?? review;
}
