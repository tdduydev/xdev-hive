// The model router (roadmap 54c): which model and effort a run gets, from the task's kind, size and risk.
import { z } from "zod";
import type { AgentRole } from "./agents.ts";
import { DEFAULT_TASK_CLASS, TASK_KINDS, TASK_SIZES, type TaskKind, type TaskRisk, type TaskSize } from "./task-classify.ts";

export const MODEL_TIERS = ["light", "standard", "strong", "max"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];
/** Tiết kiệm / Cân bằng / Chất lượng; balanced when a project chose none. */
export const MODEL_PROFILES = ["economy", "balanced", "quality"] as const;
export type ModelProfile = (typeof MODEL_PROFILES)[number];
/** The kinds of plan the router speaks for: a custom CLI takes no flag the router could know. */
export const ROUTED_KINDS = ["claude", "codex", "antigravity"] as const;
export type RoutedKind = (typeof ROUTED_KINDS)[number];

/**
 * No `max` and no fast mode: both bill outside the plan's quota (spec 54, out of scope), so not even an admin can put
 * them in the table. Fable is a model name, so an admin may still type it into a row by hand.
 */
export const MODEL_EFFORTS = ["low", "medium", "high", "xhigh"] as const;
export type ModelEffort = (typeof MODEL_EFFORTS)[number];

export const modelChoiceSchema = z.object({ model: z.string().regex(/^[A-Za-z0-9._:[\]-]{1,100}$/), effort: z.enum(MODEL_EFFORTS).nullable() });
export type ModelChoice = z.infer<typeof modelChoiceSchema>;
/** null: this kind of plan has no model at the tier, and the nearest tier that has one stands in. */
export const modelTierRowSchema = z.object({ claude: modelChoiceSchema.nullable(), codex: modelChoiceSchema.nullable(), antigravity: modelChoiceSchema.nullable() });
export type ModelTierRow = z.infer<typeof modelTierRowSchema>;
export const modelTableSchema = z.record(z.enum(MODEL_TIERS), modelTierRowSchema);
export const modelCellsSchema = z.record(z.enum(TASK_KINDS), z.record(z.enum(TASK_SIZES), z.enum(MODEL_TIERS)));
/** A project's part: off keeps runs exactly as before 54c; its cells override the hub's one by one. */
export const modelProjectSchema = z.object({
  enabled: z.boolean().default(true),
  profile: z.enum(MODEL_PROFILES).default("balanced"),
  cells: z.partialRecord(z.enum(TASK_KINDS), z.partialRecord(z.enum(TASK_SIZES), z.enum(MODEL_TIERS))).default({}),
});
export type ModelProject = z.infer<typeof modelProjectSchema>;

export interface ModelRouterSettings {
  tiers: Record<ModelTier, ModelTierRow>;
  cells: Record<TaskKind, Record<TaskSize, ModelTier>>;
  projects: Record<string, ModelProject>;
}

/** What the hub sends with a run request; the machine picks the plan, then takes that kind's model from `models`. */
export interface ModelSelection {
  tier: ModelTier;
  models: Partial<Record<RoutedKind, ModelChoice | null>>;
  /** For the run log and the chip's tooltip, e.g. "feature/l, balanced, high risk, failure 1". */
  reason: string;
  /** The choice for the review the machine runs after this implement run (reviewAfter), which is not the hub's request. */
  review?: Omit<ModelSelection, "review"> | null;
}

const choice = (model: string, effort: ModelEffort | null): ModelChoice => ({ model, effort });

export const DEFAULT_MODEL_TIERS: Record<ModelTier, ModelTierRow> = {
  light: { claude: choice("sonnet", "low"), codex: choice("gpt-6-luna", "medium"), antigravity: choice("gemini-3.8-flash", "low") },
  standard: { claude: choice("sonnet", "medium"), codex: choice("gpt-6.1-sol", "low"), antigravity: choice("gemini-3.8-pro", "medium") },
  // Antigravity's Claude/GPT pool has its own quota (53) the hub does not see, so strong and above stay on Gemini pro.
  strong: { claude: choice("opus", "medium"), codex: choice("gpt-6.1-sol", "high"), antigravity: null },
  max: { claude: choice("opus", "high"), codex: choice("gpt-6-astra", "medium"), antigravity: null },
};

