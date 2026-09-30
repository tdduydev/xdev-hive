// Cảnh báo (docs/design/2026-09-redesign, xDev Hive Web Admin; roadmap 22m): rules a hub admin turns on or off, checked
// every minute against what the hub knows (runs machines pushed, heartbeats, webhooks, backups). A rule that holds opens
// an alert, sent to the webhooks that want alert.opened; it resolves by itself once the rule no longer holds. Also the
// admin overview's live feed: what machines and people did lately.
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  ALERT_RULES,
  HiveError,
  type Actor,
  type AlertRule,
  type AlertRuleState,
  type AlertSeverity,
  type FeedEvent,
  type HiveEvent,
  type HubAlert,
  type MachineDetail,
  type RunRecord,
} from "@xdev-hive/core";
import type { SqliteHive } from "@xdev-hive/core/node";
import type { WebhookStore } from "./webhooks.ts";

export const RULE_SEVERITY: Record<AlertRule, AlertSeverity> = {
  run_fail_streak: "high",
  ci_fix_exhausted: "high",
  machine_offline: "medium",
  webhook_failed: "medium",
  quota_near: "low",
  vendor_resting: "high",
  backup_overdue: "medium",
};
/** On until an admin turns them off; the quota one is chatty, so it starts off. */
const DEFAULT_ON: Record<AlertRule, boolean> = { ...Object.fromEntries(ALERT_RULES.map((r) => [r, true])), quota_near: false } as Record<AlertRule, boolean>;

/** The rules' thresholds, as the design words them. */
const STREAK = { runs: 3, minutes: 60 };
const OFFLINE_MINUTES = 60;
/** A machine not heard from for this long is gone, not offline: no alert. */
const GONE_DAYS = 7;
const QUOTA_PERCENT = 80;
const CI_LIMIT_DAYS = 7;

export interface AlertOptions {
  webhooks?: WebhookStore;
  /** HIVE_BACKUP_DIR and how often it runs: backup_overdue only checks a hub that makes backups. */
  backup?: { dir: string; hours: number } | null;
  /** An alert opened: the server sends it to webhooks. */
  onOpen?: (alert: HubAlert) => void;
  now?: () => Date;
}

interface Found {
  rule: AlertRule;
  key: string;
  vars: Record<string, string | number>;
  project: string | null;
}

type Row = Record<string, unknown>;
const str = (v: unknown) => (v == null ? null : String(v));

const toAlert = (r: Row): HubAlert => ({
  id: Number(r.id),
  rule: String(r.rule) as AlertRule,
  key: String(r.key),
  severity: String(r.severity) as AlertSeverity,
  vars: JSON.parse(String(r.vars)) as HubAlert["vars"],
  project: str(r.project),
  openedAt: String(r.opened_at),
  lastSeenAt: String(r.last_seen_at),
  resolvedAt: str(r.resolved_at),
  resolvedBy: str(r.resolved_by),
  ackedBy: str(r.acked_by),
  ackedAt: str(r.acked_at),
});

/** The hub looking at its own data: every project, every machine. */
const HUB: Actor = { name: "hub", role: "admin" };

export class AlertStore {
  readonly #db: DatabaseSync;
  readonly #hive: SqliteHive;
  readonly #opts: AlertOptions & { now: () => Date };
  readonly #startedAt: Date;
  #checking: Promise<void> | null = null;
  #checkedAt = 0;

