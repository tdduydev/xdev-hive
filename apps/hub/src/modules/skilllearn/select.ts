import { type LearnTrigger, SKILL_LEARNING_COST_PERCENTILE, SKILL_LEARNING_MIN_RETRIES } from "@xdev-hive/contracts";
import { and, desc, eq, gt, gte, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import type { Tx } from "../platform/index.ts";
import { runs } from "../runs/index.ts";
import { skillLearningBatches, skillLearningMarks } from "./schema.ts";

// Chọn run đáng học (specs/014 FR-001). Ba lý do: thử lại ≥ 2 lần, chi phí vượt p90 của dự án, người duyệt đánh dấu.
// Chỉ run code đã có kết quả dùng được mới có “cách sửa” để học; run đánh dấu thì nhận mọi trạng thái đã kết thúc.

/** Run đủ số mẫu mới so p90 được: ít hơn thì phân vị không nói gì. */
export const MIN_COST_SAMPLE = 10;
/** Cửa sổ lấy mẫu p90 của dự án. */
const COST_WINDOW_DAYS = 30;
/** Lô đầu tiên của dự án chỉ nhìn lại chừng này ngày. */
export const FIRST_LOOKBACK_DAYS = 3;

const RESOLVED = ["succeeded", "no_changes", "needs_review"] as const;
const FINISHED = ["succeeded", "no_changes", "needs_review", "failed", "cancelled"] as const;

export interface Candidate {
  runId: string;
  taskId: string | null;
  triggers: LearnTrigger[];
  retries: number;
  costUsd: number | null;
  tokens: number;
  /** Mọi run của task đã vào lô (cùng task thì gộp thành một mục). */
  runIds: string[];
  score: number;
}

/** Điểm xếp hạng: nhiều lý do và nhiều lần thử lại thì lên trước; đánh dấu tay luôn đứng đầu. */
export function scoreOf(triggers: LearnTrigger[], retries: number, costRatio: number): number {
  return (triggers.includes("marked") ? 100 : 0) + triggers.length * 10 + retries + Math.min(costRatio, 10);
}

/** Số lần thử lại của một run: lần thử hạ tầng của chính nó, hoặc số lần task đã phải chạy lại. */
export const retriesOf = (attempt: number, taskRuns: number) => Math.max(attempt - 1, taskRuns - 1);

/** Run đã nằm trong một lô trước của dự án: không xét lại. */
async function consumedRunIds(tx: Tx, projectId: string): Promise<Set<string>> {
  const rows = await tx
    .select({ candidates: skillLearningBatches.candidates })
    .from(skillLearningBatches)
    .where(eq(skillLearningBatches.projectId, projectId))
    .orderBy(desc(skillLearningBatches.createdAt))
    .limit(120);
  const out = new Set<string>();
  for (const r of rows) for (const id of Object.keys(r.candidates)) out.add(id);
  return out;
}

/** Ngưỡng p90 (USD và token) của dự án; null khi chưa đủ mẫu. */
export async function costThresholds(
  tx: Tx,
  projectId: string,
  now: Date,
): Promise<{ usd: number | null; tokens: number | null }> {
  const since = new Date(now.getTime() - COST_WINDOW_DAYS * 86_400_000);
  const base = and(
    eq(runs.projectId, projectId),
    eq(runs.kind, "code"),
    inArray(runs.state, [...RESOLVED]),
    gte(runs.finishedAt, since),
  );
  const p = SKILL_LEARNING_COST_PERCENTILE;
  const [usd] = await tx
    .select({
      v: sql<number | null>`percentile_cont(${p}) within group (order by ${runs.costUsd})`,
      n: sql<number>`count(${runs.costUsd})::int`,
    })
    .from(runs)
    .where(and(base, isNotNull(runs.costUsd)));
  // Run không báo USD (Codex, Gemini): so theo tổng token.
  const total = sql`(${runs.tokensIn} + ${runs.tokensOut})`;
  const [tok] = await tx
    .select({
      v: sql<number | null>`percentile_cont(${p}) within group (order by ${total})`,
      n: sql<number>`count(*)::int`,
    })
    .from(runs)
    .where(and(base, sql`${total} > 0`));
  return {
    usd: usd && usd.n >= MIN_COST_SAMPLE && usd.v !== null ? Number(usd.v) : null,
    tokens: tok && tok.n >= MIN_COST_SAMPLE && tok.v !== null ? Number(tok.v) : null,
  };
}

/**
 * Task đáng học của dự án trong cửa sổ `(from, to]`, mỗi task một mục (run cuối cùng của nó), tốt nhất trước.
 * Run đã vào lô trước thì bỏ; run được đánh dấu thì xét dù ở ngoài cửa sổ cho tới khi vào một lô.
 */
export async function selectCandidates(
  tx: Tx,
  projectId: string,
  window: { from: Date; to: Date },
  limit: number,
): Promise<Candidate[]> {
  const consumed = await consumedRunIds(tx, projectId);
  const marks = await tx.select({ runId: skillLearningMarks.runId }).from(skillLearningMarks);
  const markedIds = marks.map((m) => m.runId).filter((id) => !consumed.has(id));
  const pool = await tx
    .select()
    .from(runs)
    .where(
      and(
        eq(runs.projectId, projectId),
        eq(runs.kind, "code"),
        or(
          and(inArray(runs.state, [...RESOLVED]), gt(runs.finishedAt, window.from), lte(runs.finishedAt, window.to)),
          markedIds.length ? and(inArray(runs.id, markedIds), inArray(runs.state, [...FINISHED])) : undefined,
        ),
      ),
    );
  if (!pool.length) return [];
  const taskIds = [...new Set(pool.flatMap((r) => (r.taskId ? [r.taskId] : [])))];
  const counts = taskIds.length
    ? await tx
        .select({ taskId: runs.taskId, n: sql<number>`count(*)::int` })
        .from(runs)
        .where(and(inArray(runs.taskId, taskIds), eq(runs.kind, "code")))
        .groupBy(runs.taskId)
    : [];
  const taskRuns = new Map(counts.map((c) => [c.taskId, c.n]));
  const threshold = await costThresholds(tx, projectId, window.to);
  const marked = new Set(markedIds);
  const byTask = new Map<string, Candidate>();
  for (const r of pool.sort((a, b) => (a.finishedAt?.getTime() ?? 0) - (b.finishedAt?.getTime() ?? 0))) {
    if (consumed.has(r.id)) continue;
    const retries = retriesOf(r.attempt, r.taskId ? (taskRuns.get(r.taskId) ?? 1) : 1);
    const tokens = r.tokensIn + r.tokensOut;
    const triggers: LearnTrigger[] = [];
    if (retries >= SKILL_LEARNING_MIN_RETRIES) triggers.push("retries");
    const over =
      r.costUsd !== null
        ? threshold.usd !== null && r.costUsd > threshold.usd
          ? r.costUsd / threshold.usd
          : 0
        : threshold.tokens !== null && tokens > threshold.tokens
          ? tokens / threshold.tokens
          : 0;
    if (over > 0) triggers.push("cost");
    if (marked.has(r.id)) triggers.push("marked");
    if (!triggers.length) continue;
    const key = r.taskId ?? r.id;
    const prev = byTask.get(key);
    const merged = [...new Set([...(prev?.triggers ?? []), ...triggers])];
    byTask.set(key, {
      runId: r.id,
      taskId: r.taskId,
      triggers: merged,
      retries: Math.max(prev?.retries ?? 0, retries),
      costUsd: r.costUsd,
      tokens,
      runIds: [...(prev?.runIds ?? []), r.id],
      score: Math.max(prev?.score ?? 0, scoreOf(merged, retries, over)),
    });
  }
  return [...byTask.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}
