export type Role = "viewer" | "agent" | "admin";
export type DocScope = "org" | "project";

export interface Actor {
  /** Who is acting, e.g. `claude@duy` or `duy`. Recorded on every write. */
  name: string;
  role: Role;
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
  project: string;
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
