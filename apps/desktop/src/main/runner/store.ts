// Local run history and per-profile cooldowns. Lives on the machine that runs the agents.
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentKind, AgentRole, AgentRun, MrState, RunStatus } from "@xdev-hive/core";
import { tr } from "../i18n.ts";

const SCHEMA = `
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
`;

/** Columns added after the first release; created on open when missing. */
const ADDED_COLUMNS: Array<[name: string, ddl: string]> = [
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
];

type Row = Record<string, unknown>;
const JSON_FIELDS = new Set(["avoidKinds", "excludedProfiles"]);
const BOOL_FIELDS = new Set(["reviewAfter", "mrDraft"]);
const column = (field: string) => field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

function toRun(r: Row): AgentRun {
  const s = (v: unknown) => (v == null ? null : String(v));
  return {
    id: String(r.id),
    project: String(r.project),
    taskId: String(r.task_id),
    taskTitle: String(r.task_title),
    role: r.role as AgentRole,
    status: r.status as RunStatus,
    profileId: s(r.profile_id),
    preferredProfile: s(r.preferred_profile),
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
    createdAt: String(r.created_at),
    startedAt: s(r.started_at),
    finishedAt: s(r.finished_at),
    mrUrl: s(r.mr_url),
    mrIid: r.mr_iid == null ? null : Number(r.mr_iid),
    costUsd: r.cost_usd == null ? null : Number(r.cost_usd),
    inputTokens: r.input_tokens == null ? null : Number(r.input_tokens),
    outputTokens: r.output_tokens == null ? null : Number(r.output_tokens),
    mrState: s(r.mr_state) as MrState | null,
    mrDraft: Number(r.mr_draft) === 1,
    mrNote: s(r.mr_note),
  };
}

const encode = (field: string, value: unknown) =>
  JSON_FIELDS.has(field) ? JSON.stringify(value) : BOOL_FIELDS.has(field) ? (value ? 1 : 0) : (value ?? null);

export type NewRun = Pick<AgentRun, "project" | "taskId" | "taskTitle" | "role" | "attempt" | "maxAttempts"> &
  Partial<Pick<AgentRun, "preferredProfile" | "avoidKinds" | "excludedProfiles" | "parentRunId" | "worktree" | "branch" | "baseSha" | "instructions" | "reviewAfter">>;

export const ACTIVE: RunStatus[] = ["queued", "running"];

export class RunStore {
  readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
    const have = new Set((this.db.prepare("PRAGMA table_info(runs)").all() as Row[]).map((c) => String(c.name)));
    for (const [name, ddl] of ADDED_COLUMNS) if (!have.has(name)) this.db.exec(`ALTER TABLE runs ADD COLUMN ${name} ${ddl}`);
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

  get(id: string): AgentRun | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Row | undefined;
    return row ? toRun(row) : null;
  }

  list(filter: { project?: string; limit?: number } = {}): AgentRun[] {
    return (
      this.db
        .prepare("SELECT * FROM runs WHERE (?1 IS NULL OR project = ?1) ORDER BY created_at DESC, rowid DESC LIMIT ?2")
        .all(filter.project ?? null, filter.limit ?? 100) as Row[]
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
        .prepare("SELECT * FROM runs WHERE cost_usd IS NOT NULL AND cost_reported = 0 AND finished_at IS NOT NULL ORDER BY finished_at, rowid LIMIT ?")
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

  /** Most recent succeeded run of a task with the given role. */
  lastSucceeded(project: string, taskId: string, role: AgentRole): AgentRun | null {
    const row = this.db
      .prepare(
        "SELECT * FROM runs WHERE project = ? AND task_id = ? AND role = ? AND status = 'succeeded' ORDER BY created_at DESC, rowid DESC LIMIT 1",
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

  profileStats(profileId: string) {
    const rows = this.db
      .prepare("SELECT status, COUNT(*) AS n, MAX(started_at) AS last, SUM(cost_usd) AS cost FROM runs WHERE profile_id = ? GROUP BY status")
      .all(profileId) as Row[];
    const by = (s: RunStatus) => Number(rows.find((r) => r.status === s)?.n ?? 0);
    const last = rows.map((r) => (r.last == null ? "" : String(r.last))).sort().at(-1) || null;
    return {
      running: by("running"),
      lastUsedAt: last,
      stats: {
        runs: rows.reduce((n, r) => n + Number(r.n), 0),
        succeeded: by("succeeded"),
        failed: by("failed"),
        rateLimited: by("rate_limited"),
        costUsd: rows.reduce((n, r) => n + Number(r.cost ?? 0), 0),
      },
    };
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
