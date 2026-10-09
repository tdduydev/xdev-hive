import { GATE_MODES, MAX_FIX_ROUNDS, type GateMode, type GateModes, type SdlcGate, type SdlcPolicyView } from "@xdev-hive/core";

type ProjectView = SdlcPolicyView["projects"][string];

/** sdlc.setProject replaces the whole settings object, so one changed row must carry every other stored field or it silently resets them. */
export function projectSettingsPatch(view: ProjectView | undefined, patch: { gates?: Partial<GateModes>; autoDispatch?: boolean; maxFixRounds?: number }): Record<string, unknown> {
  const gates = { ...Object.fromEntries(Object.entries(view?.gates ?? {})), ...patch.gates } as GateModes;
  return {
    gates,
    autoDispatch: patch.autoDispatch ?? view?.autoDispatch,
    maxFixRounds: patch.maxFixRounds ?? view?.maxFixRounds,
    maxParallel: view?.maxParallel ?? null,
    releaseMachine: view?.releaseMachine,
    allowedAgentKinds: view?.allowedAgentKinds,
    fastLaneKinds: view?.fastLaneKinds,
    planApproval: view?.planApproval,
  };
}

/** Release is never decided by an AI; a project cannot pick a mode above the hub ceiling (it would be stored but run at the ceiling). */
export function gateModeOptions(gate: SdlcGate, ceiling: GateMode | undefined): GateMode[] {
  const top = GATE_MODES.indexOf(ceiling ?? "auto");
  return GATE_MODES.filter((m, i) => i <= top && (gate !== "release" || m !== "ai"));
}

export const fixRoundOptions = Array.from({ length: MAX_FIX_ROUNDS + 1 }, (_, i) => i);
