import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { loadProject } from "../catalog/index.ts";
import { type Jobs, type Tx, withTenant } from "../platform/index.ts";
import { type GitProviderKind, loadConnection, type ReviewComment } from "../scm/index.ts";
import {
  bodyHash,
  COMMENT_RECONCILE_QUEUE,
  type CommentSyncDeps,
  type CommentSyncJob,
  enqueueCommentSync,
  syncAudit,
} from "./comment-sync.ts";
import { notifyComment } from "./comments.ts";
import { codeReviews, codeReviewComments as comments, codeReviewCommentLinks as links } from "./schema.ts";
import type { CodeReviewDeps } from "./service.ts";

export interface IncomingReviewComment {
  projectId: string;
  prNumber: number;
  provider: GitProviderKind;
  action: "created" | "edited" | "deleted" | "resolved" | "unresolved";
  comment: ReviewComment;
}

/** Webhook và đối chiếu dùng cùng đường ghi để việc giao lại không phát thông báo lần nữa. */
export async function receiveReviewComment(tx: Tx, input: IncomingReviewComment, deps: CodeReviewDeps = {}) {
  const project = await loadProject(tx, input.projectId);
  if (!project || project.scmKind !== input.provider || project.settings.features.prCommentSync === false) return;
  // Cùng PR chỉ một luồng nhận ghi tại một thời điểm; reply tới trước root sẽ được job đối chiếu bù.
  const [review] = await tx
    .select()
    .from(codeReviews)
    .where(
      and(
        eq(codeReviews.projectId, project.id),
        eq(codeReviews.prNumber, input.prNumber),
        inArray(codeReviews.status, ["in_review", "changes_requested", "approved"]),
      ),
    )
    .for("update");
  if (!review) return;
  const remote = input.comment;
  const at = new Date(remote.updatedAt);
  if (!Number.isFinite(at.getTime())) return;
  const [existing] = await tx
    .select({ link: links, comment: comments })
    .from(links)
    .innerJoin(comments, eq(comments.id, links.commentId))
    .where(and(eq(links.connectionId, project.scmConnectionId), eq(links.providerCommentId, remote.id)));
  if (!existing) {
    // Không tin dấu ẩn do người ngoài sao chép. Chỉ phản hồi API mới được gắn id cho bình luận Hive.
    if (/<!--\s*xdev-hive:c=[0-9a-f-]{36}\s*-->/i.test(remote.body)) return;
    if (input.action === "resolved" || input.action === "unresolved") return;
    let rootId: string | undefined;
    if (remote.inReplyToId) {
      const [root] = await tx
        .select({ comment: comments })
        .from(links)
        .innerJoin(comments, eq(comments.id, links.commentId))
        .where(
          and(
            eq(links.connectionId, project.scmConnectionId),
            eq(links.providerThreadId, remote.threadId),
            eq(comments.reviewId, review.id),
            sql`${comments.id} = ${comments.threadId}`,
          ),
        );
      if (!root) return;
      rootId = root.comment.id;
    }
    const id = randomUUID();
    const [row] = await tx
      .insert(comments)
      .values({
        id,
        threadId: rootId ?? id,
        orgId: review.orgId,
        reviewId: review.id,
        path: remote.path,
        line: Math.max(1, remote.line),
        side: remote.side === "LEFT" ? "old" : "new",
        headSha: remote.commitSha,
        body: input.action === "deleted" ? "" : remote.body.slice(0, 20000),
        deletedAt: input.action === "deleted" ? at : null,
        origin: input.provider,
        externalAuthor: remote.author,
        createdAt: at,
        editedAt: at,
        resolvedAt: remote.resolved ? at : null,
      })
      .returning();
    if (!row) return;
    await tx.insert(links).values({
      orgId: review.orgId,
      commentId: id,
      connectionId: project.scmConnectionId,
      provider: input.provider,
      prNumber: input.prNumber,
      providerCommentId: remote.id,
      providerThreadId: remote.threadId,
      providerUrl: remote.url,
      providerUpdatedAt: at,
      providerResolved: remote.resolved,
      state: "synced",
      providerDeleted: input.action === "deleted",
      bodyHash: bodyHash(remote.body),
    });
    await syncAudit(tx, "sync_in", row);
    if (input.action !== "deleted") await notifyComment(tx, "", review, row, deps);
    return;
  }
  const { comment, link } = existing;
  if (comment.reviewId !== review.id || comment.deletedAt) return;
  const deleted = input.action === "deleted";
  const threadEvent = input.action === "resolved" || input.action === "unresolved";
  if (!deleted && link.providerUpdatedAt && at < link.providerUpdatedAt) return;
  const resolved = threadEvent ? input.action === "resolved" : remote.resolved;
  // Giữ tác giả Hive khi nhà cung cấp trả về nội dung có tên và dấu ẩn.
  let body = remote.body;
  if (comment.origin === "hive") {
    const marker = `<!-- xdev-hive:c=${comment.id} -->`;
    const split = body.indexOf("\n\n");
    if (body.endsWith(marker) && split >= 0) body = body.slice(split + 2, -marker.length).replace(/\n\n$/, "");
  }
  const hash = bodyHash(body);
  if (!deleted && link.providerResolved === resolved && (threadEvent || link.bodyHash === hash)) return;
  const localAt = Math.max(comment.createdAt.getTime(), comment.editedAt?.getTime() ?? 0);
  if (!deleted && !threadEvent && at.getTime() < localAt) return;
  const [updated] = await tx
    .update(comments)
    .set(
      deleted
        ? { body: "", deletedAt: at }
        : threadEvent
          ? { resolvedAt: resolved ? at : null, resolvedBy: null }
          : { body: body.slice(0, 20000), editedAt: at },
    )
    .where(eq(comments.id, comment.id))
    .returning();
  if (comment.id === comment.threadId || threadEvent) {
    await tx
      .update(comments)
      .set({ resolvedAt: resolved ? at : null, resolvedBy: null })
      .where(eq(comments.id, comment.threadId));
  }
  await tx
    .update(links)
    .set({
      bodyHash: bodyHash(body),
      providerUpdatedAt: at,
      providerResolved: resolved,
      providerDeleted: deleted,
      state: "synced",
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
    })
    .where(eq(links.commentId, comment.id));
  if (updated) await syncAudit(tx, "sync_in", updated);
}

