// Chooses which subscription runs next. Pure so the rotation rules are easy to test.
import type { AgentKind, AgentProfile, AgentRole } from "@xdev-hive/core";
import { tr } from "#desktop/main/i18n.ts";

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
  /** Plan left before a stop threshold, in points (see usageHeadroom); null or missing: not known. */
  headroom?: number | null;
  /** How much of the five-hour session is used, in percent; null or missing: not known. */
  sessionPercent?: number | null;
  /** ISO time the limit that stops the profile first resets (see limitResetAt); null or missing: not known. */
  resetAt?: string | null;
}

export interface RunNeeds {
  role: AgentRole;
  preferredProfile: string | null;
  avoidKinds: AgentKind[];
  excludedProfiles: string[];
  /** Profiles to avoid when another will do: those the other best-of-n candidates run on. */
  avoidProfiles?: string[];
  /**
   * avoidKinds is a must while a profile of another kind could take the run once free (a cross-review waits for it);
   * only when every such profile is off, resting or over its plan threshold does a profile of an avoided kind do.
   */
  strictKinds?: boolean;
  /**
   * A kind asked for when the run was given (roadmap 24c): the run waits for a profile of it while one could take the
   * run once free, and goes to another kind only when every one of them is off, signed out, over its threshold or resting.
   */
  preferKind?: AgentKind | null;
  /**
   * A light or standard run (roadmap 54c): it goes to a plan whose session is not past QUOTA_PRESSURE_PERCENT first,
   * so the plan near its limit keeps what is left for strong work. A strong or max run does not move for this.
   */
  pressure?: boolean;
}

/** Session use past which a cheap run looks elsewhere first (spec 54, Áp lực hạn mức). */
export const QUOTA_PRESSURE_PERCENT = 70;
const pressed = (l: ProfileLoad) => (l.sessionPercent ?? 0) > QUOTA_PRESSURE_PERCENT;

/**
 * Whether a profile takes runs of this role. A classify run (roadmap 54b) is a few seconds of a cheap model: any Claude
 * or Codex profile that does the work itself takes it, rather than one more role to tick on every profile.
 */
export function takesRole(profile: Pick<AgentProfile, "kind" | "roles">, role: AgentRole): boolean {
  if (role === "research") return (profile.kind === "claude" || profile.kind === "codex") && profile.roles.some(r => r === "plan" || r === "implement");
  if (role === "classify") return (profile.kind === "claude" || profile.kind === "codex") && profile.roles.includes("implement");
  return profile.roles.includes(role);
}

/** Could take a run once a slot is free: on, installed, signed in, under its plan threshold and not resting. */
function usable(p: ProfileLoad, now: Date): boolean {
  return (
    p.profile.enabled &&
    p.installed !== false &&
    p.loggedIn !== false &&
    !p.overLimit &&
    (p.cooldownUntil === null || new Date(p.cooldownUntil) <= now)
  );
}

/** A preferred kind the run still waits for: none for a cross-review that has to avoid that kind. */
function preferred(needs: RunNeeds): AgentKind | null {
  const kind = needs.preferKind ?? null;
  return kind && !(needs.strictKinds && needs.avoidKinds.includes(kind)) ? kind : null;
}

/** When the profile's quota resets, if it has some left and that is known: the sooner, the sooner it goes to waste. */
const resetKey = (l: ProfileLoad) => (l.resetAt && (l.headroom ?? 0) > 0 ? l.resetAt : null);
/** Known times first, the earlier first. */
const soonest = (a: string | null, b: string | null) => (a === b ? 0 : a === null ? 1 : b === null ? -1 : Date.parse(a) - Date.parse(b));

export function isAvailable(p: ProfileLoad, now: Date): boolean {
  return usable(p, now) && p.running < p.profile.maxConcurrent;
}

/**
 * Rules, in order:
 * 1. A pinned profile waits for that profile only.
 * 2. Skip disabled, not installed, signed-out, over their plan threshold, busy, cooling-down, excluded (already failed this run)
 *    and role-mismatched profiles.
 * 3. A cross-review (strictKinds) waits for another vendor; then a preferred kind (preferKind) waits for a profile of
 *    that kind, while one of either could take the run once free.
 * 4. Prefer profiles not in avoidProfiles (each best-of-n candidate on its own subscription), then kinds not
 *    in avoidKinds (cross-review uses a different vendor than the implementer).
 * 5. Among profiles with plan left, the one whose binding limit resets soonest first (roadmap 24c): its quota is the
 *    next to go to waste. A reset that is not known comes after.
 * 6. The most plan left (roadmap 24a): a profile whose usage is known before one whose usage is not, so a run
 *    goes where it can finish and the subscriptions wear down together.
 * 7. Lower priority number first, then least recently used, which rotates equal-priority subscriptions.
 */
