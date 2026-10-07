import { z } from "zod";
import type { TaskKind } from "#core/task-classify.ts";

export const runTimeoutSettingsSchema = z.object({
  maxMinutes: z.number().int().min(1).max(720).default(180),
  defaults: z.record(z.enum(["integration", "land"]), z.number().int().min(1).max(720).nullable()).default({ integration: 120, land: 120 }),
}).strict();
export type RunTimeoutSettings = z.infer<typeof runTimeoutSettingsSchema>;
export const DEFAULT_RUN_TIMEOUT: RunTimeoutSettings = { maxMinutes: 180, defaults: { integration: 120, land: 120 } };

/** A profile remains the ceiling even when the task type asks for more time. */
export function runTimeoutMinutes(settings: RunTimeoutSettings, profileMinutes: number, kind: TaskKind | null, taskId: string, requested?: number | null): number {
  const type = /^INT-/i.test(taskId) ? "integration" : /^LAND-/i.test(taskId) ? "land" : kind;
  const preset = type === "integration" || type === "land" ? settings.defaults[type] : null;
  return Math.min(requested ?? preset ?? profileMinutes, profileMinutes, settings.maxMinutes);
}
