import { and, desc, eq, gt } from "drizzle-orm";
import { loadProject } from "../catalog/index.ts";
import { costSummary } from "../cost/index.ts";
import { listOnlineMachines } from "../fleet/index.ts";
import type { Tx } from "../platform/index.ts";
import { runs } from "../runs/index.ts";
import { listTasks } from "../tasks/index.ts";
import { chatMessages, chatThreads } from "./schema.ts";

export async function queuedLeaderPrompt(tx: Tx, threadId: string, after: Date) {
  const [thread] = await tx.select().from(chatThreads).where(eq(chatThreads.id, threadId));
  if (!thread?.projectId) return null;
  const [queued] = await tx
    .select({ id: chatMessages.id, senderId: chatMessages.senderId })
    .from(chatMessages)
    .where(and(eq(chatMessages.threadId, threadId), eq(chatMessages.role, "user"), gt(chatMessages.createdAt, after)))
    .limit(1);
  if (!queued) return null;
  const [project] = await tx
    .select({ id: chatThreads.projectId })
    .from(chatThreads)
    .where(eq(chatThreads.id, threadId));
  const details = project?.id ? await loadProject(tx, project.id) : null;
  if (!details) return null;
  const messages = await tx
    .select({ role: chatMessages.role, content: chatMessages.content })
    .from(chatMessages)
    .where(eq(chatMessages.threadId, threadId))
    .orderBy(chatMessages.createdAt);
  const first = messages[0];
  const selected = first ? [first] : [];
  let used = first?.content.length ?? 0;
  for (const message of messages.slice(1).reverse()) {
    const size = message.content.length + message.role.length + 4;
    if (used + size > 24_000) continue;
    selected.unshift(message);
    used += size;
  }
  const transcript = selected.map((message) => `${message.role}: ${message.content}`).join("\n\n");
  const [todo, running] = await Promise.all([
    listTasks(tx, thread.createdBy, details.id, "todo"),
    listTasks(tx, thread.createdBy, details.id, "running"),
  ]);
  const recentRuns = await tx
    .select({ kind: runs.kind, state: runs.state })
    .from(runs)
    .where(eq(runs.projectId, details.id))
    .orderBy(desc(runs.createdAt))
    .limit(5);
  const machines = await listOnlineMachines(tx, details.teamId);
  const today = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  let costs = "không có quyền xem chi phí";
  try {
    const summary = await costSummary(tx, thread.createdBy, { projectId: details.id, from, to: today, groupBy: "day" });
    costs = `${summary.total.costUsd.toFixed(4)} USD trong 7 ngày`;
  } catch {
    // Chi phí chỉ được đưa vào prompt khi người tạo thread có quyền quản trị dự án.
  }
  const prompt = [
    "Bạn là leader agent của dự án. Chỉ đọc repository và bối cảnh được cung cấp.",
    "Trả lời người dùng bằng đúng một lần gọi MCP `leader_reply`.",
    "Mọi hành động phải được đề xuất bằng MCP `leader_propose`; không tự thực hiện thay đổi.",
    `Dự án: ${details.name} (${details.key}); nhánh chính: ${details.defaultBranch ?? "main"}.`,
    "Lịch sử cuộc trò chuyện (giữ tin đầu và các tin gần nhất trong ngân sách ký tự):",
    transcript,
    `Task đang mở: ${
      [...todo, ...running]
        .slice(0, 10)
        .map((task) => `${task.key} (${task.status}): ${task.title}`)
        .join("; ") || "không có"
    }`,
    `Run gần đây: ${recentRuns.map((run) => `${run.kind}/${run.state}`).join(", ") || "không có"}`,
    `Máy trực tuyến: ${machines.map((machine) => `${machine.name} [${machine.clis.join(", ")}]`).join(", ") || "không có"}`,
    `Chi phí: ${costs}`,
  ].join("\n\n");
  return { userId: queued.senderId ?? thread.createdBy, projectId: details.id, prompt };
}
