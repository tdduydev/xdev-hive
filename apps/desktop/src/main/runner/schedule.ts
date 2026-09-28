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
  /** false when the CLI says it is signed out; unknown counts as signed in. */
  loggedIn?: boolean;
  /** The plan usage reached the profile's stop threshold (see usageStop). */
  overLimit?: boolean;
}

export interface RunNeeds {
  role: AgentRole;
  preferredProfile: string | null;
  avoidKinds: AgentKind[];
  excludedProfiles: string[];
  /** Profiles to avoid when another will do: those the other best-of-n candidates run on. */
  avoidProfiles?: string[];
}

export function isAvailable(p: ProfileLoad, now: Date): boolean {
  return (
    p.profile.enabled &&
    p.installed !== false &&
    p.loggedIn !== false &&
    !p.overLimit &&
    p.running < p.profile.maxConcurrent &&
    (p.cooldownUntil === null || new Date(p.cooldownUntil) <= now)
  );
}

/**
 * Rules, in order:
 * 1. A pinned profile waits for that profile only.
 * 2. Skip disabled, not installed, signed-out, over their plan threshold, busy, cooling-down, excluded (already failed this run)
 *    and role-mismatched profiles.
 * 3. Prefer profiles not in avoidProfiles (each best-of-n candidate on its own subscription), then kinds not
 *    in avoidKinds (cross-review uses a different vendor than the implementer).
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
  const avoid = needs.avoidProfiles ?? [];
  candidates.sort(
    (a, b) =>
      Number(avoid.includes(a.profile.id)) - Number(avoid.includes(b.profile.id)) ||
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
  const signedIn = installed.filter((l) => l.loggedIn !== false);
  if (!signedIn.length) return tr("runNote.notSignedIn", { profiles: installed.map((l) => l.profile.id).join(", ") });
  const underLimit = signedIn.filter((l) => !l.overLimit);
  if (!underLimit.length) return tr("runNote.overLimit", { profiles: signedIn.map((l) => l.profile.id).join(", ") });
  const resting = underLimit.filter((l) => l.cooldownUntil && new Date(l.cooldownUntil) > now);
  if (resting.length === underLimit.length) {
    const next = resting.map((l) => l.cooldownUntil!).sort()[0]!;
    return tr("runNote.allResting", { time: next });
  }
  return tr("runNote.waitingSlot");
}
