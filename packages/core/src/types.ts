import type { Access } from "./access.ts";
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
  updatedBy: string;
  updatedAt: string;
}

export interface Doc extends DocSummary {
  content: string;
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

export const COMMAND_STATUSES = ["pending", "running", "done", "failed", "rejected", "cancelled", "expired"] as const;
export type CommandStatus = (typeof COMMAND_STATUSES)[number];

/** An install an admin asked a machine to run. The machine's user approves it first. */
export interface MachineCommand {
  id: number;
  machineId: string;
  /** A SetupItem id the machine reported as installable. */
  itemId: string;
  label: string;
  status: CommandStatus;
  requestedBy: string;
  requestedAt: string;
  updatedAt: string;
  output: string | null;
}

/** Chat services a hub webhook can post to, and the events it can post. */
export const WEBHOOK_KINDS = ["teams", "slack"] as const;
export type WebhookKind = (typeof WEBHOOK_KINDS)[number];
export const WEBHOOK_EVENTS = ["proposal.created", "memory.pending", "command.requested", "command.finished", "run.failed", "mr.created"] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** Something a person may want to hear about, emitted after the change is stored (see SqliteHiveOptions.onEvent). */
export type HiveEvent =
  | { type: "proposal.created"; project: string | null; proposal: Proposal }
  | { type: "memory.pending"; project: string | null; memory: Memory }
  | { type: "command.requested"; project: null; command: MachineCommand }
  | { type: "command.finished"; project: null; command: MachineCommand }
  | { type: "run.failed"; project: string; run: RunNotice }
  | { type: "mr.created"; project: string; run: RunNotice };

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
  /** The end of the run's readable log, lines that looked like secrets hidden: runs.get only. */
  log?: string;
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
  text: string;
  requestedBy: string;
  createdAt: string;
  /** Kept by the hub to cut `grant`; the web hub never sends it to machines. */
  sender?: ChatSender;
  /** Hub token for the leader's MCP calls while it writes this reply: the sender's rights, never more than the machine's. */
  grant?: string;
}

/** A run a machine tells the hub about: it failed for good, or it opened a merge request. Not stored. */
export interface RunNotice {
  kind: "failed" | "mr";
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
