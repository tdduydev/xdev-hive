import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { can, levelOn, type Level } from "./access.ts";
import { HiveError, type ErrorText } from "./errors.ts";
import { parseDocKey, titleFromSlug } from "./keys.ts";
import { EMPTY_POLICY } from "./policy.ts";
import {
  authorize,
  parseInput,
  type HiveBackend,
  type Method,
  type MethodInput,
  type MethodOutput,
  type ParsedInput,
} from "./methods.ts";
import { assertNoHidden } from "./hidden.ts";
import { assertNoSecret } from "./secrets.ts";
import { parseSource, type WriteSource } from "./source.ts";
import { SEED_DOCS } from "./seed.ts";
import type {
  Actor,
  AuditEntry,
  CommandStatus,
  CostTotals,
  Doc,
  DocSummary,
  DocVersion,
  Machine,
  MachineCommand,
  MachineDetail,
  MachineRun,
  Memory,
  Proposal,
  QuotaCooldown,
  ReportedProfile,
  SetupReport,
  Task,
  TeamPolicy,
} from "./types.ts";

const MIGRATIONS: string[] = [
  `
  CREATE TABLE docs(
    key TEXT PRIMARY KEY, scope TEXT NOT NULL, project TEXT, title TEXT NOT NULL,
    content TEXT NOT NULL, version INTEGER NOT NULL, include_in_agents INTEGER NOT NULL DEFAULT 0,
    updated_by TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE INDEX docs_project ON docs(project);
  CREATE TABLE doc_versions(
    key TEXT NOT NULL, version INTEGER NOT NULL, content TEXT NOT NULL, author TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, PRIMARY KEY(key, version));
  CREATE TABLE proposals(
    id INTEGER PRIMARY KEY, doc_key TEXT NOT NULL, base_version INTEGER NOT NULL, content TEXT NOT NULL,
    reason TEXT NOT NULL, author TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    reviewer TEXT, review_note TEXT, decided_at TEXT, created_at TEXT NOT NULL);
  CREATE INDEX proposals_status ON proposals(status);
  CREATE TABLE memory(
    id INTEGER PRIMARY KEY, project TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL,
    author TEXT NOT NULL, task_id TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE INDEX memory_project ON memory(project, status);
  CREATE VIRTUAL TABLE memory_fts USING fts5(
    content, content='memory', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
  CREATE TRIGGER memory_ai AFTER INSERT ON memory BEGIN
    INSERT INTO memory_fts(rowid, content) VALUES (new.id, new.content);
  END;
  CREATE TRIGGER memory_ad AFTER DELETE ON memory BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, content) VALUES ('delete', old.id, old.content);
  END;
  CREATE TRIGGER memory_au AFTER UPDATE OF content ON memory BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, content) VALUES ('delete', old.id, old.content);
    INSERT INTO memory_fts(rowid, content) VALUES (new.id, new.content);
  END;
  CREATE TABLE tasks(
    id TEXT PRIMARY KEY, project TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'todo',
    owner TEXT, lease_until TEXT, note TEXT, updated_at TEXT NOT NULL);
  CREATE INDEX tasks_project ON tasks(project, status);
  `,
  `
  CREATE TABLE machines(
    id TEXT PRIMARY KEY, machine TEXT NOT NULL, instance TEXT NOT NULL, prev_instance TEXT,
    version TEXT NOT NULL DEFAULT '', runs TEXT NOT NULL DEFAULT '[]', last_seen TEXT NOT NULL, duplicate_at TEXT);
  CREATE TABLE quota_cooldowns(
    account TEXT PRIMARY KEY, until TEXT NOT NULL, reason TEXT NOT NULL,
    reported_by TEXT NOT NULL, updated_at TEXT NOT NULL);
  `,
  `
  ALTER TABLE machines ADD COLUMN setup TEXT;
  ALTER TABLE machines ADD COLUMN setup_at TEXT;
  ALTER TABLE machines ADD COLUMN profiles TEXT NOT NULL DEFAULT '[]';
  CREATE TABLE machine_commands(
    id INTEGER PRIMARY KEY, machine_id TEXT NOT NULL, item_id TEXT NOT NULL, label TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', requested_by TEXT NOT NULL, requested_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, output TEXT);
  CREATE INDEX machine_commands_machine ON machine_commands(machine_id, status);
  CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE audit(
    id INTEGER PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL,
    target TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '');
  CREATE INDEX audit_at ON audit(at);
  `,
  `
  ALTER TABLE audit ADD COLUMN detail_key TEXT;
  ALTER TABLE audit ADD COLUMN detail_vars TEXT;
  `,
  `
  ALTER TABLE doc_versions ADD COLUMN source TEXT;
  ALTER TABLE proposals ADD COLUMN source TEXT;
  ALTER TABLE memory ADD COLUMN source TEXT;
  `,
  `
  CREATE TABLE run_costs(
    machine_id TEXT NOT NULL, run_id TEXT NOT NULL, machine TEXT NOT NULL, project TEXT NOT NULL, task_id TEXT NOT NULL,
    profile_id TEXT NOT NULL, account TEXT, cost_usd REAL NOT NULL, input_tokens INTEGER, output_tokens INTEGER,
    finished_at TEXT NOT NULL, PRIMARY KEY(machine_id, run_id));
  CREATE INDEX run_costs_at ON run_costs(finished_at);
  `,
  `
  ALTER TABLE memory ADD COLUMN last_used_at TEXT;
  ALTER TABLE memory ADD COLUMN use_count INTEGER NOT NULL DEFAULT 0;
  `,
];

/** Run costs older than this are dropped; the summary only looks back 30 days. */
const COST_DAYS = 90;

