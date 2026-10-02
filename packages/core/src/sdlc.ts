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