export async function reconcileCommentPr(deps: CommentSyncDeps, job: CommentSyncJob) {
  const tenant = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(deps.pool, { orgId: job.orgId }, fn);
  const pre = await tenant(async (tx) => {
    const project = await loadProject(tx, job.projectId);
    if (!project || project.settings.features.prCommentSync === false || !deps.masterKey) return null;
    const connection = await loadConnection(tx, deps.masterKey, project.scmConnectionId);
    return connection ? { project, provider: deps.providerFactory(connection) } : null;
  });
  if (!pre) return;
  const startedAt = new Date();
  const list = await pre.provider.listReviewComments(
    { owner: pre.project.repoOwner, name: pre.project.repoName },
    job.prNumber,
  );
  // Đọc root trước để phân trang không làm câu trả lời mất luồng.
  list.sort((a, b) => Number(Boolean(a.inReplyToId)) - Number(Boolean(b.inReplyToId)));
  await tenant(async (tx) => {
    for (const comment of list)
      await receiveReviewComment(tx, { ...job, provider: pre.project.scmKind, action: "edited", comment }, deps);
    const ids = new Set(list.map((c) => c.id));
    const saved = await tx
      .select({ comment: comments, link: links })
      .from(links)
      .innerJoin(comments, eq(comments.id, links.commentId))
      .innerJoin(codeReviews, eq(codeReviews.id, comments.reviewId))
      .where(
        and(
          eq(codeReviews.projectId, job.projectId),
          eq(links.prNumber, job.prNumber),
          eq(links.connectionId, pre.project.scmConnectionId),
          eq(links.mode, "inline"),
        ),
      );
    for (const { comment, link } of saved) {
      if (
        !link.providerCommentId ||
        ids.has(link.providerCommentId) ||
        comment.deletedAt ||
        (link.providerUpdatedAt && link.providerUpdatedAt >= startedAt)
      )
        continue;
      await receiveReviewComment(
        tx,
        {
          ...job,
          provider: pre.project.scmKind,
          action: "deleted",
          comment: {
            id: link.providerCommentId,
            threadId: link.providerThreadId ?? "",
            path: comment.path,
            line: comment.line,
            side: comment.side === "old" ? "LEFT" : "RIGHT",
            commitSha: comment.headSha,
            body: "",
            author: null,
            url: link.providerUrl,
            updatedAt: new Date().toISOString(),
            resolved: Boolean(comment.resolvedAt),
            inReplyToId: null,
          },
        },
        deps,
      );
    }
    await enqueueCommentSync(tx, job, deps.jobs);
  });
}

export async function reconcileOpenComments(deps: CommentSyncDeps) {
  const orgs = await withTenant(
    deps.pool,
    {},
    async (tx) => (await tx.execute<{ org_id: string }>(sql`select org_id from hive.code_review_comment_orgs()`)).rows,
  );
  for (const { org_id: orgId } of orgs) {
    const reviews = await withTenant(deps.pool, { orgId }, (tx) =>
      tx
        .select()
        .from(codeReviews)
        .where(inArray(codeReviews.status, ["in_review", "changes_requested", "approved"])),
    );
    for (const review of reviews)
      await deps.jobs?.enqueue(
        COMMENT_RECONCILE_QUEUE,
        { orgId, projectId: review.projectId, prNumber: review.prNumber },
        { singletonKey: review.id },
      );
  }
}

export async function registerCommentReconcileWorker(jobs: Jobs, deps: CommentSyncDeps) {
  const full = { ...deps, jobs };
  await jobs.work<CommentSyncJob | Record<string, never>>(COMMENT_RECONCILE_QUEUE, async ({ data }) => {
    if ("orgId" in data) await reconcileCommentPr(full, data as CommentSyncJob);
    else await reconcileOpenComments(full);
  });
  await jobs.schedule(COMMENT_RECONCILE_QUEUE, "*/10 * * * *");
}
