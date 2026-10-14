import type { CheckOutcome } from "@xdev-hive/contracts";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Tx } from "../platform/index.ts";
import { runEvents, runs } from "../runs/index.ts";
import { loadTask, type TaskRow } from "../tasks/index.ts";
import { type AttemptDigest, costLabel, type TaskDigest } from "./digest.ts";
import type { Candidate } from "./select.ts";

/** Tối đa bấy nhiêu lần chạy trước của một task vào tóm tắt. */
const MAX_ATTEMPTS = 4;
const MAX_COMMANDS = 8;

/** Lý do một run thất bại hoặc chưa đạt, từ kết quả hub ghi: lý do chung rồi tới kiểm tra không đạt. */
function problemsOf(result: { reasons?: string[]; checks?: CheckOutcome[] } | null | undefined): string[] {
  if (!result) return [];
  const failed = (result.checks ?? []).filter((c) => c.passed === false && !c.skipped).map((c) => c.message);
  return [...(result.reasons ?? []).slice(0, 3), ...failed.slice(0, 3)];
}

/** Lệnh shell trong sự kiện tool_call của worker (nếu có): chỉ lấy chuỗi lệnh, không lấy đầu ra. */
function commandOf(data: Record<string, unknown>): string | null {
  const direct = data.command;
  if (typeof direct === "string") return direct;
  const input = data.input;
  if (input && typeof input === "object" && typeof (input as { command?: unknown }).command === "string")
    return (input as { command: string }).command;
  return null;
}

/** Tóm tắt một ứng viên từ dữ liệu hub đã có (task, kết quả các run, báo cáo của agent), không đọc log thô. */
export async function loadDigest(tx: Tx, c: Candidate): Promise<TaskDigest | null> {
  const task: TaskRow | null = c.taskId ? await loadTask(tx, c.taskId) : null;
  const siblings = c.taskId
    ? await tx
        .select()
        .from(runs)
        .where(and(eq(runs.taskId, c.taskId), eq(runs.kind, "code")))
        .orderBy(desc(runs.createdAt))
        .limit(MAX_ATTEMPTS + 1)
    : await tx.select().from(runs).where(eq(runs.id, c.runId));
  const final = siblings.find((r) => r.id === c.runId) ?? siblings[0];
  if (!final) return null;
  const before = siblings
    .filter((r) => r.id !== final.id)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const attempts: AttemptDigest[] = before
    .slice(-MAX_ATTEMPTS)
    .map((r) => ({ state: r.state, problems: problemsOf(r.result) }));
  const events = await tx
    .select({ type: runEvents.type, data: runEvents.data })
    .from(runEvents)
    .where(and(eq(runEvents.runId, final.id), inArray(runEvents.type, ["agent_report", "tool_call"])))
    .orderBy(asc(runEvents.id))
    .limit(400);
  const notes = events
    .filter((e) => e.type === "agent_report" && typeof e.data.note === "string")
    .map((e) => e.data.note as string)
    .slice(-2);
  const commands = [
    ...new Set(
      events
        .filter((e) => e.type === "tool_call")
        .map((e) => commandOf(e.data))
        .filter((x): x is string => !!x),
    ),
  ].slice(-MAX_COMMANDS);
  return {
    taskKey: task?.key ?? final.branch,
    title: task?.title ?? final.branch,
    body: task?.body ?? "",
    triggers: c.triggers,
    retries: c.retries,
    cost: costLabel(c.costUsd, c.tokens),
    attempts: [
      ...attempts,
      ...(problemsOf(final.result).length ? [{ state: final.state, problems: problemsOf(final.result) }] : []),
    ],
    notes,
    commands,
    runIds: c.runIds,
  };
}
