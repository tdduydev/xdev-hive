import type { Access } from "./access.ts";
import type { AgentPolicy } from "./agent-policy.ts";
import type { AgentProfile, AgentRole } from "./agents.ts";
import type { WriteSource } from "./source.ts";

/** member: a person's hub account (what it may do comes from its per-project grants). */
export type Role = "viewer" | "agent" | "member" | "admin";
export type DocScope = "org" | "project";

export interface Actor {
  /** Who is acting, e.g. `claude@duy` or `duy`. Recorded on every write. */
  name: string;
  role: Role;
  /** Per-project grants of a hub account; absent = unrestricted (local mode, hub admins, tokens of no account). */
  access?: Access;
  /** Where this request came from; stored with docs versions, proposals and memory it writes. */
  source?: WriteSource;
  /** Set by the hub for a chat leader's short-lived token: the reply it writes, the only one it may propose actions for. */
  chatReply?: number;
}

export interface DocSummary {
  key: string;
  scope: DocScope;
  project: string | null;
  title: string;
  version: number;
  includeInAgents: boolean;
  /**
   * Repo-relative globs the doc applies to. Such a doc is not put in AGENTS.md: it goes to a nested
   * AGENTS.md (glob with a folder) or to .claude/rules/xdev-hive/ (glob without one), and AGENTS.md lists it.
   */
  paths: string[];
  /** The page it sits under (same space), null at the top (roadmap 22j). Missing from a hub older than 22j. */
  parent: string | null;
  /** Shown as a folder: a page whose job is to hold other pages. */
  folder: boolean;
  /** Mirrored from the repo (roadmap 26): the file (and section) it comes from and the commit; null when Hive is its home. */
  mirror?: DocMirror | null;
  updatedBy: string;
  updatedAt: string;
}

export interface DocMirror {
  /** `README.md`, or `README.md#Hub cho team` for a section. */
  from: string;
  commit: string;
}

export interface Doc extends DocSummary {
  content: string;
}

/** A file attached to a page (roadmap 22j): Markdown shows it as assets/<slug>/<name>. */
export interface DocAsset {
  id: number;
  docKey: string;
  name: string;
  type: string;
  size: number;
  uploadedBy: string;
  createdAt: string;
}

/** What the writing assistant is asked for (roadmap 22k): the panel's quick asks, or free text. */
export const DOC_ASSIST_KINDS = ["draft", "code", "check", "summary", "free"] as const;
export type DocAssistKind = (typeof DOC_ASSIST_KINDS)[number];
export const DOC_ASSIST_STATUSES = ["pending", "running", "done", "failed", "cancelled", "expired"] as const;
export type DocAssistStatus = (typeof DOC_ASSIST_STATUSES)[number];

/** One ask of the writing assistant on a page: a machine writes it with one of its Claude profiles. */
export interface DocAssist {
  id: number;
  docKey: string;
  project: string | null;
  kind: DocAssistKind;
  prompt: string;
  /** What it was given to work from: "doc:<key>", "memory:<id>", "code:<path or glob>" (the page itself always). */
  sources: string[];
  status: DocAssistStatus;
  /** The machine writing it, once one took it. */
  machine: string | null;
  profile: string | null;
  /** Its short answer: what it changed and from which sources. */
  reply: string;
  /** The whole page as it proposes it; null: no change to the page. */
  markdown: string | null;
  /** The page it started from (the draft at the time): the diff is against this. */
  base: string;
  error: { message: string; key?: string; vars?: Record<string, string | number> } | null;
  costUsd: number | null;
  /** What the person did with the proposal. */
  outcome: "applied" | "dropped" | null;
  requestedBy: string;
  createdAt: string;
  updatedAt: string;
}

/** What a machine gets to write an ask: the page's title, the sources' text, and repo files to read itself. */
export interface DocAssistJob extends DocAssist {
  title: string;
  context: string;
  code: string[];
}

