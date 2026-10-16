import { randomUUID } from "node:crypto";
import {
  type CodeReviewComment,
  type CodeReviewCommentThread,
  codeReviewCommentAddInput,
  codeReviewCommentEditInput,
  codeReviewCommentReplyInput,
} from "@xdev-hive/contracts";
import { asc, eq, inArray } from "drizzle-orm";
import type { z } from "zod";
import { recordAudit } from "../audit/index.ts";
import { authUser } from "../identity/index.ts";
import { flatGates } from "../knowledge/index.ts";
import { notify } from "../notify/index.ts";
import { ForbiddenError, NotFoundError, type Tx } from "../platform/index.ts";
import { notificationRecipients, teamMemberIds } from "../tenancy/index.ts";
import { queueCommentSync } from "./comment-sync.ts";
import { userReader, visibleReview } from "./queries.ts";
import { codeReviewCommentLinks, codeReviewComments } from "./schema.ts";
import { type CodeReviewDeps, type CodeReviewRow, codeReviewLink } from "./service.ts";

type CommentDeps = Pick<CodeReviewDeps, "publicUrl" | "jobs">;

type CommentRow = typeof codeReviewComments.$inferSelect;
const missing = () => new NotFoundError("CODE_REVIEW_COMMENT_NOT_FOUND", "Không tìm thấy bình luận review code.");
const iso = (value: Date | null) => value?.toISOString() ?? null;

function presentRow(row: CommentRow, authorName: string | null): CodeReviewComment {
  return {
    id: row.id,
    threadId: row.threadId,
    authorId: row.authorId,
    authorName,
    body: row.deletedAt ? "" : row.body,
    origin: row.origin,
    externalAuthor: row.externalAuthor,
    createdAt: row.createdAt.toISOString(),
    editedAt: iso(row.editedAt),
    deletedAt: iso(row.deletedAt),
    syncState: null,
    providerUrl: null,
  };
}

async function presentMany(tx: Tx, rows: CommentRow[]): Promise<CodeReviewComment[]> {
  const ids = [...new Set(rows.flatMap((row) => (row.authorId ? [row.authorId] : [])))];
  const authors = ids.length
    ? await tx.select({ id: authUser.id, name: authUser.name }).from(authUser).where(inArray(authUser.id, ids))
    : [];
  const names = new Map(authors.map((author) => [author.id, author.name]));
  const links = rows.length
    ? await tx
        .select()
        .from(codeReviewCommentLinks)
        .where(
          inArray(
            codeReviewCommentLinks.commentId,
            rows.map((row) => row.id),
          ),
        )
    : [];
  const byComment = new Map(links.map((link) => [link.commentId, link]));
  return rows.map((row) => {
    const link = byComment.get(row.id);
    return {
      ...presentRow(row, row.authorId ? (names.get(row.authorId) ?? null) : null),
      syncState: link?.state ?? null,
      providerUrl: link?.providerUrl ?? null,
      syncError: link?.lastError ?? null,
    };
  });
}

async function present(tx: Tx, row: CommentRow): Promise<CodeReviewComment> {
  const [comment] = await presentMany(tx, [row]);
  if (!comment) throw missing();
  return comment;
}

function presentThread(
  review: CodeReviewRow,
  root: CommentRow,
  comments: CodeReviewComment[],
): CodeReviewCommentThread {
  return {
    id: root.id,
    path: root.path,
    line: root.line,
    side: root.side,
    headSha: root.headSha,
    // Chưa có ánh xạ diff giữa hai commit; giữ luồng cũ và báo rõ khi head đã đổi.
    outdated: root.headSha !== review.headSha,
    resolved: root.resolvedAt !== null,
    resolvedAt: iso(root.resolvedAt),
    resolvedBy: root.resolvedBy,
    comments,
  };
}

