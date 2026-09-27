// Chooses which subscription runs next. Pure so the rotation rules are easy to test.
import type { AgentKind, AgentProfile, AgentRole } from "@xdev-hive/core";

export interface ProfileLoad {
  profile: AgentProfile;
  running: number;
  cooldownUntil: string | null;
  lastUsedAt: string | null;
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
    p.running < p.profile.maxConcurrent &&
    (p.cooldownUntil === null || new Date(p.cooldownUntil) <= now)
  );
}

/**
 * Rules, in order:
 * 1. A pinned profile waits for that profile only.
 * 2. Skip disabled, busy, cooling-down, excluded (already failed this run) and role-mismatched profiles.
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
  if (!eligible.length) return "Không có profile nào phù hợp (đã tắt, sai vai trò hoặc đã thử hết)";
  const resting = eligible.filter((l) => l.cooldownUntil && new Date(l.cooldownUntil) > now);
  if (resting.length === eligible.length) {
    const next = resting.map((l) => l.cooldownUntil!).sort()[0]!;
    return `Mọi gói đang nghỉ vì quota, sớm nhất ${next}`;
  }
  return "Đang chờ slot trống";
}