/** A machine is online if it sent a heartbeat this recently (runners send one every 30 s). */
const ONLINE_MINUTES = 2;
/** Instances seen alternating within this window count as two apps under one machine name. */
const DUPLICATE_MINUTES = 5;
/** Machines silent for this long are dropped. */
const MACHINE_TTL_DAYS = 14;
/** A command nobody approved on the machine within this time is dropped. */
const COMMAND_TTL_HOURS = 24;
/** Commands kept per machine in the admin view. */
const COMMAND_HISTORY = 20;

/** Allowed status moves for a machine reporting on a command. */
const COMMAND_MOVES: Record<CommandStatus, CommandStatus[]> = {
  pending: ["running", "rejected", "done", "failed"],
  running: ["done", "failed"],
  done: [],
  failed: [],
  rejected: [],
  cancelled: [],
  expired: [],
};

const clipDetail = (s: string) => (s.length > 300 ? `${s.slice(0, 299)}…` : s);

/**
 * Admin actions written to the audit log: method → what it acted on. Reads are never logged.
 * `text` is the detail as a message key of the UI catalogue, so the log reads in each admin's language.
 */
const AUDITED: Partial<Record<Method, (input: any, output: any) => { target: string; detail?: string; text?: ErrorText }>> = {
  "docs.save": (i, o) => ({ target: i.key, detail: `v${o.version}${i.note ? ` · ${i.note}` : ""}` }),
  "proposals.approve": (i, o) => ({ target: o.docKey, detail: `đề xuất #${i.id}`, text: { key: "audit.proposal", vars: { id: i.id } } }),
  "proposals.reject": (i, o) => {
    const text: ErrorText = i.note ? { key: "audit.proposalNote", vars: { id: i.id, note: i.note } } : { key: "audit.proposal", vars: { id: i.id } };
    return { target: o.docKey, detail: `đề xuất #${i.id}${i.note ? ` · ${i.note}` : ""}`, text };
  },
  "memory.approve": (i, o) => ({ target: `${o.project ?? "org"} #${i.id}` }),
  "memory.remove": (i) => ({ target: `memory #${i.id}` }),
  "tasks.create": (i) => ({ target: i.id, detail: i.title }),
  "machines.remove": (i) => ({ target: i.id }),
  "cooldowns.clear": (i) => ({ target: i.account }),
  "policy.set": (_i, o: TeamPolicy) => ({
    target: "policy",
    detail: `CLI: ${o.requiredClis.join(", ") || "—"} · shim: ${o.requireShim ? "có" : "không"} · ${Object.keys(o.projects).length} dự án · ${o.profileTemplates.length} mẫu profile`,
    text: {
      key: o.requireShim ? "audit.policyShim" : "audit.policy",
      vars: { clis: o.requiredClis.join(", ") || "—", projects: Object.keys(o.projects).length, templates: o.profileTemplates.length },
    },
  }),
  "admin.commandCreate": (i, o: MachineCommand) => ({
    target: i.machineId,
    detail: `yêu cầu ${o.label} (${i.itemId}, #${o.id})`,
    text: { key: "audit.commandCreate", vars: { label: o.label, item: i.itemId, id: o.id } },
  }),
  "admin.commandCancel": (i, o: MachineCommand) => ({
    target: o.machineId,
    detail: `huỷ #${i.id} ${o.itemId}`,
    text: { key: "audit.commandCancel", vars: { id: i.id, item: o.itemId } },
  }),
  "machines.commandResult": (i, o: MachineCommand) => ({ target: o.machineId, detail: `#${i.id} ${o.itemId} → ${i.status}` }),
};

type Row = Record<string, unknown>;
const str = (v: unknown) => v as string;
const strOrNull = (v: unknown) => (v == null ? null : String(v));
const num = (v: unknown) => Number(v);
const sourceOf = (v: unknown): WriteSource | null => (v ? parseSource(JSON.parse(str(v))) : null);
const sourceJson = (s: WriteSource | null | undefined) => (s ? JSON.stringify(s) : null);

const toSummary = (r: Row): DocSummary => ({
  key: str(r.key),
  scope: str(r.scope) as DocSummary["scope"],
  project: strOrNull(r.project),
  title: str(r.title),
  version: num(r.version),
  includeInAgents: num(r.include_in_agents) === 1,
  updatedBy: str(r.updated_by),
  updatedAt: str(r.updated_at),
});
const toDoc = (r: Row): Doc => ({ ...toSummary(r), content: str(r.content) });
const toVersion = (r: Row): DocVersion => ({
  key: str(r.key),
  version: num(r.version),
  content: str(r.content),
  author: str(r.author),
  note: str(r.note),
  source: sourceOf(r.source),
  createdAt: str(r.created_at),
});
const toProposal = (r: Row): Proposal => ({
  id: num(r.id),
  docKey: str(r.doc_key),
  baseVersion: num(r.base_version),
  content: str(r.content),
  reason: str(r.reason),
  author: str(r.author),
  status: str(r.status) as Proposal["status"],
  reviewer: strOrNull(r.reviewer),
  reviewNote: strOrNull(r.review_note),
  decidedAt: strOrNull(r.decided_at),
  source: sourceOf(r.source),
  createdAt: str(r.created_at),
});
/** Shared (team-wide) memory is stored with an empty project: no project key can be empty. */
const SHARED = "";
/** staleBefore: entries neither used nor written since then are stale; null turns staleness off. */
const toMemory = (r: Row, staleBefore: string | null): Memory => ({
  id: num(r.id),
  project: str(r.project) === SHARED ? null : str(r.project),
  kind: str(r.kind) as Memory["kind"],
  content: str(r.content),
  author: str(r.author),
  taskId: strOrNull(r.task_id),
  status: str(r.status) as Memory["status"],
  source: sourceOf(r.source),
  createdAt: str(r.created_at),
  lastUsedAt: strOrNull(r.last_used_at),
  useCount: num(r.use_count ?? 0),
  stale: staleBefore !== null && (strOrNull(r.last_used_at) ?? str(r.created_at)) < staleBefore,
});
const toTask = (r: Row): Task => ({
  id: str(r.id),
  project: str(r.project),
  title: str(r.title),
  status: str(r.status) as Task["status"],
  owner: strOrNull(r.owner),
  leaseUntil: strOrNull(r.lease_until),
  note: strOrNull(r.note),
  updatedAt: str(r.updated_at),
});
const toCooldown = (r: Row): QuotaCooldown => ({
  account: str(r.account),
  until: str(r.until),
  reason: str(r.reason),
  reportedBy: str(r.reported_by),
  updatedAt: str(r.updated_at),
});
const toCommand = (r: Row): MachineCommand => ({
  id: num(r.id),
  machineId: str(r.machine_id),
  itemId: str(r.item_id),
  label: str(r.label),
  status: str(r.status) as CommandStatus,
  requestedBy: str(r.requested_by),
  requestedAt: str(r.requested_at),
  updatedAt: str(r.updated_at),
  output: strOrNull(r.output),
});
const toAudit = (r: Row): AuditEntry => ({
  id: num(r.id),
  at: str(r.at),
  actor: str(r.actor),
  action: str(r.action),
  target: str(r.target),
  detail: str(r.detail),
  ...(r.detail_key ? { detailKey: str(r.detail_key), detailVars: r.detail_vars ? (JSON.parse(str(r.detail_vars)) as AuditEntry["detailVars"]) : undefined } : {}),
});

