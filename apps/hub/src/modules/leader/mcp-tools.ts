import { leaderAction } from "@xdev-hive/contracts";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { McpToolRegistry } from "../mcp/index.ts";
import { BadRequestError, ForbiddenError, NotFoundError } from "../platform/index.ts";
import { runEvents, runs } from "../runs/index.ts";
import { emitLeaderEvent } from "./observer.ts";
import { approvals, chatMessages, chatThreads } from "./schema.ts";

const requireLeaderRun = (principal: { kind: string; runKind?: string | undefined; runId?: string | undefined }) => {
  if (principal.kind !== "run" || principal.runKind !== "leader" || !principal.runId) {
    throw new ForbiddenError("LEADER_RUN_REQUIRED", "Chỉ leader agent mới được gọi công cụ này.");
  }
  return principal.runId;
};

export function registerMcpTools(registry: McpToolRegistry, approvalTtlSec = configuredApprovalTtl()): void {
  registry.register({
    name: "leader_reply",
    title: "Trả lời trong cuộc trò chuyện",
    description: "Gửi câu trả lời vào cuộc trò chuyện hiện tại với người dùng.",
    input: z.object({ threadId: z.string().uuid(), content: z.string().trim().min(1).max(20_000) }),
    runKinds: ["leader"],
    readOnly: true,
    handler: async ({ threadId, content }, { tx, principal }) => {
      const runId = requireLeaderRun(principal);
      const [run] = await tx
        .select({ kind: runs.kind, projectId: runs.projectId, orgId: runs.orgId, attempt: runs.attempt })
        .from(runs)
        .where(eq(runs.id, runId));
      const [thread] = await tx.select().from(chatThreads).where(eq(chatThreads.id, threadId));
      if (run?.kind !== "leader" || !thread || (thread.projectId && thread.projectId !== run.projectId)) {
        throw new NotFoundError("LEADER_THREAD_NOT_FOUND", "Không tìm thấy cuộc trò chuyện của leader run.");
      }
      await tx.insert(chatMessages).values({ orgId: thread.orgId, threadId, role: "leader", content, runId });
      await tx
        .insert(runEvents)
        .values({ orgId: run.orgId, runId, attempt: run.attempt, type: "leader_reply", data: {} });
      await tx.update(chatThreads).set({ updatedAt: sql`now()` }).where(eq(chatThreads.id, threadId));
      await emitLeaderEvent(tx, { threadId, kind: "reply", content });
      return { recorded: true };
    },
  });

  registry.register({
    name: "leader_propose",
    title: "Đề xuất hành động",
    description: "Tạo đề xuất để người có quyền xem xét; không thực hiện hành động ngay.",
    input: z.object({
      threadId: z.string().uuid(),
      action: leaderAction,
      rationale: z.string().trim().min(1).max(4000),
    }),
    runKinds: ["leader"],
    readOnly: true,
    handler: async ({ threadId, action, rationale }, { tx, principal }) => {
      const runId = requireLeaderRun(principal);
      const [run] = await tx
        .select({ kind: runs.kind, projectId: runs.projectId })
        .from(runs)
        .where(eq(runs.id, runId));
      const [thread] = await tx.select().from(chatThreads).where(eq(chatThreads.id, threadId));
      if (run?.kind !== "leader" || !thread || (thread.projectId && thread.projectId !== run.projectId)) {
        throw new NotFoundError("LEADER_THREAD_NOT_FOUND", "Không tìm thấy cuộc trò chuyện của leader run.");
      }
      const checked = leaderAction.safeParse(action);
      if (!checked.success) throw new BadRequestError("LEADER_ACTION_INVALID", "Đề xuất hành động không hợp lệ.");
      const [approval] = await tx
        .insert(approvals)
        .values({
          orgId: thread.orgId,
          threadId,
          action: checked.data,
          expiresAt: new Date(Date.now() + approvalTtlSec * 1000),
        })
        .returning();
      await tx
        .insert(chatMessages)
        .values({ orgId: thread.orgId, threadId, role: "leader", content: rationale, runId });
      if (!approval) throw new Error("Không tạo được đề xuất.");
      await emitLeaderEvent(tx, { threadId, kind: "proposal", content: rationale, approvalId: approval.id });
      return { approvalId: approval.id, status: approval.status, expiresAt: approval.expiresAt.toISOString() };
    },
  });
}

function configuredApprovalTtl(): number {
  const value = Number.parseInt(process.env.HIVE_LEADER_APPROVAL_TTL_SECONDS ?? "86400", 10);
  return Number.isSafeInteger(value) && value >= 60 && value <= 2_592_000 ? value : 86_400;
}
