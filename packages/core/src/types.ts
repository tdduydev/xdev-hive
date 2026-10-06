import type { Access } from "./access.ts";
import type { AgentPolicy } from "./agent-policy.ts";
import type { AgentProfile, AgentRole, PreferKind } from "./agents.ts";
import type { MrStatus, PipelineStatus } from "./gitlab.ts";
import type { WriteSource } from "./source.ts";
import type { MapPhase } from "./mapreduce.ts";

/** member: a person's hub account (what it may do comes from its per-project grants). */
export type Role = "viewer" | "agent" | "member" | "admin";
/** org: the team's shared data; project: one project's; system: a system's, shared by its services (roadmap 19c). */
export type DocScope = "org" | "project" | "system";

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
  /** The agent's label (`x-hive-agent`, e.g. `claude-1.duy-mbp`), so the audit log tells agents apart from people. */
  agent?: string;
  /**
   * The account that owns the token (or the token's name when no account does). An agent acts for that person, so
   * "approving your own work" compares this, not `name`, which carries the agent's label (27c), and a machine's Board
   * runs count against that person's spending cap (27b).
   */
  onBehalf?: string;
  /** The run the agent works in (`x-hive-run`, from the HIVE_RUN the runner sets). */
  run?: string;
  /**
   * The hub account behind the session or token; absent for a token of no account (CI, the CLI's). Unlike onBehalf it
   * never falls back to a token's name, so it can tell who owns a machine (roadmap 18d).
   */
  account?: string;
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
  blocks: Array<{ kind: "shared" | "system" | "project" | "paths" | "skills"; items: Array<{ key: string | null; title: string; version: number | null; lines: number }> }>;
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

/**
 * The agent a task is *for* (roadmap 50), apart from `owner`, which says who took it: the hub queues the run itself as
 * soon as that machine has a free place and the task waits for nothing.
 */
export interface TaskAgent {
  /** The machine's hub id (`runner.<machine>@<account>`), as machines.list gives it. */
  machineId: string;
  machine: string;
  /** null: any plan of that machine, picked when the run goes out, as "Gửi cho máy" does. */
  profileId: string | null;
  /** Place in that machine's queue; the smallest goes first. A fraction keeps a dragged task between two others. */
  order: number;
  by: string;
  at: string;
  /**
   * Why the hub stopped giving this task to its agent (a run of it failed, a plan it was pinned to is gone). While it
   * is set nothing goes out; assigning the task again clears it (the *Chạy lại* button).
   */
  hold: RunRequestError | null;
}

export interface Task {
  id: string;
  project: string;
  title: string;
  status: TaskStatus;
  owner: string | null;
  leaseUntil: string | null;
  note: string | null;
  updatedAt: string;
  /** Tasks that have to be done first: of the same project, or of another service of a system it is in (roadmap 19d). */
  dependsOn: string[];
  /** Those of them not done yet: while any is left the task cannot be claimed. */
  waitingOn: string[];
  /** The project of each of them in another project (roadmap 19d); absent when all are of this one. */
  depProjects?: Record<string, string>;
  /** Open dependencies in projects the reader cannot see: left out of the lists above, counted here. */
  waitingHidden?: number;
  /** The agent it is assigned to (roadmap 50); null: nobody, and the task behaves exactly as before. */
  agent: TaskAgent | null;
}

/** One line of an agent's queue (tasks.agentQueue): the task and why the hub has not sent it out yet. */
export interface TaskAgentQueueItem {
  task: Task;
  /** null: nothing holds it back, it only waits its turn (or just went out). */
  waiting: RunRequestError | null;
}

/** installed: nothing to do · missing: the app can install it · outdated: installed for another build · manual: needs a hand edit. */
export type SetupState = "installed" | "missing" | "outdated" | "manual";

/** Something the desktop checks on this machine or in a repo, and the fix it can apply. */
export interface SetupItem {
  /** cli:<kind> · shim · <project>:agents · <project>:codegraph-mcp · <project>:codegraph-index · <project>:superpowers · <project>:speckit */
  id: string;
  label: string;
  state: SetupState;
  /** Version and path when installed, otherwise what is missing. */
  detail: string;
  /** Install button label, when the app can fix it itself. */
  action: string | null;
  /** An agent CLI's version, and the newest on its registry when it could be looked up (roadmap 33). */
  version?: string | null;
  latest?: string | null;
}

export interface SetupReport {
  machine: SetupItem[];
  projects: Array<{ project: string; repo: string; items: SetupItem[] }>;
}

