import { type ChatArtifactRef, type LeaderAction, leaderAction } from "@xdev-hive/contracts";
import { and, desc, eq, sql } from "drizzle-orm";
import { recordAudit } from "../audit/index.ts";
import { loadProject } from "../catalog/index.ts";
import type { Tx } from "../platform/index.ts";
import { ConflictError, NotFoundError } from "../platform/index.ts";
import type { RunsEngine } from "../runs/index.ts";
import type { SdlcDeps } from "../sdlc/index.ts";
import { emitLeaderActivity, executeLeaderAction, tierChoice } from "./actions.ts";
import { assembleLeaderPrompt, loadTranscript, projectContext } from "./prompt.ts";
import { approvals, chatMessages, chatThreads } from "./schema.ts";

export const messageView = (row: typeof chatMessages.$inferSelect, artifact: ChatArtifactRef | null = null) => ({
  id: row.id,
  role: row.role,
  content: row.content,
  runId: row.runId,
  createdAt: row.createdAt.toISOString(),
  artifact,
});
export const threadView = (row: typeof chatThreads.$inferSelect) => ({
  id: row.id,
  projectId: row.projectId,
  title: row.title,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});
export const approvalView = (row: typeof approvals.$inferSelect) => ({
  id: row.id,
  threadId: row.threadId,
  action: leaderAction.parse(row.action),
  status: row.status,
  expiresAt: row.expiresAt.toISOString(),
  decidedBy: row.decidedBy,
  reason: row.reason,
  createdAt: row.createdAt.toISOString(),
});

export async function createThread(
  tx: Tx,
  userId: string,
  input: { projectId?: string | null | undefined; title: string },
) {
  const [row] = await tx
    .insert(chatThreads)
    .values({
      orgId: sql`hive.ctx_org()`,
      projectId: input.projectId ?? null,
      createdBy: userId,
      title: input.title,
    })
    .returning();
  if (!row) throw new Error("Không tạo được cuộc trò chuyện.");
  return row;
}

/**
 * Lưu tin của người dùng rồi giao leader run. Chạy trong transaction của người gọi; `afterCommit` phải gọi sau khi
 * transaction commit để run được giao đi.
 */
export async function sendLeaderMessage(
  runsEngine: RunsEngine,
  tx: Tx,
  userId: string,
  input: {
    threadId: string;
    content: string;
    cli?: Parameters<RunsEngine["startLeaderRun"]>[2]["cli"];
    model?: string | null;
  },
) {
  const [thread] = await tx.select().from(chatThreads).where(eq(chatThreads.id, input.threadId));
  if (!thread) throw new NotFoundError("LEADER_THREAD_NOT_FOUND", "Không tìm thấy cuộc trò chuyện.");
  if (!thread.projectId)
    throw new ConflictError("LEADER_PROJECT_REQUIRED", "Hãy gắn cuộc trò chuyện với một dự án trước khi gửi tin nhắn.");
  const project = await loadProject(tx, thread.projectId);
  if (!project) throw new NotFoundError("PROJECT_NOT_FOUND", "Không tìm thấy dự án của cuộc trò chuyện.");
  const [message] = await tx
    .insert(chatMessages)
    .values({
      orgId: thread.orgId,
      threadId: thread.id,
      role: "user",
      senderId: userId,
      content: input.content,
    })
    .returning();
  await tx.update(chatThreads).set({ updatedAt: new Date() }).where(eq(chatThreads.id, thread.id));
  if (!message) throw new Error("Không lưu được tin nhắn.");
  const transcript = await loadTranscript(tx, thread.id);
  const context = await projectContext(tx, userId, project.id, project.teamId);
  const prompt = assembleLeaderPrompt({
    transcript,
    projectName: project.name,
    projectKey: project.key,
    defaultBranch: project.defaultBranch,
    context,
  });
  const started = await runsEngine.startLeaderRun(tx, userId, {
    threadId: thread.id,
    projectId: project.id,
    prompt,
    ...(input.cli ? { cli: input.cli } : {}),
    ...(input.model ? { model: input.model } : {}),
  });
  return {
    response: { message: messageView(message), runId: started.runId },
    afterCommit: started.afterCommit,
  };
}

