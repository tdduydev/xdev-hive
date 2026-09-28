import { z } from "zod";
import { HiveError } from "./errors.ts";
import { ACCOUNT_ID, AGENT_ROLES, agentProfileSchema } from "./agents.ts";
import { MACHINE_ID, PROJECT_NAME } from "./keys.ts";
import {
  MEMORY_KINDS,
  MEMORY_STATUSES,
  POLICY_CLIS,
  POLICY_REPO_PARTS,
  PROPOSAL_STATUSES,
  TASK_STATUSES,
  type Actor,
  type AuditEntry,
  type CostSummary,
  type RunNotice,
  type Doc,
  type DocSummary,
  type DocVersion,
  type Machine,
  type MachineCommand,
  type MachineDetail,
  type Memory,
  type Proposal,
  type QuotaCooldown,
  type Role,
  type Task,
  type TeamPolicy,
} from "./types.ts";

const docKey = z.string().min(1).max(200);
const project = z.string().regex(PROJECT_NAME, "project must be lowercase letters, digits, . _ -");
const id = z.number().int().positive();
// Repo-relative glob, e.g. apps/web/** or src/**/*.{ts,tsx}. No leading "/", no "..", no spaces.
const pathGlob = z
  .string()
  .min(1)
  .max(200)
  .regex(/^(?!\/)(?!(?:.*\/)?\.\.(?:\/|$))[\w.*?\/{}\[\],@+-]+$/, "path glob: repo-relative, e.g. apps/web/** or **/*.test.ts");
const taskId = z.string().regex(/^[A-Za-z0-9._-]{1,100}$/, "task id: letters, digits, . _ -");
const content = z.string().max(200_000);
/** A path from the repo root: no leading slash, no backslash, no empty or ".." segment. */
const repoPath = z
  .string()
  .min(1)
  .max(300)
  .refine((p) => !p.startsWith("/") && !p.includes("\\") && !p.split("/").some((s) => s === "" || s === ".."), "path from the repo root, like src/app.ts");
const objectId = z.string().regex(/^[0-9a-f]{40,64}$/);
const account = z.string().regex(ACCOUNT_ID, "account: letters, digits, . _ @ : + -");
const machineRef = z.string().min(1).max(200);
/** cli:<kind> · shim · <project>:<part> — ids of the desktop's setup items. */
const setupItemId = z.string().regex(/^(cli:[a-z]+|shim|[a-z0-9][a-z0-9._-]{0,99}:(agents|codegraph-mcp|codegraph-index|superpowers))$/, "unknown setup item");

const setupItem = z.object({
  id: z.string().max(200),
  label: z.string().max(100),
  state: z.enum(["installed", "missing", "outdated", "manual"]),
  detail: z.string().max(1000),
  action: z.string().max(60).nullable(),
});
const setupReport = z.object({
  machine: z.array(setupItem).max(20),
  projects: z.array(z.object({ project, repo: z.string().max(500), items: z.array(setupItem).max(10) })).max(50),
});
const reportedProfile = z.object({
  id: z.string().max(40),
  label: z.string().max(80),
  kind: z.string().max(20),
  enabled: z.boolean(),
  account: z.string().max(100).nullable(),
  installed: z.boolean(),
  loggedIn: z.boolean().nullable().default(null),
  sessionPercent: z.number().min(0).max(1000).nullable().default(null),
  weekPercent: z.number().min(0).max(1000).nullable().default(null),
  weekResets: z.string().max(80).nullable().default(null),
  overLimit: z.boolean().default(false),
  cooldownUntil: z.string().max(40).nullable(),
  runs: z.number().int().min(0),
  rateLimited: z.number().int().min(0),
});
/** A finished run's cost estimate, sent once by the machine that ran it. */
const runCost = z.object({
  runId: z.string().regex(/^[\w.-]{1,40}$/),
  project,
  taskId,
  profileId: z.string().max(40),
  account: account.nullable(),
  costUsd: z.number().min(0).max(10_000),
  inputTokens: z.number().int().min(0).nullable(),
  outputTokens: z.number().int().min(0).nullable(),
  finishedAt: z.iso.datetime(),
});

/** Team profile templates never carry env: login dirs and keys belong to each machine. */
const profileTemplate = agentProfileSchema.extend({
  env: z.record(z.string(), z.string()).default({}).refine((env) => Object.keys(env).length === 0, "profile templates cannot carry env"),
});

