// Gates of the delivery lifecycle (roadmap 34): at each step of a flow the hub drives, a person decides, an agent of
// another vendor checks and passes it (or hands it to a person), or it goes on by itself. The hub admin sets how far
// each gate may go (the ceiling); a project picks within it, never past it.
import { z } from "zod";

/** In flow order. spec/plan/tasks: after each Spec Kit step; dispatch: before a flow task runs; review: after it ran;
 * fix: when its review asks for changes; merge: when its MR is green. */
export const SDLC_GATES = ["spec", "plan", "tasks", "dispatch", "review", "fix", "merge"] as const;
export type SdlcGate = (typeof SDLC_GATES)[number];

/** From least to most left to the agents: a person decides; an agent checks, then passes or asks a person; it goes on. */
export const GATE_MODES = ["human", "ai", "auto"] as const;
export type GateMode = (typeof GATE_MODES)[number];

export type GateModes = Record<SdlcGate, GateMode>;

/** Fix runs a flow queues by itself for one task before a person has to look (spec 34). */
export const DEFAULT_MAX_FIX_ROUNDS = 2;
export const MAX_FIX_ROUNDS = 5;

export const gateModeSchema = z.enum(GATE_MODES);
export const gateModesSchema = z.partialRecord(z.enum(SDLC_GATES), gateModeSchema);

export interface SdlcProjectSettings {
  /** A gate left out is "human". */
  gates: Partial<GateModes>;
  maxFixRounds?: number;
  /** Flow tasks running at once when dispatch is not "human"; left out: no limit. */
  maxParallel?: number;
}

export interface SdlcPolicySettings {
  /** The hub's ceiling: the most each gate may be set to. A gate left out may go up to "auto". */
  ceiling: Partial<GateModes>;
  projects: Record<string, SdlcProjectSettings>;
  updatedAt: string | null;
  updatedBy: string | null;
}

export const EMPTY_SDLC_POLICY: SdlcPolicySettings = { ceiling: {}, projects: {}, updatedAt: null, updatedBy: null };

const rank = (m: GateMode) => GATE_MODES.indexOf(m);
/** The lesser of two modes: what a project asks for, held to the ceiling. */
export const lowerMode = (a: GateMode, b: GateMode): GateMode => (rank(a) <= rank(b) ? a : b);

export const fullCeiling = (ceiling: Partial<GateModes>): GateModes =>
  Object.fromEntries(SDLC_GATES.map((g) => [g, ceiling[g] ?? "auto"])) as GateModes;

/** What each gate of a project does now: its choice (default "human"), never past the hub's ceiling. */
export function effectiveGates(policy: SdlcPolicySettings, project: string): GateModes {
  const ceiling = fullCeiling(policy.ceiling);
  const own = policy.projects[project]?.gates ?? {};
  return Object.fromEntries(SDLC_GATES.map((g) => [g, lowerMode(own[g] ?? "human", ceiling[g])])) as GateModes;
}

/** The settings as the pages read them: the ceiling filled in, and each project's choice next to what applies. */
export interface SdlcPolicyView {
  ceiling: GateModes;
  projects: Record<string, { gates: Partial<GateModes>; effective: GateModes; maxFixRounds: number; maxParallel: number | null }>;
  updatedAt: string | null;
  updatedBy: string | null;
}

export function sdlcPolicyView(policy: SdlcPolicySettings, projects: string[]): SdlcPolicyView {
  const names = [...new Set([...Object.keys(policy.projects), ...projects])].sort();
  return {
    ceiling: fullCeiling(policy.ceiling),
    projects: Object.fromEntries(
      names.map((p) => {
        const own = policy.projects[p];
        return [p, { gates: own?.gates ?? {}, effective: effectiveGates(policy, p), maxFixRounds: own?.maxFixRounds ?? DEFAULT_MAX_FIX_ROUNDS, maxParallel: own?.maxParallel ?? null }];
      }),
    ),
    updatedAt: policy.updatedAt,
    updatedBy: policy.updatedBy,
  };
}

