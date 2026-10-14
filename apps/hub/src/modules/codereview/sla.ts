import { and, eq, isNull, lt, sql } from "drizzle-orm";
import type pg from "pg";
import { flatGates } from "../knowledge/index.ts";
import { notify } from "../notify/index.ts";
import { type Jobs, withTenant } from "../platform/index.ts";
import { notificationRecipients, teamMemberIds } from "../tenancy/index.ts";
import { codeReviewGateRuns, codeReviews } from "./schema.ts";
import { codeReviewLink } from "./service.ts";

/**
 * Queue riêng cho nhắc hạn: `CodeReviewJob` thuộc làn core nên không thêm loại job `sla` vào đó; main.ts chỉ cần thêm
 * `codeReviewSlaQueue` vào danh sách queue và gọi `registerCodeReviewSla`.
 */
export const CODE_REVIEW_SLA_QUEUE = "codereview-sla";
export const CODE_REVIEW_SLA_CRON = "*/10 * * * *";
export const codeReviewSlaQueue = {
  name: CODE_REVIEW_SLA_QUEUE,
  // Lịch 10 phút sau chạy lại được, không cần thử lại từng lượt.
  retryLimit: 0,
  expireInSeconds: 5 * 60,
} as const;

export interface CodeReviewSlaDeps {
  pool: pg.Pool;
  jobs?: Jobs | undefined;
  /** Địa chỉ web để link trong thông báo. */
  publicUrl?: string | undefined;
}

/**
 * Nhắc checkpoint người duyệt quá hạn: báo người được chỉ định và quản trị đội một lần cho mỗi lượt chờ
 * (`overdue_notified_at`). `hive.code_review_overdue_orgs` (SECURITY DEFINER) chỉ trả id tổ chức; phần còn lại chạy
 * trong tổ chức đó. Trả số lượt chờ vừa được nhắc.
 */
export async function remindOverdueCodeReviews(deps: CodeReviewSlaDeps): Promise<number> {
  const orgs = await withTenant(deps.pool, {}, async (tx) => {
    const { rows } = await tx.execute<{ org_id: string }>(sql`select org_id from hive.code_review_overdue_orgs()`);
    return rows.map((r) => r.org_id);
  });
  let reminded = 0;
  for (const orgId of orgs) {
    reminded += await withTenant(deps.pool, { orgId }, async (tx) => {
      const due = await tx
        .select({ run: codeReviewGateRuns, review: codeReviews })
        .from(codeReviewGateRuns)
        .innerJoin(codeReviews, eq(codeReviews.id, codeReviewGateRuns.reviewId))
        .where(
          and(
            eq(codeReviewGateRuns.status, "waiting"),
            lt(codeReviewGateRuns.dueAt, sql`now()`),
            isNull(codeReviewGateRuns.overdueNotifiedAt),
            eq(codeReviews.status, "in_review"),
            // Phiên đã đi tiếp (quyết thay, trả lại) thì lượt chờ cũ không còn gì để nhắc.
            eq(codeReviews.gateIndex, codeReviewGateRuns.gateIndex),
          ),
        );
      for (const { run, review } of due) {
        const gate = flatGates(review.phases)[run.gateIndex]?.gate;
        const ids = new Set(await notificationRecipients(tx, gate?.reviewers?.users ?? []));
        for (const id of await teamMemberIds(tx, review.teamId, "admin")) ids.add(id);
        await notify(
          tx,
          {
            orgId,
            event: "code_review.overdue",
            title: `Quá hạn duyệt: PR #${review.prNumber} ${review.branch}`,
            body: `Checkpoint “${gate?.name ?? run.gateId}” của quy trình ${review.workflowName} đã quá hạn (PR #${review.prNumber}). Quản trị đội có thể nhắc hoặc quyết thay.\nCommit: ${review.headSha}\nHãy xem thay đổi trên web trước khi quyết định.`,
            eventKey: `code-review-overdue:${run.id}`,
            recipientIds: [...ids],
            link: codeReviewLink(deps.publicUrl, review.id),
            actions:
              gate?.kind === "human"
                ? [
                    { kind: "code_review.approve", reviewId: review.id, headSha: review.headSha, gateRunId: run.id },
                    { kind: "code_review.changes", reviewId: review.id, headSha: review.headSha, gateRunId: run.id },
                  ]
                : [],
          },
          { jobs: deps.jobs },
        );
        // Đánh dấu kể cả khi không có người nhận để không quét lại mỗi 10 phút.
        await tx
          .update(codeReviewGateRuns)
          .set({ overdueNotifiedAt: sql`now()` })
          .where(eq(codeReviewGateRuns.id, run.id));
      }
      return due.length;
    });
  }
  return reminded;
}

export async function registerCodeReviewSla(jobs: Jobs, deps: CodeReviewSlaDeps): Promise<void> {
  const full = { ...deps, jobs };
  await jobs.work(CODE_REVIEW_SLA_QUEUE, async () => void (await remindOverdueCodeReviews(full)));
  await jobs.schedule(CODE_REVIEW_SLA_QUEUE, CODE_REVIEW_SLA_CRON);
}