/** Every operation the Hive backend supports. Web RPC, desktop IPC and MCP tools all go through this table. */
export const schemas = {
  "docs.list": z.object({
    project: project.optional(),
    scope: z.enum(["org", "project"]).optional(),
  }),
  "docs.get": z.object({ key: docKey }),
  "docs.history": z.object({ key: docKey }),
  "docs.save": z.object({
    key: docKey,
    content,
    title: z.string().min(1).max(200).optional(),
    includeInAgents: z.boolean().optional(),
    /** Globs the doc applies to (replaces the current ones); [] makes it a doc for the whole repo again. */
    paths: z.array(pathGlob).max(20).optional(),
    note: z.string().max(500).optional(),
    /** Optimistic lock: the version the editor loaded (0 = creating a new doc). */
    baseVersion: z.number().int().min(0).optional(),
  }),

  "proposals.list": z.object({
    status: z.enum(PROPOSAL_STATUSES).optional(),
    docKey: docKey.optional(),
  }),
  "proposals.create": z.object({
    docKey,
    baseVersion: z.number().int().min(0),
    content,
    reason: z.string().min(1).max(500),
  }),
  "proposals.approve": z.object({ id }),
  "proposals.reject": z.object({ id, note: z.string().max(500).optional() }),

  /** A project's memory plus the team-wide (shared) entries; no project: shared entries only; anyProject: everything. */
  "memory.search": z.object({
    project: project.optional(),
    query: z.string().max(500).default(""),
    limit: z.number().int().min(1).max(50).default(10),
    includeShared: z.boolean().default(true),
    anyProject: z.boolean().default(false),
    /** Entries nobody used for the stale period are left out unless asked for. */
    includeStale: z.boolean().default(false),
  }),
  /** project: that project (plus shared with includeShared) · null: shared only · omitted: everything. */
  "memory.list": z.object({
    project: project.nullable().optional(),
    includeShared: z.boolean().default(false),
    status: z.enum(MEMORY_STATUSES).optional(),
    /** true: only the stale entries, to review them. */
    stale: z.boolean().optional(),
    limit: z.number().int().min(1).max(500).default(200),
  }),
  /** shared: true records a team-wide entry that every project sees (no project then). */
  "memory.write": z
    .object({
      project: project.optional(),
      shared: z.boolean().default(false),
      kind: z.enum(MEMORY_KINDS),
      content: z.string().min(1).max(4000),
      taskId: taskId.optional(),
      /** Files the fact is about; the entry is flagged for review when they change. */
      files: z.array(repoPath).max(10).default([]),
      /** An older entry of the same project this one replaces (the fact changed). */
      supersedes: id.optional(),
      /** An entry this one disagrees with; a person decides which is right. */
      contradicts: id.optional(),
    })
    .refine((m) => (m.shared ? m.project === undefined : m.project !== undefined), "memory needs a project, or shared: true without one"),
  "memory.approve": z.object({ id }),
  /** Settles a conflict: keep this entry (the other is replaced by it), the other, or both (no conflict after all). */
  "memory.resolve": z.object({ id, other: id, keep: z.enum(["this", "other", "both"]) }),
  /** Still true: counts as used now, so it is no longer stale, and the cited files as they are now become the baseline. */
  "memory.keep": z.object({ id }),
  /** What the project's cited files are now (null: gone), from a machine that has the repo. */
  "memory.checkFiles": z.object({
    project,
    files: z.array(z.object({ path: repoPath, sha: objectId.nullable() })).max(2000),
  }),
  "memory.remove": z.object({ id }),

  "tasks.list": z.object({
    project: project.optional(),
    status: z.enum(TASK_STATUSES).optional(),
  }),
  "tasks.create": z.object({ id: taskId, project, title: z.string().min(1).max(300), dependsOn: z.array(taskId).max(20).default([]) }),
  /** Replaces what the task depends on (tasks of the same project, no cycles). */
  "tasks.setDeps": z.object({ id: taskId, dependsOn: z.array(taskId).max(20) }),
  /** Tasks ready to start: to do, nothing they depend on is open, nobody holds them. Those that unlock the most come first. */
  "tasks.next": z.object({ project: project.optional(), limit: z.number().int().min(1).max(20).default(5) }),
  "tasks.claim": z.object({
    id: taskId,
    leaseMinutes: z.number().int().min(5).max(24 * 60).default(120),
  }),
  "tasks.update": z.object({
    id: taskId,
    status: z.enum(TASK_STATUSES),
    note: z.string().max(2000).optional(),
  }),

  /** Desktop runners report every ~30 s; the reply carries the shared quota cooldowns. */
  "machines.heartbeat": z.object({
    machine: z.string().regex(MACHINE_ID),
    /** Random per app start, to tell two live instances apart from a restart. */
    instance: z.string().regex(/^[a-f0-9]{8,64}$/),
    version: z.string().max(40).default(""),
    /** The machine's Setup page result; sent after each check, kept by the hub until the next one. */
    setup: z.object({ checkedAt: z.iso.datetime(), report: setupReport }).optional(),
    profiles: z.array(reportedProfile).max(50).optional(),
    runs: z
      .array(
        z.object({
          runId: z.string().max(40),
          project,
          taskId,
          taskTitle: z.string().max(300),
          role: z.enum(AGENT_ROLES),
          status: z.enum(["queued", "running"]),
          profileId: z.string().max(40).nullable(),
          since: z.string().max(40),
        }),
      )
      .max(100)
      .default([]),
    /** Finished runs not reported yet; the hub keeps the first report of each run. */
    costs: z.array(runCost).max(100).default([]),
  }),
  "machines.list": z.object({}),
  /** A machine reports a run that failed for good or opened a merge request (for the hub's webhooks). */
  "runs.report": z.object({
    kind: z.enum(["failed", "mr"]),
    project,
    taskId,
    taskTitle: z.string().max(300),
    runId: z.string().regex(/^[\w.-]{1,40}$/),
    profileId: z.string().max(40).nullable(),
    role: z.enum(AGENT_ROLES),
    error: z.string().max(2000).nullable().default(null),
    mrUrl: z.url({ protocol: /^https?$/ }).max(500).nullable().default(null),
    mrIid: z.number().int().positive().nullable().default(null),
  }),
  "costs.summary": z.object({}),
  "machines.remove": z.object({ id: z.string().min(1).max(200) }),

  "cooldowns.list": z.object({}),
  "cooldowns.set": z.object({ account, until: z.iso.datetime(), reason: z.string().max(300) }),
  "cooldowns.clear": z.object({ account }),

  /** A machine reports progress on a command it was sent (only for commands addressed to itself). */
  "machines.commandResult": z.object({
    id,
    status: z.enum(["running", "done", "failed", "rejected"]),
    output: z.string().max(8000).optional(),
  }),

  "policy.get": z.object({}),
  "policy.set": z.object({
    requiredClis: z.array(z.enum(POLICY_CLIS)).max(POLICY_CLIS.length).default([]),
    requireShim: z.boolean().default(false),
    projects: z.record(project, z.array(z.enum(POLICY_REPO_PARTS)).max(POLICY_REPO_PARTS.length)).default({}),
    profileTemplates: z
      .array(profileTemplate)
      .max(20)
      .default([])
      .refine((list) => new Set(list.map((p) => p.id)).size === list.length, "template ids must be unique"),
  }),

  "admin.machines": z.object({}),
  "admin.commandCreate": z.object({ machineId: machineRef, itemId: setupItemId }),
  "admin.commandCancel": z.object({ id }),
  "admin.audit": z.object({
    limit: z.number().int().min(1).max(1000).default(200),
    action: z.string().max(60).optional(),
  }),
} as const;

