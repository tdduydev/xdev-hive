import { selectModel, type ModelRouterSettings, type TaskKind, type TaskSize } from "@xdev-hive/core";
import type { PipelineStep } from "#ui/lib/pipeline.ts";

/** The router stores task cells, so steps sharing a kind edit the same cell rather than an imaginary step override. */
export function stepModelKind(step: PipelineStep, kind: TaskKind = "feature"): TaskKind | null {
  if (["idea", "release", "done"].includes(step)) return null;
  if (["spec", "plan", "tasks"].includes(step)) return "spec";
  if (step === "review") return "review";
  if (step === "merge") return "merge";
  return kind;
}
export function stepModel(settings: ModelRouterSettings, project: string, step: PipelineStep, kind: TaskKind = "feature", size: TaskSize = "m") {
  const cell = stepModelKind(step, kind);
  return cell ? selectModel(settings, project, { kind: cell, size, risk: "normal", role: step === "review" ? "review" : "implement" }) : null;
}
export function presetModelProfile(preset: string) {
  return preset === "cautious" ? "quality" as const : preset === "balanced" ? "balanced" as const : preset === "maximum" ? "economy" as const : null;
}
