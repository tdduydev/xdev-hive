import { GATE_MODES, SDLC_GATES, type GateMode, type GateModes, type SdlcFlow, type SdlcFlowTask, type SdlcGate, type SdlcGateRecord } from "@xdev-hive/core";

export const PIPELINE_STEPS = ["idea", "spec", "plan", "tasks", "dispatch", "build", "review", "fix", "merge", "done"] as const;
export type PipelineStep = (typeof PIPELINE_STEPS)[number];
export type PipelinePreset = "cautious" | "balanced" | "maximum" | "fast";
export const PIPELINE_PRESETS: PipelinePreset[] = ["cautious", "balanced", "maximum", "fast"];
export const FAST_KINDS = ["docs", "small-fix", "test"] as const;

const modes = (values: Partial<GateModes>): GateModes => Object.fromEntries(SDLC_GATES.map((gate) => [gate, values[gate] ?? "auto"])) as GateModes;
export function presetGates(preset: PipelinePreset, ceiling: GateModes, current?: GateModes): GateModes {
  const wanted = preset === "cautious" ? modes({ spec: "human", plan: "human", review: "human", merge: "human" })
    : preset === "balanced" ? modes({ spec: "human", plan: "ai", tasks: "ai", review: "ai", merge: "human" })
    : preset === "fast" && current ? current
    : modes({ merge: "ai" });
  return Object.fromEntries(SDLC_GATES.map((gate) => [gate, GATE_MODES[Math.min(GATE_MODES.indexOf(wanted[gate]), GATE_MODES.indexOf(ceiling[gate]))]!])) as GateModes;
}

export function gateMetrics(gates: SdlcGateRecord[], now = Date.now()): Record<SdlcGate, { medianHours: number | null; firstPass: number | null }> {
  const since = now - 30 * 86400_000;
  return Object.fromEntries(SDLC_GATES.map((gate) => {
    const rows = gates.filter((g) => g.gate === gate && Date.parse(g.createdAt) >= since && Number.isFinite(Date.parse(g.createdAt)));
    const decided = rows.filter((g) => g.decidedAt && ["passed", "rejected"].includes(g.status));
    const waits = decided.map((g) => Math.max(0, (Date.parse(g.decidedAt!) - Date.parse(g.createdAt)) / 3600_000)).sort((a, b) => a - b);
    const mid = Math.floor(waits.length / 2);
    return [gate, { medianHours: waits.length ? (waits.length % 2 ? waits[mid]! : (waits[mid - 1]! + waits[mid]!) / 2) : null, firstPass: decided.length ? Math.round(100 * decided.filter((g) => g.status === "passed").length / decided.length) : null }];
  })) as Record<SdlcGate, { medianHours: number | null; firstPass: number | null }>;
}

export function flowStep(flow: SdlcFlow): PipelineStep {
  if (flow.state === "done") return "done";
  if (flow.step === "specify") return "spec";
  if (flow.step === "plan") return "plan";
  if (flow.step === "tasks") return "tasks";
  return flow.step === "import" ? "dispatch" : "build";
}
export function taskStep(task: SdlcFlowTask): PipelineStep {
  if (task.stage === "done") return "done";
  if (["review", "check", "checking", "gate"].includes(task.stage)) return "review";
  if (["fix", "fixnext"].includes(task.stage)) return "fix";
  if (["merge", "merging"].includes(task.stage)) return "merge";
  return "build";
}
export function stepCounts(flows: SdlcFlow[], tasks: SdlcFlowTask[]): Record<PipelineStep, number> {
  const counts = Object.fromEntries(PIPELINE_STEPS.map((step) => [step, 0])) as Record<PipelineStep, number>;
  for (const flow of flows) if (flow.step !== "dispatch") counts[flowStep(flow)]++;
  for (const task of tasks) counts[taskStep(task)]++;
  return counts;
}
export function gateForStep(step: PipelineStep): SdlcGate | null {
  return SDLC_GATES.includes(step as SdlcGate) ? step as SdlcGate : null;
}
export function modeWithinCeiling(mode: GateMode, ceiling: GateMode): boolean { return GATE_MODES.indexOf(mode) <= GATE_MODES.indexOf(ceiling); }