async function thread(tx: Tx, review: CodeReviewRow, root: CommentRow): Promise<CodeReviewCommentThread> {
  const rows = await tx
    .select()
    .from(codeReviewComments)
    .where(eq(codeReviewComments.threadId, root.id))
    .orderBy(asc(codeReviewComments.createdAt), asc(codeReviewComments.id));
  return presentThread(review, root, await presentMany(tx, rows));
}

/** Khoá review trước mọi thao tác để trả lời, xoá và xử lý cùng luồng luôn có thứ tự nhất quán. */
async function load(tx: Tx, userId: string, id: string, rootOnly = false) {
  const [found] = await tx.select().from(codeReviewComments).where(eq(codeReviewComments.id, id));
  if (!found) throw missing();
  const review = await visibleReview(tx, await userReader(tx, userId), found.reviewId, true);
  const [row] = await tx.select().from(codeReviewComments).where(eq(codeReviewComments.id, id));
  if (!row || (rootOnly && row.id !== row.threadId)) throw missing();
  return { review, row };
}

async function audit(tx: Tx, userId: string, action: string, row: CommentRow) {
  await recordAudit(tx, {
    action: `code_review.comment.${action}`,
    actorUserId: userId,
    targetType: "code_review_comment",
    targetId: row.id,
    data: { reviewId: row.reviewId, threadId: row.threadId },
  });
}

export async function notifyComment(tx: Tx, userId: string, review: CodeReviewRow, row: CommentRow, deps: CommentDeps) {
  const recipients = new Set<string>();
  if (review.requesterUserId) recipients.add(review.requesterUserId);
  for (const { gate } of flatGates(review.phases)) {
    const r = gate.kind === "human" ? gate.reviewers : undefined;
    if (!r) continue;
    for (const id of r.users) recipients.add(id);
    for (const role of r.roles) {
      const ids =
        role === "org-admin"
          ? await notificationRecipients(tx)
          : await teamMemberIds(tx, review.teamId, role === "team-admin" ? "admin" : "member");
      for (const id of ids) recipients.add(id);
    }
    for (const teamId of r.teams) for (const id of await teamMemberIds(tx, teamId, "member")) recipients.add(id);
  }
  recipients.delete(userId);
  // Dùng nhóm sự kiện review hiện có để giữ tuỳ chọn nhận thông báo của người dùng.
  await notify(
    tx,
    {
      orgId: review.orgId,
      event: "code_review.awaiting",
      title: "Có bình luận mới",
      body: `PR #${review.prNumber} · ${row.path}:${row.line}\n${row.body}`,
      eventKey: `code_review.comment:${row.id}`,
      recipientIds: [...recipients],
      link: codeReviewLink(deps.publicUrl, review.id),
    },
    { jobs: deps.jobs },
  );
}

export async function listReviewComments(tx: Tx, userId: string, reviewId: string) {
  const review = await visibleReview(tx, await userReader(tx, userId), reviewId);
  const rows = await tx
    .select()
    .from(codeReviewComments)
    .where(eq(codeReviewComments.reviewId, review.id))
    .orderBy(asc(codeReviewComments.createdAt), asc(codeReviewComments.id));
  const groups = new Map<string, CodeReviewComment[]>();
  for (const comment of await presentMany(tx, rows)) {
    const group = groups.get(comment.threadId) ?? [];
    group.push(comment);
    groups.set(comment.threadId, group);
  }
  return {
    threads: rows
      .filter((row) => row.id === row.threadId)
      .map((root) => presentThread(review, root, groups.get(root.id) ?? [])),
  };
}

export async function addReviewComment(
  tx: Tx,
  userId: string,
  input: z.input<typeof codeReviewCommentAddInput>,
  deps: CommentDeps = {},
) {
  const value = codeReviewCommentAddInput.parse(input);
  const review = await visibleReview(tx, await userReader(tx, userId), value.reviewId, true);
  const id = randomUUID();
  const [row] = await tx
    .insert(codeReviewComments)
    .values({ ...value, id, threadId: id, orgId: review.orgId, authorId: userId })
    .returning();
  if (!row) throw missing();
  await audit(tx, userId, "add", row);
  await notifyComment(tx, userId, review, row, deps);
  await queueCommentSync(tx, review, row, deps);
  return thread(tx, review, row);
}

