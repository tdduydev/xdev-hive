import type { HiveClient } from "#ui/client.ts";
import { GATE_MODES, SDLC_GATES, type GateMode, type GateModes, type SdlcFlow, type SdlcFlowTask, type SdlcGate, type SdlcGateRecord, FAST_LANE_KINDS } from "@xdev-hive/core";

export const PIPELINE_STEPS = ["idea", "spec", "plan", "tasks", "dispatch", "build", "review", "fix", "test", "merge", "release", "done"] as const;
export const PIPELINE_STEP_GATES: Partial<Record<(typeof PIPELINE_STEPS)[number], SdlcGate>> = { spec: "spec", plan: "plan", tasks: "tasks", dispatch: "dispatch", review: "review", fix: "fix", test: "test", merge: "merge", release: "release" };
export type PipelineStep = (typeof PIPELINE_STEPS)[number];
export type PipelinePreset = "cautious" | "balanced" | "maximum" | "fast";
export const PIPELINE_PRESETS: PipelinePreset[] = ["cautious", "balanced", "maximum", "fast"];
export const FAST_KINDS = FAST_LANE_KINDS;

const modes = (values: Partial<GateModes>): GateModes => Object.fromEntries(SDLC_GATES.map((gate) => [gate, values[gate] ?? "auto"])) as GateModes;
export function presetGates(preset: PipelinePreset, ceiling: GateModes, current?: GateModes): GateModes {
  const wanted = preset === "cautious" ? modes({ spec: "human", plan: "human", review: "human", test: "human", merge: "human", release: "human" })
    : preset === "balanced" ? modes({ spec: "human", plan: "ai", tasks: "ai", review: "ai", merge: "human", release: "human" })
    : preset === "fast" && current ? current
    : modes({ merge: "ai" });
  return Object.fromEntries(SDLC_GATES.map((gate) => [gate, GATE_MODES[Math.min(GATE_MODES.indexOf(wanted[gate]), GATE_MODES.indexOf(ceiling[gate]))]!])) as GateModes;
}

export function gateMetrics(gates: SdlcGateRecord[], now = Date.now()): Record<SdlcGate, { medianHours: number | null; firstPass: number | null }> {
  const since = now - 30 * 86400_000;
  return Object.fromEntries(SDLC_GATES.map((gate) => {
    const rows = gates.filter((g) => g.gate === gate && Date.parse(g.createdAt) >= since && Date.parse(g.createdAt) <= now);
    const decided = rows.filter((g) => g.decidedAt && ["passed", "rejected", "escalated"].includes(g.status) && Number.isFinite(Date.parse(g.decidedAt)));
    const waits = decided.map((g) => Math.max(0, (Date.parse(g.decidedAt!) - Date.parse(g.createdAt)) / 3600_000)).sort((a, b) => a - b);
    const mid = Math.floor(waits.length / 2);
    // Count the first attempt per task, so a later approval after rework is not a first pass.
    const first = new Map<string, SdlcGateRecord>();
    for (const row of [...gates].filter((g) => g.gate === gate).sort((a, b) => a.id - b.id)) {
      if (!first.has(row.taskId)) first.set(row.taskId, row);
    }
    const attempts = [...first.values()].filter((g) => decided.includes(g) && g.firstAttempt !== false);
    return [gate, { medianHours: waits.length ? (waits.length % 2 ? waits[mid]! : (waits[mid - 1]! + waits[mid]!) / 2) : null, firstPass: attempts.length ? Math.round(100 * attempts.filter((g) => g.status === "passed" && (g.mode !== "ai" || g.decidedBy?.startsWith("run:"))).length / attempts.length) : null }];
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
  if (task.stage === "queued") return "dispatch";
  if (task.gate && ["gate", "check", "checking"].includes(task.stage)) return task.gate.gate === "dispatch" ? "dispatch" : task.gate.gate === "fix" ? "fix" : task.gate.gate === "test" ? "test" : task.gate.gate === "merge" ? "merge" : "review";
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

/** A repeated attempt replaces the previous verdict; all tasks at a feature's gate must pass. */
export function passedGates(records: SdlcGateRecord[]): Set<SdlcGate> {
  const latest = new Map<string, SdlcGateRecord>();
  for (const row of [...records].sort((a, b) => a.id - b.id)) latest.set(`${row.taskId}:${row.gate}`, row);
  return new Set(SDLC_GATES.filter((gate) => {
    const rows = [...latest.values()].filter((row) => row.gate === gate);
    return rows.length > 0 && rows.every((row) => row.status === "passed");
  }));
}

/** Counts and feature links use the same complete list rather than stopping at one API page. */
export async function allPipelineFlows(client: HiveClient, filter: { project?: string; projects?: string[] }): Promise<SdlcFlow[]> {
  const flows: SdlcFlow[] = [];
  for (let offset = 0; ; offset += 200) {
    const page = await client.call("sdlc.flows", { ...filter, limit: 200, offset });
    flows.push(...page);
    if (page.length < 200) return flows;
  }
}