const sizes = (s: ModelTier, m: ModelTier, l: ModelTier): Record<TaskSize, ModelTier> => ({ s, m, l });
export const DEFAULT_MODEL_CELLS: Record<TaskKind, Record<TaskSize, ModelTier>> = {
  docs: sizes("light", "light", "standard"),
  test: sizes("light", "light", "standard"),
  ops: sizes("light", "light", "standard"),
  "small-fix": sizes("light", "standard", "standard"),
  ui: sizes("light", "standard", "standard"),
  feature: sizes("standard", "standard", "strong"),
  refactor: sizes("standard", "strong", "strong"),
  merge: sizes("standard", "strong", "strong"),
  debug: sizes("strong", "strong", "strong"),
  spec: sizes("strong", "strong", "strong"),
  review: sizes("standard", "standard", "strong"),
};

export const DEFAULT_MODEL_ROUTER: ModelRouterSettings = { tiers: DEFAULT_MODEL_TIERS, cells: DEFAULT_MODEL_CELLS, projects: {} };

/** Escalations a task gets at most (spec: effort first, then one tier). */
export const MAX_ESCALATIONS = 2;

export function shiftTier(tier: ModelTier, steps: number): ModelTier {
  return MODEL_TIERS[Math.min(MODEL_TIERS.length - 1, Math.max(0, MODEL_TIERS.indexOf(tier) + steps))]!;
}

/** One effort up; Antigravity's --effort stops at high. null stays null: the CLI's default is not a level we know. */
export function raiseEffort(kind: RoutedKind, effort: ModelEffort | null): ModelEffort | null {
  if (!effort) return null;
  const top = kind === "antigravity" ? MODEL_EFFORTS.indexOf("high") : MODEL_EFFORTS.length - 1;
  return MODEL_EFFORTS[Math.min(top, MODEL_EFFORTS.indexOf(effort) + 1)]!;
}

/** The row's model for each kind, or the nearest tier's (lower first on a tie, the cheaper guess) when it has none. */
function modelsAt(tiers: Record<ModelTier, ModelTierRow>, tier: ModelTier): Record<RoutedKind, ModelChoice | null> {
  const at = MODEL_TIERS.indexOf(tier);
  const byDistance = [...MODEL_TIERS].sort((a, b) => Math.abs(MODEL_TIERS.indexOf(a) - at) - Math.abs(MODEL_TIERS.indexOf(b) - at) || MODEL_TIERS.indexOf(a) - MODEL_TIERS.indexOf(b));
  return Object.fromEntries(ROUTED_KINDS.map((kind) => [kind, byDistance.map((t) => tiers[t]?.[kind] ?? null).find((c) => c !== null) ?? null])) as Record<RoutedKind, ModelChoice | null>;
}

export interface RouteInput {
  kind: TaskKind | null;
  size: TaskSize | null;
  risk: TaskRisk | null;
  role: AgentRole;
  /** Failed tries of this task so far (failed run, review asking for changes, red CI); only the implementer escalates. */
  failures?: number;
}

/** null: routing is off for the project, or the role is not one it picks for (classify has its own cheap model). */
export function selectModel(settings: ModelRouterSettings, project: string, input: RouteInput): ModelSelection | null {
  const own = settings.projects[project];
  if (own?.enabled === false || input.role === "classify") return null;
  // A review run reviews whatever the task is, so it takes the review row at the task's size.
  const kind = input.role === "review" ? "review" : (input.kind ?? DEFAULT_TASK_CLASS.kind);
  const size = input.size ?? DEFAULT_TASK_CLASS.size;
  const profile = own?.profile ?? "balanced";
  const start = own?.cells[kind]?.[size] ?? settings.cells[kind]?.[size] ?? DEFAULT_MODEL_CELLS[kind][size];
  const failures = input.role === "implement" ? Math.min(MAX_ESCALATIONS, Math.max(0, input.failures ?? 0)) : 0;
  const shift =
    (profile === "economy" ? -1 : profile === "quality" && kind !== "docs" && kind !== "test" ? 1 : 0) +
    (input.risk === "high" ? 1 : 0) +
    // The first failure raises the effort only; the second takes the tier above.
    (failures >= 2 ? 1 : 0);
  const tier = shiftTier(start, shift);
  const models = modelsAt(settings.tiers, tier);
  if (failures === 1)
    for (const k of ROUTED_KINDS) {
      const picked = models[k];
      if (picked) models[k] = { ...picked, effort: raiseEffort(k, picked.effort) };
    }
  // Plan with Opus, then edit with Sonnet (spec 54, like Aider's architect/editor): for big features and refactors only.
  if (tier === "strong" && size === "l" && (kind === "feature" || kind === "refactor") && models.claude?.model === "opus") models.claude = { ...models.claude, model: "opusplan" };
  const reason = [`${kind}/${size}`, profile, input.risk === "high" ? "high risk" : null, failures ? `failure ${failures}` : null].filter(Boolean).join(", ");
  return { tier, models, reason };
}
