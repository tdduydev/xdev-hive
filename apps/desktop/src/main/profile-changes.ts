// Profile changes asked for on the web (roadmap 18d): a hub admin or this machine's owner turns a subscription on or
// off, or changes its priority; the heartbeat brings it here and the app saves it in config.json, no restart needed.
import type { AgentProfile, ProfileChange } from "@xdev-hive/core";

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
    if (enabled === p.enabled && priority === p.priority) return p;
    const changed = { ...p, enabled, priority };
    applied.push({ change: c, profile: changed });
    return changed;
  });
  return { agents: next, applied };
}
