import type { Machine, QuotaCooldown, ReportedProfile } from "@xdev-hive/core";
import { profileCard, type ProfileCard } from "#ui/lib/agentmap.ts";

export interface QuotaRow {
  key: string;
  profile: ReportedProfile;
  members: Array<{ machine: Machine; card: ProfileCard }>;
  available: boolean;
  slots: number;
  nextAt: string | null;
  full: number | null;
}

/** Accounts share quota across machines, but different providers have independent subscriptions. */
export function quotaRows(machines: Machine[], cooldowns: QuotaCooldown[], now: number, machineId = ""): QuotaRow[] {
  const groups = new Map<string, QuotaRow>();
  for (const machine of machines) for (const profile of machine.profiles) {
    const key = JSON.stringify([profile.kind, profile.account?.trim() || [machine.id, profile.id]]);
    const card = profileCard(machine, profile, cooldowns, now);
    card.running = Math.max(card.running, profile.running ?? 0);
    if (card.running && card.state === "ready") card.state = "running";
    const member = { machine, card };
    const existing = groups.get(key);
    if (existing) {
      existing.members.push(member);
      if ((Date.parse(profile.usageCheckedAt ?? "") || 0) > (Date.parse(existing.profile.usageCheckedAt ?? "") || 0)) existing.profile = profile;
    } else groups.set(key, { key, profile, members: [member], available: false, slots: 0, nextAt: null, full: null });
  }
  for (const row of groups.values()) {
    const p = row.profile;
    // Running state takes precedence in the map; quota blockers still prevent another dispatch.
    row.slots = p.overLimit || p.spendControlReached || (p.sessionPercent ?? 0) >= 100 || (p.weekPercent ?? 0) >= 100 ? 0 : row.members.reduce((sum, { machine: m, card: c }) => sum + (
      (!machineId || m.id === machineId) && m.online && m.acceptsRuns && !m.duplicate && c.profile.enabled && c.profile.installed && c.profile.loggedIn !== false && !c.profile.overLimit && !c.restingUntil
        ? Math.max(0, c.max - c.running) : 0
    ), 0);
    row.available = row.slots > 0;
    const dates = [(p.weekPercent ?? 0) >= 100 ? null : p.sessionResetsAt, p.weekResetsAt, ...row.members.map(m => m.card.restingUntil)].filter((v): v is string => !!v && Date.parse(v) > now);
    row.nextAt = dates.sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;
    row.full = p.fullSessionsLeft == null || p.resetsLeft == null ? null : Math.min(p.fullSessionsLeft, p.resetsLeft);
  }
  return [...groups.values()];
}

export function quotaTotals(rows: QuotaRow[]) {
  const estimates = rows.flatMap(r => r.full === null ? [] : [r.full]);
  return {
    available: rows.filter(r => r.available).length,
    slots: rows.reduce((n, r) => n + r.slots, 0),
    full: estimates.length ? estimates.reduce((a, b) => a + b, 0) : null,
    unknown: rows.length - estimates.length,
    nextAt: rows.flatMap(r => r.nextAt ? [r.nextAt] : []).sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null,
  };
}