/** The hub itself (hub.info, roadmap 22n): what runs, its database and backups, search, sign-in, hosts. */
export interface HubInfo {
  /** The xDev Hive version the hub was built from (the app's version), and its commit when the deploy said. */
  version: string;
  commit: string | null;
  node: string;
  container: boolean;
  startedAt: string;
  uptimeSeconds: number;
  db: { path: string; bytes: number; walBytes: number; counts: Record<"docs" | "memory" | "tasks" | "runs" | "machines" | "users", number> };
  /** null: HIVE_BACKUP_DIR is not set. */
  backup: { dir: string; hours: number; keep: number; last: string | null; count: number } | null;
  search: { mode: "keyword" | "hybrid"; model: string | null; url: string | null; indexed: number; total: number; lastError: string | null };
  /** Doc files (roadmap 23c): in the database, or in a store (SeaweedFS) with `inDb` still to move there. */
  files: { store: string | null; where: string | null; count: number; bytes: number; inDb: number; lastError: string | null };
  sso: { name: string; issuer: string; linked: number } | null;
  hosts: { allowed: string[] | null; publicUrl: string | null; trustProxy: boolean };
}

/** What an agent of a project gets from Hive (docs.context, roadmap 22n): the AGENTS.md a sync writes, and more. */
export interface AgentContext {
  project: string;
  agentsMd: string;
  lines: number;
  /** Past this many lines the sync suggests moving parts into docs for some paths. */
  limit: number;
  /** What AGENTS.md is made of, in order: the team's docs, the project's own, the list of docs for some paths, skills. */
  blocks: Array<{ kind: "shared" | "project" | "paths" | "skills"; items: Array<{ key: string | null; title: string; version: number | null; lines: number }> }>;
  /** Docs for some paths and the file each goes to (nested: an AGENTS.md in the folder, read by Codex and Claude Code). */
  paths: Array<{ key: string; title: string; globs: string[]; file: string; nested: boolean }>;
  /** Every file the sync writes in the repo. */
  files: Array<{ path: string; lines: number; block: boolean }>;
  /** Memory agents find with memory_search: the project's and the team's (approved, current), and what they skip. */
  memory: { project: number; shared: number; stale: number; pending: number };
}

/** A page's links (docs.links): the pages it links to, those that link to it, and memory that names it. */
export interface DocLinks {
  /** exists false: a broken link (the page was never made, or has another key). */
  out: Array<{ target: string; key: string; title: string | null; exists: boolean }>;
  back: Array<{ key: string; title: string; snippet: string }>;
  memory: Array<{ id: number; project: string | null; content: string }>;
}

export interface DocVersion {
  key: string;
  version: number;
  content: string;
  author: string;
  note: string;
  /** null: written before sources were recorded, or by the hub itself (seed). */
  source: WriteSource | null;
  createdAt: string;
}

export const PROPOSAL_STATUSES = ["pending", "approved", "rejected", "conflict"] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export interface Proposal {
  id: number;
  docKey: string;
  baseVersion: number;
  content: string;
  reason: string;
  author: string;
  status: ProposalStatus;
  reviewer: string | null;
  reviewNote: string | null;
  decidedAt: string | null;
  source: WriteSource | null;
  createdAt: string;
}

export const MEMORY_KINDS = ["decision", "convention", "gotcha", "context"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];
export const MEMORY_STATUSES = ["pending", "approved"] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export interface Memory {
  id: number;
  /** null: shared by the whole team, seen from every project. */
  project: string | null;
  kind: MemoryKind;
  content: string;
  author: string;
  taskId: string | null;
  status: MemoryStatus;
  source: WriteSource | null;
  createdAt: string;
  /** Last time memory_search gave it to an agent; null: never. */
  lastUsedAt: string | null;
  /** How many agent searches returned it. */
  useCount: number;
  /** Neither used nor written within the stale period: agents' searches leave it out until someone keeps it. */
  stale: boolean;
  /** Repo files the fact is about (paths from the repo root), with the blob last checked against. */
  files: MemoryFile[];
  /** A cited file changed or disappeared since; keeping the entry accepts the files as they are now. */
  review: MemoryReview | null;
  /** The older entry this one replaces. */
  supersedes: number | null;
  /** The newer entry that replaces this one; agents stop seeing it once that one is approved. */
  supersededBy: number | null;
  /** Entries this one disagrees with, until someone decides which is right. */
  conflictsWith: number[];
}

/** How memory_search finds entries: words only, or words plus meaning (embeddings). */
export interface MemorySearchInfo {
  mode: "keyword" | "hybrid";
  /** Embedding model, when there is one. */
  model: string | null;
  /** Approved entries with a vector for the model, out of all approved entries. */
  indexed: number;
  total: number;
  /** The last embedding error ("HTTP 500", "timeout"…), cleared by the next success. */
  lastError: string | null;
  lastIndexedAt: string | null;
}

