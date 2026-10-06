import { z } from "zod";
import { TASK_KINDS, TASK_SIZES, type TaskKind, type TaskSize } from "./task-classify.ts";

export const MODEL_TIERS = ["light", "standard", "strong", "max"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];
export const MODEL_PROFILES = ["economy", "balanced", "quality"] as const;
export type ModelProfile = (typeof MODEL_PROFILES)[number];
export const modelChoiceSchema = z.object({ model: z.string().min(1).max(100), effort: z.enum(["low", "medium", "high", "xhigh"]).nullable() });
export type ModelChoice = z.infer<typeof modelChoiceSchema>;
export const modelTierRowSchema = z.object({ claude: modelChoiceSchema.nullable(), codex: modelChoiceSchema.nullable(), antigravity: modelChoiceSchema.nullable() });
export type ModelTierRow = z.infer<typeof modelTierRowSchema>;
export const modelTableSchema = z.record(z.enum(MODEL_TIERS), modelTierRowSchema);
export const modelCellsSchema = z.record(z.enum(TASK_KINDS), z.record(z.enum(TASK_SIZES), z.enum(MODEL_TIERS)));
export const modelProjectSchema = z.object({ enabled: z.boolean().default(true), profile: z.enum(MODEL_PROFILES).default("balanced"), cells: z.partialRecord(z.enum(TASK_KINDS), z.partialRecord(z.enum(TASK_SIZES), z.enum(MODEL_TIERS))).default({}) });
export type ModelProject = z.infer<typeof modelProjectSchema>;
export interface ModelRouterSettings { tiers: Record<ModelTier, ModelTierRow>; cells: Record<TaskKind, Record<TaskSize, ModelTier>>; projects: Record<string, ModelProject> }
export interface ModelSelection { tier: ModelTier; models: ModelTierRow; reason: string }
const choice = (model: string, effort: ModelChoice["effort"]): ModelChoice => ({ model, effort });
export const DEFAULT_MODEL_TIERS: Record<ModelTier, ModelTierRow> = {
  light: { claude: choice("sonnet", "low"), codex: choice("gpt-6-luna", "medium"), antigravity: choice("gemini-3.8-flash", "low") },
  standard: { claude: choice("sonnet", "medium"), codex: choice("gpt-6.1-sol", "low"), antigravity: choice("gemini-3.8-pro", "medium") },
  strong: { claude: choice("opus", "medium"), codex: choice("gpt-6.1-sol", "high"), antigravity: null },
  max: { claude: choice("opus", "high"), codex: choice("gpt-6-astra", "medium"), antigravity: null },
};
const row = (s: ModelTier, m: ModelTier, l: ModelTier) => ({ s, m, l });
export const DEFAULT_MODEL_CELLS = Object.fromEntries(TASK_KINDS.map((kind) => [kind,
  ["docs", "test", "ops"].includes(kind) ? row("light", "light", "standard") :
  ["small-fix", "ui"].includes(kind) ? row("light", "standard", "standard") :
  kind === "feature" ? row("standard", "standard", "strong") :
  ["refactor", "merge"].includes(kind) ? row("standard", "strong", "strong") :
  kind === "review" ? row("standard", "standard", "strong") : row("strong", "strong", "strong")])) as Record<TaskKind, Record<TaskSize, ModelTier>>;
export const DEFAULT_MODEL_ROUTER: ModelRouterSettings = { tiers: DEFAULT_MODEL_TIERS, cells: DEFAULT_MODEL_CELLS, projects: {} };
export function raiseTier(tier: ModelTier, steps = 1): ModelTier { return MODEL_TIERS[Math.min(3, Math.max(0, MODEL_TIERS.indexOf(tier) + steps))]!; }
export function selectModel(settings: ModelRouterSettings, project: string, kind: TaskKind | null, size: TaskSize | null, risk: string | null, failures = 0): ModelSelection | null {
  const p = settings.projects[project];
  if (p?.enabled === false) return null;
  const k = kind ?? "feature", s = size ?? "m";
  const base = p?.cells[k]?.[s] ?? settings.cells[k]?.[s] ?? DEFAULT_MODEL_CELLS[k][s];
  const shift = (p?.profile === "economy" ? -1 : p?.profile === "quality" && !["docs", "test"].includes(k) ? 1 : 0) + (risk === "high" ? 1 : 0);
  const tier = raiseTier(base, shift + Math.min(1, Math.max(0, failures - 1)));
  const models = { ...settings.tiers[tier] };
  for (const kind of ["claude", "codex", "antigravity"] as const) {
    if (models[kind]) continue;
    const index = MODEL_TIERS.indexOf(tier);
    const nearest = [...MODEL_TIERS].sort((a, b) => Math.abs(MODEL_TIERS.indexOf(a) - index) - Math.abs(MODEL_TIERS.indexOf(b) - index));
    models[kind] = nearest.map((candidate) => settings.tiers[candidate][kind]).find((choice) => choice !== null) ?? null;
  }
  if (tier === "strong" && s === "l" && ["feature", "refactor"].includes(k) && models.claude?.model === "opus") models.claude = { ...models.claude, model: "opusplan" };
  if (failures === 1) {
    const efforts = ["low", "medium", "high", "xhigh"] as const;
    for (const kind of ["claude", "codex", "antigravity"] as const) {
      const selected = models[kind];
      if (selected?.effort) models[kind] = { ...selected, effort: efforts[Math.min(3, efforts.indexOf(selected.effort) + 1)]! };
    }
  }
  return { tier, models, reason: `${k}/${s}, ${p?.profile ?? "balanced"}${risk === "high" ? ", high risk" : ""}${failures ? `, failure ${failures}` : ""}` };
}