export type Method = keyof typeof schemas;
/** What callers send (defaults optional). */
export type MethodInput<M extends Method> = z.input<(typeof schemas)[M]>;
/** What handlers receive (defaults applied). */
export type ParsedInput<M extends Method> = z.output<(typeof schemas)[M]>;

export interface MethodOutput {
  "docs.list": DocSummary[];
  "docs.get": Doc | null;
  "docs.history": DocVersion[];
  "docs.save": Doc;
  "proposals.list": Proposal[];
  "proposals.create": Proposal;
  "proposals.approve": Proposal;
  "proposals.reject": Proposal;
  "memory.search": Memory[];
  "memory.list": Memory[];
  "memory.write": Memory;
  "memory.approve": Memory;
  "memory.resolve": Memory;
  "memory.keep": Memory;
  "memory.checkFiles": { flagged: number; baselined: number };
  "memory.remove": { removed: boolean };
  "tasks.list": Task[];
  "tasks.create": Task;
  "tasks.setDeps": Task;
  "tasks.next": Task[];
  "tasks.claim": { claimed: boolean; task: Task | null };
  "tasks.update": Task;
  "machines.heartbeat": { duplicate: boolean; cooldowns: QuotaCooldown[]; policy: TeamPolicy; commands: MachineCommand[] };
  "machines.list": Machine[];
  "costs.summary": CostSummary;
  "runs.report": RunNotice;
  "machines.remove": { removed: boolean };
  "cooldowns.list": QuotaCooldown[];
  /** null when `until` is already past (nothing to rest). */
  "cooldowns.set": QuotaCooldown | null;
  "cooldowns.clear": { cleared: boolean };
  "machines.commandResult": MachineCommand;
  "policy.get": TeamPolicy;
  "policy.set": TeamPolicy;
  "admin.machines": MachineDetail[];
  "admin.commandCreate": MachineCommand;
  "admin.commandCancel": MachineCommand;
  "admin.audit": AuditEntry[];
}