/** FTS5 query from free text: every word becomes a quoted prefix term, OR-ed together. */
function ftsQuery(text: string): string | null {
  const words = text.match(/[\p{L}\p{N}_]+/gu);
  if (!words?.length) return null;
  return words.map((w) => `"${w}"*`).join(" OR ");
}

export interface SqliteHiveOptions {
  /** When true, memory written by non-admins stays `pending` (hidden from search) until an admin approves it. */
  memoryRequiresApproval?: boolean;
  /** Memory no agent searched up (nor anyone wrote or kept) for this many days is stale. 0: never. Default 90. */
  memoryStaleDays?: number;
  /** Injectable clock for tests. */
  now?: () => Date;
}

type Handlers = { [M in Method]: (input: ParsedInput<M>, actor: Actor) => MethodOutput[M] };

export class SqliteHive implements HiveBackend {
  readonly db: DatabaseSync;
  readonly #opts: Required<SqliteHiveOptions>;
  readonly #handlers: Handlers;

  constructor(dbOrPath: DatabaseSync | string, opts: SqliteHiveOptions = {}) {
    if (typeof dbOrPath === "string" && dbOrPath !== ":memory:") {
      mkdirSync(path.dirname(dbOrPath), { recursive: true });
    }
    this.db = typeof dbOrPath === "string" ? new DatabaseSync(dbOrPath) : dbOrPath;
    this.#opts = { memoryRequiresApproval: false, memoryStaleDays: 90, now: () => new Date(), ...opts };
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    this.#migrate();
    this.#handlers = this.#buildHandlers();
  }

  async call<M extends Method>(method: M, input: MethodInput<M>, actor: Actor): Promise<MethodOutput[M]> {
    authorize(method, actor);
    const parsed = parseInput(method, input);
    const handler = this.#handlers[method] as (i: ParsedInput<M>, a: Actor) => MethodOutput[M];
    this.#check(method, parsed as ParsedInput<Method>, actor);
    const output = this.#filter(method, handler(parsed, actor), actor);
    const audited = AUDITED[method];
    if (audited) {
      const { target, detail, text } = audited(parsed, output);
      this.audit(actor, method, target, detail, text);
    }
    return output;
  }

  // ── per-project access (access.ts) ─────────────────────────────────────────