export interface MemoryFile {
  path: string;
  /** Git object id of the file on the project's branch when first checked; null until then. */
  sha: string | null;
}

export interface MemoryReview {
  at: string;
  changed: string[];
  missing: string[];
  /** What the files are now, adopted as the new baseline when the entry is kept. */
  current: Record<string, string | null>;
}

export const TASK_STATUSES = ["todo", "doing", "review", "done", "blocked"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface Task {
  id: string;
  project: string;
  title: string;
  status: TaskStatus;
  owner: string | null;
  leaseUntil: string | null;
  note: string | null;
  updatedAt: string;
  /** Tasks of the same project that have to be done first. */
  dependsOn: string[];
  /** Those of them not done yet: while any is left the task cannot be claimed. */
  waitingOn: string[];
}

/** installed: nothing to do · missing: the app can install it · outdated: installed for another build · manual: needs a hand edit. */
export type SetupState = "installed" | "missing" | "outdated" | "manual";

/** Something the desktop checks on this machine or in a repo, and the fix it can apply. */
export interface SetupItem {
  /** cli:<kind> · shim · <project>:agents · <project>:codegraph-mcp · <project>:codegraph-index · <project>:superpowers */
  id: string;
  label: string;
  state: SetupState;
  /** Version and path when installed, otherwise what is missing. */
  detail: string;
  /** Install button label, when the app can fix it itself. */
  action: string | null;
}

export interface SetupReport {
  machine: SetupItem[];
  projects: Array<{ project: string; repo: string; items: SetupItem[] }>;
}

/** A subscription profile as a machine reports it to the hub: no command line, no env. */
export interface ReportedProfile {
  id: string;
  label: string;
  kind: string;
  enabled: boolean;
  account: string | null;
  /** The profile's CLI is on that machine's PATH. */
  installed: boolean;
  /** The CLI says it is signed in; null: unknown (no status command, not checked yet, older app). */
  loggedIn?: boolean | null;
  /** Plan usage in percent (Claude Code subscriptions); null when unknown. */
  sessionPercent?: number | null;
  weekPercent?: number | null;
  weekResets?: string | null;
  /** The profile's stop threshold is reached: the machine starts no new run on it. */
  overLimit?: boolean;
  cooldownUntil: string | null;
  runs: number;
  rateLimited: number;
}

export const POLICY_CLIS = ["claude", "codex", "gemini"] as const;
export const POLICY_REPO_PARTS = ["agents", "codegraph-mcp", "codegraph-index", "superpowers"] as const;
export type PolicyRepoPart = (typeof POLICY_REPO_PARTS)[number];

/** What the team expects on every machine, set by an admin on the hub. */
export interface TeamPolicy {
  requiredClis: Array<(typeof POLICY_CLIS)[number]>;
  requireShim: boolean;
  /** Project key → repo setup parts every machine that has the project should have. */
  projects: Record<string, PolicyRepoPart[]>;
  /** Profiles the team recommends; desktops add them in one click (each machine fills in its own env). */
  profileTemplates: AgentProfile[];
  updatedAt: string | null;
  updatedBy: string | null;
}

/**
 * A system (roadmap 19b): the projects that make one product, each a service with its own repository. Picked in the
 * sidebar, the pages show the tasks, runs, merge requests and chat of every project in it. A project may be in several.
 */
export interface HiveSystem {
  name: string;
  projects: string[];
  updatedAt: string;
  updatedBy: string;
}

export const COMMAND_STATUSES = ["pending", "running", "done", "failed", "rejected", "cancelled", "expired"] as const;
export type CommandStatus = (typeof COMMAND_STATUSES)[number];

export const COMMAND_KINDS = ["install", "sync"] as const;
export type CommandKind = (typeof COMMAND_KINDS)[number];

/**
 * Something the hub asked a machine to do. install: an admin's install the machine's user approves first.
 * sync (roadmap 22n): write a project's context into its repo and mirror its docs, as the Projects page's Đồng bộ
 * does; nothing to approve, since it only writes what Hive already holds for that project.
 */
export interface MachineCommand {
  id: number;
  machineId: string;
  kind: CommandKind;
  /** install: a SetupItem id the machine reported as installable. sync: `sync:<project>`. */
  itemId: string;
  /** sync: the project to sync; null for an install. */
  project: string | null;
  label: string;
  status: CommandStatus;
  requestedBy: string;
  requestedAt: string;
  updatedAt: string;
  /** install: what the installer printed. sync: a SyncOutcome as JSON when done, the error when failed. */
  output: string | null;
}

/** What a machine's sync did, sent back as a sync command's output (roadmap 22n): short enough for the web. */
export interface SyncOutcome {
  /** Repo files written or removed. */
  changed: string[];
  /** Files left as they were because someone edited them by hand, or the repo has its own. */
  skipped: string[];
  commit: string | null;
  /** Pages mirrored from the repo as a new version; null when the project mirrors nothing. */
  mirrored: number | null;
  note: string | null;
}

/** Each machine that has a project, with its last sync request (Context agent page, roadmap 22n). */
export interface ProjectSyncState {
  machineId: string;
  machine: string;
  online: boolean;
  version: string;
  last: MachineCommand | null;
}

/** Chat services a hub webhook can post to, and the events it can post. */
export const WEBHOOK_KINDS = ["teams", "slack"] as const;
export type WebhookKind = (typeof WEBHOOK_KINDS)[number];
export const WEBHOOK_EVENTS = ["proposal.created", "memory.pending", "command.requested", "command.finished", "run.failed", "mr.created", "alert.opened", "agentPolicy.changed"] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** Something a person may want to hear about, emitted after the change is stored (see SqliteHiveOptions.onEvent). */
export type HiveEvent =
  | { type: "proposal.created"; project: string | null; proposal: Proposal }
  | { type: "memory.pending"; project: string | null; memory: Memory }
  | { type: "command.requested"; project: null; command: MachineCommand }
  | { type: "command.finished"; project: null; command: MachineCommand }
  | { type: "run.failed"; project: string; run: RunNotice }
  | { type: "mr.created"; project: string; run: RunNotice }
  /** A merge request's pipeline still fails after the last fix run the machine may start (roadmap 22m). */
  | { type: "run.ciLimit"; project: string; run: RunNotice }
  /** The hub opened an alert (a rule of Cảnh báo holds): see apps/web/src/alerts.ts. */
  | { type: "alert.opened"; project: string | null; alert: HubAlert }
  /** A hub admin changed the hub's agent policy (project null) or a project manager their project's; policy null: cleared. */
  | { type: "agentPolicy.changed"; project: string | null; by: string; policy: Partial<AgentPolicy> | null };

/** The hub's alert rules (roadmap 22m), each turned on or off by a hub admin. */
export const ALERT_RULES = ["run_fail_streak", "ci_fix_exhausted", "machine_offline", "webhook_failed", "quota_near", "vendor_resting", "backup_overdue"] as const;
export type AlertRule = (typeof ALERT_RULES)[number];
export type AlertSeverity = "high" | "medium" | "low";

/** Something a rule found: open while it holds, resolved by itself once it does not (or by a hub admin). */
export interface HubAlert {
  id: number;
  rule: AlertRule;
  /** What it is about, within the rule (a machine, project/task, webhook id…): one open alert per rule and key. */
  key: string;
  severity: AlertSeverity;
  /** For the UI's text (alerts.<rule>.title / .detail). */
  vars: Record<string, string | number>;
  project: string | null;
  openedAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  /** null with resolvedAt: it ended by itself. */
  resolvedBy: string | null;
  ackedBy: string | null;
  ackedAt: string | null;
}

export interface AlertRuleState {
  rule: AlertRule;
  enabled: boolean;
  severity: AlertSeverity;
  updatedBy: string | null;
  updatedAt: string | null;
}

/** One line of the admin overview's live feed (alerts.feed): what machines and the hub did lately. */
export interface FeedEvent {
  at: string;
  tone: "running" | "success" | "danger" | "warning" | "info" | "neutral";
  /** Who or what did it: a machine, a person, "hub". */
  src: string;
  /** The UI catalogue's key under feed.* and its values. */
  key: string;
  vars: Record<string, string | number>;
  /** Where a click goes (a hash route), when somewhere. */
  href?: string;
}

/**
 * A run as the machine that runs it last pushed it to the hub (runs.push): what the team sees on the web.
 * Kept 30 days after its last update.
 */
export interface RunRecord {
  /** The machine's hub actor, which with runId names the run. */
  machineId: string;
  machine: string;
  runId: string;
  project: string;
  taskId: string;
  taskTitle: string;
  role: string;
  status: string;
  profileId: string | null;
  /** What the agent is doing now, while it runs. */
  activity: string | null;
  summary: string | null;
  error: string | null;
  branch: string | null;
  commits: number;
  mrUrl: string | null;
  costUsd: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
  /** A project manager asked on the web to stop it (runs.cancel): the machine stops it at its next heartbeat. */
  cancelRequestedBy: string | null;
  cancelRequestedAt: string | null;
  /** The end of the run's readable log, lines that looked like secrets hidden: runs.get only. */
  log?: string;
  /** What it changed (git diff from its base), as its machine last sent it; null: not sent (yet). runs.get only. */
  patch?: string | null;
}

/** A run a machine is asked to stop (heartbeat), and who asked. */
export interface RunCancel {
  runId: string;
  requestedBy: string;
}

export const RUN_REQUEST_STATUSES = ["pending", "accepted", "rejected", "cancelled", "expired"] as const;
export type RunRequestStatus = (typeof RUN_REQUEST_STATUSES)[number];

/** Why a machine refused a run request: the message, and its key in the UI catalogue when there is one. */
export interface RunRequestError {
  message: string;
  key?: string;
  vars?: Record<string, string | number>;
}

/**
 * A run a project manager asked one machine to start (runs.dispatch). The machine gets it in the answer to its next
 * heartbeat, queues it like a run started on its Board, and says whether it took it (runs.requestResult).
 */
export interface RunRequest {
  id: number;
  /** The machine's hub actor. */
  machineId: string;
  machine: string;
  project: string;
  taskId: string;
  taskTitle: string;
  role: AgentRole;
  /** Pinned profile; null: the machine rotates its profiles. */
  profileId: string | null;
  reviewAfter: boolean;
  candidates: number;
  instructions: string;
  status: RunRequestStatus;
  /** The machine's run, once it took the request (the first candidate's for best-of-n). */
  runId: string | null;
  error: RunRequestError | null;
  requestedBy: string;
  requestedAt: string;
  updatedAt: string;
}

/** Claude Code's --effort levels. */
export const CHAT_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ChatEffort = (typeof CHAT_EFFORTS)[number];
/** Aliases Claude Code takes for the latest models (--model); a model's full name is taken too. */
export const CHAT_MODEL_ALIASES = ["fable", "opus", "sonnet", "haiku"] as const;

/** What a project's new chats start with, unless the person picks otherwise (roadmap 17h). */
/**
 * Commands a project's chat leader may run (roadmap 17i-2), as Claude Code Bash prefixes: the command and any
 * arguments. Everything else stays refused, a chained command included. Read-only git by default.
 */
export const DEFAULT_LEADER_COMMANDS = ["git status", "git log", "git diff", "git show"];
/** One to four lowercase words: no shell operator, quote or variable can get in. */
export const LEADER_COMMAND = /^[a-z0-9][a-z0-9._-]*(?: [a-z0-9][a-z0-9._=-]*){0,3}$/;
export const MAX_LEADER_COMMANDS = 20;

export interface ChatDefaults {
  project: string;
  machineId: string | null;
  profileId: string | null;
  model: string | null;
  effort: ChatEffort | null;
  /** What its leader may run; DEFAULT_LEADER_COMMANDS until a manager sets them ([] runs nothing). */
  commands: string[];
  updatedBy: string | null;
  updatedAt: string | null;
}

export const CHAT_REPLY_STATUSES = ["pending", "running", "done", "failed", "cancelled", "expired"] as const;
export type ChatReplyStatus = (typeof CHAT_REPLY_STATUSES)[number];

/** A conversation with a project's leader agent, held on one machine whose Claude Code session each reply resumes. */
export interface ChatThread {
  id: number;
  project: string;
  title: string;
  /** The machine's hub actor: every reply of the thread is written there, in the same session. */
  machineId: string;
  machine: string;
  /** A Claude profile of that machine; null: the machine picks one. */
  profileId: string | null;
  /** Claude Code's model for its replies (an alias like opus, or a full name); null: the profile's own. */
  model: string | null;
  effort: ChatEffort | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** A reply is waiting or being written: the thread takes no new message until it ends. */
  busy: boolean;
}

export interface ChatMessage {
  id: number;
  threadId: number;
  role: "user" | "assistant";
  /** A person, or for a reply the profile and machine that wrote it. */
  author: string;
  /** What was written; for a reply being written, the text so far. */
  text: string;
  /** Replies only. */
  status: ChatReplyStatus | null;
  activity: string | null;
  /** The agent's steps as the run log shows them (▶ tool, ✓ ✗ result), replies only. */
  steps: string;
  error: RunRequestError | null;
  costUsd: number | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  /** What the leader asked to do while writing this reply (replies only). */
  actions: ChatAction[];
  /** Images and files the person attached (their messages only). */
  files: ChatFile[];
}

/** A file attached to a chat message (roadmap 17g): its bytes are read from the hub by id. */
export interface ChatFile {
  id: number;
  name: string;
  /** What the hub read from its bytes (see sniffChatFile). */
  type: string;
  size: number;
  createdAt: string;
}

export const CHAT_ACTION_KINDS = ["task.create", "task.update", "run.dispatch"] as const;
export type ChatActionKind = (typeof CHAT_ACTION_KINDS)[number];
export const CHAT_ACTION_STATUSES = ["proposed", "done", "failed", "dismissed"] as const;
export type ChatActionStatus = (typeof CHAT_ACTION_STATUSES)[number];

/**
 * Something a chat leader asks to do: a task to create or move, a run to queue on a machine. It does nothing until a
 * manager of the project confirms it in the chat; then it runs as that person's own call (roadmap 17c, asked 29/9).
 */
export interface ChatAction {
  id: number;
  replyId: number;
  threadId: number;
  project: string;
  kind: ChatActionKind;
  /** The input of the call it becomes (tasks.create, tasks.update, runs.dispatch), project included. */
  input: Record<string, unknown>;
  /** The leader's one line on why. */
  reason: string;
  status: ChatActionStatus;
  /** What confirming it made: the task, or the run request sent to the machine. */
  result: { taskId?: string; requestId?: number } | null;
  error: RunRequestError | null;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
}

/** The rights of whoever wrote a chat message, kept for the hub to cut the reply's MCP token (see ChatRequest.grant). */
export interface ChatSender {
  name: string;
  role: Role;
  access?: Access;
}

/** A reply a machine is asked to write (heartbeat): the person's message and the session to resume. */
export interface ChatRequest {
  replyId: number;
  threadId: number;
  project: string;
  profileId: string | null;
  /** The thread's Claude Code session; null for its first reply. */
  sessionId: string | null;
  /** The thread's model and effort; null (or missing, from an older hub): the profile's own. */
  model?: string | null;
  effort?: ChatEffort | null;
  /** The project's leader commands; missing (an older hub): none. */
  commands?: string[];
  text: string;
  requestedBy: string;
  createdAt: string;
  /** Kept by the hub to cut `grant`; the web hub never sends it to machines. */
  sender?: ChatSender;
  /** Hub token for the leader's MCP calls while it writes this reply: the sender's rights, never more than the machine's. */
  grant?: string;
  /** What the message came with (GET /api/chat/files/<id> with the grant); none from a hub older than 17g. */
  files?: ChatFile[];
}

/** A run a machine tells the hub about: it failed for good, or it opened a merge request. Not stored. */
export interface RunNotice {
  kind: "failed" | "mr" | "ci_limit";
  project: string;
  taskId: string;
  taskTitle: string;
  runId: string;
  profileId: string | null;
  role: string;
  /** Last line of the failure, cleaned: hidden characters removed, withheld when it looks like a secret. */
  error: string | null;
  mrUrl: string | null;
  mrIid: number | null;
  /** The reporting machine (its hub actor). */
  machine: string;
}

/** Admin view of a machine: the heartbeat plus what it reported about its setup. */
export interface MachineDetail extends Machine {
  setup: SetupReport | null;
  setupAt: string | null;
  commands: MachineCommand[];
}

export interface AuditEntry {
  id: number;
  at: string;
  actor: string;
  action: string;
  target: string;
  detail: string;
  /** The detail as a message key of the UI catalogue (entries from before keys existed have none). */
  detailKey?: string;
  detailVars?: Record<string, string | number>;
}

/** A queued or running agent run, as a desktop runner reports it to the hub. */
export interface MachineRun {
  runId: string;
  project: string;
  taskId: string;
  taskTitle: string;
  role: "plan" | "implement" | "review";
  status: "queued" | "running";
  profileId: string | null;
  since: string;
}

/** A desktop runner as the hub last heard from it. */
export interface Machine {
  /** Hub actor of the heartbeat: `runner.<machine>@<token>`. */
  id: string;
  machine: string;
  version: string;
  lastSeen: string;
  /** Heard from in the last 2 minutes. */
  online: boolean;
  /** Two app instances heartbeat under this id: same machine name and token, so they share task leases. */
  duplicate: boolean;
  runs: MachineRun[];
  /** The machine's subscription profiles as it last reported them (installed, signed in, resting). */
  profiles: ReportedProfile[];
  /** Projects the app on that machine has a repo for (empty for an app older than 0.46). */
  projects: string[];
  /** Its user lets project managers queue runs on it from the web (runs.dispatch). */
  acceptsRuns: boolean;
}

/** API-price cost estimates over rolling windows: the last 24 hours, 7 days and 30 days. */
export interface CostTotals {
  usd1: number;
  usd7: number;
  usd30: number;
  /** Runs with a cost in the last 30 days. */
  runs30: number;
}

/** What finished runs cost, as the machines reported it (Claude Code runs only), for the projects the reader sees. */
export interface CostSummary {
  total: CostTotals;
  projects: Array<CostTotals & { project: string }>;
  profiles: Array<CostTotals & { machine: string; profileId: string; account: string | null }>;
}

/** A subscription account resting after a rate limit, shared by every machine logged into it. */
export interface QuotaCooldown {
  account: string;
  until: string;
  reason: string;
  reportedBy: string;
  updatedAt: string;
}

// ── App updates (roadmap 22i): the hub hands out the desktop builds it was given by the release script ──

export const RELEASE_CHANNELS = ["stable", "beta"] as const;
export type ReleaseChannel = (typeof RELEASE_CHANNELS)[number];
export const INSTALL_WHEN = ["ask", "quit", "idle"] as const;
/** ask: the person restarts from the app · quit: installs when the app quits · idle: installs as soon as no run is going. */
export type InstallWhen = (typeof INSTALL_WHEN)[number];
export type ReleasePlatform = "mac" | "win" | "linux";
export type ReleaseArch = "arm64" | "x64";
export type ReleaseKind = "zip" | "dmg" | "exe" | "AppImage";

export interface AppReleaseFile {
  id: number;
  version: string;
  platform: ReleasePlatform;
  arch: ReleaseArch;
  kind: ReleaseKind;
  name: string;
  size: number;
  sha256: string;
}

export interface AppRelease {
  version: string;
  channel: ReleaseChannel;
  notes: string;
  createdAt: string;
  files: AppReleaseFile[];
}

/** Which build machines should run, and how they move to it. */
export interface AppRollout {
  /** The version machines update to; null: no update is offered. */
  target: string | null;
  /** Share of machines (by a stable hash of their id) that get the target, 0–100. */
  percent: number;
  paused: boolean;
  autoDownload: boolean;
  installWhen: InstallWhen;
  /** Machines older than this get no runs from the hub. */
  minVersion: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
}

/** What a machine hears in its heartbeat reply when it should update. */
export interface UpdateOffer {
  version: string;
  file: AppReleaseFile;
  /** Path on the hub to download the file with the machine's token. */
  url: string;
  autoDownload: boolean;
  installWhen: InstallWhen;
  notes: string;
}

export const UPDATE_STATES = ["idle", "downloading", "ready", "installing", "failed"] as const;
export type UpdateState = (typeof UPDATE_STATES)[number];

/** How a machine's update goes, as its heartbeat reports it. */
export interface UpdateReport {
  state: UpdateState;
  version: string | null;
  /** Download progress, 0–100. */
  percent: number | null;
  error: string | null;
}

export interface MachineUpdate extends UpdateReport {
  machineId: string;
  machine: string;
  current: string;
  updatedAt: string;
}

/** Compares dotted versions (0.9.10 > 0.9.2); a pre-release suffix sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = "", pre = ""] = v.trim().replace(/^v/, "").split("-", 2);
    return { parts: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.parts.length, y.parts.length); i++) {
    const d = (x.parts[i] ?? 0) - (y.parts[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}