/** What a machine with the project still lacks (roadmap 29a): for the project's readers, so no install action or local paths. */
export interface MachineSetupMissing {
  machineId: string;
  machine: string;
  items: Array<Omit<SetupItem, "action">>;
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
  /** Plan usage in percent (Claude Code and Codex subscriptions); null when unknown. */
  sessionPercent?: number | null;
  weekPercent?: number | null;
  /** When each limit resets, as PlanLimit.resets has it ("Oct 8 at 5:59pm (Asia/Saigon)"). */
  sessionResets?: string | null;
  weekResets?: string | null;
  /** When those numbers were taken: Codex's are those of its last turn on the machine, which may be hours old. */
  usageCheckedAt?: string | null;
  /** The profile's stop threshold is reached: the machine starts no new run on it. */
  overLimit?: boolean;
  cooldownUntil: string | null;
  runs: number;
  rateLimited: number;
  /** Lower runs first (AgentProfile.priority). Absent from apps older than 0.95, which cannot take changes from the hub. */
  priority?: number;
  /** Runs it takes at once (AgentProfile.maxConcurrent); absent from apps older than 0.110, counted as 1. */
  maxConcurrent?: number;
}

/**
 * A change to one of a machine's profiles asked for on the web (roadmap 18d), waiting until the machine reports the
 * profile as asked. null: that part is left as the machine has it.
 */
export interface ProfileChange {
  machineId: string;
  profileId: string;
  enabled: boolean | null;
  priority: number | null;
  requestedBy: string;
  requestedAt: string;
}

export const POLICY_CLIS = ["claude", "codex", "gemini", "antigravity"] as const;
export const POLICY_REPO_PARTS = ["agents", "codegraph-mcp", "codegraph-index", "superpowers", "speckit"] as const;
/**
 * admins: a hub admin may approve their own work, since on a hub of one person their agents run on their token too.
 * nobody: everyone needs someone else.
 */
export const SELF_APPROVALS = ["admins", "nobody"] as const;
export type SelfApproval = (typeof SELF_APPROVALS)[number];
export type PolicyRepoPart = (typeof POLICY_REPO_PARTS)[number];

