// Bản đồ agent (roadmap 31b): machine → profile → run, as the hub last heard it, for the cards of the map.
import type { Machine, MachineRun, QuotaCooldown, ReportedProfile } from "@xdev-hive/core";
import type { Scope } from "#ui/lib/scope.ts";

/**
 * What a profile's card says, the first that holds: its machine is gone, it is off, its CLI is missing or signed out,
 * it is running, it reached its stop threshold, it rests until its quota resets, or it is ready.
 */
export type ProfileState = "offline" | "off" | "noCli" | "signedOut" | "running" | "overLimit" | "resting" | "ready";

export interface ProfileCard {
  profile: ReportedProfile;
  state: ProfileState;
  /** Its runs on the machine now, running ones first. */
  runs: MachineRun[];
  running: number;
  /** Runs it takes at once; apps older than 0.110 do not say, which is one. */
  max: number;
  /** Until when it rests (its own cooldown, or its account's on the hub); null when it does not. */
  restingUntil: string | null;
}

/** The pending hub intake value wins until the machine reports that it applied it. */
export function hubIntakeControl(m: Pick<Machine, "runnerSettings" | "runnerChange" | "acceptsRuns">) {
  return {
    supported: typeof m.runnerSettings?.acceptHubRuns === "boolean",
    value: m.runnerChange?.settings.acceptHubRuns ?? m.runnerSettings?.acceptHubRuns ?? m.acceptsRuns,
    waiting: m.runnerChange?.settings.acceptHubRuns !== undefined,
  };
}

const later = (a: string | null, b: string | null) => (!a ? b : !b ? a : a > b ? a : b);

export function profileCard(m: Pick<Machine, "online" | "runs">, p: ReportedProfile, cooldowns: QuotaCooldown[], now: number): ProfileCard {
  const runs = m.runs.filter((r) => r.profileId === p.id).sort((a, b) => (a.status === b.status ? a.since.localeCompare(b.since) : a.status === "running" ? -1 : 1));
  const running = runs.filter((r) => r.status === "running").length;
  const future = (iso: string | null | undefined) => (iso && Date.parse(iso) > now ? iso : null);
  const account = p.account ? cooldowns.find((c) => c.account === p.account) : undefined;
  const restingUntil = later(future(p.cooldownUntil), future(account?.until));
  const state: ProfileState = !m.online
    ? "offline"
    : !p.enabled
      ? "off"
      : !p.installed
        ? "noCli"
        : p.loggedIn === false
          ? "signedOut"
          : running > 0
            ? "running"
            : p.overLimit
              ? "overLimit"
              : restingUntil
                ? "resting"
                : "ready";
  return { profile: p, state, runs, running, max: p.maxConcurrent ?? 1, restingUntil };
}

/** A machine's cards, and its runs no profile of it claims (waiting for one, or of a profile it no longer reports). */
export function machineCards(m: Machine, cooldowns: QuotaCooldown[], now: number): { cards: ProfileCard[]; queue: MachineRun[] } {
  const cards = m.profiles.map((p) => profileCard(m, p, cooldowns, now));
  const known = new Set(m.profiles.map((p) => p.id));
  return { cards, queue: m.runs.filter((r) => !r.profileId || !known.has(r.profileId)) };
}

/** The machines with a repo of the picked project (or system), online first, then by name. */
export function mapMachines(machines: Machine[], scope: Scope): Machine[] {
  const wanted = scope.kind === "project" ? [scope.project] : scope.kind === "system" ? scope.projects : null;
  return machines
    .filter((m) => !wanted || m.projects.some((p) => wanted.includes(p)))
    .sort((a, b) => Number(b.online) - Number(a.online) || a.machine.localeCompare(b.machine));
}

/** A picked card, as the prompt and batch forms take it. */
export interface AgentTarget {
  machineId: string;
  profileId: string;
}

/** Targets in an address (#/tasks?agents=…), so the Task page can give picked tasks to the agents picked on the map. */
export const encodeTargets = (targets: AgentTarget[]): string => targets.map((x) => `${x.machineId}|${x.profileId}`).join(",");

export function decodeTargets(text: string | null): AgentTarget[] {
  if (!text) return [];
  return text
    .split(",")
    .map((part) => part.split("|"))
    .filter((p): p is [string, string] => p.length === 2 && !!p[0] && !!p[1])
    .map(([machineId, profileId]) => ({ machineId, profileId }));
}
