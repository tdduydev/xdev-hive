import { createHash } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import type pg from "pg";
import { recordAudit } from "../audit/index.ts";
import { loadProject } from "../catalog/index.ts";
import { authUser } from "../identity/index.ts";
import { type Jobs, type Tx, withTenant } from "../platform/index.ts";
import type { ProviderFactory } from "../scm/index.ts";
import { GitProviderError, loadConnection } from "../scm/index.ts";
import { codeReviews, codeReviewComments as comments, codeReviewCommentLinks as links } from "./schema.ts";
import type { CodeReviewDeps, CodeReviewRow } from "./service.ts";

const rateLimitMessage = "Đã chạm hạn mức nhà cung cấp, sẽ thử lại sau.";

export const COMMENT_SYNC_QUEUE = "codereview.comment-sync";
export const commentSyncQueue = {
  name: COMMENT_SYNC_QUEUE,
  policy: "stately",
  retryLimit: 5,
  retryDelay: 30,
  retryBackoff: true,
} as const;
export const COMMENT_RECONCILE_QUEUE = "codereview.comment-sync-reconcile";
export const commentReconcileQueue = {
  name: COMMENT_RECONCILE_QUEUE,
  retryLimit: 5,
  retryDelay: 30,
  retryBackoff: true,
} as const;
export interface CommentSyncDeps extends CodeReviewDeps {
  pool: pg.Pool;
  providerFactory: ProviderFactory;
}
export interface CommentSyncJob {
  orgId: string;
  projectId: string;
  prNumber: number;
}
export type CommentRow = typeof comments.$inferSelect;
export const bodyHash = (body: string) => createHash("sha256").update(body).digest("hex");
export const commentMarker = (id: string) => `<!-- xdev-hive:c=${id} -->`;

export async function queueCommentSync(
  tx: Tx,
  review: CodeReviewRow,
  row: CommentRow,
  deps: Pick<CodeReviewDeps, "jobs">,
) {
  if (row.origin !== "hive") return;
  const project = await loadProject(tx, review.projectId);
  if (!project) return;
  const enabled = project.settings.features.prCommentSync !== false;
  await tx
    .insert(links)
    .values({
      commentId: row.id,
      orgId: row.orgId,
      connectionId: project.scmConnectionId,
      provider: project.scmKind,
      prNumber: review.prNumber,
      state: enabled ? "pending" : "disabled",
      lastError: enabled ? null : "Dự án đã tắt đồng bộ bình luận PR.",
    })
    .onConflictDoUpdate({
      target: links.commentId,
      set: {
        state: enabled ? "pending" : "disabled",
        attempts: 0,
        nextAttemptAt: null,
        lastError: enabled ? null : "Dự án đã tắt đồng bộ bình luận PR.",
      },
    });
  if (enabled)
    await enqueueCommentSync(
      tx,
      { orgId: row.orgId, projectId: review.projectId, prNumber: review.prNumber },
      deps.jobs,
    );
}

export async function enqueueCommentSync(tx: Tx, job: CommentSyncJob, jobs?: Jobs, startAfter?: Date) {
  await jobs?.enqueue(COMMENT_SYNC_QUEUE, job, {
    tx,
    singletonKey: `${job.orgId}:${job.projectId}:${job.prNumber}`,
    startAfter,
  });
}

export async function syncAudit(tx: Tx, action: "sync_out" | "sync_in" | "sync_failed", comment: CommentRow) {
  await recordAudit(tx, {
    action: `code_review.comment.${action}`,
    actorUserId: null,
    targetType: "code_review_comment",
    targetId: comment.id,
    data: { reviewId: comment.reviewId, threadId: comment.threadId },
  });
}

