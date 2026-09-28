// Chooses which subscription runs next. Pure so the rotation rules are easy to test.
import type { AgentKind, AgentProfile, AgentRole } from "@xdev-hive/core";
import { tr } from "../i18n.ts";

export interface ProfileLoad {
  profile: AgentProfile;
  running: number;
  cooldownUntil: string | null;
  lastUsedAt: string | null;
  /** false when the profile's CLI is not on this machine's PATH (default true). */
  installed?: boolean;
}

export interface RunNeeds {
  role: AgentRole;
  preferredProfile: string | null;
  avoidKinds: AgentKind[];
  excludedProfiles: string[];
}

export function isAvailable(p: ProfileLoad, now: Date): boolean {
  return (
    p.profile.enabled &&
    p.installed !== false &&
    p.running < p.profile.maxConcurrent &&
    (p.cooldownUntil === null || new Date(p.cooldownUntil) <= now)
  );
}

/**
 * Rules, in order:
 * 1. A pinned profile waits for that profile only.
 * 2. Skip disabled, not installed, busy, cooling-down, excluded (already failed this run) and role-mismatched profiles.
 * 3. Prefer kinds not in avoidKinds (cross-review uses a different vendor than the implementer).
 * 4. Lower priority number first, then least recently used, which rotates equal-priority subscriptions.
 */
export function pickProfile(loads: ProfileLoad[], needs: RunNeeds, now: Date): ProfileLoad | null {
  if (needs.preferredProfile) {
    const pinned = loads.find((l) => l.profile.id === needs.preferredProfile);
    return pinned && isAvailable(pinned, now) ? pinned : null;
  }
  const candidates = loads.filter(
    (l) =>
      isAvailable(l, now) &&
      l.profile.roles.includes(needs.role) &&
      !needs.excludedProfiles.includes(l.profile.id),
  );
  candidates.sort(
    (a, b) =>
      Number(needs.avoidKinds.includes(a.profile.kind)) - Number(needs.avoidKinds.includes(b.profile.kind)) ||
      a.profile.priority - b.profile.priority ||
      (a.lastUsedAt ?? "").localeCompare(b.lastUsedAt ?? ""),
  );
  return candidates[0] ?? null;
}

/** Why a queued run is still waiting, for the UI. */
export function waitingReason(loads: ProfileLoad[], needs: RunNeeds, now: Date): string {
  const eligible = loads.filter(
    (l) =>
      l.profile.enabled &&
      (needs.preferredProfile ? l.profile.id === needs.preferredProfile : l.profile.roles.includes(needs.role)) &&
      !needs.excludedProfiles.includes(l.profile.id),
  );
  if (!eligible.length) return tr("runNote.noProfile");
  const installed = eligible.filter((l) => l.installed !== false);
  if (!installed.length) {
    return tr("runNote.noCli", { bins: eligible.map((l) => l.profile.bin).join(", ") });
  }
  const resting = installed.filter((l) => l.cooldownUntil && new Date(l.cooldownUntil) > now);
  if (resting.length === installed.length) {
    const next = resting.map((l) => l.cooldownUntil!).sort()[0]!;
    return tr("runNote.allResting", { time: next });
  }
  return tr("runNote.waitingSlot");
}