/** What the team expects on every machine, set by an admin on the hub. */
export interface TeamPolicy {
  requiredClis: Array<(typeof POLICY_CLIS)[number]>;
  requireShim: boolean;
  /** Project key → repo setup parts every machine that has the project should have. */
  projects: Record<string, PolicyRepoPart[]>;
  /** Profiles the team recommends; desktops add them in one click (each machine fills in its own env). */
  profileTemplates: AgentProfile[];
  /** Who may approve their own work (roadmap 27c): hub admins, or nobody. */
  selfApproval: SelfApproval;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** The tool catalog (roadmap 28a): what machines may set up for runs, kept on the hub instead of in the app's code. */
export const TOOL_KINDS = ["mcp", "plugin", "hook", "cli"] as const;
export const TOOL_AGENTS = ["claude", "codex", "gemini", "antigravity"] as const;
export const TOOL_REGISTRIES = ["npm", "pypi", "brew", "git", "claude-plugin"] as const;
/**
 * Tools the app already has its own code for: from 28b the machine runs that code to install, prepare and check them,
 * and the catalog decides whether they are on, their version and policy.
 */
export const TOOL_HANDLERS = ["codegraph", "superpowers", "speckit"] as const;
export const TOOL_HOOK_EVENTS = ["PreToolUse", "PostToolUse", "SessionStart", "Stop"] as const;
export type ToolKind = (typeof TOOL_KINDS)[number];
export type ToolAgent = (typeof TOOL_AGENTS)[number];
export type ToolRegistry = (typeof TOOL_REGISTRIES)[number];
export type ToolHandler = (typeof TOOL_HANDLERS)[number];

export interface ToolEntry {
  /** Also the MCP server's name in a run's config and in the agent policy: TOOL_ID. */
  id: string;
  name: string;
  description: string;
  kind: ToolKind;
  /** Always a pinned version: a run gets what was reviewed, not whatever the registry has today. */
  package: { registry: ToolRegistry; name: string; version: string } | null;
  /** kind "mcp": the command that runs the server. */
  mcp: { command: string; args: string[] } | null;
  /** kind "plugin": the Claude Code plugin id, e.g. superpowers@claude-plugins-official. */
  plugin: string | null;
  /** kind "hook": Claude Code hooks a run turns on (28b/28d); runs otherwise set disableAllHooks. */
  hooks: Array<{ event: (typeof TOOL_HOOK_EVENTS)[number]; matcher: string; command: string[] }>;
  agents: ToolAgent[];
  /** On the machine: a command that exits 0 when installed, and one that installs. null: nothing to install (npx fetches it). */
  check: string[] | null;
  install: string[] | null;
  /** In a run's worktree: init when `marker` is missing, sync when it is there (like codegraph's index). */
  prepare: { init: string[]; sync: string[]; marker: string } | null;
  /** Fixed variables, never secrets: telemetry and update checks off. */
  env: Record<string, string>;
  /** Names of variables the machine supplies itself (API keys…): the hub never holds their values. */
  secretEnv: string[];
  /** SPDX, e.g. MIT. */
  license: string;
  /** https. */
  homepage: string | null;
  /** Seeds only: the code of the app that sets the tool up. */
  handler: ToolHandler | null;
  /** On for every project but those that turn it off. */
  enabledByDefault: boolean;
}

/** A project's own setting for a tool; enabled null follows the tool's enabledByDefault. */
export interface ToolProjectSetting {
  project: string;
  enabled: boolean | null;
  required: boolean;
  effective: boolean;
}

export interface ToolView extends ToolEntry {
  /** A seed: never removed, only turned off. */
  builtin: boolean;
  /** The entry's own version (optimistic lock), not the package's. */
  version: number;
  updatedAt: string;
  updatedBy: string;
  /** The projects the reader may view that have their own setting (with tools.list's project: that one, always). */
  projects: ToolProjectSetting[];
}

/** A project's setting for one tool, as a heartbeat carries it (roadmap 28b). */
export interface MachineToolSetting {
  id: string;
  enabled: boolean | null;
  effective: boolean;
  required: boolean;
}

/**
 * The catalog as a machine gets it at its heartbeat (roadmap 28b): the entries its projects may use, placeholders
 * left as written (the machine fills them in with toolArgv), and each of its projects' settings.
 */
export interface MachineTools {
  entries: ToolEntry[];
  projects: Record<string, MachineToolSetting[]>;
}

/**
 * Where a tool stands for a project (roadmap 28e, tools.status): whether the project gets it, and the setup items that
 * set it up as each machine with the project last reported them, so a leader can tell why a run lacks it.
 */
export interface ToolStatus {
  id: string;
  name: string;
  /** The project gets it: its own choice, else the tool's default. */
  effective: boolean;
  required: boolean;
  /** The setup items of the tool for the project (toolSetupItems): what propose_install takes. */
  items: string[];
  /** Each machine with the project that reported its setup; items: those of the tool it reported (none: an older app). */
  machines: Array<{ machineId: string; machine: string; items: Array<Omit<SetupItem, "action">> }>;
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

/**
 * What a project is to the hub (roadmap 47), table `project_states`: no row means in use.
 * `archived` hides it and refuses writes, and can be undone; `deleted` is the headstone left after the data went,
 * so a machine still reporting the repo cannot bring the name back by itself.
 */
export const PROJECT_STATES = ["archived", "deleted"] as const;
export type ProjectState = (typeof PROJECT_STATES)[number];

/** A project as the admin table shows it (projects.list): what it holds, where it is, and its state. */
export interface ProjectSummary {
  project: string;
  /** null while the project is in use. */
  state: ProjectState | null;
  stateAt: string | null;
  stateBy: string | null;
  openTasks: number;
  tasks: number;
  docs: number;
  memory: number;
  runs: number;
  /** Machines that reported a repo for it at their last heartbeat. */
  machines: string[];
  /** Systems it is a service of. */
  systems: string[];
}

/** What projects.delete removed: rows per table, and the doc files of the store that went with them. */
export interface ProjectDeleted {
  project: string;
  /** The database snapshot taken before anything was deleted. */
  backup: string;
  /** Table → rows deleted, tables that had none left out. */
  rows: Record<string, number>;
  files: { removed: number; failed: number };
}

/** Key of `AgentsPaused.by` for the whole hub: no project key is "*". */
export const PAUSED_HUB = "*";

/**
 * The stop-all switch (roadmap 27d), settings key `paused`: while the hub or a project is paused nobody queues a run
 * or talks to its leader, and every machine stops the scope's runs and starts none, Board runs too.
 */
export interface AgentsPaused {
  hub: boolean;
  projects: string[];
  /** Who paused each scope and when, for the Board's notice: PAUSED_HUB for the hub, else the project. */
  by: Record<string, { name: string; at: string }>;
}

/** What agents.stop did, also what its confirmation counts before it is pressed. */
export interface AgentsStop {
  project: string | null;
  paused: AgentsPaused;
  /** Run requests no machine took yet, now cancelled. */
  requests: number;
  /** Runs running on a machine, now asked to stop (queued ones wait in their queue until the pause is lifted). */
  runs: number;
  /** Chat replies waiting or being written, now cancelled. */
  chats: number;
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
export const WEBHOOK_EVENTS = [
  "proposal.created",
  "memory.pending",
  "command.requested",
  "command.finished",
  "run.failed",
  "mr.created",
  "alert.opened",
  "agentPolicy.changed",
  "agents.stopped",
  "agents.resumed",
  "project.archived",
  "project.deleted",
] as const;
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
  | { type: "agentPolicy.changed"; project: string | null; by: string; policy: Partial<AgentPolicy> | null }
  /** Someone stopped every agent of a project (project) or of the hub (null), roadmap 27d. */
  | { type: "agents.stopped"; project: string | null; by: string; stop: AgentsStop }
  | { type: "agents.resumed"; project: string | null; by: string }
  /**
   * The tool catalog changed (roadmap 28a): an entry saved or removed (project null), or a project's setting. For 28b to
   * push to machines; not a webhook event yet.
   */
  | { type: "tool.changed"; project: string | null; by: string; tool: string; removed: boolean }
  /** A hub admin archived a project (roadmap 47) or took it back out of the archive. */
  | { type: "project.archived"; project: string; by: string; archived: boolean }
  /** A hub admin deleted a project for good: what went with it is in `deleted`. */
  | { type: "project.deleted"; project: string; by: string; deleted: ProjectDeleted };

/** The hub's alert rules (roadmap 22m), each turned on or off by a hub admin. */
export const ALERT_RULES = [
  "run_fail_streak",
  "ci_fix_exhausted",
  "machine_offline",
  "webhook_failed",
  "quota_near",
  "vendor_resting",
  "backup_overdue",
  "budget_near",
  "budget_exceeded",
] as const;
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
  /** What its machine last saw of the run's merge request or pull request (roadmap 18c); null: none, or an older app. */
  mr: RunMr | null;
  /** A merge asked for on the web (runs.merge) and how it went; null: none asked. */
  merge: RunMerge | null;
  /** What the run used, once its machine reported it (roadmap 28c); null before, or for a run the CLI gave none. */
  tokens: RunTokens | null;
  /**
   * When the hub dropped the run's log and patch to keep only what it did (roadmap 41b); null: it still has them.
   * An empty log means nothing on its own — a queued run has none either.
   */
  logPrunedAt: string | null;
  /** The end of the run's readable log, lines that looked like secrets hidden: runs.get only. */
  log?: string;
  /** What it changed (git diff from its base), as its machine last sent it; null: not sent (yet). runs.get only. */
  patch?: string | null;
}

/** A run's merge request (GitLab) or pull request (GitHub) as its machine's MR watcher last saw it. */
export interface RunMr {
  iid: number | null;
  status: MrStatus | null;
  draft: boolean;
  /** GitLab's pipeline, or GitHub's checks read as one. */
  pipeline: PipelineStatus | null;
  pipelineUrl: string | null;
  checkedAt: string | null;
}

export const MERGE_STATUSES = ["pending", "merged", "failed"] as const;
export type MergeStatus = (typeof MERGE_STATUSES)[number];

/** A merge asked for on the web: the run's machine does it with its own GitLab or GitHub token (asked 2/10). */
export interface RunMerge {
  requestedBy: string;
  requestedAt: string;
  status: MergeStatus;
  error: RunRequestError | null;
  finishedAt: string | null;
}

/** A merge a machine is asked to do (heartbeat). */
export interface RunMergeOrder {
  runId: string;
  mrUrl: string;
  requestedBy: string;
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
  /** Unpinned: the kind to wait for while one of its profiles could take the run (roadmap 24c); null: any. */
  preferKind: PreferKind | null;
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

export const RUN_GROUP_KINDS = ["batch", "fanout", "mapreduce", "roles"] as const;
export type RunGroupKind = (typeof RUN_GROUP_KINDS)[number];
/** held: waits at the hub; sent: became a run request; failed: could not, when released; cancelled: with its group. */
export const RUN_GROUP_ITEM_STATUSES = ["held", "sent", "failed", "cancelled"] as const;
export type RunGroupItemStatus = (typeof RUN_GROUP_ITEM_STATUSES)[number];

/** What a run did on its machine, as the machine pushed it (run_records). */
export interface RunGroupRun {
  machineId: string;
  runId: string;
  machine: string;
  status: string;
  profileId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  costUsd: number | null;
}

/** One task of a run group (roadmap 31a): held at the hub until there is room, then a run request. */
export interface RunGroupItem {
  id: number;
  position: number;
  taskId: string;
  /** null once the task is gone. */
  taskTitle: string | null;
  taskStatus: TaskStatus | null;
  role: AgentRole;
  /** null: any free machine, picked when the item is released; then the one picked. */
  machineId: string | null;
  profileId: string | null;
  preferKind: PreferKind | null;
  instructions: string;
  status: RunGroupItemStatus;
  request: RunRequest | null;
  run: RunGroupRun | null;
  /** Taking up one of the group's places: its request waits for the machine, or its run has not ended. */
  active: boolean;
  error: RunRequestError | null;
  updatedAt: string;
}

/** Runs started as one (roadmap 31): several tasks on several machines, at most maxParallel at a time. */
export interface RunGroup {
  id: number;
  project: string;
  kind: RunGroupKind;
  title: string;
  /** null: every item at once. */
  maxParallel: number | null;
  reviewAfter: boolean;
  instructions: string;
  parentTask: string | null;
  winnerTask: string | null;
  createdBy: string;
  createdAt: string;
  /** Nothing left to release or running. */
  closedAt: string | null;
  items: RunGroupItem[];
  /** Map-reduce (roadmap 31c): where the group is; null for the other kinds. */
  phase: MapPhase | null;
  /** The job's parts: given, or written by the split run (to check while the phase is "ready"). */
  parts: string[];
  /** The machine every part and the merge run on: their branches have to be in one repository. */
  machineId: string | null;
  /** The split run's or the merge run's request, and what its run did. */
  phaseRequest: RunRequest | null;
  phaseRun: RunGroupRun | null;
  /** Why the group stopped. */
  phaseError: RunRequestError | null;
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
  /**
   * Kinds of proposal its leader runs at once, as the person who sent the message, without waiting for a confirm
   * (roadmap 29c). None by default; never one of CHAT_ACTION_ALWAYS_CONFIRM.
   */
  autoKinds: ChatActionKind[];
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

export const CHAT_ACTION_KINDS = [
  "task.create",
  "task.update",
  "task.assign",
  "run.dispatch",
  "run.cancel",
  "run.merge",
  "machine.profile",
  "agent.policy",
  "agents.stop",
  "agents.resume",
  "machine.install",
  "tool.enable",
] as const;
export type ChatActionKind = (typeof CHAT_ACTION_KINDS)[number];
/**
 * Kinds a person always confirms, whatever the project lets its leader do alone (roadmap 29c): both loosen the limits
 * the leader itself runs under, and an agent does not widen its own leash.
 */
export const CHAT_ACTION_ALWAYS_CONFIRM: readonly ChatActionKind[] = ["agent.policy", "agents.resume"];
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
  /**
   * The input of the call it becomes (tasks.create, runs.dispatch, runs.cancel, agentPolicy.set…), project included;
   * agent.policy also keeps `before`, the project's part when proposed, which is not sent.
   */
  input: Record<string, unknown>;
  /** The leader's one line on why. */
  reason: string;
  status: ChatActionStatus;
  /** What confirming it made: the task, the run request sent to the machine, or the install command. */
  result: { taskId?: string; requestId?: number; commandId?: number } | null;
  error: RunRequestError | null;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
  /** The leader ran it at once, as decidedBy (who sent the message), because the project lets it (roadmap 29c). */
  auto: boolean;
}

/** The rights of whoever wrote a chat message, kept for the hub to cut the reply's MCP token (see ChatRequest.grant). */
export interface ChatSender {
  name: string;
  role: Role;
  access?: Access;
  /** The hub account, for what checks one (a machine's owner); absent for messages from before roadmap 29c. */
  account?: string;
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
  /** The systems the project is a service of (roadmap 19d); the leader may propose tasks for their other services. */
  systems?: Array<{ name: string; projects: string[] }>;
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
  /** Set when an agent did it (roadmap 27c): its label, the account it acted for and its run. */
  agent: string | null;
  onBehalf: string | null;
  run: string | null;
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
  /** The hub account its token belongs to: with hub admins, the only one who may change its profiles from the web. */
  owner: string | null;
  /** Profile changes asked for on the web that the machine has not reported yet (roadmap 18d). */
  profileChanges: ProfileChange[];
}

/**
 * The share of input read from the prompt cache, 0–1 (roadmap 28c): what a run, a project or a subscription reuses.
 * null when nothing says how much came from the cache (runs from before the counts were kept apart).
 */
export function cacheReadShare(u: { inputTokens: number | null; cacheWriteTokens: number | null; cacheReadTokens: number | null }): number | null {
  if (u.cacheReadTokens === null) return null;
  const all = (u.inputTokens ?? 0) + (u.cacheWriteTokens ?? 0) + u.cacheReadTokens;
  return all > 0 ? u.cacheReadTokens / all : null;
}

/** The windows the app adds a subscription's tokens up over (roadmap 46): 24 hours, 7 days, 30 days. */
export const TOKEN_WINDOWS = ["d1", "d7", "d30"] as const;
export type TokenWindow = (typeof TOKEN_WINDOWS)[number];
const WINDOW_DAYS: Record<TokenWindow, number> = { d1: 1, d7: 7, d30: 30 };

/**
 * A window's tokens (roadmap 46). The input split counts only the runs that reported it, as on the web's costs (28c);
 * output counts every run. `oldRuns`: runs from before 28c, their input one number the split cannot use.
 * cacheReadTokens stays null while no run of the window split its input, so cacheReadShare says nothing.
 */
export interface TokenTotals {
  runs: number;
  oldRuns: number;
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number | null;
  outputTokens: number;
}

export type TokenWindows = Record<TokenWindow, TokenTotals>;

const noTokens = (): TokenTotals => ({ runs: 0, oldRuns: 0, inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: null, outputTokens: 0 });

/** Adds runs' tokens up over each window by the time they finished; runs without tokens (not finished, a custom CLI) stay out. */
export function tokenWindows(runs: Array<RunTokens & { finishedAt: string | null }>, now: Date): TokenWindows {
  const out = { d1: noTokens(), d7: noTokens(), d30: noTokens() };
  for (const r of runs) {
    if (!r.finishedAt || (r.inputTokens === null && r.outputTokens === null && r.cacheReadTokens === null)) continue;
    const age = now.getTime() - Date.parse(r.finishedAt);
    for (const w of TOKEN_WINDOWS) {
      if (age > WINDOW_DAYS[w] * 86_400_000) continue;
      const t = out[w];
      t.runs++;
      t.outputTokens += r.outputTokens ?? 0;
      if (r.cacheReadTokens === null) {
        t.oldRuns++;
        continue;
      }
      t.inputTokens += r.inputTokens ?? 0;
      t.cacheWriteTokens += r.cacheWriteTokens ?? 0;
      t.cacheReadTokens = (t.cacheReadTokens ?? 0) + r.cacheReadTokens;
    }
  }
  return out;
}

/** Several subscriptions' windows as one: the machine's line. */
export function addTokenWindows(list: TokenWindows[]): TokenWindows {
  const out = { d1: noTokens(), d7: noTokens(), d30: noTokens() };
  for (const w of list) {
    for (const k of TOKEN_WINDOWS) {
      const a = out[k];
      const b = w[k];
      a.runs += b.runs;
      a.oldRuns += b.oldRuns;
      a.inputTokens += b.inputTokens;
      a.cacheWriteTokens += b.cacheWriteTokens;
      a.outputTokens += b.outputTokens;
      if (b.cacheReadTokens !== null) a.cacheReadTokens = (a.cacheReadTokens ?? 0) + b.cacheReadTokens;
    }
  }
  return out;
}

/** API-price cost estimates over rolling windows: the last 24 hours, 7 days and 30 days. */
export interface CostTotals {
  usd1: number;
  usd7: number;
  usd30: number;
  /** Runs with a cost or tokens in the last 30 days. */
  runs30: number;
  /**
   * Tokens of the last 30 days (roadmap 28c). The input split (fresh, written to the cache, read from it) counts only the
   * runs that reported it; output counts every run.
   */
  tokens30: RunTokens;
}

/** A run's tokens (roadmap 28c): input read fresh, written to the prompt cache, read from it, and output. */
export interface RunTokens {
  inputTokens: number | null;
  cacheWriteTokens: number | null;
  cacheReadTokens: number | null;
  outputTokens: number | null;
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