/** Where a gate stands: waiting for a person, being checked by an agent, passed, sent back, or handed to a person. */
export const GATE_STATUSES = ["waiting", "checking", "passed", "rejected", "escalated"] as const;
export type GateStatus = (typeof GATE_STATUSES)[number];

/** One time a flow reached a gate (sdlc_gates): what it was about, how it was set then, and who decided. */
export interface SdlcGateRecord {
  id: number;
  project: string;
  taskId: string;
  gate: SdlcGate;
  mode: GateMode;
  status: GateStatus;
  /** A person's name, a review run ("run:<machine>/<id>"), or "auto". */
  decidedBy: string | null;
  note: string | null;
  createdAt: string;
  decidedAt: string | null;
}

// ── flows (roadmap 34b) ──────────────────────────────────────────────────────

/**
 * Where a flow stands: its step runs, its gate's check waits to be queued, an agent checks it, a person decides at its
 * gate, its next step waits for a free machine or for the files the machine pushes, it stopped (a run failed: a person
 * starts it again), or it is done.
 */
export const FLOW_STATES = ["running", "check", "checking", "gate", "next", "stopped", "done"] as const;
export type FlowState = (typeof FLOW_STATES)[number];

/** The Spec Kit steps of a flow, then the import of its tasks.md into the board. */
export const FLOW_STEPS = ["specify", "plan", "tasks", "import"] as const;
export type FlowStep = (typeof FLOW_STEPS)[number];

/** The gate after each Spec Kit step. */
export const STEP_GATE: Record<Exclude<FlowStep, "import">, SdlcGate> = { specify: "spec", plan: "plan", tasks: "tasks" };
/** What comes after a step once its gate passed. */
export const NEXT_STEP: Record<Exclude<FlowStep, "import">, FlowStep> = { specify: "plan", plan: "tasks", tasks: "import" };

/** One feature's way through Spec Kit, driven by the hub (sdlc_flows): one task, one branch, one machine. */
export interface SdlcFlow {
  taskId: string;
  project: string;
  /** specs/<dir>; null until the machine pushed what the specify step wrote. */
  dir: string | null;
  step: FlowStep;
  state: FlowState;
  machineId: string;
  machine: string;
  profileId: string | null;
  /** The gate it waits at, when it does. */
  gate: SdlcGateRecord | null;
  /** Why it stopped, or what the last check said. */
  note: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** The files each Spec Kit gate reads. */
const GATE_FILE: Partial<Record<SdlcGate, string>> = { spec: "spec.md", plan: "plan.md", tasks: "tasks.md" };

/** What a gate's check looks for: the agent reads the step's file and says whether the next step can start. */
const GATE_CHECKS: Partial<Record<SdlcGate, string[]>> = {
  spec: [
    "Every requirement is clear and testable, with acceptance criteria.",
    "No [NEEDS CLARIFICATION] mark is left, and nothing the request asked for is missing or out of scope.",
  ],
  plan: [
    "The plan covers every requirement of spec.md, and its technical choices fit the repository as it is.",
    "Risks, data changes and tests are named; nothing in it contradicts the project's AGENTS.md.",
  ],
  tasks: [
    "The tasks cover the whole plan, each small enough for one run, in a working order (dependencies, [P] only when independent).",
    "Each task names the files it touches and how it is checked (tests).",
  ],
};

/**
 * Instructions for the review run that checks a gate (mode "ai"): not a code review. It ends with the verdict line
 * parseVerdict reads; "approve" lets the flow go on, anything else hands the gate to a person with the report.
 */
export function gateCheckInstructions(gate: SdlcGate, o: { dir?: string | null } = {}): string {
  const file = GATE_FILE[gate];
  return [
    `This is the "${gate}" gate of a delivery flow, not a code review: decide whether the next step may start without a person.`,
    file ? `Read specs/${o.dir ?? "<the feature's folder>"}/${file} on this branch, and the task note.` : "Read the task and its note.",
    "Check:",
    ...(GATE_CHECKS[gate] ?? []).map((c) => `- ${c}`),
    "Change nothing and commit nothing.",
    "End with exactly one line: `Verdict: approve` when the next step can start as it is, or `Verdict: changes` followed by what must change. When unsure, say changes.",
  ].join("\n");
}