/**
 * Minimum role per method (viewer < agent = member < admin). Writes on a project also need a level on
 * that project (see access.ts and SqliteHive): docs.save, approvals, memory removal and task creation
 * need "manage", which unrestricted actors only have as admin — the old rule.
 */
export const METHOD_ROLES: Record<Method, Role> = {
  "docs.list": "viewer",
  "docs.get": "viewer",
  "docs.history": "viewer",
  "docs.save": "agent",
  "proposals.list": "viewer",
  "proposals.create": "agent",
  "proposals.approve": "agent",
  "proposals.reject": "agent",
  "memory.search": "viewer",
  "memory.list": "viewer",
  "memory.write": "agent",
  "memory.approve": "agent",
  "memory.resolve": "agent",
  "memory.keep": "agent",
  "memory.checkFiles": "agent",
  "memory.remove": "agent",
  "tasks.list": "viewer",
  "tasks.create": "agent",
  "tasks.setDeps": "agent",
  "tasks.next": "viewer",
  "tasks.claim": "agent",
  "tasks.update": "agent",
  "machines.heartbeat": "agent",
  "machines.list": "viewer",
  "costs.summary": "viewer",
  "runs.report": "agent",
  "machines.remove": "admin",
  "cooldowns.list": "viewer",
  "cooldowns.set": "agent",
  "cooldowns.clear": "agent",
  "machines.commandResult": "agent",
  "policy.get": "viewer",
  "policy.set": "admin",
  "admin.machines": "admin",
  "admin.commandCreate": "admin",
  "admin.commandCancel": "admin",
  "admin.audit": "admin",
};

export const ROLE_RANK: Record<Role, number> = { viewer: 0, agent: 1, member: 1, admin: 2 };
export const ROLES = Object.keys(ROLE_RANK) as Role[];
/** Roles a token can have. member: a machine token from a person's desktop sign-in (their own rights). */
export const TOKEN_ROLES: Role[] = ["viewer", "agent", "member", "admin"];

export function isMethod(value: unknown): value is Method {
  return typeof value === "string" && Object.hasOwn(schemas, value);
}

export function authorize(method: Method, actor: Actor): void {
  const needed = METHOD_ROLES[method];
  if (ROLE_RANK[actor.role] < ROLE_RANK[needed]) {
    throw new HiveError("forbidden", `${method} requires role "${needed}", you are "${actor.role}".`, { key: "errors.roleTooLow" });
  }
}

export function parseInput<M extends Method>(method: M, raw: unknown): ParsedInput<M> {
  const result = schemas[method].safeParse(raw ?? {});
  if (!result.success) throw new HiveError("bad_request", z.prettifyError(result.error));
  return result.data as ParsedInput<M>;
}

/**
 * The one interface every transport implements or consumes: SQLite (local/hub), HTTP (desktop → hub),
 * IPC (renderer → main) and MCP (agent → backend).
 */
export interface HiveBackend {
  call<M extends Method>(method: M, input: MethodInput<M>, actor: Actor): Promise<MethodOutput[M]>;
}