/** Giữ một slot ghi theo kết nối trong DB để nhiều worker không cộng dồn vượt hạn mức. */
async function reserveWrite(tx: Tx, connectionId: string, commentId: string, now: Date): Promise<Date | null> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${connectionId}, 34))`);
  const [limited] = await tx
    .select({ at: links.nextAttemptAt })
    .from(links)
    .where(
      and(
        eq(links.connectionId, connectionId),
        eq(links.lastError, rateLimitMessage),
        sql`${links.nextAttemptAt} > ${now}`,
      ),
    )
    .orderBy(sql`${links.nextAttemptAt} desc`)
    .limit(1);
  if (limited?.at) return limited.at;
  const [last] = await tx
    .select({ at: links.writeStartedAt })
    .from(links)
    .where(eq(links.connectionId, connectionId))
    .orderBy(sql`${links.writeStartedAt} desc nulls last`)
    .limit(1);
  const next = last?.at ? new Date(last.at.getTime() + 2000) : now;
  if (next > now) return next;
  await tx.update(links).set({ writeStartedAt: now }).where(eq(links.commentId, commentId));
  return null;
}

export async function syncCommentJob(deps: CommentSyncDeps, job: CommentSyncJob, now = new Date()): Promise<void> {
  const tenant = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(deps.pool, { orgId: job.orgId }, fn);
  const pre = await tenant(async (tx) => {
    const project = await loadProject(tx, job.projectId);
    if (!project || !deps.masterKey) return null;
    const connection = await loadConnection(tx, deps.masterKey, project.scmConnectionId);
    return connection
      ? {
          project,
          provider: deps.providerFactory(connection),
          ref: { owner: project.repoOwner, name: project.repoName },
        }
      : null;
  });
  if (!pre) return;
  const pending = await tenant((tx) =>
    tx
      .select({ comment: comments, link: links })
      .from(links)
      .innerJoin(comments, eq(comments.id, links.commentId))
      .innerJoin(codeReviews, eq(codeReviews.id, comments.reviewId))
      .where(
        and(
          eq(codeReviews.projectId, job.projectId),
          eq(links.prNumber, job.prNumber),
          eq(links.connectionId, pre.project.scmConnectionId),
          eq(links.state, "pending"),
        ),
      )
      .orderBy(asc(comments.createdAt), asc(comments.id)),
  );
  if (!pending.length) return;
  let disabled: string | null =
    pre.project.settings.features.prCommentSync === false ? "Dự án đã tắt đồng bộ bình luận PR." : null;
  let accessError: unknown;
  if (!disabled) {
    try {
      const access = await pre.provider.checkAccess(pre.ref.owner);
      if (access.missingScopes.length) disabled = `Kết nối Git thiếu quyền: ${access.missingScopes.join(", ")}.`;
    } catch (error) {
      accessError = error;
    }
  }
  for (const { comment, link } of pending) {
    if (comment.origin !== "hive") continue;
    if (disabled) {
      await tenant((tx) =>
        tx.update(links).set({ state: "disabled", lastError: disabled }).where(eq(links.commentId, comment.id)),
      );
      continue;
    }
    if (link.nextAttemptAt && link.nextAttemptAt > now) {
      await tenant((tx) => enqueueCommentSync(tx, job, deps.jobs, link.nextAttemptAt ?? undefined));
      continue;
    }
    const root = await tenant(
      async (tx) => (await tx.select().from(links).where(eq(links.commentId, comment.threadId)))[0],
    );
    if (comment.id !== comment.threadId && (!root?.providerCommentId || root.state === "pending")) {
      // Một root lỗi không được làm trả lời treo vô hạn mà không có lý do hiển thị.
      if (root?.state === "failed" || root?.state === "disabled") {
        await tenant((tx) =>
          tx
            .update(links)
            .set({ state: root.state, lastError: "Bình luận đầu luồng chưa đồng bộ được." })
            .where(eq(links.commentId, comment.id)),
        );
      } else await tenant((tx) => enqueueCommentSync(tx, job, deps.jobs, new Date(now.getTime() + 2000)));
      continue;
    }
    const deferred = await tenant((tx) => reserveWrite(tx, link.connectionId, comment.id, now));
    if (deferred) {
      await tenant((tx) => enqueueCommentSync(tx, job, deps.jobs, deferred));
      continue;
    }
    const author = await tenant(async (tx) => {
      // Không đưa id nội bộ vào bình luận công khai khi người dùng đã bị xoá.
      return comment.authorId
        ? (await tx.select({ name: authUser.name }).from(authUser).where(eq(authUser.id, comment.authorId)))[0]?.name
        : null;
    });
    const body = `**${author ?? "Thành viên Hive"}** (qua xDev Hive):\n\n${comment.body}\n\n${commentMarker(comment.id)}`;
    const hash = bodyHash(comment.body);
    try {
      if (accessError) throw accessError;
      let result: Partial<typeof links.$inferInsert> = {};
      if (comment.deletedAt) {
        if (link.providerCommentId && !link.providerDeleted) {
          if (link.mode === "fallback")
            throw new GitProviderError("unsupported", "Nhà cung cấp chưa hỗ trợ xoá bình luận chung.");
          try {
            await pre.provider.deleteReviewComment(pre.ref, job.prNumber, link.providerCommentId);
          } catch (error) {
            if (!(error instanceof GitProviderError) || error.code !== "not_found") throw error;
          }
        }
        result = { providerDeleted: true };
      } else if (!link.providerCommentId) {
        if (link.mode === "fallback" || (comment.id !== comment.threadId && root?.mode === "fallback")) {
          const remote = await pre.provider.commentOnIssue(
            pre.ref,
            job.prNumber,
            `${comment.path}:${comment.line}@${comment.headSha}\n\n${body}`,
            { pullRequest: true },
          );
          result = {
            providerCommentId: remote.id,
            mode: "fallback",
            bodyHash: hash,
            providerResolved: Boolean(comment.resolvedAt),
          };
        } else
          try {
            const remote =
              comment.id !== comment.threadId
                ? await pre.provider.replyReviewComment(pre.ref, job.prNumber, root?.providerThreadId ?? "", body)
                : await pre.provider.createReviewComment(pre.ref, job.prNumber, {
                    path: comment.path,
                    line: comment.line,
                    side: comment.side === "old" ? "LEFT" : "RIGHT",
                    commitSha: comment.headSha,
                    body,
                  });
            result = {
              providerCommentId: remote.id,
              providerThreadId: remote.threadId,
              providerUrl: remote.url,
              providerUpdatedAt: new Date(remote.updatedAt),
              bodyHash: hash,
              providerResolved: remote.resolved,
            };
          } catch (error) {
            if (!(error instanceof GitProviderError) || error.code !== "position_invalid") throw error;
            // Lần ghi fallback cũng cần slot riêng, kể cả khi lần inline bị từ chối.
            await tenant((tx) => tx.update(links).set({ mode: "fallback" }).where(eq(links.commentId, comment.id)));
            await tenant((tx) => enqueueCommentSync(tx, job, deps.jobs, new Date(now.getTime() + 2000)));
            continue;
          }
      } else if (link.bodyHash !== hash) {
        if (link.mode === "fallback")
          throw new GitProviderError("unsupported", "Nhà cung cấp chưa hỗ trợ sửa bình luận chung.");
        const remote = await pre.provider.editReviewComment(pre.ref, job.prNumber, link.providerCommentId, body);
        result = { bodyHash: hash, providerUpdatedAt: new Date(remote.updatedAt) };
      } else if (comment.id === comment.threadId && link.providerResolved !== Boolean(comment.resolvedAt)) {
        if (link.mode === "fallback")
          throw new GitProviderError("unsupported", "Bình luận chung không có trạng thái luồng.");
        await pre.provider.setReviewThreadResolved(
          pre.ref,
          job.prNumber,
          link.providerThreadId ?? "",
          Boolean(comment.resolvedAt),
        );
        result = { providerResolved: Boolean(comment.resolvedAt) };
      }
      await tenant(async (tx) => {
        const [current] = await tx.select().from(comments).where(eq(comments.id, comment.id)).for("update");
        if (!current) return;
        const merged = { ...link, ...result };
        const complete = current.deletedAt
          ? merged.providerDeleted
          : merged.bodyHash === bodyHash(current.body) &&
            (current.id !== current.threadId || merged.providerResolved === Boolean(current.resolvedAt));
        await tx
          .update(links)
          .set({
            ...result,
            state: complete ? (merged.mode === "fallback" ? "fallback" : "synced") : "pending",
            attempts: 0,
            lastError: null,
            nextAttemptAt: null,
          })
          .where(eq(links.commentId, comment.id));
        await syncAudit(tx, "sync_out", current);
        if (!complete) await enqueueCommentSync(tx, job, deps.jobs, new Date(now.getTime() + 2000));
      });
    } catch (error) {
      const rateLimited = error instanceof GitProviderError && error.code === "rate_limited";
      const noAccess =
        error instanceof GitProviderError && ["forbidden", "unauthorized", "unsupported"].includes(error.code);
      const attempts = link.attempts + (rateLimited ? 0 : 1);
      const state = noAccess ? "disabled" : attempts >= 5 ? "failed" : "pending";
      const nextAttemptAt = new Date(
        now.getTime() + (rateLimited ? (error.retryAfterMs ?? 60_000) : 30_000 * 2 ** attempts),
      );
      await tenant(async (tx) => {
        await tx
          .update(links)
          .set({
            state,
            attempts,
            nextAttemptAt,
            lastError: noAccess
              ? "Kết nối Git không đủ quyền hoặc không hỗ trợ thao tác này."
              : rateLimited
                ? rateLimitMessage
                : "Đồng bộ bình luận thất bại, vui lòng thử lại.",
          })
          .where(eq(links.commentId, comment.id));
        if (state === "failed") await syncAudit(tx, "sync_failed", comment);
        if (state === "pending") await enqueueCommentSync(tx, job, deps.jobs, nextAttemptAt);
      });
    }
  }
}

export async function registerCommentSyncWorker(jobs: Jobs, deps: CommentSyncDeps) {
  await jobs.work<CommentSyncJob>(COMMENT_SYNC_QUEUE, ({ data }) => syncCommentJob({ ...deps, jobs }, data));
}