export function pickProfile(loads: ProfileLoad[], needs: RunNeeds, now: Date): ProfileLoad | null {
  return pickWithReason(loads, needs, now)?.load ?? null;
}

/** The profile pickProfile takes and why, for the run's log (roadmap 24c). */
export function pickWithReason(loads: ProfileLoad[], needs: RunNeeds, now: Date): { load: ProfileLoad; reason: string } | null {
  if (needs.preferredProfile) {
    const pinned = loads.find((l) => l.profile.id === needs.preferredProfile);
    return pinned && isAvailable(pinned, now) ? { load: pinned, reason: tr("runNote.pickPinned", { profile: pinned.profile.id }) } : null;
  }
  const fits = (l: ProfileLoad) => takesRole(l.profile, needs.role) && !needs.excludedProfiles.includes(l.profile.id);
  let candidates = loads.filter((l) => isAvailable(l, now) && fits(l));
  if (needs.strictKinds && needs.avoidKinds.length) {
    const other = (l: ProfileLoad) => !needs.avoidKinds.includes(l.profile.kind);
    if (loads.some((l) => other(l) && usable(l, now) && fits(l))) {
      candidates = candidates.filter(other);
      if (!candidates.length) return null;
    }
  }
  const kind = preferred(needs);
  let prefer: string | null = null;
  if (kind) {
    const same = (l: ProfileLoad) => l.profile.kind === kind;
    if (loads.some((l) => same(l) && usable(l, now) && fits(l))) {
      candidates = candidates.filter(same);
      if (!candidates.length) return null;
      prefer = tr("runNote.pickPreferred", { kind });
    } else {
      prefer = tr("runNote.pickPreferredGone", { kind });
    }
  }
  const avoid = needs.avoidProfiles ?? [];
  candidates.sort(
    (a, b) =>
      Number(avoid.includes(a.profile.id)) - Number(avoid.includes(b.profile.id)) ||
      Number(needs.avoidKinds.includes(a.profile.kind)) - Number(needs.avoidKinds.includes(b.profile.kind)) ||
      (needs.pressure ? Number(pressed(a)) - Number(pressed(b)) : 0) ||
      soonest(resetKey(a), resetKey(b)) ||
      (b.headroom ?? -1) - (a.headroom ?? -1) ||
      a.profile.priority - b.profile.priority ||
      (a.lastUsedAt ?? "").localeCompare(b.lastUsedAt ?? ""),
  );
  const load = candidates[0];
  if (!load) return null;
  const reset = resetKey(load);
  const order =
    candidates.length === 1
      ? tr("runNote.pickOnly")
      : reset
        ? tr("runNote.pickResetFirst", { time: reset })
        : load.headroom != null
          ? tr("runNote.pickHeadroom", { left: load.headroom })
          : tr("runNote.pickRotate");
  return { load, reason: tr("runNote.picked", { profile: load.profile.id, why: [prefer, order].filter(Boolean).join("; ") }) };
}

/** Why a queued run is still waiting, for the UI. */
export function waitingReason(loads: ProfileLoad[], needs: RunNeeds, now: Date): string {
  const eligible = loads.filter(
    (l) =>
      l.profile.enabled &&
      (needs.preferredProfile ? l.profile.id === needs.preferredProfile : takesRole(l.profile, needs.role)) &&
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
  if (needs.strictKinds && needs.avoidKinds.length && underLimit.some((l) => !needs.avoidKinds.includes(l.profile.kind) && !resting.includes(l))) {
    return tr("runNote.waitingVendor");
  }
  const kind = preferred(needs);
  if (kind && underLimit.some((l) => l.profile.kind === kind && !resting.includes(l))) return tr("runNote.waitingKind", { kind });
  if (resting.length === underLimit.length) {
    const next = resting.map((l) => l.cooldownUntil!).sort()[0]!;
    return tr("runNote.allResting", { time: next });
  }
  return tr("runNote.waitingSlot");
}
