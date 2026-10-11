import { implement } from "@orpc/server";
import { contract, leaderAction } from "@xdev-hive/contracts";
import { and, desc, eq, sql } from "drizzle-orm";
import { recordAudit } from "../audit/index.ts";
import { loadProject, updateProjectSettings } from "../catalog/index.ts";
import { costSummary } from "../cost/index.ts";
import { listOnlineMachines } from "../fleet/index.ts";
import type { RequestContext, Tx } from "../platform/index.ts";
import { ConflictError, NotFoundError, withTenant } from "../platform/index.ts";
import { type RunsEngine, runs } from "../runs/index.ts";
import { createTask, listTasks } from "../tasks/index.ts";
import { type OrgDeps, orgMiddlewares } from "../tenancy/index.ts";
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
          const prompt = leaderPrompt(history, project.name, project.key, project.defaultBranch);
          const context = await projectContext(tx, user.id, project.id, project.teamId);
          const started = await runsEngine.startLeaderRun(tx, user.id, {
            threadId: thread.id,
            projectId: project.id,
            prompt: `${prompt}\n\nBối cảnh dự án:\n${context}`,
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
          .where(input.status ? eq(approvals.status, input.status) : undefined)
          .orderBy(desc(approvals.createdAt));
        return rows.map(approvalView);
      }),
      approve: os.approvals.approve.use(orgMember).handler(async ({ context: { pool, user, orgId }, input }) => {
        const { response, afterCommit } = await withTenant(pool, { userId: user.id, orgId }, async (tx) => {
          await expireApprovals(tx);
          const [row] = await tx.select().from(approvals).where(eq(approvals.id, input.id)).for("update");
          if (row?.status !== "pending")
            throw new ConflictError("APPROVAL_NOT_PENDING", "Đề xuất không còn chờ duyệt.");
          const action = leaderAction.parse(row.action);
          let result: Record<string, unknown> | null = null;
          let afterCommitAction: (() => void) | undefined;
          if (action.type === "task.create") result = { task: await createTask(tx, user.id, action) };
          else if (action.type === "project.settings")
            result = { settings: await updateProjectSettings(tx, user.id, action.projectKey, action.patch) };
          else if (action.type === "run.dispatch") {
            if (!deps.runs) throw new Error("Hub chưa cấu hình giao run.");
            const queued = await deps.runs.startRun(tx, user.id, {
              taskId: action.taskId,
              ...(action.cli ? { cli: action.cli } : {}),
            });
            result = { run: queued.run };
            afterCommitAction = queued.afterCommit;
          } else if (action.type === "run.cancel") {
            if (!deps.runs) throw new Error("Hub chưa cấu hình giao run.");
            const cancelled = await deps.runs.cancelRun(tx, user.id, action.runId);
            result = { run: cancelled.run };
            afterCommitAction = cancelled.afterCommit;
          }
          const [updated] = await tx
            .update(approvals)
            .set({ status: "approved", decidedBy: user.id })
            .where(eq(approvals.id, row.id))
            .returning();
          await recordAudit(tx, {
            action: "leader.approval.approve",
            targetType: "approval",
            targetId: row.id,
            data: { action: action.type },
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
        return approvalView(updated);
      }),
    },
  };
}

const HISTORY_CHAR_BUDGET = 24_000;

function leaderPrompt(
  messages: Array<{ role: string; content: string }>,
  projectName: string,
  projectKey: string,
  defaultBranch: string | null,
): string {
  const first = messages[0];
  const selected = first ? [first] : [];
  let used = first?.content.length ?? 0;
  for (const message of messages.slice(1).reverse()) {
    const size = message.content.length + message.role.length + 4;
    if (used + size > HISTORY_CHAR_BUDGET) continue;
    selected.unshift(message);
    used += size;
  }
  const transcript = selected.map((m) => `${m.role}: ${m.content}`).join("\n\n");
  return [
    "Bạn là leader agent của dự án. Chỉ đọc repository và bối cảnh được cung cấp.",
    "Trả lời người dùng bằng đúng một lần gọi MCP `leader_reply`.",
    "Mọi hành động phải được đề xuất bằng MCP `leader_propose`; không tự thực hiện thay đổi.",
    `Dự án: ${projectName} (${projectKey}); nhánh chính: ${defaultBranch ?? "main"}.`,
    "Lịch sử cuộc trò chuyện (giữ tin đầu và các tin gần nhất trong ngân sách ký tự):",
    transcript,
  ].join("\n\n");
}

async function projectContext(tx: Tx, userId: string, projectId: string, teamId: string): Promise<string> {
  const [todo, running] = await Promise.all([
    listTasks(tx, userId, projectId, "todo"),
    listTasks(tx, userId, projectId, "running"),
  ]);
  const recentRuns = await tx
    .select({ kind: runs.kind, state: runs.state, createdAt: runs.createdAt })
    .from(runs)
    .where(eq(runs.projectId, projectId))
    .orderBy(desc(runs.createdAt))
    .limit(5);
  const machines = await listOnlineMachines(tx, teamId);
  const today = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  let costs: string;
  try {
    const summary = await costSummary(tx, userId, { projectId, from, to: today, groupBy: "day" });
    costs = `${summary.total.costUsd.toFixed(4)} USD trong 7 ngày`;
  } catch {
    costs = "không có quyền xem chi phí";
  }
  return [
    `Task đang mở: ${
      [...todo, ...running]
        .slice(0, 10)
        .map((t) => `${t.key} (${t.status}): ${t.title}`)
        .join("; ") || "không có"
    }`,
    `Run gần đây: ${recentRuns.map((r) => `${r.kind}/${r.state}`).join(", ") || "không có"}`,
    `Máy trực tuyến: ${machines.map((m) => `${m.name} [${m.clis.join(", ")}]`).join(", ") || "không có"}`,
    `Chi phí: ${costs}`,
  ].join("\n");
}

async function expireApprovals(tx: Tx) {
  await tx
    .update(approvals)
    .set({ status: "expired" })
    .where(and(eq(approvals.status, "pending"), sql`expires_at <= now()`));
}
