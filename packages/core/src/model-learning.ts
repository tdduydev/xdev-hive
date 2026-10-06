// What the model router learns from finished tasks (roadmap 54d): plain counts and medians, no model of its own.
import { z } from "zod";
import { MODEL_TIERS, profileShift, shiftTier, type ModelProfile, type ModelTier } from "./model-router.ts";
import { TASK_KINDS, TASK_SIZES, type TaskKind, type TaskSize } from "./task-classify.ts";

/** Spec 54: 30 days of tasks, a tier qualifies with ≥ 80% finished without escalation over ≥ 10 tasks. */
export const LEARN_DAYS = 30;
export const LEARN_MIN_TASKS = 10;
export const LEARN_MIN_RATE = 0.8;
/** One task in this many tries the tier below, so a cheaper tier keeps getting data to qualify with. */
export const TRIAL_EVERY = 10;
/** Review runs take the review row whatever the task is, and no implement run starts from it: nothing to learn there. */
export const LEARNED_KINDS = TASK_KINDS.filter((k) => k !== "review");

/** One run of a finished task, as the hub reads it from run_records and run_costs. */
export interface LearningRun {
  taskId: string;
  taskKind: TaskKind;
  taskSize: TaskSize;
  role: string;
  status: string;
  verdict: string | null;
  tier: string | null;
  /** The profile's kind (claude, codex, …); null from apps before 54a. */
  plan: string | null;
  /** The MR's CI ended red after this run. */
  pipelineFailed: boolean;
  createdAt: string;
  /** All of input, cache write, cache read and output; null: the machine reported none. */
  tokens: number | null;
  /** null: no price (Codex reports tokens only). */
  costUsd: number | null;
}

export interface LearnedTask {
  taskId: string;
  kind: TaskKind;
  size: TaskSize;
  /** The tier its first implement run started at: what the cell (or a trial) chose, before any escalation. */
  tier: ModelTier;
  plan: string | null;
  /** Done with no failure the router counts (failed implement, review asking for changes, red CI) and no tier change. */
  clean: boolean;
  tokens: number | null;
  costUsd: number | null;
}

/** One row of the learning table: (task kind × size × tier × kind of plan). */
export interface ModelLearningStat {
  kind: TaskKind;
  size: TaskSize;
  tier: ModelTier;
  plan: string | null;
  tasks: number;
  clean: number;
  cleanRate: number;
  /** Per finished task, every try of it included (all its runs: implement, review, fix, rotation). */
  tokensMedian: number | null;
  costMedian: number | null;
}

export interface ModelLearningProposal {
  /** The cell's value to set, before the project's profile moves it (what modelRouter's cells hold). */
  tier: ModelTier;
  /** The tier runs went to, which qualified; differs from `tier` when the project's profile shifts the cell. */
  ranAt: ModelTier;
  tasks: number;
  cleanRate: number;
}

export interface ModelLearningCell {
  kind: TaskKind;
  size: TaskSize;
  /** The cell's value now: the project's own, else the hub's. */
  current: ModelTier;
  locked: boolean;
  /** null: no tier qualifies yet, or the cheapest one that does is the current one. */
  proposal: ModelLearningProposal | null;
}

export const LEARNING_CHANGES = ["auto", "apply", "lock", "unlock", "on", "off"] as const;
export type LearningChange = (typeof LEARNING_CHANGES)[number];

export interface ModelLearningLogEntry {
  id: number;
  change: LearningChange;
  kind: TaskKind | null;
  size: TaskSize | null;
  fromTier: ModelTier | null;
  toTier: ModelTier | null;
  tasks: number | null;
  cleanRate: number | null;
  by: string;
  at: string;
}

/** What modelLearning.get answers, and what 56c's table reads. */
export interface ModelLearningView {
  project: string;
  /** Tự học: auto-apply and trials. Off: the table and proposals still show, and *Áp dụng* still works. */
  enabled: boolean;
  /** Chọn model is on for the project; off, runs carry no tier and there is nothing to learn from. */
  routing: boolean;
  /** The last nightly round on this hub; null: none yet. */
  learnedAt: string | null;
  stats: ModelLearningStat[];
  cells: ModelLearningCell[];
  log: ModelLearningLogEntry[];
}

const cellSchema = z.object({ kind: z.enum(LEARNED_KINDS as [TaskKind, ...TaskKind[]]), size: z.enum(TASK_SIZES) });
export const modelLearningSetSchema = z.object({
  enabled: z.boolean().optional(),
  lock: cellSchema.extend({ locked: z.boolean() }).optional(),
  apply: cellSchema.optional(),
});

