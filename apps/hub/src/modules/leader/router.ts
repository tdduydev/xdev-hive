import { implement } from "@orpc/server";
import { contract, leaderAction } from "@xdev-hive/contracts";
import { and, desc, eq, sql } from "drizzle-orm";
import { recordAudit } from "../audit/index.ts";
import { loadProject } from "../catalog/index.ts";
import type { RequestContext, Tx } from "../platform/index.ts";
import { ConflictError, NotFoundError, withTenant } from "../platform/index.ts";
import type { RunsEngine } from "../runs/index.ts";
import { type OrgDeps, orgMiddlewares } from "../tenancy/index.ts";
import { emitLeaderActivity, executeLeaderAction, tierChoice } from "./actions.ts";
import { assembleLeaderPrompt, formatTranscript, projectContext } from "./prompt.ts";
import { approvals, chatMessages, chatThreads } from "./schema.ts";

export interface LeaderRouterDeps extends OrgDeps {
  runs?: RunsEngine | undefined;
  approvalTtlSec?: number | undefined;
}

const messageView = (row: typeof chatMessages.$inferSelect) => ({
  id: row.id,
  role: row.role,
  content: row.content,
  runId: row.runId,
  createdAt: row.createdAt.toISOString(),
});
const threadView = (row: typeof chatThreads.$inferSelect) => ({
  id: row.id,
  projectId: row.projectId,
  title: row.title,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});
const approvalView = (row: typeof approvals.$inferSelect) => ({
  id: row.id,
  threadId: row.threadId,
  action: leaderAction.parse(row.action),
  status: row.status,
  expiresAt: row.expiresAt.toISOString(),
  decidedBy: row.decidedBy,
  reason: row.reason,
  createdAt: row.createdAt.toISOString(),
});