export async function listApprovals(tx: Tx, status?: (typeof approvals.$inferSelect)["status"], threadId?: string) {
  await expireApprovals(tx);
  const rows = await tx
    .select()
    .from(approvals)
    .where(
      and(status ? eq(approvals.status, status) : undefined, threadId ? eq(approvals.threadId, threadId) : undefined),
    )
    .orderBy(desc(approvals.createdAt));
  return rows.map(approvalView);
}

export async function approveApproval(
  runsEngine: RunsEngine | undefined,
  tx: Tx,
  userId: string,
  id: string,
  tier?: "light" | "medium" | "heavy",
  sdlc: SdlcDeps = {},
) {
  await expireApprovals(tx);
  const [row] = await tx.select().from(approvals).where(eq(approvals.id, id)).for("update");
  if (row?.status !== "pending") throw new ConflictError("APPROVAL_NOT_PENDING", "Đề xuất không còn chờ duyệt.");
  const proposed = leaderAction.parse(row.action);
  // Người duyệt sửa cấp độ Leader đã chọn: hành động lưu lại với cấp mới để lịch sử khớp việc đã làm.
  const action =
    tier && (proposed.type === "task.create" || proposed.type === "run.dispatch") ? { ...proposed, tier } : proposed;
  const choice = await tierChoice(tx, action);
  const { result, afterCommit: afterCommitAction } = await executeLeaderAction(tx, userId, action, runsEngine, sdlc);
  const [updated] = await tx
    .update(approvals)
    .set({ status: "approved", decidedBy: userId, action })
    .where(eq(approvals.id, row.id))
    .returning();
  await recordAudit(tx, {
    action: "leader.approval.approve",
    targetType: "approval",
    targetId: row.id,
    data: {
      action: action.type,
      ...(choice
        ? {
            tier: choice.tier,
            tierReason: choice.reason,
            model: choice.model,
            // Cấp Leader đề xuất khi người duyệt đã đổi, để audit thấy ai chọn cấp nào.
            ...("tier" in proposed && proposed.tier !== choice.tier ? { proposedTier: proposed.tier ?? null } : {}),
          }
        : {}),
    },
  });
  await tx.insert(chatMessages).values({
    orgId: row.orgId,
    threadId: row.threadId,
    role: "system",
    content: "Đề xuất đã được duyệt và thực hiện.",
  });
  if (!updated) throw new Error("Không cập nhật được đề xuất.");
  return {
    response: { approval: approvalView(updated), result },
    afterCommit: () => {
      afterCommitAction?.();
      emitLeaderActivity(updated.threadId);
    },
  };
}

export async function rejectApproval(tx: Tx, userId: string, id: string, reason: string) {
  await expireApprovals(tx);
  const [row] = await tx.select().from(approvals).where(eq(approvals.id, id)).for("update");
  if (row?.status !== "pending" || row.expiresAt <= new Date())
    throw new ConflictError("APPROVAL_NOT_PENDING", "Đề xuất không còn chờ xử lý.");
  const [updated] = await tx
    .update(approvals)
    .set({ status: "rejected", decidedBy: userId, reason })
    .where(eq(approvals.id, row.id))
    .returning();
  await recordAudit(tx, {
    action: "leader.approval.reject",
    targetType: "approval",
    targetId: row.id,
    data: { reason },
  });
  await tx.insert(chatMessages).values({
    orgId: row.orgId,
    threadId: row.threadId,
    role: "system",
    content: `Đề xuất bị từ chối: ${reason}`,
  });
  if (!updated) throw new Error("Không cập nhật được đề xuất.");
  emitLeaderActivity(updated.threadId);
  return approvalView(updated);
}

async function expireApprovals(tx: Tx) {
  await tx
    .update(approvals)
    .set({ status: "expired" })
    .where(and(eq(approvals.status, "pending"), sql`expires_at <= now()`));
}

export type { LeaderAction };