  /** Owner project of a doc key: null for org/* (shared). */
  static #docOwner(key: string): string | null {
    return parseDocKey(key).project;
  }

  /**
   * Refuses a call on something the actor may not touch. Invisible projects answer not_found, so an
   * account cannot learn what exists in projects it was not given; visible but too low a level is forbidden.
   */
  #need(actor: Actor, owner: string | null, level: Level, what: string): void {
    if (can(actor, owner, level)) return;
    if (levelOn(actor, owner) === null) throw new HiveError("not_found", `${what} not found.`, { key: "errors.notFound" });
    const where = owner === null ? "the shared (team-wide) data" : `project ${owner}`;
    throw new HiveError("forbidden", `${what}: needs "${level}" on ${where}.`, {
      key: owner === null ? `errors.needShared.${level}` : `errors.need.${level}`,
      vars: { project: owner ?? "" },
    });
  }

  #check(method: Method, input: ParsedInput<Method>, actor: Actor): void {
    const i = input as Record<string, any>;
    const owner = SqliteHive.#docOwner;
    switch (method) {
      case "docs.get":
      case "docs.history":
        return this.#need(actor, owner(i.key), "view", `Doc ${i.key}`);
      case "docs.save":
        return this.#need(actor, owner(i.key), "manage", `Doc ${i.key}`);
      case "proposals.create":
        return this.#need(actor, owner(i.docKey), "contribute", `Doc ${i.docKey}`);
      case "proposals.approve":
      case "proposals.reject": {
        const row = this.db.prepare("SELECT doc_key FROM proposals WHERE id = ?").get(i.id) as Row | undefined;
        if (row) this.#need(actor, owner(str(row.doc_key)), "manage", `Proposal #${i.id}`);
        return;
      }
      case "memory.search":
        if (i.project) this.#need(actor, i.project, "view", `Project ${i.project}`);
        return;
      case "memory.write":
        return this.#need(actor, i.shared ? null : i.project, "contribute", i.shared ? "Shared memory" : `Project ${i.project}`);
      case "memory.approve":
      case "memory.keep":
      case "memory.remove": {
        const row = this.db.prepare("SELECT project FROM memory WHERE id = ?").get(i.id) as Row | undefined;
        if (row) this.#need(actor, str(row.project) === SHARED ? null : str(row.project), "manage", `Memory #${i.id}`);
        return;
      }
      case "tasks.create":
        return this.#need(actor, i.project, "manage", `Project ${i.project}`);
      case "tasks.claim":
      case "tasks.update": {
        const task = this.#getTask(i.id);
        if (task) this.#need(actor, task.project, "contribute", `Task ${i.id}`);
        return;
      }
      default:
        return;
    }
  }

  /** Lists only show what the actor can see (shared items are visible to every account). */
  #filter<M extends Method>(method: M, output: MethodOutput[M], actor: Actor): MethodOutput[M] {
    if (!actor.access) return output;
    const sees = (owner: string | null) => levelOn(actor, owner) !== null;
    const out = output as unknown;
    switch (method as Method) {
      case "docs.list":
        return (out as DocSummary[]).filter((d) => sees(d.project)) as MethodOutput[M];
      case "proposals.list":
        return (out as Proposal[]).filter((p) => sees(SqliteHive.#docOwner(p.docKey))) as MethodOutput[M];
      case "memory.search":
      case "memory.list":
        return (out as Memory[]).filter((m) => sees(m.project)) as MethodOutput[M];
      case "tasks.list":
        return (out as Task[]).filter((t) => sees(t.project)) as MethodOutput[M];
      // Machines are the team's, but what they are running shows the project: hide runs of hidden projects.
      case "machines.list":
        return (out as Machine[]).map((m) => ({ ...m, runs: m.runs.filter((r) => sees(r.project)) })) as MethodOutput[M];
      case "policy.get": {
        const policy = out as TeamPolicy;
        return { ...policy, projects: Object.fromEntries(Object.entries(policy.projects).filter(([p]) => sees(p))) } as MethodOutput[M];
      }
      default:
        return output;
    }
  }

  /** Records an admin action (also used by the hub for token changes, which live outside the method table). */
  audit(actor: Actor, action: string, target: string, detail = "", text?: ErrorText): void {
    this.db
      .prepare("INSERT INTO audit(at, actor, action, target, detail, detail_key, detail_vars) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(this.#now(), actor.name, action, target, clipDetail(detail), text?.key ?? null, text?.vars ? JSON.stringify(text.vars) : null);
  }

  /** Creates the default org docs on an empty database. Safe to call on every start. */
  seed(author = "xdev-hive"): void {
    const count = num((this.db.prepare("SELECT COUNT(*) AS n FROM docs").get() as Row).n);
    if (count > 0) return;
    this.#tx(() => {
      for (const d of SEED_DOCS) {
        this.#writeDoc(d.key, d.content, { title: d.title, includeInAgents: d.includeInAgents, note: "Seed" }, author);
      }
    });
  }

  close(): void {
    this.db.close();
  }

  #now(offsetMinutes = 0): string {
    return new Date(this.#opts.now().getTime() + offsetMinutes * 60_000).toISOString();
  }

  #migrate(): void {
    const current = num((this.db.prepare("PRAGMA user_version").get() as Row).user_version);
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.#tx(() => {
        this.db.exec(MIGRATIONS[v]!);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  #tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  #getDoc(key: string): Doc | null {
    const row = this.db.prepare("SELECT * FROM docs WHERE key = ?").get(key) as Row | undefined;
    return row ? toDoc(row) : null;
  }

  #writeDoc(
    key: string,
    content: string,
    meta: { title?: string; includeInAgents?: boolean; note?: string },
    author: string,
    source: WriteSource | null = null,
  ): Doc {
    const parsed = parseDocKey(key);
    assertNoSecret(content, "Document content");
    assertNoHidden(content, "Document content");
    if (meta.title) assertNoHidden(meta.title, "Title");
    if (meta.note) assertNoHidden(meta.note, "Note");
    const existing = this.#getDoc(key);
    const version = (existing?.version ?? 0) + 1;
    const now = this.#now();
    const title = meta.title ?? existing?.title ?? titleFromSlug(parsed.slug);
    const include = meta.includeInAgents ?? existing?.includeInAgents ?? parsed.scope === "org";
    this.db
      .prepare(
        `INSERT INTO docs(key, scope, project, title, content, version, include_in_agents, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET title = excluded.title, content = excluded.content,
           version = excluded.version, include_in_agents = excluded.include_in_agents,
           updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      )
      .run(key, parsed.scope, parsed.project, title, content, version, include ? 1 : 0, author, now);
    this.db
      .prepare("INSERT INTO doc_versions(key, version, content, author, note, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(key, version, content, author, meta.note ?? "", sourceJson(source), now);
    return this.#getDoc(key)!;
  }

  #getProposal(id: number): Proposal {
    const row = this.db.prepare("SELECT * FROM proposals WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new HiveError("not_found", `Proposal #${id} not found.`, { key: "errors.proposalNotFound", vars: { id } });
    return toProposal(row);
  }

  #getMemory(id: number): Memory {
    const row = this.db.prepare("SELECT * FROM memory WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new HiveError("not_found", `Memory #${id} not found.`, { key: "errors.memoryNotFound", vars: { id } });
    return toMemory(row, this.#staleBefore());
  }

  #staleBefore(): string | null {
    return this.#opts.memoryStaleDays > 0 ? this.#now(-this.#opts.memoryStaleDays * 24 * 60) : null;
  }

  #getTask(id: string): Task | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Row | undefined;
    return row ? toTask(row) : null;
  }

  /** Cooldowns still in force; expired ones are dropped on the way. */
  #cooldowns(): QuotaCooldown[] {
    const now = this.#now();
    this.db.prepare("DELETE FROM quota_cooldowns WHERE until <= ?").run(now);
    return (this.db.prepare("SELECT * FROM quota_cooldowns ORDER BY until").all() as Row[]).map(toCooldown);
  }

  #policy(): TeamPolicy {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'policy'").get() as Row | undefined;
    return row ? { ...EMPTY_POLICY, ...(JSON.parse(str(row.value)) as TeamPolicy) } : EMPTY_POLICY;
  }

  /** Pending commands nobody approved in time become expired. */
  #expireCommands(): void {
    this.db
      .prepare("UPDATE machine_commands SET status = 'expired', updated_at = ?1 WHERE status = 'pending' AND requested_at < ?2")
      .run(this.#now(), this.#now(-COMMAND_TTL_HOURS * 60));
  }

  #command(id: number): MachineCommand {
    const row = this.db.prepare("SELECT * FROM machine_commands WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new HiveError("not_found", `Command #${id} not found.`, { key: "errors.commandNotFound", vars: { id } });
    return toCommand(row);
  }

  #toMachine(r: Row): Machine {
    const dup = strOrNull(r.duplicate_at);
    return {
      id: str(r.id),
      machine: str(r.machine),
      version: str(r.version),
      lastSeen: str(r.last_seen),
      online: str(r.last_seen) > this.#now(-ONLINE_MINUTES),
      duplicate: dup !== null && dup > this.#now(-DUPLICATE_MINUTES),
      runs: JSON.parse(str(r.runs)) as MachineRun[],
      profiles: JSON.parse(str(r.profiles ?? "[]")) as ReportedProfile[],
    };
  }

  #buildHandlers(): Handlers {
    const db = this.db;
    return {
      "docs.list": ({ project, scope }) => {
        const rows = db
          .prepare(
            `SELECT key, scope, project, title, version, include_in_agents, updated_by, updated_at FROM docs
             WHERE (?1 IS NULL OR scope = ?1) AND (?2 IS NULL OR scope = 'org' OR project = ?2)
             ORDER BY scope, project, key`,
          )
          .all(scope ?? null, project ?? null) as Row[];
        return rows.map(toSummary);
      },

      "docs.get": ({ key }) => this.#getDoc(key),

      "docs.history": ({ key }) =>
        (db.prepare("SELECT * FROM doc_versions WHERE key = ? ORDER BY version DESC").all(key) as Row[]).map(toVersion),

      "docs.save": (input, actor) =>
        this.#tx(() => {
          const current = this.#getDoc(input.key)?.version ?? 0;
          if (input.baseVersion !== undefined && input.baseVersion !== current) {
            throw new HiveError(
              "conflict",
              `${input.key} is at v${current} but you edited v${input.baseVersion}. Reload and re-apply your changes.`,
              { key: "errors.docConflict", vars: { key: input.key, current, base: input.baseVersion } },
            );
          }
          return this.#writeDoc(input.key, input.content, input, actor.name, actor.source);
        }),

      "proposals.list": ({ status, docKey }) =>
        (
          db
            .prepare(
              `SELECT * FROM proposals WHERE (?1 IS NULL OR status = ?1) AND (?2 IS NULL OR doc_key = ?2)
               ORDER BY id DESC LIMIT 200`,
            )
            .all(status ?? null, docKey ?? null) as Row[]
        ).map(toProposal),

      "proposals.create": (input, actor) => {
        parseDocKey(input.docKey);
        assertNoSecret(input.content, "Proposed content");
        assertNoSecret(input.reason, "Reason");
        assertNoHidden(input.content, "Proposed content");
        assertNoHidden(input.reason, "Reason");
        const doc = this.#getDoc(input.docKey);
        const current = doc?.version ?? 0;
        if (input.baseVersion !== current) {
          throw new HiveError(
            "conflict",
            `${input.docKey} is at v${current}, you based your change on v${input.baseVersion}. Call doc_get again and re-propose.`,
            { key: "errors.proposalStale", vars: { key: input.docKey, current, base: input.baseVersion } },
          );
        }
        if (doc && doc.content === input.content) {
          throw new HiveError("bad_request", "Proposed content is identical to the current version.", { key: "errors.proposalSame" });
        }
        const res = db
          .prepare(
            `INSERT INTO proposals(doc_key, base_version, content, reason, author, source, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(input.docKey, input.baseVersion, input.content, input.reason, actor.name, sourceJson(actor.source), this.#now());
        return this.#getProposal(num(res.lastInsertRowid));
      },

      "proposals.approve": ({ id }, actor) =>
        this.#tx(() => {
          const p = this.#getProposal(id);
          if (p.status !== "pending") throw new HiveError("bad_request", `Proposal #${id} is already ${p.status}.`, { key: "errors.proposalDecided", vars: { id } });
          const current = this.#getDoc(p.docKey)?.version ?? 0;
          const decide = (status: Proposal["status"], note: string | null) =>
            db
              .prepare("UPDATE proposals SET status = ?, reviewer = ?, review_note = ?, decided_at = ? WHERE id = ?")
              .run(status, actor.name, note, this.#now(), id);
          if (current !== p.baseVersion) {
            decide("conflict", `Doc moved from v${p.baseVersion} to v${current} before approval.`);
          } else {
            // The version keeps where the proposed text came from; the audit log has who approved it.
            this.#writeDoc(p.docKey, p.content, { note: `#${id}: ${p.reason}` }, `${p.author} (approved by ${actor.name})`, p.source);
            decide("approved", null);
          }
          return this.#getProposal(id);
        }),

      "proposals.reject": ({ id, note }, actor) => {
        const p = this.#getProposal(id);
        if (p.status !== "pending") throw new HiveError("bad_request", `Proposal #${id} is already ${p.status}.`, { key: "errors.proposalDecided", vars: { id } });
        db.prepare("UPDATE proposals SET status = 'rejected', reviewer = ?, review_note = ?, decided_at = ? WHERE id = ?").run(
          actor.name,
          note ?? null,
          this.#now(),
          id,
        );
        return this.#getProposal(id);
      },

      "memory.search": ({ project, query, limit, includeShared, anyProject, includeStale }, actor) => {
        const match = ftsQuery(query);
        // ?2 = the project (or shared when none), ?3 = also shared entries, ?5 = every project, ?6 = the stale cutoff ('' keeps all).
        const scope = `(?5 = 1 OR m.project = ?2 OR (?3 = 1 AND m.project = '')) AND COALESCE(m.last_used_at, m.created_at) >= ?6`;
        const own = project ?? SHARED;
        const shared = includeShared ? 1 : 0;
        const staleBefore = this.#staleBefore();
        const cutoff = includeStale || staleBefore === null ? "" : staleBefore;
        const rows = (
          match
            ? db
                .prepare(
                  `SELECT m.* FROM memory_fts f JOIN memory m ON m.id = f.rowid
                   WHERE memory_fts MATCH ?1 AND ${scope} AND m.status = 'approved'
                   ORDER BY bm25(memory_fts) LIMIT ?4`,
                )
                .all(match, own, shared, limit, anyProject ? 1 : 0, cutoff)
            : db
                .prepare(`SELECT m.* FROM memory m WHERE ${scope} AND m.status = 'approved' ORDER BY m.id DESC LIMIT ?4`)
                .all(null, own, shared, limit, anyProject ? 1 : 0, cutoff)
        ) as Row[];
        // What an agent was given counts as used; people browsing the page do not.
        if (actor.role === "agent" && rows.length) {
          const now = this.#now();
          const touch = db.prepare("UPDATE memory SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?");
          for (const r of rows) {
            touch.run(now, num(r.id));
            r.last_used_at = now;
            r.use_count = num(r.use_count ?? 0) + 1;
          }
        }
        return rows.map((r) => toMemory(r, staleBefore));
      },

      "memory.list": ({ project, includeShared, status, stale, limit }) => {
        const staleBefore = this.#staleBefore();
        // ?5: only entries older than this cutoff ('' matches nothing, so staleness off lists none).
        const onlyStale = stale ? (staleBefore ?? "") : null;
        return (
          db
            .prepare(
              `SELECT * FROM memory
               WHERE (?1 IS NULL OR project = ?1 OR (?2 = 1 AND project = '')) AND (?3 IS NULL OR status = ?3)
                 AND (?5 IS NULL OR COALESCE(last_used_at, created_at) < ?5)
               ORDER BY id DESC LIMIT ?4`,
            )
            .all(project === undefined ? null : (project ?? SHARED), includeShared ? 1 : 0, status ?? null, limit, onlyStale) as Row[]
        ).map((r) => toMemory(r, staleBefore));
      },

      "memory.write": (input, actor) => {
        assertNoSecret(input.content, "Memory content");
        assertNoHidden(input.content, "Memory content");
        const owner = input.shared ? null : input.project!;
        const status = this.#opts.memoryRequiresApproval && !can(actor, owner, "manage") ? "pending" : "approved";
        const res = db
          .prepare(
            "INSERT INTO memory(project, kind, content, author, task_id, status, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            input.shared ? SHARED : input.project!,
            input.kind,
            input.content,
            actor.name,
            input.taskId ?? actor.source?.task ?? null,
            status,
            sourceJson(actor.source),
            this.#now(),
          );
        return this.#getMemory(num(res.lastInsertRowid));
      },

      "memory.approve": ({ id }) => {
        this.#getMemory(id);
        db.prepare("UPDATE memory SET status = 'approved' WHERE id = ?").run(id);
        return this.#getMemory(id);
      },

      "memory.keep": ({ id }) => {
        this.#getMemory(id);
        db.prepare("UPDATE memory SET last_used_at = ? WHERE id = ?").run(this.#now(), id);
        return this.#getMemory(id);
      },

      "memory.remove": ({ id }) => ({ removed: num(db.prepare("DELETE FROM memory WHERE id = ?").run(id).changes) === 1 }),

      "tasks.list": ({ project, status }) =>
        (
          db
            .prepare(
              `SELECT * FROM tasks WHERE (?1 IS NULL OR project = ?1) AND (?2 IS NULL OR status = ?2)
               ORDER BY updated_at DESC LIMIT 500`,
            )
            .all(project ?? null, status ?? null) as Row[]
        ).map(toTask),

      "tasks.create": (input) => {
        if (this.#getTask(input.id)) throw new HiveError("conflict", `Task ${input.id} already exists.`, { key: "errors.taskExists", vars: { id: input.id } });
        db.prepare("INSERT INTO tasks(id, project, title, updated_at) VALUES (?, ?, ?, ?)").run(
          input.id,
          input.project,
          input.title,
          this.#now(),
        );
        return this.#getTask(input.id)!;
      },

      "tasks.claim": ({ id, leaseMinutes }, actor) => {
        if (!this.#getTask(id)) throw new HiveError("not_found", `Task ${id} not found.`, { key: "errors.taskNotFound", vars: { id } });
        const now = this.#now();
        const res = db
          .prepare(
            `UPDATE tasks SET owner = ?1, status = 'doing', lease_until = ?2, updated_at = ?3
             WHERE id = ?4 AND status != 'done'
               AND (owner IS NULL OR owner = ?1 OR lease_until IS NULL OR lease_until < ?3)`,
          )
          .run(actor.name, this.#now(leaseMinutes), now, id);
        return { claimed: num(res.changes) === 1, task: this.#getTask(id) };
      },

      "tasks.update": ({ id, status, note }, actor) =>
        this.#tx(() => {
          const task = this.#getTask(id);
          if (!task) throw new HiveError("not_found", `Task ${id} not found.`, { key: "errors.taskNotFound", vars: { id } });
          const now = this.#now();
          const heldByOther =
            task.owner !== null && task.owner !== actor.name && task.leaseUntil !== null && task.leaseUntil > now;
          if (heldByOther && actor.role !== "admin") {
            throw new HiveError("forbidden", `Task ${id} is held by ${task.owner} until ${task.leaseUntil}.`, {
              key: "errors.taskHeld",
              vars: { id, owner: task.owner ?? "", until: task.leaseUntil ?? "" },
            });
          }
          const doing = status === "doing";
          db.prepare(
            "UPDATE tasks SET status = ?, owner = ?, lease_until = ?, note = COALESCE(?, note), updated_at = ? WHERE id = ?",
          ).run(
            status,
            doing ? actor.name : null,
            doing ? (task.owner === actor.name ? task.leaseUntil : this.#now(120)) : null,
            note ?? null,
            now,
            id,
          );
          return this.#getTask(id)!;
        }),

      // Keyed by the hub actor (`runner.<machine>@<token>`): the same key as the leases that machine takes.
      "machines.heartbeat": ({ machine, instance, version, runs, setup, profiles, costs }, actor) =>
        this.#tx(() => {
          const now = this.#now();
          const row = db.prepare("SELECT instance, prev_instance, last_seen, duplicate_at FROM machines WHERE id = ?").get(actor.name) as
            | Row
            | undefined;
          let prev = strOrNull(row?.prev_instance);
          let duplicateAt = strOrNull(row?.duplicate_at);
          if (row && str(row.instance) !== instance) {
            // A restart switches instance once; two live apps keep alternating (A, B, A…).
            if (prev === instance && str(row.last_seen) > this.#now(-DUPLICATE_MINUTES)) duplicateAt = now;
            prev = str(row.instance);
          }
          db.prepare(
            `INSERT INTO machines(id, machine, instance, prev_instance, version, runs, last_seen, duplicate_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET machine = excluded.machine, instance = excluded.instance,
               prev_instance = excluded.prev_instance, version = excluded.version, runs = excluded.runs,
               last_seen = excluded.last_seen, duplicate_at = excluded.duplicate_at`,
          ).run(actor.name, machine, instance, prev, version, JSON.stringify(runs), now, duplicateAt);
          if (setup) db.prepare("UPDATE machines SET setup = ?, setup_at = ? WHERE id = ?").run(JSON.stringify(setup.report), setup.checkedAt, actor.name);
          if (profiles) db.prepare("UPDATE machines SET profiles = ? WHERE id = ?").run(JSON.stringify(profiles), actor.name);
          // A machine resends until the hub answers, so a run is kept as first reported.
          const cost = db.prepare(
            `INSERT OR IGNORE INTO run_costs(machine_id, run_id, machine, project, task_id, profile_id, account, cost_usd, input_tokens, output_tokens, finished_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          );
          for (const c of costs) {
            cost.run(actor.name, c.runId, machine, c.project, c.taskId, c.profileId, c.account, c.costUsd, c.inputTokens, c.outputTokens, c.finishedAt);
          }
          db.prepare("DELETE FROM run_costs WHERE finished_at < ?").run(this.#now(-COST_DAYS * 24 * 60));
          db.prepare("DELETE FROM machines WHERE last_seen < ?").run(this.#now(-MACHINE_TTL_DAYS * 24 * 60));
          this.#expireCommands();
          const commands = (
            db.prepare("SELECT * FROM machine_commands WHERE machine_id = ? AND status = 'pending' ORDER BY id").all(actor.name) as Row[]
          ).map(toCommand);
          return {
            duplicate: duplicateAt !== null && duplicateAt > this.#now(-DUPLICATE_MINUTES),
            cooldowns: this.#cooldowns(),
            policy: this.#policy(),
            commands,
          };
        }),

      "costs.summary": (_input, actor) => {
        const since = (days: number) => this.#now(-days * 24 * 60);
        const rows = db
          .prepare(
            `SELECT project, machine, profile_id, account,
               SUM(CASE WHEN finished_at >= ?1 THEN cost_usd ELSE 0 END) AS usd1,
               SUM(CASE WHEN finished_at >= ?2 THEN cost_usd ELSE 0 END) AS usd7,
               SUM(cost_usd) AS usd30, COUNT(*) AS runs30
             FROM run_costs WHERE finished_at >= ?3 GROUP BY project, machine, profile_id, account`,
          )
          .all(since(1), since(7), since(30)) as Row[];
        const visible = rows.filter((r) => levelOn(actor, str(r.project)) !== null);
        const zero = (): CostTotals => ({ usd1: 0, usd7: 0, usd30: 0, runs30: 0 });
        const add = (t: CostTotals, r: Row) => {
          t.usd1 += Number(r.usd1);
          t.usd7 += Number(r.usd7);
          t.usd30 += Number(r.usd30);
          t.runs30 += Number(r.runs30);
          return t;
        };
        const group = <K extends string>(key: (r: Row) => K) => {
          const out = new Map<K, CostTotals>();
          for (const r of visible) out.set(key(r), add(out.get(key(r)) ?? zero(), r));
          return [...out].sort((a, b) => b[1].usd30 - a[1].usd30);
        };
        const sep = "\u0000";
        return {
          total: visible.reduce(add, zero()),
          projects: group((r) => str(r.project)).map(([project, t]) => ({ project, ...t })),
          profiles: group((r) => [str(r.machine), str(r.profile_id), strOrNull(r.account) ?? ""].join(sep)).map(([k, t]) => {
            const [machine, profileId, account] = k.split(sep) as [string, string, string];
            return { machine, profileId, account: account || null, ...t };
          }),
        };
      },

      "machines.list": () =>
        (db.prepare("SELECT * FROM machines ORDER BY last_seen DESC").all() as Row[]).map((r) => this.#toMachine(r)),

      "machines.remove": ({ id }) => ({ removed: num(db.prepare("DELETE FROM machines WHERE id = ?").run(id).changes) === 1 }),

      "cooldowns.list": () => this.#cooldowns(),

      // Last report wins: the newest rate-limit message has the best reset time.
      "cooldowns.set": ({ account, until, reason }, actor) => {
        assertNoSecret(reason, "Cooldown reason");
        const iso = new Date(until).toISOString();
        const now = this.#now();
        if (iso <= now) {
          db.prepare("DELETE FROM quota_cooldowns WHERE account = ?").run(account);
          return null;
        }
        db.prepare(
          `INSERT INTO quota_cooldowns(account, until, reason, reported_by, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(account) DO UPDATE SET until = excluded.until, reason = excluded.reason,
             reported_by = excluded.reported_by, updated_at = excluded.updated_at`,
        ).run(account, iso, reason, actor.name, now);
        return toCooldown(db.prepare("SELECT * FROM quota_cooldowns WHERE account = ?").get(account) as Row);
      },

      "cooldowns.clear": ({ account }) => ({
        cleared: num(db.prepare("DELETE FROM quota_cooldowns WHERE account = ?").run(account).changes) === 1,
      }),

      "machines.commandResult": ({ id, status, output }, actor) =>
        this.#tx(() => {
          const cmd = this.#command(id);
          if (cmd.machineId !== actor.name) throw new HiveError("forbidden", `Command #${id} is for ${cmd.machineId}, not ${actor.name}.`);
          if (!COMMAND_MOVES[cmd.status].includes(status)) throw new HiveError("conflict", `Command #${id} is ${cmd.status}, cannot become ${status}.`);
          db.prepare("UPDATE machine_commands SET status = ?, output = COALESCE(?, output), updated_at = ? WHERE id = ?").run(
            status,
            output ?? null,
            this.#now(),
            id,
          );
          return this.#command(id);
        }),

      "policy.get": () => this.#policy(),

      "policy.set": (input, actor) => {
        const policy: TeamPolicy = { ...input, updatedAt: this.#now(), updatedBy: actor.name };
        assertNoSecret(JSON.stringify(policy), "Policy");
        db.prepare("INSERT INTO settings(key, value) VALUES ('policy', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
          JSON.stringify(policy),
        );
        return this.#policy();
      },

      "admin.machines": () => {
        this.#expireCommands();
        return (db.prepare("SELECT * FROM machines ORDER BY last_seen DESC").all() as Row[]).map(
          (r): MachineDetail => ({
            ...this.#toMachine(r),
            setup: r.setup == null ? null : (JSON.parse(str(r.setup)) as SetupReport),
            setupAt: strOrNull(r.setup_at),
            commands: (
              db.prepare("SELECT * FROM machine_commands WHERE machine_id = ? ORDER BY id DESC LIMIT ?").all(str(r.id), COMMAND_HISTORY) as Row[]
            ).map(toCommand),
          }),
        );
      },

      // Only an install the machine itself reported as possible: the hub never sends a free-form command.
      "admin.commandCreate": ({ machineId, itemId }, actor) =>
        this.#tx(() => {
          const row = db.prepare("SELECT setup FROM machines WHERE id = ?").get(machineId) as Row | undefined;
          if (!row) throw new HiveError("not_found", `No machine ${machineId}.`, { key: "errors.machineNotFound", vars: { machine: machineId } });
          const report = row.setup == null ? null : (JSON.parse(str(row.setup)) as SetupReport);
          const item = report ? [...report.machine, ...report.projects.flatMap((p) => p.items)].find((i) => i.id === itemId) : undefined;
          if (!item) throw new HiveError("bad_request", `${machineId} has not reported ${itemId}.`, { key: "errors.itemNotReported", vars: { machine: machineId, item: itemId } });
          if (!item.action) throw new HiveError("bad_request", `${itemId} is ${item.state} on ${machineId}: nothing the app can install.`, {
              key: "errors.nothingToInstall",
              vars: { machine: machineId, item: itemId },
            });
          const open = db
            .prepare("SELECT id FROM machine_commands WHERE machine_id = ? AND item_id = ? AND status IN ('pending', 'running')")
            .get(machineId, itemId) as Row | undefined;
          if (open) throw new HiveError("conflict", `Command #${num(open.id)} for ${itemId} is still open.`, { key: "errors.commandOpen", vars: { id: num(open.id), item: itemId } });
          const now = this.#now();
          const res = db
            .prepare("INSERT INTO machine_commands(machine_id, item_id, label, requested_by, requested_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
            .run(machineId, itemId, `${item.action}: ${item.label}`, actor.name, now, now);
          return this.#command(num(res.lastInsertRowid));
        }),

      "admin.commandCancel": ({ id }) =>
        this.#tx(() => {
          const cmd = this.#command(id);
          if (cmd.status !== "pending") throw new HiveError("conflict", `Command #${id} is ${cmd.status}; only pending commands can be cancelled.`, { key: "errors.commandNotPending", vars: { id } });
          db.prepare("UPDATE machine_commands SET status = 'cancelled', updated_at = ? WHERE id = ?").run(this.#now(), id);
          return this.#command(id);
        }),

      "admin.audit": ({ limit, action }) =>
        (
          db.prepare("SELECT * FROM audit WHERE (?1 IS NULL OR action = ?1) ORDER BY id DESC LIMIT ?2").all(action ?? null, limit) as Row[]
        ).map(toAudit),
    };
  }
}