const isTier = (v: string | null): v is ModelTier => v !== null && (MODEL_TIERS as readonly string[]).includes(v);

/** Finished tasks from their runs (any order). A task whose implement runs never carried a tier is left out. */
export function learnedTasks(runs: LearningRun[]): LearnedTask[] {
  const byTask = new Map<string, LearningRun[]>();
  for (const r of runs) byTask.set(r.taskId, [...(byTask.get(r.taskId) ?? []), r]);
  const out: LearnedTask[] = [];
  for (const [taskId, list] of byTask) {
    const sorted = [...list].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const implement = sorted.filter((r) => r.role === "implement" && isTier(r.tier));
    const first = implement[0];
    if (!first) continue;
    // Same as the router's failure count (sqlite #selection): out of quota is rate_limited, so it does not count.
    const failed = sorted.some((r) => r.verdict === "changes" || (r.role === "implement" && (r.status === "failed" || r.pipelineFailed)));
    const sum = (pick: (r: LearningRun) => number | null) => sorted.reduce<number | null>((acc, r) => (pick(r) == null ? acc : (acc ?? 0) + pick(r)!), null);
    out.push({
      taskId,
      kind: first.taskKind,
      size: first.taskSize,
      tier: first.tier as ModelTier,
      plan: first.plan,
      clean: !failed && implement.every((r) => r.tier === first.tier),
      tokens: sum((r) => r.tokens),
      costUsd: sum((r) => r.costUsd),
    });
  }
  return out;
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const order = (kind: TaskKind, size: TaskSize, tier: ModelTier) =>
  TASK_KINDS.indexOf(kind) * 100 + TASK_SIZES.indexOf(size) * 10 + MODEL_TIERS.indexOf(tier);

export function learningStats(tasks: LearnedTask[]): ModelLearningStat[] {
  const groups = new Map<string, LearnedTask[]>();
  for (const t of tasks) {
    const key = [t.kind, t.size, t.tier, t.plan ?? ""].join("\u0000");
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  return [...groups.values()]
    .map((list): ModelLearningStat => {
      const { kind, size, tier, plan } = list[0]!;
      const clean = list.filter((t) => t.clean).length;
      return {
        kind,
        size,
        tier,
        plan,
        tasks: list.length,
        clean,
        cleanRate: clean / list.length,
        tokensMedian: median(list.flatMap((t) => (t.tokens == null ? [] : [t.tokens]))),
        costMedian: median(list.flatMap((t) => (t.costUsd == null ? [] : [t.costUsd]))),
      };
    })
    .sort((a, b) => order(a.kind, a.size, a.tier) - order(b.kind, b.size, b.tier) || (a.plan ?? "").localeCompare(b.plan ?? ""));
}

/**
 * The cheapest tier of a cell finishing ≥ 80% of ≥ 10 tasks without escalation, every kind of plan together: the cell
 * names a tier, and each kind of plan takes its own model at it. Taken back through the project's profile, so that
 * applying it sends runs to the tier that qualified. null when none qualifies, or it is what the cell holds already.
 */
export function proposeTier(stats: ModelLearningStat[], kind: TaskKind, size: TaskSize, current: ModelTier, profile: ModelProfile): ModelLearningProposal | null {
  for (const ranAt of MODEL_TIERS) {
    const rows = stats.filter((s) => s.kind === kind && s.size === size && s.tier === ranAt);
    const tasks = rows.reduce((n, s) => n + s.tasks, 0);
    const clean = rows.reduce((n, s) => n + s.clean, 0);
    if (tasks < LEARN_MIN_TASKS || clean / tasks < LEARN_MIN_RATE) continue;
    const tier = shiftTier(ranAt, -profileShift(profile, kind));
    return tier === current ? null : { tier, ranAt, tasks, cleanRate: clean / tasks };
  }
  return null;
}

/**
 * About one task in TRIAL_EVERY, picked from its id so every run of the task agrees (a retry must not flip between
 * tiers, and a review must see the same choice). FNV-1a: stable across hubs and versions, unlike a random draw.
 */
export function isTrialTask(project: string, taskId: string): boolean {
  let h = 0x811c9dc5;
  for (const ch of `${project}/${taskId}`) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % TRIAL_EVERY === 0;
}

/** The nightly round is due between 1 and 5 at night (the hub's clock), once a day; after 2 days down, at once. */
export function learningDue(last: string | null, now: Date): boolean {
  if (!last) return true;
  const since = now.getTime() - Date.parse(last);
  if (since >= 48 * 3_600_000) return true;
  return since >= 20 * 3_600_000 && now.getHours() >= 1 && now.getHours() < 5;
}