export function leaderRouter(deps: LeaderRouterDeps) {
  const { authed, inOrg, orgMember } = orgMiddlewares(deps);
  const os = implement(contract.leader).$context<RequestContext>().use(authed);
  return {
    threads: {
      create: os.threads.create.use(inOrg).handler(async ({ context: { tx, user, orgId }, input }) => {
        const [row] = await tx
          .insert(chatThreads)
          .values({
            orgId,
            projectId: input.projectId ?? null,
            createdBy: user.id,
            title: input.title,
          })
          .returning();
        if (!row) throw new Error("Không tạo được cuộc trò chuyện.");
        return threadView(row);
      }),
      list: os.threads.list
        .use(inOrg)
        .handler(async ({ context: { tx } }) =>
          (await tx.select().from(chatThreads).orderBy(desc(chatThreads.updatedAt))).map(threadView),
        ),
      get: os.threads.get.use(inOrg).handler(async ({ context: { tx }, input }) => {
        const [row] = await tx.select().from(chatThreads).where(eq(chatThreads.id, input.id));
        if (!row) throw new NotFoundError("LEADER_THREAD_NOT_FOUND", "Không tìm thấy cuộc trò chuyện.");
        const messages = await tx
          .select()
          .from(chatMessages)
          .where(eq(chatMessages.threadId, row.id))
          .orderBy(chatMessages.createdAt);
        return { thread: threadView(row), messages: messages.map(messageView) };
      }),
      send: os.threads.send.use(inOrg).handler(async ({ context: { pool, user, orgId }, input }) => {
        const runsEngine = deps.runs;
        if (!runsEngine) throw new ConflictError("RUNS_DISABLED", "Hub chưa cấu hình giao leader run.");
        const { response, afterCommit } = await withTenant(pool, { userId: user.id, orgId }, async (tx) => {
          const [thread] = await tx.select().from(chatThreads).where(eq(chatThreads.id, input.id));
          if (!thread) throw new NotFoundError("LEADER_THREAD_NOT_FOUND", "Không tìm thấy cuộc trò chuyện.");
          if (!thread.projectId)
            throw new ConflictError(
              "LEADER_PROJECT_REQUIRED",
              "Hãy gắn cuộc trò chuyện với một dự án trước khi gửi tin nhắn.",
            );
          const project = await loadProject(tx, thread.projectId);
          if (!project) throw new NotFoundError("PROJECT_NOT_FOUND", "Không tìm thấy dự án của cuộc trò chuyện.");
          const [message] = await tx
            .insert(chatMessages)
            .values({
              orgId: thread.orgId,
              threadId: thread.id,
              role: "user",
              senderId: user.id,
              content: input.content,
            })
            .returning();
          await tx.update(chatThreads).set({ updatedAt: new Date() }).where(eq(chatThreads.id, thread.id));
          if (!message) throw new Error("Không lưu được tin nhắn.");
          const history = await tx
            .select({ role: chatMessages.role, content: chatMessages.content })
            .from(chatMessages)
            .where(eq(chatMessages.threadId, thread.id))
            .orderBy(chatMessages.createdAt);
          const transcript = formatTranscript(history);
          const context = await projectContext(tx, user.id, project.id, project.teamId);
          const prompt = assembleLeaderPrompt({
            transcript,
            projectName: project.name,
            projectKey: project.key,
            defaultBranch: project.defaultBranch,
            context,
          });
          const started = await runsEngine.startLeaderRun(tx, user.id, {
            threadId: thread.id,
            projectId: project.id,
            prompt,
            ...(input.cli ? { cli: input.cli } : {}),
          });
          return {
            response: { message: messageView(message), runId: started.runId },
            afterCommit: started.afterCommit,
          };
        });
        afterCommit();
        return response;
      }),
    },
    approvals: {
      list: os.approvals.list.use(inOrg).handler(async ({ context: { tx }, input }) => {
        await expireApprovals(tx);
        const rows = await tx
          .select()
          .from(approvals)
          .where(
            and(
              input.status ? eq(approvals.status, input.status) : undefined,
              input.threadId ? eq(approvals.threadId, input.threadId) : undefined,
            ),
          )
          .orderBy(desc(approvals.createdAt));
        return rows.map(approvalView);
      }),
      approve: os.approvals.approve.use(orgMember).handler(async ({ context: { pool, user, orgId }, input }) => {
        const { response, afterCommit } = await withTenant(pool, { userId: user.id, orgId }, async (tx) => {
          await expireApprovals(tx);
          const [row] = await tx.select().from(approvals).where(eq(approvals.id, input.id)).for("update");
          if (row?.status !== "pending")
            throw new ConflictError("APPROVAL_NOT_PENDING", "Đề xuất không còn chờ duyệt.");
          const proposed = leaderAction.parse(row.action);
          // Người duyệt sửa cấp độ Leader đã chọn: hành động lưu lại với cấp mới để lịch sử khớp việc đã làm.
          const action =
            input.tier && (proposed.type === "task.create" || proposed.type === "run.dispatch")
              ? { ...proposed, tier: input.tier }
              : proposed;
          const choice = await tierChoice(tx, action);
          const { result, afterCommit: afterCommitAction } = await executeLeaderAction(tx, user.id, action, deps.runs);
          const [updated] = await tx
            .update(approvals)
            .set({ status: "approved", decidedBy: user.id, action })
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
                    ...("tier" in proposed && proposed.tier !== choice.tier
                      ? { proposedTier: proposed.tier ?? null }
                      : {}),
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
          return { response: { approval: approvalView(updated), result }, afterCommit: afterCommitAction };
        });
        afterCommit?.();
        emitLeaderActivity(response.approval.threadId);
        return response;
      }),
      reject: os.approvals.reject.use(inOrg).handler(async ({ context: { tx, user }, input }) => {
        await expireApprovals(tx);
        const [row] = await tx.select().from(approvals).where(eq(approvals.id, input.id)).for("update");
        if (row?.status !== "pending" || row.expiresAt <= new Date())
          throw new ConflictError("APPROVAL_NOT_PENDING", "Đề xuất không còn chờ xử lý.");
        const [updated] = await tx
          .update(approvals)
          .set({ status: "rejected", decidedBy: user.id, reason: input.reason })
          .where(eq(approvals.id, row.id))
          .returning();
        await recordAudit(tx, {
          action: "leader.approval.reject",
          targetType: "approval",
          targetId: row.id,
          data: { reason: input.reason },
        });
        await tx.insert(chatMessages).values({
          orgId: row.orgId,
          threadId: row.threadId,
          role: "system",
          content: `Đề xuất bị từ chối: ${input.reason}`,
        });
        if (!updated) throw new Error("Không cập nhật được đề xuất.");
        emitLeaderActivity(updated.threadId);
        return approvalView(updated);
      }),
    },
  };
}

async function expireApprovals(tx: Tx) {
  await tx
    .update(approvals)
    .set({ status: "expired" })
    .where(and(eq(approvals.status, "pending"), sql`expires_at <= now()`));
}
