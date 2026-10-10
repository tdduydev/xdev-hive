// Profile changes asked for on the web (roadmap 18d): a hub admin or this machine's owner turns a subscription on or
// off, or changes its priority; the heartbeat brings it here and the app saves it in config.json, no restart needed.
import type { AgentProfile, ProfileChange, RunnerChange } from "@xdev-hive/core";

export interface AppliedChange {
  change: ProfileChange;
  profile: AgentProfile;
}

/**
 * The profiles with the hub's changes in, and the changes that changed something. A change for a profile this machine
 * no longer has is skipped; the hub drops it once the next heartbeat reports the profiles without it.
 */
export function applyProfileChanges(agents: AgentProfile[], changes: ProfileChange[]): { agents: AgentProfile[]; applied: AppliedChange[] } {
  const applied: AppliedChange[] = [];
  const next = agents.map((p) => {
    const c = changes.find((x) => x.profileId === p.id);
    if (!c) return p;
    const enabled = c.enabled ?? p.enabled;
    const priority = c.priority ?? p.priority;
    const stopAtSession = c.stopAtSession ?? p.stopAtSession;
    const stopAtWeek = c.stopAtWeek ?? p.stopAtWeek;
    if (enabled === p.enabled && priority === p.priority && stopAtSession === p.stopAtSession && stopAtWeek === p.stopAtWeek) return p;
    const changed = { ...p, enabled, priority, stopAtSession, stopAtWeek };
    applied.push({ change: c, profile: changed });
    return changed;
  });
  return { agents: next, applied };
}

/** Preserve every local setting outside the public remote patch, including credentials and MR policy. */
export function applyRunnerChange<T extends { runner: { maxParallel: number; acceptHubRuns: boolean }; gitlab: { mr: { enabled: boolean; when: "after_review" | "after_success" } } }>(config: T, change: RunnerChange): T {
  const s = change.settings;
  return { ...config, runner: { ...config.runner, maxParallel: s.maxParallel ?? config.runner.maxParallel, acceptHubRuns: s.acceptHubRuns ?? config.runner.acceptHubRuns },
    gitlab: { ...config.gitlab, mr: { ...config.gitlab.mr, enabled: s.mrEnabled ?? config.gitlab.mr.enabled, when: s.mrWhen ?? config.gitlab.mr.when } } };
}
