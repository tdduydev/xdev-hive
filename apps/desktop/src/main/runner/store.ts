import type { WorktreeLog, WorktreeCommand } from "@xdev-hive/core";
// Local run history and per-profile cooldowns. Lives on the machine that runs the agents.
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentKind, AgentRole, PreferKind, ProfileResume, AgentRun, BestOf, CiFix, MrState, MrStatus, PipelineStatus, RunCompression, RunStatus, RunTokens, ModelSelection } from "@xdev-hive/core";
import { tr } from "#desktop/main/i18n.ts";
import type { UsageSample } from "./usage.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS worktree_command_receipts(id TEXT PRIMARY KEY, results TEXT NOT NULL, acked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS worktree_cleanup_log(id INTEGER PRIMARY KEY, entry TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS tool_approval_receipts(
  id TEXT PRIMARY KEY, acked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS steer_messages(
  key TEXT PRIMARY KEY, run_id TEXT NOT NULL, text TEXT NOT NULL, by TEXT NOT NULL, at TEXT NOT NULL,
  delivered_at TEXT NOT NULL, hub_id INTEGER, acked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS profile_usage_history(
  profile_id TEXT NOT NULL, at TEXT NOT NULL, session REAL NOT NULL, week REAL NOT NULL,
  session_resets_at TEXT, PRIMARY KEY(profile_id, at));
CREATE INDEX IF NOT EXISTS profile_usage_at ON profile_usage_history(at);
CREATE TABLE IF NOT EXISTS runs(
  id TEXT PRIMARY KEY, project TEXT NOT NULL, task_id TEXT NOT NULL, task_title TEXT NOT NULL,
  role TEXT NOT NULL, status TEXT NOT NULL, profile_id TEXT, preferred_profile TEXT,
  avoid_kinds TEXT NOT NULL DEFAULT '[]', excluded_profiles TEXT NOT NULL DEFAULT '[]',
  attempt INTEGER NOT NULL, max_attempts INTEGER NOT NULL, parent_run_id TEXT,
  worktree TEXT, branch TEXT, base_sha TEXT, instructions TEXT NOT NULL DEFAULT '',
  review_after INTEGER NOT NULL DEFAULT 0, exit_code INTEGER, summary TEXT, error TEXT,
  commits INTEGER NOT NULL DEFAULT 0, head_sha TEXT,
  created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT);
CREATE INDEX IF NOT EXISTS runs_status ON runs(status, created_at);
CREATE INDEX IF NOT EXISTS runs_task ON runs(project, task_id);
CREATE TABLE IF NOT EXISTS profile_cooldowns(
  profile_id TEXT PRIMARY KEY, until TEXT NOT NULL, reason TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS profile_stats_since(
  profile_id TEXT PRIMARY KEY, since TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS profile_resumes(
  profile_id TEXT PRIMARY KEY, until TEXT NOT NULL, at TEXT NOT NULL, by TEXT NOT NULL);
`;

/** Columns added after the first release; created on open when missing. */
const ADDED_COLUMNS: Array<[name: string, ddl: string]> = [
  ["start_sha", "TEXT"], ["remote_sha", "TEXT"], ["pushed", "INTEGER"], ["push_error", "TEXT"],
  ["mr_url", "TEXT"],
  ["mr_iid", "INTEGER"],
  ["mr_state", "TEXT"],
  ["mr_draft", "INTEGER NOT NULL DEFAULT 0"],
  ["mr_note", "TEXT"],
  ["cost_usd", "REAL"],
  ["input_tokens", "INTEGER"],
  ["output_tokens", "INTEGER"],
  /** 1 once the hub has the run's cost (hub mode). */
  ["cost_reported", "INTEGER NOT NULL DEFAULT 0"],
  /** The MR on GitLab, as the watcher last saw it. */
  ["mr_status", "TEXT"],
  ["pipeline_status", "TEXT"],
  ["pipeline_url", "TEXT"],
  ["mr_checked_at", "TEXT"],
  /** JSON: the failed pipeline this run was queued to fix. */
  ["ci_fix", "TEXT"],
  /** JSON: the best-of-n group this run is a candidate or the judge of. */
  ["best_of", "TEXT"],
  /** Who asked for the run on the web (hub run request); null: started here. */
  ["requested_by", "TEXT"],
  /** Input written to and read from the prompt cache (roadmap 28c); null for runs from before. */
  ["cache_write_tokens", "INTEGER"],
  ["cache_read_tokens", "INTEGER"],
  /** The kind the run prefers (roadmap 24c); null: any. */
  ["prefer_kind", "TEXT"],
  ["allowed_agent_kinds", "TEXT"],
  /** JSON: what RTK left out of the run's Bash output (roadmap 28d); null: no RTK, or no numbers. */
  ["skills", "TEXT"],
  ["compression", "TEXT"],
  /** What it ran on (roadmap 54a): the profile's kind, and the model and effort its final args set. */
  ["agent_kind", "TEXT"],
  ["model", "TEXT"],
  ["effort", "TEXT"],
  ["selection", "TEXT"],
  ["plan", "TEXT"],
  ["diff_review", "TEXT"],
  ["diff_summary_for", "TEXT"],
  ["diff_patch", "TEXT"],
  ["timeout_minutes", "REAL"],
  ["continuation", "TEXT"],
  ["redispatch", "TEXT"],
];

type Row = Record<string, unknown>;
const JSON_FIELDS = new Set(["skills", "avoidKinds", "allowedAgentKinds", "excludedProfiles", "ciFix", "bestOf", "compression", "selection", "plan", "diffReview", "redispatch"]);
const BOOL_FIELDS = new Set(["reviewAfter", "mrDraft", "pushed"]);
const column = (field: string) => field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

function toRun(r: Row): AgentRun {
  const s = (v: unknown) => (v == null ? null : String(v));
  return {
    timeoutMinutes: r.timeout_minutes == null ? null : Number(r.timeout_minutes),
    continuation: s(r.continuation),
    redispatch: r.redispatch == null ? null : JSON.parse(String(r.redispatch)),
    plan: r.plan == null ? null : JSON.parse(String(r.plan)),
    id: String(r.id),
    project: String(r.project),
    taskId: String(r.task_id),
    taskTitle: String(r.task_title),
    role: r.role as AgentRole,
    status: r.status as RunStatus,
    profileId: s(r.profile_id),
    preferredProfile: s(r.preferred_profile),
    preferKind: s(r.prefer_kind) as PreferKind | null,
    allowedAgentKinds: r.allowed_agent_kinds == null ? null : JSON.parse(String(r.allowed_agent_kinds)) as AgentKind[],
    avoidKinds: JSON.parse(String(r.avoid_kinds)) as AgentKind[],
    excludedProfiles: JSON.parse(String(r.excluded_profiles)) as string[],
    attempt: Number(r.attempt),
    maxAttempts: Number(r.max_attempts),
    parentRunId: s(r.parent_run_id),
    worktree: s(r.worktree),
    branch: s(r.branch),
    baseSha: s(r.base_sha),
    instructions: String(r.instructions),
    reviewAfter: Number(r.review_after) === 1,
    exitCode: r.exit_code == null ? null : Number(r.exit_code),
    summary: s(r.summary),
    error: s(r.error),
    commits: Number(r.commits),
    headSha: s(r.head_sha),
    startSha: s(r.start_sha), remoteSha: s(r.remote_sha),
    pushed: r.pushed == null ? null : Number(r.pushed) === 1, pushError: s(r.push_error),
    createdAt: String(r.created_at),
    startedAt: s(r.started_at),
    finishedAt: s(r.finished_at),
    mrUrl: s(r.mr_url),
    mrIid: r.mr_iid == null ? null : Number(r.mr_iid),
    costUsd: r.cost_usd == null ? null : Number(r.cost_usd),
    inputTokens: r.input_tokens == null ? null : Number(r.input_tokens),
    cacheWriteTokens: r.cache_write_tokens == null ? null : Number(r.cache_write_tokens),
    cacheReadTokens: r.cache_read_tokens == null ? null : Number(r.cache_read_tokens),
    outputTokens: r.output_tokens == null ? null : Number(r.output_tokens),
    skills: r.skills == null ? [] : JSON.parse(String(r.skills)),
    compression: r.compression == null ? null : (JSON.parse(String(r.compression)) as RunCompression | null),
    mrState: s(r.mr_state) as MrState | null,
    mrDraft: Number(r.mr_draft) === 1,
    mrNote: s(r.mr_note),
    mrStatus: s(r.mr_status) as MrStatus | null,
    pipelineStatus: s(r.pipeline_status) as PipelineStatus | null,
    pipelineUrl: s(r.pipeline_url),
    mrCheckedAt: s(r.mr_checked_at),
    ciFix: r.ci_fix == null ? null : (JSON.parse(String(r.ci_fix)) as CiFix | null),
    bestOf: r.best_of == null ? null : (JSON.parse(String(r.best_of)) as BestOf | null),
    requestedBy: s(r.requested_by),
    agentKind: s(r.agent_kind) as AgentKind | null,
    model: s(r.model),
    effort: s(r.effort),
    diffSummaryFor: s(r.diff_summary_for),
    diffPatch: s(r.diff_patch),
    diffReview: r.diff_review == null ? null : JSON.parse(String(r.diff_review)),
    selection: r.selection == null ? null : JSON.parse(String(r.selection)) as ModelSelection,
  };
}

const encode = (field: string, value: unknown) =>
  JSON_FIELDS.has(field) ? JSON.stringify(value) : BOOL_FIELDS.has(field) ? (value ? 1 : 0) : (value ?? null);

export type NewRun = Pick<AgentRun, "project" | "taskId" | "taskTitle" | "role" | "attempt" | "maxAttempts"> &
  Partial<Pick<AgentRun, "preferredProfile" | "preferKind" | "allowedAgentKinds" | "avoidKinds" | "excludedProfiles" | "parentRunId" | "worktree" | "branch" | "baseSha" | "instructions" | "reviewAfter" | "ciFix" | "bestOf" | "requestedBy" | "selection" | "plan" | "diffSummaryFor" | "timeoutMinutes" | "redispatch">>;

export const ACTIVE: RunStatus[] = ["queued", "running"];

export class RunStore {
  readonly db: DatabaseSync;

  recordUsage(profileId: string, sample: UsageSample, now: Date): void {
    const cutoff = new Date(+now - 14 * 86400_000).toISOString();
    this.db.prepare("DELETE FROM profile_usage_history WHERE at < ?").run(cutoff);
    if (sample.at < cutoff || sample.at > now.toISOString()) return;
    this.db.prepare("INSERT OR IGNORE INTO profile_usage_history VALUES (?, ?, ?, ?, ?)").run(profileId, sample.at, sample.session, sample.week, sample.sessionResetsAt);
  }

  usageHistory(profileId: string, now: Date): UsageSample[] {
    this.db.prepare("DELETE FROM profile_usage_history WHERE at < ?").run(new Date(+now - 14 * 86400_000).toISOString());
    return this.db.prepare("SELECT at, session, week, session_resets_at AS sessionResetsAt FROM profile_usage_history WHERE profile_id = ? AND at >= ? ORDER BY at").all(profileId, new Date(+now - 14 * 86400_000).toISOString()) as unknown as UsageSample[];
  }

  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
    const have = new Set((this.db.prepare("PRAGMA table_info(runs)").all() as Row[]).map((c) => String(c.name)));
    for (const [name, ddl] of ADDED_COLUMNS) if (!have.has(name)) this.db.exec(`ALTER TABLE runs ADD COLUMN ${name} ${ddl}`);
  }

  worktreeResult(id: string): WorktreeCommand["results"] | null {
    const r = this.db.prepare("SELECT results FROM worktree_command_receipts WHERE id = ?").get(id);
    return r ? JSON.parse(String(r.results)) : null;
  }
  recordWorktreeResult(id: string, results: WorktreeCommand["results"]): void {
    this.db.prepare("INSERT OR IGNORE INTO worktree_command_receipts(id, results) VALUES (?, ?)").run(id, JSON.stringify(results));
  }
  worktreeResults(): Array<{ id: string; results: WorktreeCommand["results"] }> {
    return (this.db.prepare("SELECT id, results FROM worktree_command_receipts WHERE acked = 0 LIMIT 100").all() as { id: string; results: string }[]).map(r => ({ id: r.id, results: JSON.parse(r.results) }));
  }
  ackWorktreeResults(ids: string[]): void {
    for (const id of ids) this.db.prepare("UPDATE worktree_command_receipts SET acked = 1 WHERE id = ?").run(id);
  }
  logWorktree(entry: WorktreeLog): void {
    this.db.prepare("INSERT INTO worktree_cleanup_log(entry) VALUES (?)").run(JSON.stringify(entry));
    this.db.exec("DELETE FROM worktree_cleanup_log WHERE id NOT IN (SELECT id FROM worktree_cleanup_log ORDER BY id DESC LIMIT 500)");
  }
  worktreeLogs(): WorktreeLog[] {
    return this.db.prepare("SELECT entry FROM worktree_cleanup_log ORDER BY id DESC LIMIT 50").all().map(r => JSON.parse(String(r.entry)));
  }

  steering(runId: string): Array<{ id: number; text: string; by: string; at: string; deliveredAt: string }> {
    return this.db.prepare("SELECT rowid AS id, text, by, at, delivered_at AS deliveredAt FROM steer_messages WHERE run_id = ? ORDER BY rowid").all(runId) as unknown as Array<{ id: number; text: string; by: string; at: string; deliveredAt: string }>;
  }

  hasSteering(key: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM steer_messages WHERE key = ?").get(key);
  }

  saveSteering(key: string, runId: string, text: string, by: string, at: string, hubId: number | null, deliveredAt: string): void {
    this.db.prepare("INSERT OR IGNORE INTO steer_messages(key, run_id, text, by, at, hub_id, delivered_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(key, runId, text, by, at, hubId, deliveredAt);
  }

  toolApprovalApplied(id: string): boolean {
    return !!this.db.prepare("SELECT id FROM tool_approval_receipts WHERE id = ?").get(id);
  }

  recordToolApproval(id: string): void {
    this.db.prepare("INSERT OR IGNORE INTO tool_approval_receipts(id) VALUES (?)").run(id);
  }

  toolApprovalAcks(): string[] {
    return (this.db.prepare("SELECT id FROM tool_approval_receipts WHERE acked = 0 LIMIT 100").all() as { id: string }[]).map((r) => r.id);
  }

  ackToolApprovals(ids: string[]): void {
    for (const id of ids) this.db.prepare("UPDATE tool_approval_receipts SET acked = 1 WHERE id = ?").run(id);
  }

  steeringAcks(): number[] {
    return (this.db.prepare("SELECT hub_id FROM steer_messages WHERE hub_id IS NOT NULL AND acked = 0 LIMIT 100").all() as Array<{ hub_id: number }>).map((r) => r.hub_id);
  }

  ackSteering(ids: number[]): void {
    const put = this.db.prepare("UPDATE steer_messages SET acked = 1 WHERE hub_id = ?");
    for (const id of ids) put.run(id);
  }

  insert(run: NewRun, now: string): AgentRun {
    const id = `R-${randomBytes(3).toString("hex")}`;
    const full: Row = {
      preferredProfile: null,
      avoidKinds: [],
      excludedProfiles: [],
      parentRunId: null,
      worktree: null,
      branch: null,
      baseSha: null,
      instructions: "",
      reviewAfter: false,
      ...run,
      id,
      status: "queued",
      createdAt: now,
    };
    const fields = Object.keys(full);
    this.db
      .prepare(`INSERT INTO runs(${fields.map(column).join(", ")}) VALUES (${fields.map(() => "?").join(", ")})`)
      .run(...fields.map((f) => encode(f, full[f]) as string | number | null));
    return this.get(id)!;
  }

  update(id: string, patch: Partial<AgentRun>): AgentRun {
    const fields = Object.keys(patch).filter((f) => f !== "id");
    if (fields.length) {
      this.db
        .prepare(`UPDATE runs SET ${fields.map((f) => `${column(f)} = ?`).join(", ")} WHERE id = ?`)
        .run(...fields.map((f) => encode(f, (patch as Row)[f]) as string | number | null), id);
    }
    return this.get(id)!;
  }

  /** The latest run of each merge request that is open (or not checked yet), finished since `since`. */
  openMrs(since: string): AgentRun[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM runs r WHERE mr_url IS NOT NULL AND (mr_status IS NULL OR mr_status = 'opened') AND created_at >= ?
           AND NOT EXISTS (SELECT 1 FROM runs n WHERE n.mr_url = r.mr_url AND n.created_at > r.created_at)
         ORDER BY created_at`,
      )
      .all(since) as Row[];
    return rows.map(toRun);
  }

  /** The latest run that points at a merge request. */
  lastOfMr(url: string): AgentRun | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE mr_url = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(url) as Row | undefined;
    return row ? toRun(row) : null;
  }

  /** Pipelines of a merge request that already got a fix run (rotations of one fix count once). */
  ciFixedPipelines(mrUrl: string): number[] {
    const rows = this.db
      .prepare("SELECT DISTINCT json_extract(ci_fix, '$.pipelineId') AS p FROM runs WHERE json_extract(ci_fix, '$.mrUrl') = ?")
      .all(mrUrl) as Row[];
    return rows.map((r) => Number(r.p));
  }

  /** Saves what GitLab says about a merge request on every run that points at it. */
  updateMr(url: string, patch: Pick<AgentRun, "mrStatus" | "pipelineStatus" | "pipelineUrl" | "mrCheckedAt">): void {
    this.db
      .prepare("UPDATE runs SET mr_status = ?, pipeline_status = ?, pipeline_url = ?, mr_checked_at = ? WHERE mr_url = ?")
      .run(patch.mrStatus, patch.pipelineStatus, patch.pipelineUrl, patch.mrCheckedAt, url);
  }

  /** Every run of a best-of-n group (candidates, their new attempts and the judge), oldest first. */
  group(id: string): AgentRun[] {
    return (
      this.db.prepare("SELECT * FROM runs WHERE json_extract(best_of, '$.group') = ? ORDER BY created_at, rowid").all(id) as Row[]
    ).map(toRun);
  }

  /** Records the kept candidate on every run of the group. */
  setPick(group: string, pick: number, reason: string): void {
    this.db
      .prepare("UPDATE runs SET best_of = json_set(best_of, '$.pick', ?, '$.reason', ?) WHERE json_extract(best_of, '$.group') = ?")
      .run(pick, reason.slice(0, 500), group);
  }

  get(id: string): AgentRun | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Row | undefined;
    return row ? toRun(row) : null;
  }

  /** A project's runs, a system's (`projects`), or every one, the newest first. */
  list(filter: { project?: string; projects?: string[]; limit?: number; includeDiffSummaries?: boolean } = {}): AgentRun[] {
    // From the page: only strings go into the list.
    const projects = Array.isArray(filter.projects) ? JSON.stringify(filter.projects.map(String)) : null;
    return (
      this.db
        .prepare(
          `SELECT * FROM runs WHERE (?1 IS NULL OR project = ?1) AND (?3 IS NULL OR project IN (SELECT value FROM json_each(?3))) AND (?4 = 1 OR diff_summary_for IS NULL)
           ORDER BY created_at DESC, rowid DESC LIMIT ?2`,
        )
        .all(filter.project ?? null, filter.limit ?? 100, projects, filter.includeDiffSummaries === false ? 0 : 1) as Row[]
    ).map(toRun);
  }

  queued(): AgentRun[] {
    return (this.db.prepare("SELECT * FROM runs WHERE status = 'queued' ORDER BY created_at, rowid").all() as Row[]).map(toRun);
  }

  /** Queued and running runs, oldest first (what a heartbeat reports). */
  active(limit = 100): AgentRun[] {
    return (
      this.db.prepare("SELECT * FROM runs WHERE status IN ('queued', 'running') ORDER BY created_at, rowid LIMIT ?").all(limit) as Row[]
    ).map(toRun);
  }

  /** Finished runs with a cost the hub has not received yet, oldest first. */
  unreportedCosts(limit = 100): AgentRun[] {
    return (
      this.db
        // Runs with a price (Claude Code) or tokens only (Codex, roadmap 28c).
        .prepare("SELECT * FROM runs WHERE (cost_usd IS NOT NULL OR output_tokens IS NOT NULL) AND cost_reported = 0 AND finished_at IS NOT NULL ORDER BY finished_at, rowid LIMIT ?")
        .all(limit) as Row[]
    ).map(toRun);
  }

  markCostsReported(ids: string[]): void {
    const mark = this.db.prepare("UPDATE runs SET cost_reported = 1 WHERE id = ?");
    for (const id of ids) mark.run(id);
  }

  activeForTask(project: string, taskId: string): AgentRun | null {
    const row = this.db
      .prepare("SELECT * FROM runs WHERE project = ? AND task_id = ? AND status IN ('queued', 'running') LIMIT 1")
      .get(project, taskId) as Row | undefined;
    return row ? toRun(row) : null;
  }

  /** Runs of a task created after `since`. */
  newerRuns(project: string, taskId: string, since: string): AgentRun[] {
    return (
      this.db.prepare("SELECT * FROM runs WHERE project = ? AND task_id = ? AND created_at > ? AND diff_summary_for IS NULL ORDER BY created_at, rowid").all(project, taskId, since) as Row[]
    ).map(toRun);
  }

  /** Most recent succeeded run of a task with the given role. */
  lastSucceeded(project: string, taskId: string, role: AgentRole): AgentRun | null {
    const row = this.db
      .prepare(
        "SELECT * FROM runs WHERE project = ? AND task_id = ? AND role = ? AND status = 'succeeded' AND diff_summary_for IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1",
      )
      .get(project, taskId, role) as Row | undefined;
    return row ? toRun(row) : null;
  }

  /** Last run of a task that had a worktree, to reuse its base commit. */
  lastWithWorktree(project: string, taskId: string): AgentRun | null {
    const row = this.db
      .prepare("SELECT * FROM runs WHERE project = ? AND task_id = ? AND base_sha IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(project, taskId) as Row | undefined;
    return row ? toRun(row) : null;
  }

  running(profileId?: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM runs WHERE status = 'running' AND (?1 IS NULL OR profile_id = ?1)")
      .get(profileId ?? null) as Row;
    return Number(row.n);
  }

  /**
   * A profile's run counts since its counter was last reset (roadmap 52), or since its first run. Running and last
   * used stay over every run: the scheduler needs them whatever the person chose to count from.
   */
  profileStats(profileId: string) {
    const since = this.statsSince(profileId);
    // A run counts by when it ended: one that hit the limit right after the reset belongs to the new count.
    const counted = "(?2 IS NULL OR COALESCE(finished_at, started_at, created_at) >= ?2)";
    const rows = this.db
      .prepare(
        `SELECT status, COUNT(*) AS n, MAX(started_at) AS last, SUM(CASE WHEN ${counted} THEN 1 ELSE 0 END) AS counted,
           SUM(CASE WHEN ${counted} THEN cost_usd END) AS cost
         FROM runs WHERE profile_id = ?1 GROUP BY status`,
      )
      .all(profileId, since) as Row[];
    const row = (s: RunStatus) => rows.find((r) => r.status === s);
    const by = (s: RunStatus) => Number(row(s)?.counted ?? 0);
    const last = rows.map((r) => (r.last == null ? "" : String(r.last))).sort().at(-1) || null;
    return {
      running: Number(row("running")?.n ?? 0),
      lastUsedAt: last,
      stats: {
        runs: rows.reduce((n, r) => n + Number(r.counted ?? 0), 0),
        succeeded: by("succeeded"),
        failed: by("failed"),
        rateLimited: by("rate_limited"),
        costUsd: rows.reduce((n, r) => n + Number(r.cost ?? 0), 0),
        since,
      },
    };
  }

  /** When the profile's counter was last reset; null: it counts every run. */
  statsSince(profileId: string): string | null {
    const row = this.db.prepare("SELECT since FROM profile_stats_since WHERE profile_id = ?").get(profileId) as Row | undefined;
    return row ? String(row.since) : null;
  }

  /** Counts the profile's runs from `since` on; the runs themselves stay. */
  resetStats(profileId: string, since: string): void {
    this.db
      .prepare("INSERT INTO profile_stats_since(profile_id, since) VALUES (?, ?) ON CONFLICT(profile_id) DO UPDATE SET since = excluded.since")
      .run(profileId, since);
  }

  /** The profile's last Dùng tiếp, kept after it ends so the card still says who asked. */
  resume(profileId: string): ProfileResume | null {
    const row = this.db.prepare("SELECT until, at, by FROM profile_resumes WHERE profile_id = ?").get(profileId) as Row | undefined;
    return row ? { until: String(row.until), at: String(row.at), by: String(row.by) } : null;
  }

  setResume(profileId: string, resume: ProfileResume): void {
    this.db
      .prepare("INSERT INTO profile_resumes(profile_id, until, at, by) VALUES (?, ?, ?, ?) ON CONFLICT(profile_id) DO UPDATE SET until = excluded.until, at = excluded.at, by = excluded.by")
      .run(profileId, resume.until, resume.at, resume.by.slice(0, 200));
  }

  /** A profile's runs that finished since `since`, with their tokens only (roadmap 46). */
  profileTokens(profileId: string, since: string): Array<RunTokens & { finishedAt: string }> {
    const rows = this.db
      .prepare(
        `SELECT finished_at, input_tokens, cache_write_tokens, cache_read_tokens, output_tokens FROM runs
         WHERE profile_id = ? AND finished_at >= ?`,
      )
      .all(profileId, since) as Row[];
    const n = (v: unknown) => (v == null ? null : Number(v));
    return rows.map((r) => ({
      finishedAt: String(r.finished_at),
      inputTokens: n(r.input_tokens),
      cacheWriteTokens: n(r.cache_write_tokens),
      cacheReadTokens: n(r.cache_read_tokens),
      outputTokens: n(r.output_tokens),
    }));
  }

  cooldown(profileId: string): { until: string; reason: string } | null {
    const row = this.db.prepare("SELECT until, reason FROM profile_cooldowns WHERE profile_id = ?").get(profileId) as Row | undefined;
    return row ? { until: String(row.until), reason: String(row.reason) } : null;
  }

  setCooldown(profileId: string, until: string, reason: string): void {
    this.db
      .prepare(
        `INSERT INTO profile_cooldowns(profile_id, until, reason) VALUES (?, ?, ?)
         ON CONFLICT(profile_id) DO UPDATE SET until = excluded.until, reason = excluded.reason`,
      )
      .run(profileId, until, reason.slice(0, 300));
  }

  clearCooldown(profileId: string): void {
    this.db.prepare("DELETE FROM profile_cooldowns WHERE profile_id = ?").run(profileId);
  }

  /** Runs left `running` by a previous app session (crash / force quit). */
  failInterrupted(now: string): number {
    const res = this.db
      .prepare("UPDATE runs SET status = 'failed', error = ?, finished_at = ? WHERE status = 'running'")
      .run(tr("runNote.appClosed"), now);
    return Number(res.changes);
  }
}
