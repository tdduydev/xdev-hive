import { z } from "zod";
import { HiveError } from "./errors.ts";
import { ACCOUNT_ID, AGENT_ROLES, agentProfileSchema, MAX_CANDIDATES, RUN_STATUSES } from "./agents.ts";
import { MACHINE_ID, PROJECT_NAME } from "./keys.ts";
import type { SkillSummary } from "./skills.ts";
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
  type RunRecord,
  type RunRequest,
  type ChatAction,
  type ChatMessage,
  type ChatRequest,
  type ChatThread,
  type Doc,
  type DocSummary,
  type DocVersion,
  type Machine,
  type MachineCommand,
  type MachineDetail,
  type Memory,
  type MemorySearchInfo,
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
/** Why a machine could not do what the hub asked: the message, and its key in the UI catalogue when there is one. */
const machineError = z.object({
  message: z.string().max(2000),
  key: z.string().max(80).optional(),
  vars: z.record(z.string().max(40), z.union([z.string().max(300), z.number()])).optional(),
});
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
/** What a chat leader may ask for (chat.propose): the input of the call a project manager then confirms, project left out. */
const chatAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("task.create"), id: taskId, title: z.string().min(1).max(300), dependsOn: z.array(taskId).max(20).default([]) }),
  z.object({ kind: z.literal("task.update"), id: taskId, status: z.enum(TASK_STATUSES), note: z.string().max(2000).optional() }),
  z.object({
    kind: z.literal("run.dispatch"),
    taskId,
    role: z.enum(AGENT_ROLES).default("implement"),
    /** A machine's hub id or name; the chat's own machine when left out. */
    machine: machineRef.optional(),
    profileId: z.string().max(40).nullable().default(null),
    reviewAfter: z.boolean().default(false),
    candidates: z.number().int().min(1).max(MAX_CANDIDATES).default(1),
    instructions: z.string().max(4000).default(""),
  }),
]);

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

  /** With a project: the skills its agents get (the project's own replace the team's of the same name). Without: every skill. */
  "skills.list": z.object({ project: project.optional() }),

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
  "memory.searchInfo": z.object({}),
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
    /** Projects the app has a repo for: the web offers only these machines for a project's runs. */
    projects: z.array(project).max(200).optional(),
    /** The user lets project managers queue runs on this machine from the web. */
    acceptsRuns: z.boolean().optional(),
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
  /** A machine's runs as they are now (changed ones only): status, current step, the end of the log. Hub mode. */
  "runs.push": z.object({
    machine: z.string().regex(MACHINE_ID),
    runs: z
      .array(
        z.object({
          runId: z.string().regex(/^[\w.-]{1,40}$/),
          project,
          taskId,
          taskTitle: z.string().max(300),
          role: z.enum(AGENT_ROLES),
          status: z.enum(RUN_STATUSES),
          profileId: z.string().max(40).nullable(),
          activity: z.string().max(300).nullable().default(null),
          summary: z.string().max(4000).nullable().default(null),
          error: z.string().max(2000).nullable().default(null),
          branch: z.string().max(200).nullable().default(null),
          commits: z.number().int().min(0).default(0),
          mrUrl: z.url({ protocol: /^https?$/ }).max(500).nullable().default(null),
          costUsd: z.number().min(0).nullable().default(null),
          log: z.string().max(60_000).default(""),
          createdAt: z.iso.datetime(),
          startedAt: z.iso.datetime().nullable().default(null),
          finishedAt: z.iso.datetime().nullable().default(null),
        }),
      )
      .max(20),
  }),
  /** Runs the hub was told about, the newest runs first (no log); a project's, or every project the caller sees. */
  "runs.list": z.object({ project: project.optional(), limit: z.number().int().min(1).max(200).default(50) }),
  /** One run with the end of its log. */
  "runs.get": z.object({ machineId: z.string().min(1).max(200), runId: z.string().regex(/^[\w.-]{1,40}$/) }),
  /**
   * A project manager asks one machine to start a run, as its Board would: the machine gets it with its next
   * heartbeat. Only a machine that is online, accepts runs from the hub and has the project's repo.
   */
  "runs.dispatch": z.object({
    machineId: machineRef,
    project,
    taskId,
    role: z.enum(AGENT_ROLES).default("implement"),
    /** A profile of that machine; null rotates. */
    profileId: z.string().max(40).nullable().default(null),
    reviewAfter: z.boolean().default(false),
    candidates: z.number().int().min(1).max(MAX_CANDIDATES).default(1),
    instructions: z.string().max(4000).default(""),
  }),
  /** Run requests, the newest first: a project's, or every project the caller sees. */
  "runs.requests": z.object({ project: project.optional(), limit: z.number().int().min(1).max(200).default(50) }),
  /** Withdraws a request no machine took yet. */
  "runs.cancelRequest": z.object({ id }),
  /** The machine a request is for says whether it queued the run (only for requests addressed to itself). */
  "runs.requestResult": z.object({
    id,
    status: z.enum(["accepted", "rejected"]),
    runId: z.string().regex(/^[\w.-]{1,40}$/).nullable().default(null),
    error: machineError.nullable().default(null),
  }),
  /** A message to a project's leader: the first of a new thread (machineId required) or the next of one. */
  "chat.send": z.object({
    project,
    threadId: id.optional(),
    machineId: machineRef.optional(),
    /** A Claude profile of that machine; null lets it pick. Kept for the thread. */
    profileId: z.string().max(40).nullable().default(null),
    title: z.string().max(120).optional(),
    text: z.string().min(1).max(8000),
  }),
  /** Threads, the most recently active first: a project's, or every project the caller sees. */
  "chat.threads": z.object({ project: project.optional(), limit: z.number().int().min(1).max(200).default(50) }),
  /** A thread with its messages; `after` a message id returns only the newer ones (for polling). */
  "chat.get": z.object({ threadId: id, after: z.number().int().min(0).default(0) }),
  /** A machine asks for the replies it should write, between heartbeats (every few seconds while it takes runs). */
  "chat.poll": z.object({}),
  /**
   * A chat leader asks for a task to be created or moved, or a run queued: only with the token of the reply it writes.
   * Nothing happens until a manager of the project confirms it (chat.decide).
   */
  "chat.propose": z.object({ action: chatAction, reason: z.string().min(1).max(500) }),
  /** A project manager confirms a leader's action, which then runs with their own rights, or sets it aside. */
  "chat.decide": z.object({ actionId: id, accept: z.boolean() }),
  /** Stops a reply that is waiting or being written; the machine hears it at its next progress report. */
  "chat.cancel": z.object({ replyId: id }),
  /** The machine writing a reply says how far it got; the answer tells it whether someone cancelled it. */
  "chat.progress": z.object({
    replyId: id,
    text: z.string().max(40_000).default(""),
    steps: z.string().max(40_000).default(""),
    activity: z.string().max(300).nullable().default(null),
  }),
  "chat.finish": z.object({
    replyId: id,
    status: z.enum(["done", "failed"]),
    text: z.string().max(40_000).default(""),
    steps: z.string().max(40_000).default(""),
    /** The Claude Code session the next reply of the thread resumes. */
    sessionId: z.string().regex(/^[\w-]{1,100}$/).nullable().default(null),
    costUsd: z.number().min(0).nullable().default(null),
    error: machineError.nullable().default(null),
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
  "skills.list": SkillSummary[];
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
  "memory.searchInfo": MemorySearchInfo;
  "memory.checkFiles": { flagged: number; baselined: number };
  "memory.remove": { removed: boolean };
  "tasks.list": Task[];
  "tasks.create": Task;
  "tasks.setDeps": Task;
  "tasks.next": Task[];
  "tasks.claim": { claimed: boolean; task: Task | null };
  "tasks.update": Task;
  "machines.heartbeat": {
    duplicate: boolean;
    cooldowns: QuotaCooldown[];
    policy: TeamPolicy;
    commands: MachineCommand[];
    /** Pending run requests for this machine; only while it accepts runs from the hub. */
    runRequests: RunRequest[];
    /** Chat replies this machine is asked to write; same condition. */
    chatRequests: ChatRequest[];
  };
  "machines.list": Machine[];
  "costs.summary": CostSummary;
  "runs.report": RunNotice;
  "runs.push": { stored: number };
  "runs.list": RunRecord[];
  "runs.get": RunRecord | null;
  "runs.dispatch": RunRequest;
  "runs.requests": RunRequest[];
  "runs.cancelRequest": RunRequest;
  "runs.requestResult": RunRequest;
  "chat.send": { thread: ChatThread; message: ChatMessage; reply: ChatMessage };
  "chat.threads": ChatThread[];
  "chat.get": { thread: ChatThread; messages: ChatMessage[] } | null;
  "chat.poll": ChatRequest[];
  "chat.propose": ChatAction;
  "chat.decide": ChatAction;
  "chat.cancel": ChatMessage;
  "chat.progress": { cancelled: boolean };
  "chat.finish": ChatMessage;
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
  "skills.list": "viewer",
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
  "memory.searchInfo": "viewer",
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
  "runs.push": "agent",
  "runs.list": "viewer",
  "runs.get": "viewer",
  // Also "manage" on the project: a project manager, never an agent token.
  "runs.dispatch": "agent",
  "runs.requests": "viewer",
  "runs.cancelRequest": "agent",
  "runs.requestResult": "agent",
  // Also "manage" on the project, like runs.dispatch.
  "chat.send": "agent",
  "chat.threads": "viewer",
  "chat.get": "viewer",
  "chat.poll": "agent",
  "chat.propose": "agent",
  "chat.decide": "agent",
  "chat.cancel": "agent",
  // Only the machine the thread is on.
  "chat.progress": "agent",
  "chat.finish": "agent",
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