export async function replyReviewComment(
  tx: Tx,
  userId: string,
  input: { threadId: string; body: string },
  deps: CommentDeps = {},
) {
  const value = codeReviewCommentReplyInput.parse(input);
  const { review, row: root } = await load(tx, userId, value.threadId, true);
  const [row] = await tx
    .insert(codeReviewComments)
    .values({
      orgId: review.orgId,
      reviewId: review.id,
      threadId: root.id,
      path: root.path,
      line: root.line,
      side: root.side,
      headSha: root.headSha,
      body: value.body,
      authorId: userId,
    })
    .returning();
  if (!row) throw missing();
  await audit(tx, userId, "reply", row);
  await notifyComment(tx, userId, review, row, deps);
  await queueCommentSync(tx, review, row, deps);
  return present(tx, row);
}

export async function editReviewComment(
  tx: Tx,
  userId: string,
  input: { commentId: string; body: string },
  deps: CommentDeps = {},
) {
  const value = codeReviewCommentEditInput.parse(input);
  const { review, row } = await load(tx, userId, value.commentId);
  requireAuthor(row, userId);
  if (row.deletedAt) throw missing();
  const [updated] = await tx
    .update(codeReviewComments)
    .set({ body: value.body, editedAt: new Date() })
    .where(eq(codeReviewComments.id, row.id))
    .returning();
  if (!updated) throw missing();
  await audit(tx, userId, "edit", updated);
  await queueCommentSync(tx, review, updated, deps);
  return present(tx, updated);
}

function requireAuthor(row: CommentRow, userId: string) {
  if (row.origin !== "hive" || row.authorId !== userId)
    throw new ForbiddenError(
      "CODE_REVIEW_COMMENT_AUTHOR_ONLY",
      "Chỉ tác giả được sửa hoặc xoá bình luận của mình trên Hive.",
    );
}

export async function deleteReviewComment(tx: Tx, userId: string, commentId: string, deps: CommentDeps = {}) {
  const { review, row } = await load(tx, userId, commentId);
  requireAuthor(row, userId);
  if (!row.deletedAt) {
    await tx
      .update(codeReviewComments)
      .set({ deletedAt: new Date(), body: "" })
      .where(eq(codeReviewComments.id, row.id));
    await audit(tx, userId, "delete", row);
    await queueCommentSync(tx, review, row, deps);
  }
  return { ok: true };
}

export async function resolveReviewComment(
  tx: Tx,
  userId: string,
  threadId: string,
  resolved: boolean,
  deps: CommentDeps = {},
) {
  const { review, row } = await load(tx, userId, threadId, true);
  if (Boolean(row.resolvedAt) === resolved) return thread(tx, review, row);
  const [updated] = await tx
    .update(codeReviewComments)
    .set({ resolvedAt: resolved ? new Date() : null, resolvedBy: resolved ? userId : null })
    .where(eq(codeReviewComments.id, row.id))
    .returning();
  if (!updated) throw missing();
  await audit(tx, userId, resolved ? "resolve" : "reopen", updated);
  await queueCommentSync(tx, review, updated, deps);
  return thread(tx, review, updated);
}

export async function retryReviewCommentSync(tx: Tx, userId: string, commentId: string, deps: CommentDeps = {}) {
  const { review, row } = await load(tx, userId, commentId);
  requireAuthor(row, userId);
  const [link] = await tx.select().from(codeReviewCommentLinks).where(eq(codeReviewCommentLinks.commentId, row.id));
  if (link?.state !== "failed")
    throw new ForbiddenError("CODE_REVIEW_COMMENT_SYNC_NOT_FAILED", "Chỉ thử lại khi đồng bộ bình luận bị lỗi.");
  await queueCommentSync(tx, review, row, deps);
  return present(tx, row);
}
