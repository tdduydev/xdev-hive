import type { ProjectBudget } from "@xdev-hive/contracts";
import { type CostEventData, costEventData } from "@xdev-hive/contracts/worker-protocol";
import { and, eq, ne, sql } from "drizzle-orm";
import { BadRequestError, type Tx } from "../platform/index.ts";
import { runEvents, runs } from "./schema.ts";
import type { RunRow } from "./state.ts";

/** Dữ liệu cost hợp lệ của worker, null khi sai dạng (worker cũ hoặc lỗi): bỏ qua thay vì làm hỏng run. */
export function parseCostData(data: Record<string, unknown>): CostEventData | null {
  const r = costEventData.safeParse(data);
  return r.success ? r.data : null;
}

/**
 * Cộng sự kiện cost vừa ghi (id `eventId`) vào cột của run. Worker gửi số luỹ kế của lần thử, nên phần cộng thêm là
 * hiệu với số lớn nhất đã nhận của cùng lần thử; gói đến muộn mang số nhỏ hơn cho hiệu âm, bị chặn về 0, nên cột chỉ
 * tăng. Lần thử mới bắt đầu lại từ 0 và được cộng tiếp, nên cột là tổng mọi lần thử. Người gọi đã khoá dòng run.
 */
export async function applyCost(tx: Tx, run: RunRow, eventId: number, data: CostEventData): Promise<void> {
  const num = (field: string) => sql`max((${runEvents.data}->>${field})::numeric)`;
  const [prev] = await tx
    .select({
      inputTokens: num("inputTokens"),
      outputTokens: num("outputTokens"),
      cacheReadTokens: num("cacheReadTokens"),
      cacheWriteTokens: num("cacheWriteTokens"),
      costUsd: num("costUsd"),
      turns: num("turns"),
    })
    .from(runEvents)
    .where(
      and(
        eq(runEvents.runId, run.id),
        eq(runEvents.attempt, run.attempt),
        eq(runEvents.type, "cost"),
        ne(runEvents.id, eventId),
      ),
    );
  const before = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
  const delta = (now: number | null, field: keyof NonNullable<typeof prev>) =>
    now === null ? 0 : Math.max(0, now - before(prev?.[field]));
  const d = {
    tokensIn: delta(data.inputTokens, "inputTokens"),
    tokensOut: delta(data.outputTokens, "outputTokens"),
    cacheRead: delta(data.cacheReadTokens, "cacheReadTokens"),
    cacheWrite: delta(data.cacheWriteTokens, "cacheWriteTokens"),
    turns: delta(data.turns, "turns"),
  };
  // Hiệu USD tính trong Postgres (numeric) để không mang sai số của số thực vào tổng.
  const prevUsd = prev?.costUsd === null || prev?.costUsd === undefined ? "0" : String(prev.costUsd);
  await tx
    .update(runs)
    .set({
      tokensIn: sql`${runs.tokensIn} + ${d.tokensIn}`,
      tokensOut: sql`${runs.tokensOut} + ${d.tokensOut}`,
      cacheRead: sql`${runs.cacheRead} + ${d.cacheRead}`,
      cacheWrite: sql`${runs.cacheWrite} + ${d.cacheWrite}`,
      ...(data.costUsd === null
        ? {}
        : {
            costUsd: sql`coalesce(${runs.costUsd}, 0) + greatest(0, ${String(data.costUsd)}::numeric - ${prevUsd}::numeric)`,
          }),
      ...(data.turns === null ? {} : { turns: sql`coalesce(${runs.turns}, 0) + ${d.turns}` }),
      ...(data.accountId ? { accountId: data.accountId } : {}),
    })
    .where(eq(runs.id, run.id));
}

/** USD task đã dùng qua mọi run. */
export async function taskSpentUsd(tx: Tx, taskId: string): Promise<number> {
  const [row] = await tx
    .select({ spent: sql<string>`coalesce(sum(${runs.costUsd}), 0)` })
    .from(runs)
    .where(eq(runs.taskId, taskId));
  return Number(row?.spent ?? 0);
}

/** Chi phí các run của tổ chức kết thúc hoặc còn chạy trong ngày hôm nay (UTC), cho trần ngày của Chính sách agent. */
export async function orgSpentTodayUsd(tx: Tx): Promise<number> {
  const [row] = await tx
    .select({ spent: sql<string>`coalesce(sum(${runs.costUsd}), 0)` })
    .from(runs)
    .where(
      sql`coalesce(${runs.finishedAt}, ${runs.updatedAt}) >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'`,
    );
  return Number(row?.spent ?? 0);
}

export async function taskBudgetExhausted(tx: Tx, taskId: string, budget: ProjectBudget | undefined) {
  return budget?.perTaskUsd !== undefined && (await taskSpentUsd(tx, taskId)) >= budget.perTaskUsd;
}

/** Không giao thêm run cho task đã tiêu hết ngân sách task của dự án. */
export async function assertTaskBudget(tx: Tx, taskId: string, budget: ProjectBudget | undefined): Promise<void> {
  if (await taskBudgetExhausted(tx, taskId, budget)) {
    throw new BadRequestError("TASK_BUDGET_EXHAUSTED", "Task đã dùng hết ngân sách");
  }
}

/** Trần gửi cho worker trong spec job (worker/internal/runner.Budget). */
export interface JobBudget {
  maxCostUsd?: number;
  maxTokens?: number;
  maxTurns?: number;
}

/**
 * Trần USD của run là phần nhỏ hơn giữa perRunUsd và phần ngân sách task còn lại, để run cuối không tiêu lố ngân
 * sách task. Trả undefined khi dự án không đặt trần nào.
 */
export function jobBudget(budget: ProjectBudget | undefined, taskSpent: number): JobBudget | undefined {
  if (!budget) return undefined;
  const out: JobBudget = {};
  const caps = [budget.perRunUsd, budget.perTaskUsd === undefined ? undefined : budget.perTaskUsd - taskSpent].filter(
    (v): v is number => v !== undefined,
  );
  // Ngân sách task đã hết (run giao lại sau khi mất máy): trần gần 0 để worker dừng ngay ở báo cáo usage đầu tiên.
  if (caps.length) out.maxCostUsd = Math.max(0.000001, Math.min(...caps));
  if (budget.perRunTokens !== undefined) out.maxTokens = budget.perRunTokens;
  if (budget.maxTurns !== undefined) out.maxTurns = budget.maxTurns;
  return Object.keys(out).length ? out : undefined;
}
