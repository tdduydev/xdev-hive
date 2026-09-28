import type { Access } from "./access.ts";
import type { AgentProfile } from "./agents.ts";

/** member: a person's hub account (what it may do comes from its per-project grants). */
export type Role = "viewer" | "agent" | "member" | "admin";
export type DocScope = "org" | "project";

export interface Actor {
  /** Who is acting, e.g. `claude@duy` or `duy`. Recorded on every write. */
  name: string;
  role: Role;
  /** Per-project grants of a hub account; absent = unrestricted (local mode, hub admins, tokens of no account). */
  access?: Access;
}

export interface DocSummary {
  key: string;
  scope: DocScope;
  project: string | null;
  title: string;
  version: number;
  includeInAgents: boolean;
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
  createdAt: string;
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

/** Admin view of a machine: the heartbeat plus what it reported about its setup. */
export interface MachineDetail extends Machine {
  setup: SetupReport | null;
  setupAt: string | null;
  profiles: ReportedProfile[];
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
}

/** A subscription account resting after a rate limit, shared by every machine logged into it. */
export interface QuotaCooldown {
  account: string;
  until: string;
  reason: string;
  reportedBy: string;
  updatedAt: string;
}