  constructor(hive: SqliteHive, opts: AlertOptions = {}) {
    this.#hive = hive;
    this.#db = hive.db;
    this.#opts = { now: () => new Date(), ...opts };
    this.#startedAt = this.#opts.now();
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS hub_alert_rules(rule TEXT PRIMARY KEY, enabled INTEGER NOT NULL, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS hub_alerts(
        id INTEGER PRIMARY KEY, rule TEXT NOT NULL, key TEXT NOT NULL, severity TEXT NOT NULL, vars TEXT NOT NULL, project TEXT,
        opened_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, resolved_at TEXT, resolved_by TEXT, acked_by TEXT, acked_at TEXT);
      CREATE INDEX IF NOT EXISTS hub_alerts_open ON hub_alerts(resolved_at, rule, key);
      CREATE TABLE IF NOT EXISTS hub_ci_limits(
        project TEXT NOT NULL, task_id TEXT NOT NULL, mr_iid INTEGER, mr_url TEXT, machine TEXT NOT NULL, at TEXT NOT NULL,
        PRIMARY KEY(project, task_id));
    `);
  }

  #iso(offsetMinutes = 0): string {
    return new Date(this.#opts.now().getTime() + offsetMinutes * 60_000).toISOString();
  }

  rules(): AlertRuleState[] {
    const rows = new Map((this.#db.prepare("SELECT * FROM hub_alert_rules").all() as Row[]).map((r) => [String(r.rule), r]));
    return ALERT_RULES.map((rule) => {
      const r = rows.get(rule);
      return { rule, enabled: r ? Number(r.enabled) === 1 : DEFAULT_ON[rule], severity: RULE_SEVERITY[rule], updatedBy: str(r?.updated_by), updatedAt: str(r?.updated_at) };
    });
  }

  async setRule(rule: string, enabled: boolean, by: string): Promise<AlertRuleState> {
    if (!(ALERT_RULES as readonly string[]).includes(rule)) throw new HiveError("bad_request", `Unknown alert rule ${rule}.`, { key: "errors.alertRule", vars: { rule } });
    this.#db
      .prepare("INSERT INTO hub_alert_rules(rule, enabled, updated_by, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(rule) DO UPDATE SET enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = excluded.updated_at")
      .run(rule, enabled ? 1 : 0, by, this.#iso());
    await this.check();
    return this.rules().find((r) => r.rule === rule)!;
  }

  /** Open alerts, and those that ended in the last week. Checks first when the last check is older than half a minute. */
  async list(): Promise<{ open: HubAlert[]; recent: HubAlert[]; rules: AlertRuleState[] }> {
    if (this.#opts.now().getTime() - this.#checkedAt > 30_000) await this.check();
    const open = (this.#db.prepare("SELECT * FROM hub_alerts WHERE resolved_at IS NULL ORDER BY opened_at DESC").all() as Row[]).map(toAlert);
    const recent = (this.#db.prepare("SELECT * FROM hub_alerts WHERE resolved_at >= ? ORDER BY resolved_at DESC LIMIT 30").all(this.#iso(-7 * 24 * 60)) as Row[]).map(toAlert);
    const rank: Record<AlertSeverity, number> = { high: 0, medium: 1, low: 2 };
    return { open: open.sort((a, b) => rank[a.severity] - rank[b.severity] || b.openedAt.localeCompare(a.openedAt)), recent, rules: this.rules() };
  }

  /** "Đã biết": seen by an admin; it stays open (and on the list) until what it is about is gone. */
  ack(id: number, by: string): HubAlert {
    const row = this.#db.prepare("SELECT * FROM hub_alerts WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new HiveError("not_found", `No alert #${id}.`, { key: "errors.notFound" });
    if (!row.acked_by) this.#db.prepare("UPDATE hub_alerts SET acked_by = ?, acked_at = ? WHERE id = ?").run(by, this.#iso(), id);
    return toAlert(this.#db.prepare("SELECT * FROM hub_alerts WHERE id = ?").get(id) as Row);
  }

  /** What machines report that no table of the hub keeps: a merge request whose CI fixes ran out. */
  onEvent(event: HiveEvent): void {
    if (event.type !== "run.ciLimit") return;
    const r = event.run;
    this.#db
      .prepare(
        "INSERT INTO hub_ci_limits(project, task_id, mr_iid, mr_url, machine, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(project, task_id) DO UPDATE SET mr_iid = excluded.mr_iid, mr_url = excluded.mr_url, machine = excluded.machine, at = excluded.at",
      )
      .run(r.project, r.taskId, r.mrIid, r.mrUrl, r.machine, this.#iso());
    void this.check();
  }

  /** Runs the enabled rules once: opens what holds and was not open, resolves what no longer holds. */
  check(): Promise<void> {
    this.#checking ??= this.#check().finally(() => {
      this.#checking = null;
      this.#checkedAt = this.#opts.now().getTime();
    });
    return this.#checking;
  }

  async #check(): Promise<void> {
    const rules = this.rules();
    const on = new Set(rules.filter((r) => r.enabled).map((r) => r.rule));
    const found: Found[] = [];
    const runs = on.has("run_fail_streak") || on.has("ci_fix_exhausted") ? await this.#hive.call("runs.list", { limit: 200 }, HUB) : [];
    const machines = on.has("machine_offline") || on.has("quota_near") || on.has("vendor_resting") ? await this.#hive.call("admin.machines", {}, HUB) : [];
    if (on.has("run_fail_streak")) found.push(...this.#failStreaks(runs));
    if (on.has("ci_fix_exhausted")) found.push(...this.#ciLimits(runs));
    if (on.has("machine_offline")) found.push(...this.#offline(machines));
    if (on.has("webhook_failed")) found.push(...this.#webhooks());
    if (on.has("quota_near")) found.push(...this.#quota(machines));
    if (on.has("vendor_resting")) found.push(...this.#vendors(machines));
    if (on.has("backup_overdue")) found.push(...this.#backup());

    const now = this.#iso();
    const open = (this.#db.prepare("SELECT * FROM hub_alerts WHERE resolved_at IS NULL").all() as Row[]).map(toAlert);
    const seen = new Set<string>();
    const opened: HubAlert[] = [];
    for (const f of found) {
      const id = `${f.rule}\n${f.key}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const cur = open.find((a) => a.rule === f.rule && a.key === f.key);
      if (cur) {
        this.#db.prepare("UPDATE hub_alerts SET last_seen_at = ?, vars = ? WHERE id = ?").run(now, JSON.stringify(f.vars), cur.id);
        continue;
      }
      const res = this.#db
        .prepare("INSERT INTO hub_alerts(rule, key, severity, vars, project, opened_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(f.rule, f.key, RULE_SEVERITY[f.rule], JSON.stringify(f.vars), f.project, now, now);
      opened.push(toAlert(this.#db.prepare("SELECT * FROM hub_alerts WHERE id = ?").get(Number(res.lastInsertRowid)) as Row));
    }
    // What no longer holds (or whose rule was turned off) ends by itself.
    for (const a of open) if (!seen.has(`${a.rule}\n${a.key}`)) this.#db.prepare("UPDATE hub_alerts SET resolved_at = ? WHERE id = ?").run(now, a.id);
    this.#db.prepare("DELETE FROM hub_alerts WHERE resolved_at < ?").run(this.#iso(-90 * 24 * 60));
    for (const a of opened) this.#opts.onOpen?.(a);
  }

  /** The same task failing again and again: three failed runs within the hour. */
  #failStreaks(runs: RunRecord[]): Found[] {
    const since = this.#iso(-STREAK.minutes);
    const by = new Map<string, RunRecord[]>();
    for (const r of runs) {
      if (r.status !== "failed" || !r.finishedAt || r.finishedAt < since) continue;
      const k = `${r.project}/${r.taskId}`;
      by.set(k, [...(by.get(k) ?? []), r]);
    }
    return [...by.entries()]
      .filter(([, list]) => list.length >= STREAK.runs)
      .map(([key, list]) => ({ rule: "run_fail_streak", key, project: list[0]!.project, vars: { project: list[0]!.project, task: list[0]!.taskId, title: list[0]!.taskTitle, count: list.length } }));
  }

  /** A merge request whose pipeline still fails after the last fix run: until a run of the task succeeds after it. */
  #ciLimits(runs: RunRecord[]): Found[] {
    const rows = this.#db.prepare("SELECT * FROM hub_ci_limits WHERE at >= ?").all(this.#iso(-CI_LIMIT_DAYS * 24 * 60)) as Row[];
    return rows
      .filter((row) => !runs.some((r) => r.project === row.project && r.taskId === row.task_id && r.status === "succeeded" && (r.finishedAt ?? "") > String(row.at)))
      .map((row) => ({
        rule: "ci_fix_exhausted",
        key: `${row.project}/${row.task_id}`,
        project: String(row.project),
        vars: { project: String(row.project), task: String(row.task_id), mr: row.mr_iid == null ? "?" : Number(row.mr_iid), machine: String(row.machine).split("@")[0]!.replace(/^runner\./, "") },
      }));
  }

  #offline(machines: MachineDetail[]): Found[] {
    const late = this.#iso(-OFFLINE_MINUTES);
    const gone = this.#iso(-GONE_DAYS * 24 * 60);
    return machines
      .filter((m) => m.lastSeen < late && m.lastSeen >= gone)
      .map((m) => ({ rule: "machine_offline", key: m.id, project: null, vars: { machine: m.machine, since: m.lastSeen, minutes: Math.round((this.#opts.now().getTime() - Date.parse(m.lastSeen)) / 60_000) } }));
  }

  #webhooks(): Found[] {
    return (this.#opts.webhooks?.list() ?? [])
      .filter((w) => w.enabled && w.lastError)
      .map((w) => ({ rule: "webhook_failed", key: String(w.id), project: null, vars: { name: w.name, kind: w.kind, error: w.lastError! } }));
  }

  /** A subscription at 80% of its session or week (Claude Code reports both). */
  #quota(machines: MachineDetail[]): Found[] {
    const out: Found[] = [];
    for (const m of machines.filter((x) => x.online)) {
      for (const p of m.profiles) {
        const top = Math.max(p.sessionPercent ?? 0, p.weekPercent ?? 0);
        if (p.enabled && top >= QUOTA_PERCENT) {
          out.push({ rule: "quota_near", key: `${m.id}/${p.id}`, project: null, vars: { profile: p.id, machine: m.machine, session: p.sessionPercent ?? "?", week: p.weekPercent ?? "?" } });
        }
      }
    }
    return out;
  }

  /** Every subscription of one vendor resting (on the machines online): runs and cross-reviews on it wait. */
  #vendors(machines: MachineDetail[]): Found[] {
    const now = this.#iso();
    const by = new Map<string, Array<{ until: string | null }>>();
    for (const m of machines.filter((x) => x.online)) {
      for (const p of m.profiles) {
        if (!p.enabled || !p.installed) continue;
        by.set(p.kind, [...(by.get(p.kind) ?? []), { until: p.cooldownUntil && p.cooldownUntil > now ? p.cooldownUntil : null }]);
      }
    }
    return [...by.entries()]
      .filter(([, list]) => list.length > 0 && list.every((x) => x.until))
      .map(([vendor, list]) => ({ rule: "vendor_resting", key: vendor, project: null, vars: { vendor, count: list.length, until: list.map((x) => x.until!).sort()[0]! } }));
  }

  /** No backup newer than its interval and two hours; a hub that makes none is left alone. */
  #backup(): Found[] {
    const b = this.#opts.backup;
    if (!b) return [];
    const limit = this.#opts.now().getTime() - (b.hours + 2) * 3_600_000;
    let newest: number | null = null;
    if (existsSync(b.dir)) {
      for (const f of readdirSync(b.dir)) {
        if (!/^hub-.*\.db$/.test(f)) continue;
        const t = statSync(path.join(b.dir, f)).mtimeMs;
        if (newest === null || t > newest) newest = t;
      }
    }
    // A hub that just started may not have written its first one yet.
    if (newest === null && this.#startedAt.getTime() > limit) return [];
    if (newest !== null && newest > limit) return [];
    return [{ rule: "backup_overdue", key: "backup", project: null, vars: { dir: b.dir, hours: newest === null ? "?" : Math.round((this.#opts.now().getTime() - newest) / 3_600_000) } }];
  }

  /** The overview's feed: runs starting and ending, alerts, what people did, proposals; the newest first. */
  async feed(limit = 40): Promise<FeedEvent[]> {
    const since = this.#iso(-24 * 60);
    const out: FeedEvent[] = [];
    const who = (m: string) => m.split("@")[0]!.replace(/^runner\./, "");
    for (const r of await this.#hive.call("runs.list", { limit: 100 }, HUB)) {
      const href = `#/admin/runs?run=${encodeURIComponent(r.runId)}`;
      const vars = { task: r.taskId, title: r.taskTitle, profile: r.profileId ?? "?", project: r.project };
      if (r.startedAt && r.startedAt >= since) out.push({ at: r.startedAt, tone: "running", src: r.machine, key: "feed.runStarted", vars, href });
      if (r.finishedAt && r.finishedAt >= since) {
        const tone = r.status === "succeeded" ? "success" : r.status === "cancelled" ? "neutral" : r.status === "rate_limited" ? "warning" : "danger";
        out.push({ at: r.finishedAt, tone, src: r.machine, key: `feed.run.${r.status}`, vars, href });
        if (r.mrUrl) out.push({ at: r.finishedAt, tone: "info", src: r.machine, key: "feed.mr", vars: { ...vars, url: r.mrUrl }, href });
      }
    }
    for (const a of (this.#db.prepare("SELECT * FROM hub_alerts WHERE opened_at >= ? OR resolved_at >= ?").all(since, since) as Row[]).map(toAlert)) {
      if (a.openedAt >= since) out.push({ at: a.openedAt, tone: a.severity === "high" ? "danger" : "warning", src: "hub", key: "feed.alertOpened", vars: { rule: a.rule, ...a.vars }, href: "#/admin/alerts" });
      if (a.resolvedAt && a.resolvedAt >= since) out.push({ at: a.resolvedAt, tone: "success", src: a.resolvedBy ?? "hub", key: "feed.alertResolved", vars: { rule: a.rule, ...a.vars }, href: "#/admin/alerts" });
    }
    for (const e of await this.#hive.call("admin.audit", { limit: 60 }, HUB)) {
      if (e.at < since) continue;
      out.push({ at: e.at, tone: "neutral", src: who(e.actor), key: "feed.audit", vars: { action: e.action, target: e.target }, href: "#/admin/audit" });
    }
    for (const p of await this.#hive.call("proposals.list", { status: "pending" }, HUB)) {
      if (p.createdAt < since) continue;
      out.push({ at: p.createdAt, tone: "info", src: who(p.author), key: "feed.proposal", vars: { doc: p.docKey }, href: "#/admin/review" });
    }
    return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
  }
}
