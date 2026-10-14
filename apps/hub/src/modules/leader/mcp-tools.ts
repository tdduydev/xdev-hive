import { leaderAction } from "@xdev-hive/contracts";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/index.ts";
import type { McpToolRegistry } from "../mcp/index.ts";
import { BadRequestError, ForbiddenError, NotFoundError } from "../platform/index.ts";
import { type RunsEngine, runEvents, runs } from "../runs/index.ts";
import { describeAction, emitLeaderActivity, executeLeaderAction, tierChoice, tierTable } from "./actions.ts";
import { emitLeaderEvent } from "./observer.ts";
import { approvals, chatMessages, chatThreads } from "./schema.ts";

const requireLeaderRun = (principal: { kind: string; runKind?: string | undefined; runId?: string | undefined }) => {
  if (principal.kind !== "run" || principal.runKind !== "leader" || !principal.runId) {
    throw new ForbiddenError("LEADER_RUN_REQUIRED", "Chỉ leader agent mới được gọi công cụ này.");
  }
  return principal.runId;
};

export function registerMcpTools(
  registry: McpToolRegistry,
  opts: { approvalTtlSec?: number | undefined; runs?: RunsEngine | undefined } = {},
): void {
  const approvalTtlSec = opts.approvalTtlSec ?? configuredApprovalTtl();
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

  registry.register({
    name: "leader_tiers",
    title: "Cấp độ task và model tương ứng",
    description:
      "Danh sách cấp độ (light, medium, heavy) với ý nghĩa và model/effort hub dùng cho mỗi cấp của dự án. Gọi trước khi gắn `tier` cho task.create hoặc run.dispatch.",
    input: z.object({ projectId: z.string().uuid().optional() }),
    runKinds: ["leader"],
    readOnly: true,
    handler: async ({ projectId }, { tx, principal }) =>
      tierTable(tx, projectId ?? principal.terminal?.projectId ?? principal.projectId ?? null),
  });

  registry.register({
    name: "leader_action",
    title: "Đề xuất hoặc thực hiện hành động trên hub",
    description:
      "Hành động lên hub của Leader trong terminal: tạo task, giao run, huỷ run, đổi cài đặt dự án. Chế độ Đề xuất: thành đề xuất chờ người duyệt ở khung bên cạnh. Chế độ Bypass: thực hiện ngay bằng quyền người mở phiên. task.create và run.dispatch nên có `tier` và `tierReason` (xem `leader_tiers`).",
    input: z.object({ action: leaderAction, rationale: z.string().trim().min(1).max(4000) }),
    runKinds: ["leader"],
    handler: async ({ action, rationale }, { tx, orgId, principal, afterCommit }) => {
      const terminal = principal.terminal;
      if (!terminal)
        throw new ForbiddenError("LEADER_TERMINAL_REQUIRED", "Chỉ Leader trong terminal mới gọi được công cụ này.");
      const checked = leaderAction.safeParse(action);
      if (!checked.success) throw new BadRequestError("LEADER_ACTION_INVALID", "Hành động không hợp lệ.");
      const choice = await tierChoice(tx, checked.data);
      const level = choice ? { tier: choice.tier, tierReason: choice.reason, model: choice.model } : {};
      if (terminal.mode === "propose") {
        if (!terminal.threadId)
          throw new NotFoundError("LEADER_THREAD_NOT_FOUND", "Phiên không có cuộc trò chuyện để đề xuất.");
        const [approval] = await tx
          .insert(approvals)
          .values({
            orgId,
            threadId: terminal.threadId,
            action: checked.data,
            expiresAt: new Date(Date.now() + approvalTtlSec * 1000),
          })
          .returning();
        if (!approval) throw new Error("Không tạo được đề xuất.");
        await tx
          .insert(chatMessages)
          .values({ orgId, threadId: terminal.threadId, role: "leader", content: rationale });
        await recordAudit(tx, {
          action: "terminal.propose",
          targetType: "approval",
          targetId: approval.id,
          data: { terminalSessionId: terminal.sessionId, summary: describeAction(checked.data), ...level },
        });
        afterCommit?.(() => emitLeaderActivity(terminal.threadId ?? ""));
        return { approvalId: approval.id, status: approval.status, message: "Đã gửi đề xuất, chờ người duyệt." };
      }
      // Bypass: người mở đã xác nhận cho Leader làm thẳng bằng quyền của họ; vẫn ghi audit từng lần (kèm cấp độ, model).
      const outcome = await executeLeaderAction(tx, principal.userId, checked.data, opts.runs);
      await recordAudit(tx, {
        action: "terminal.action",
        targetType: "terminal_session",
        targetId: terminal.sessionId,
        data: {
          terminalSessionId: terminal.sessionId,
          summary: describeAction(checked.data),
          type: checked.data.type,
          rationale: rationale.slice(0, 500),
          ...level,
        },
      });
      if (outcome.afterCommit) afterCommit?.(outcome.afterCommit);
      if (terminal.threadId) afterCommit?.(() => emitLeaderActivity(terminal.threadId ?? ""));
      return { done: true, result: outcome.result };
    },
  });
}

function configuredApprovalTtl(): number {
  const value = Number.parseInt(process.env.HIVE_LEADER_APPROVAL_TTL_SECONDS ?? "86400", 10);
  return Number.isSafeInteger(value) && value >= 60 && value <= 2_592_000 ? value : 86_400;
}
