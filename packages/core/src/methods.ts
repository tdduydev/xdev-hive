import { z } from "zod";
import { HiveError } from "./errors.ts";
import { agentPolicyPartSchema, agentPolicySchema, type AgentPolicy, type AgentPolicyView } from "./agent-policy.ts";
import { BUDGET_USER, budgetSchema, type BudgetBlock, type BudgetUsage } from "./budgets.ts";
import { ACCOUNT_ID, AGENT_KINDS, AGENT_ROLES, PREFER_KINDS, agentProfileSchema, MAX_CANDIDATES, RUN_STATUSES, WORK_ROLES } from "./agents.ts";
import { VERDICTS } from "./verdict.ts";
import { CHAT_FILES_PER_MESSAGE } from "./chatfiles.ts";
import { DOC_ASSET_MAX_BYTES } from "./doclinks.ts";
import { MR_STATUSES, PIPELINE_STATUSES } from "./gitlab.ts";
import { MACHINE_ID, PROJECT_NAME } from "./keys.ts";
import { MAX_MAP_PART, MAX_MAP_PARTS, MAX_MAP_PROMPT } from "./mapreduce.ts";
import type { SkillSummary } from "./skills.ts";
import { SPEC_DIR, SPEC_FEATURES_MAX, SPEC_FILE_MAX, SPEC_STEPS, type SpecFeature, type SpecFeatureDetail, type SpecTaskPlan } from "./speckit.ts";
import { toolEntrySchema } from "./tools.ts";
import { TASK_KINDS, TASK_RISKS, TASK_SIZES } from "./task-classify.ts";
import { GATE_STATUSES, gateModesSchema, MAX_FIX_ROUNDS, type SdlcFlow, type SdlcFlowTask, type SdlcGateRecord, type SdlcPolicyView } from "./sdlc.ts";
import {
  MEMORY_KINDS,
  MEMORY_STATUSES,
  POLICY_CLIS,
  POLICY_REPO_PARTS,
  PROPOSAL_STATUSES,
  SELF_APPROVALS,
  TASK_STATUSES,
  type Actor,
  type AgentsPaused,
  type AgentsStop,
  type AuditEntry,
  type CostSummary,
  type RunNotice,
  type RunCancel,
  type RunRecord,
  type RunGroup,
  type RunRequest,
  CHAT_ACTION_KINDS,
  CHAT_EFFORTS,
  LEADER_COMMAND,
  MAX_LEADER_COMMANDS,
  type ChatAction,
  type ChatDefaults,
  type ChatMessage,
  type ChatRequest,
  type ChatThread,
  type Doc,
  type AgentContext,
  type DocAsset,
  type DocAssist,
  type DocAssistJob,
  type DocLinks,
  DOC_ASSIST_KINDS,
  type DocSummary,
  type DocVersion,
  type HiveSystem,
  type Machine,
  type ProfileChange,
  type RunMergeOrder,
  type MachineCommand,
  type MachineTools,
  type MachineDetail,
  type MachineSetupMissing,
  type Memory,
  type MemorySearchInfo,
  type ProjectDeleted,
  type ProjectSummary,
  type ProjectSyncState,
  type Proposal,
  type QuotaCooldown,
  type Role,
  type Task,
  type TaskAgentQueueItem,
  type TeamPolicy,
  type ToolStatus,
  type ToolView,
} from "./types.ts";

const docKey = z.string().min(1).max(200);
const project = z.string().regex(PROJECT_NAME, "project must be lowercase letters, digits, . _ -");
/** Only these projects (a system's, roadmap 19b); none listed: nothing. With `project` too, both must hold. */
const projectList = z.array(project).max(200).optional();
const systemName = z.string().regex(PROJECT_NAME, "system name must be lowercase letters, digits, . _ -");
const id = z.number().int().positive();
// Repo-relative glob, e.g. apps/web/** or src/**/*.{ts,tsx}. No leading "/", no "..", no spaces.
const pathGlob = z
  .string()
  .min(1)
  .max(200)
  .regex(/^(?!\/)(?!(?:.*\/)?\.\.(?:\/|$))[\w.*?\/{}\[\],@+-]+$/, "path glob: repo-relative, e.g. apps/web/** or **/*.test.ts");
const taskId = z.string().regex(/^[A-Za-z0-9._-]{1,100}$/, "task id: letters, digits, . _ -");
const content = z.string().max(200_000);
const specText = z.string().max(SPEC_FILE_MAX).nullable();
/** A path from the repo root: no leading slash, no backslash, no empty or ".." segment. */
const repoPath = z
  .string()
  .min(1)
  .max(300)
  .refine((p) => !p.startsWith("/") && !p.includes("\\") && !p.split("/").some((s) => s === "" || s === ".."), "path from the repo root, like src/app.ts");
const objectId = z.string().regex(/^[0-9a-f]{40,64}$/);
const account = z.string().regex(ACCOUNT_ID, "account: letters, digits, . _ @ : + -");
const machineRef = z.string().min(1).max(200);
/** A run's id on its machine (R-1a2b3c). */
const runId = z.string().regex(/^[\w.-]{1,40}$/);
/** Why a machine could not do what the hub asked: the message, and its key in the UI catalogue when there is one. */
const machineError = z.object({
  message: z.string().max(2000),
  key: z.string().max(80).optional(),
  vars: z.record(z.string().max(40), z.union([z.string().max(300), z.number()])).optional(),
});
/** cli:<kind> · shim · tool:<id> (a hub tool, TOOL_ID) · <project>:<part> — ids of the desktop's setup items. */
const setupItemId = z
  .string()
  .regex(/^(cli:[a-z]+|shim|tool:[a-z0-9][a-z0-9-]{0,39}|[a-z0-9][a-z0-9._-]{0,99}:(agents|codegraph-mcp|codegraph-index|superpowers|speckit))$/, "unknown setup item");

const setupItem = z.object({
  id: z.string().max(200),
  label: z.string().max(100),
  state: z.enum(["installed", "missing", "outdated", "manual"]),
  detail: z.string().max(1000),
  action: z.string().max(60).nullable(),
  version: z.string().max(40).nullable().optional(),
  latest: z.string().max(40).nullable().optional(),
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
  sessionResets: z.string().max(80).nullable().default(null),
  weekResets: z.string().max(80).nullable().default(null),
  usageCheckedAt: z.string().max(40).nullable().default(null),
  resetsLeft: z.number().int().nonnegative().nullable().optional(),
  fullSessionsLeft: z.number().nonnegative().nullable().optional(),
  weekPerSession: z.number().positive().nullable().optional(),
  credits: z.object({ balance: z.union([z.string().max(100), z.number()]).nullable(), hasCredits: z.boolean(), unlimited: z.boolean() }).nullable().optional(),
  planType: z.string().max(80).nullable().optional(),
  spendControlReached: z.boolean().nullable().optional(),
  overLimit: z.boolean().default(false),
  cooldownUntil: z.string().max(40).nullable(),
  runs: z.number().int().min(0),
  rateLimited: z.number().int().min(0),
  statsSince: z.string().max(40).nullable().optional(),
  priority: z.number().int().min(0).max(100).optional(),
  maxConcurrent: z.number().int().min(1).max(8).optional(),
  classify: z.boolean().optional(),
});
/** A finished run's cost estimate, sent once by the machine that ran it. */
const runCost = z.object({
  runId: z.string().regex(/^[\w.-]{1,40}$/),
  project,
  taskId,
  profileId: z.string().max(40),
  account: account.nullable(),
  /** null: the CLI gives no price (Codex); the run still counts, with its tokens (roadmap 28c). */
  costUsd: z.number().min(0).max(10_000).nullable(),
  inputTokens: z.number().int().min(0).nullable(),
  /** Input written to and read from the prompt cache (roadmap 28c); left out by older apps, the same as null. */
  cacheWriteTokens: z.number().int().min(0).nullable().default(null),
  cacheReadTokens: z.number().int().min(0).nullable().default(null),
  outputTokens: z.number().int().min(0).nullable(),
  finishedAt: z.iso.datetime(),
  /**
   * Who asked for the run on the web (its run request); null for a Board run, which the hub counts as the account of
   * the machine's token. Left out by apps older than 27b, the same as null.
   */
  requestedBy: z.string().regex(BUDGET_USER).nullable().default(null),
});

/** Team profile templates never carry env: login dirs and keys belong to each machine. */
const profileTemplate = agentProfileSchema.extend({
  env: z.record(z.string(), z.string()).default({}).refine((env) => Object.keys(env).length === 0, "profile templates cannot carry env"),
});

/** Every operation the Hive backend supports. Web RPC, desktop IPC and MCP tools all go through this table. */
/** A model for Claude Code's --model: an alias (opus) or a full name (claude-fable-5); never an option. */
const chatModel = z.string().regex(/^[a-z0-9][a-z0-9.\-]{1,63}$/, "model: an alias like opus or a model's name");

/** What a chat leader may ask for (chat.propose): the input of the call a project manager then confirms, project left out. */
const chatAction = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("task.create"),
    id: taskId,
    /** Another service of a system the chat's project is in (roadmap 19d); left out, the chat's project. */
    project: project.optional(),
    title: z.string().min(1).max(300),
    dependsOn: z.array(taskId).max(20).default([]),
    /** `taskKind`, since `kind` names the action here; tasks.create gets it as `kind`. */
    taskKind: z.enum(TASK_KINDS).optional(),
    size: z.enum(TASK_SIZES).optional(),
    risk: z.enum(TASK_RISKS).optional(),
  }),
  z.object({ kind: z.literal("task.update"), id: taskId, status: z.enum(TASK_STATUSES), note: z.string().max(2000).optional() }),
  /** Corrects what a task is (roadmap 54b): at least one of the three. */
  z.object({ kind: z.literal("task.classify"), id: taskId, taskKind: z.enum(TASK_KINDS).optional(), size: z.enum(TASK_SIZES).optional(), risk: z.enum(TASK_RISKS).optional() }),
  /** Gives a task to an agent (roadmap 50); the machine is named by hub id or name, like the kinds below. */
  z.object({ kind: z.literal("task.assign"), taskId, machine: machineRef, profileId: z.string().max(40).nullable().default(null) }),
  z.object({
    kind: z.literal("run.dispatch"),
    taskId,
    role: z.enum(WORK_ROLES).default("implement"),
    /** A machine's hub id or name; the chat's own machine when left out. */
    machine: machineRef.optional(),
    profileId: z.string().max(40).nullable().default(null),
    reviewAfter: z.boolean().default(false),
    candidates: z.number().int().min(1).max(MAX_CANDIDATES).default(1),
    instructions: z.string().max(4000).default(""),
  }),
  // The rest name a machine by hub id or name too; the project is always the chat's.
  z.object({ kind: z.literal("run.cancel"), machine: machineRef, runId }),
  z.object({ kind: z.literal("run.merge"), machine: machineRef, runId }),
  // Enabled or priority is checked in chat.propose: a refine inside a discriminated union is not kept by every zod.
  z.object({
    kind: z.literal("machine.profile"),
    machine: machineRef,
    profileId: z.string().min(1).max(40),
    enabled: z.boolean().optional(),
    priority: z.number().int().min(0).max(100).optional(),
  }),
  /** The project's part of the agent policy; null removes it (the hub's default applies). */
  z.object({ kind: z.literal("agent.policy"), policy: agentPolicyPartSchema.nullable() }),
  z.object({ kind: z.literal("agents.stop") }),
  z.object({ kind: z.literal("agents.resume") }),
  z.object({ kind: z.literal("machine.install"), machine: machineRef, itemId: setupItemId }),
  /** The chat project's own setting for a catalog tool (roadmap 28e); required left out keeps what the project has. */
  z.object({ kind: z.literal("tool.enable"), id: z.string().min(1).max(40), enabled: z.boolean().nullable(), required: z.boolean().optional() }),
]);

export const schemas = {
  "docs.list": z.object({
    project: project.optional(),
    scope: z.enum(["org", "project", "system"]).optional(),
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
    /** The page it goes under (same space; null = the top). Left out: where it is. */
    parent: docKey.nullable().optional(),
    folder: z.boolean().optional(),
    /** Written from the repo (roadmap 26); null: Hive is its home again. Left out: as it is. */
    mirror: z.object({ from: z.string().min(1).max(300), commit: z.string().regex(/^[0-9a-f]{4,64}$/) }).nullable().optional(),
  }),
  /** Puts a page under another (or at the top) without a new version. */
  "docs.move": z.object({ key: docKey, parent: docKey.nullable() }),
  "docs.links": z.object({ key: docKey }),
  /** What the project's agents get: the AGENTS.md a sync writes, what it is made of, the files, the memory (roadmap 22n). */
  "docs.context": z.object({ project }),
  /**
   * Asks every online machine that has the project to sync it (roadmap 22n): its context into the repo and the repo's
   * docs into Hive, as the Projects page's Đồng bộ. Machines hear it at their next heartbeat.
   */
  "docs.syncRequest": z.object({ project }),
  /** Each machine that has the project, with its last sync request and how it went. */
  "docs.syncStatus": z.object({ project }),
  "docs.assets": z.object({ key: docKey }),
  "docs.assetGet": z.object({ key: docKey, name: z.string().min(1).max(200) }),
  /** The file's bytes in base64; a file of the same name on the page is replaced. */
  "docs.assetPut": z.object({ key: docKey, name: z.string().min(1).max(200), data: z.string().min(1).max(Math.ceil((DOC_ASSET_MAX_BYTES * 4) / 3) + 8) }),
  "docs.assetRemove": z.object({ key: docKey, name: z.string().min(1).max(200) }),
  /**
   * Asks the writing assistant (roadmap 22k): the page as it is being edited, other pages of its space or the team's,
   * memory entries, and repo files (paths or globs, read on the machine that writes it).
   */
  "docs.assist": z.object({
    key: docKey,
    kind: z.enum(DOC_ASSIST_KINDS),
    prompt: z.string().min(1).max(4000),
    content,
    docs: z.array(docKey).max(8).default([]),
    memory: z.array(id).max(10).default([]),
    code: z.array(z.string().min(1).max(300)).max(12).default([]),
  }),
  "docs.assists": z.object({ key: docKey }),
  "docs.assistCancel": z.object({ id }),
  "docs.assistSettle": z.object({ id, outcome: z.enum(["applied", "dropped"]).nullable() }),
  /** A machine takes one ask to write: of the team's pages, or of a project it has. */
  "docs.assistTake": z.object({ projects: z.array(project).max(500).default([]), machine: z.string().max(100).optional() }),
  "docs.assistProgress": z.object({ id }),
  "docs.assistFinish": z.object({
    id,
    status: z.enum(["done", "failed"]),
    reply: z.string().max(20_000).default(""),
    markdown: content.nullable().default(null),
    profile: z.string().max(100).nullable().default(null),
    costUsd: z.number().min(0).nullable().default(null),
    error: machineError.nullable().default(null),
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
    projects: projectList,
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
    projects: projectList,
    /** That system's own memory (roadmap 19c). */
    system: systemName.optional(),
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
      /** A system's memory (roadmap 19c): every service of the system sees it. */
      system: systemName.optional(),
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
    .refine((m) => [m.project !== undefined, m.shared, m.system !== undefined].filter(Boolean).length === 1, "memory needs a project, a system, or shared: true (one of them)"),
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
    projects: projectList,
    status: z.enum(TASK_STATUSES).optional(),
  }),
  "tasks.create": z.object({
    id: taskId,
    project,
    title: z.string().min(1).max(300),
    note: z.string().max(2000).optional(),
    dependsOn: z.array(taskId).max(20).default([]),
    /** What the task is (roadmap 54b); left out, the hub's rules and its classify run fill it. */
    kind: z.enum(TASK_KINDS).optional(),
    size: z.enum(TASK_SIZES).optional(),
    risk: z.enum(TASK_RISKS).optional(),
  }),
  /** Replaces what the task depends on (tasks of the same project, no cycles). */
  "tasks.setDeps": z.object({ id: taskId, dependsOn: z.array(taskId).max(20) }),
  /** Tasks ready to start: to do, nothing they depend on is open, nobody holds them. Those that unlock the most come first. */
  "tasks.next": z.object({ project: project.optional(), projects: projectList, limit: z.number().int().min(1).max(20).default(5) }),
  "tasks.claim": z.object({
    id: taskId,
    leaseMinutes: z.number().int().min(5).max(24 * 60).default(120),
  }),
  "tasks.update": z.object({
    id: taskId,
    status: z.enum(TASK_STATUSES),
    note: z.string().max(2000).optional(),
  }),
  /** Says what a task is (roadmap 54b), by hand: what is given replaces the hub's rules and its classify run. */
  "tasks.classify": z
    .object({ id: taskId, kind: z.enum(TASK_KINDS).optional(), size: z.enum(TASK_SIZES).optional(), risk: z.enum(TASK_RISKS).optional() })
    .refine((v) => v.kind !== undefined || v.size !== undefined || v.risk !== undefined, "kind, size or risk"),
  /** The projects that turned the classify run off (on by default); only those the caller sees. */
  "tasks.classifyConfig": z.object({}),
  "tasks.setClassifyConfig": z.object({ project, enabled: z.boolean() }),
  /**
   * Gives a task to one agent (roadmap 50): the hub queues the run itself as soon as that machine has a free place and
   * the task waits for nothing. `before`: the task it goes in front of in the machine's queue; left out it keeps its
   * place when it is already that machine's, else it goes last. Assigning again clears a hold (*Chạy lại*).
   */
  "tasks.assign": z.object({
    id: taskId,
    machineId: machineRef,
    /** A plan of that machine; null lets the hub pick one of its plans when the run goes out. */
    profileId: z.string().max(40).nullable().default(null),
    before: taskId.optional(),
  }),
  "tasks.unassign": z.object({ id: taskId }),
  /** One agent's queue in order, each with why the hub has not sent it out yet; profileId null: the machine's whole queue. */
  "tasks.agentQueue": z.object({ machineId: machineRef, profileId: z.string().max(40).nullable().default(null) }),

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
  /** What the project's machines still lack to run its agents (roadmap 29a): any reader of the project, unlike admin.machines. */
  "machines.setupMissing": z.object({ project }),
  /**
   * Turns one of a machine's profiles on or off, or changes its priority (roadmap 18d): a hub admin, or the person whose
   * account the machine's token belongs to. The machine applies it at its next heartbeat, no restart.
   */
  "machines.setProfile": z
    .object({
      machineId: machineRef,
      profileId: z.string().min(1).max(40),
      enabled: z.boolean().optional(),
      priority: z.number().int().min(0).max(100).optional(),
    })
    .refine((i) => i.enabled !== undefined || i.priority !== undefined, "enabled or priority"),
  /** A machine reports a run that failed for good or opened a merge request (for the hub's webhooks). */
  "runs.report": z.object({
    kind: z.enum(["failed", "mr", "ci_limit"]),
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
          /** What the MR watcher last saw (roadmap 18c); left out by older apps, then the hub keeps what it had. */
          mr: z
            .object({
              iid: z.number().int().positive().nullable(),
              status: z.enum(MR_STATUSES).nullable(),
              draft: z.boolean(),
              pipeline: z.enum(PIPELINE_STATUSES).nullable(),
              // Lenient: one odd value must not fail the whole push; the hub keeps only an http(s) link.
              pipelineUrl: z.string().max(500).nullable(),
              checkedAt: z.string().max(40).nullable(),
            })
            .nullable()
            .optional(),
          costUsd: z.number().min(0).nullable().default(null),
          /** What RTK left out of its Bash output (roadmap 28d); left out by older apps, then the hub keeps what it had. */
          compression: z
            .object({
              tool: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
              commands: z.number().int().min(0),
              input: z.number().int().min(0),
              output: z.number().int().min(0),
              saved: z.number().int().min(0),
            })
            .nullable()
            .optional(),
          /**
           * What the run ran on (roadmap 54a): kind, model and effort as the final args set them (null: the CLI's default),
           * the router's tier, the attempt and the run it follows, a review's verdict. Each left out by older apps, then
           * the hub keeps what it had; a review's verdict the hub then reads from the summary itself.
           */
          kind: z.enum(AGENT_KINDS).nullable().optional(),
          model: z.string().max(100).nullable().optional(),
          effort: z.string().max(40).nullable().optional(),
          tier: z.string().max(40).nullable().optional(),
          attempt: z.number().int().min(1).max(1000).nullable().optional(),
          parentRun: z.string().regex(/^[\w.-]{1,40}$/).nullable().optional(),
          verdict: z.enum(VERDICTS).nullable().optional(),
          log: z.string().max(60_000).default(""),
          /** What the run changed (git diff from its base), when it changed since the last push (roadmap 22l). */
          patch: z.string().max(400_000).optional(),
          createdAt: z.iso.datetime(),
          startedAt: z.iso.datetime().nullable().default(null),
          finishedAt: z.iso.datetime().nullable().default(null),
        }),
      )
      .max(20),
  }),
  /**
   * A machine's Spec Kit features of one project as it reads them now (roadmap 20b): its earlier rows of the project
   * that are not in this push go (feature removed, branch merged); other machines' rows stay.
   */
  "specs.push": z.object({
    project,
    features: z
      .array(
        z.object({
          dir: z.string().regex(SPEC_DIR),
          /** "" for the project's target branch. */
          branch: z.string().max(200),
          commit: z.string().regex(/^[0-9a-f]{4,64}$/),
          files: z.object({ spec: specText, plan: specText, tasks: specText }),
        }),
      )
      .max(SPEC_FEATURES_MAX),
  }),
  /** Spec Kit features (no file contents): a project's, or every project the caller sees. */
  "specs.list": z.object({ project: project.optional(), projects: projectList }),
  /** One feature with its spec.md, plan.md and tasks.md. */
  "specs.get": z.object({ project, dir: z.string().regex(SPEC_DIR), branch: z.string().max(200) }),
  /**
   * A feature's tasks.md into board tasks <prefix>-T001…, with the order its template sets (roadmap 20c); dryRun only
   * plans. Tasks already on the board are left as they are.
   */
  "specs.importTasks": z.object({
    project,
    dir: z.string().regex(SPEC_DIR),
    branch: z.string().max(200),
    prefix: z.string().regex(/^[A-Za-z0-9._-]{1,40}$/).optional(),
    dryRun: z.boolean().default(false),
  }),
  /** Runs the hub was told about, the newest runs first (no log); a project's, or every project the caller sees. */
  "runs.list": z.object({ project: project.optional(), projects: projectList, limit: z.number().int().min(1).max(200).default(50) }),
  /**
   * A project manager stops a run that waits or runs on a machine taking runs from the hub: the machine hears it at
   * its next heartbeat, stops the agent and reports the run as cancelled.
   */
  "runs.cancel": z.object({ machineId: z.string().min(1).max(200), runId }),
  /**
   * Merges the run's open MR or PR (roadmap 18c): someone with Code review on the project, not the one who asked for the
   * run. The machine does it with its own GitLab or GitHub token at its next heartbeat; only one that takes runs from the hub.
   */
  "runs.merge": z.object({ machineId: z.string().min(1).max(200), runId }),
  /** The machine says how a merge asked of it went (only for its own runs). */
  "runs.mergeResult": z.object({ runId: z.string().regex(/^[\w.-]{1,40}$/), ok: z.boolean(), error: machineError.nullable().default(null) }),
  /** One run with the end of its log. */
  "runs.get": z.object({ machineId: z.string().min(1).max(200), runId: z.string().regex(/^[\w.-]{1,40}$/) }),
  /**
   * A project manager asks one machine to start a run, as its Board would: the machine gets it with its next
   * heartbeat. Only a machine that is online, accepts runs from the hub and has the project's repo.
   */
  "runs.dispatch": z.object({
    machineId: machineRef.nullable().default(null),
    project,
    taskId,
    role: z.enum(WORK_ROLES).default("implement"),
    /** A profile of that machine; null rotates. */
    profileId: z.string().max(40).nullable().default(null),
    /** Unpinned: wait for a profile of this kind while one could take the run, then any (roadmap 24c). */
    preferKind: z.enum(PREFER_KINDS).nullable().default(null),
    reviewAfter: z.boolean().default(false),
    candidates: z.number().int().min(1).max(MAX_CANDIDATES).default(1),
    instructions: z.string().max(4000).default(""),
  }),
  /**
   * A free prompt from the web (roadmap 32b): a new task P-<n> of the project holds it, and one machine is asked to
   * run it, in one go. Checked like runs.dispatch; nothing is made when a check fails.
   */
  "runs.prompt": z.object({
    project,
    /** Left out: the prompt's first line. */
    title: z.string().max(120).optional(),
    prompt: z.string().min(1).max(4000),
    machineId: machineRef,
    /** A profile of that machine; null rotates. */
    profileId: z.string().max(40).nullable().default(null),
    /** Unpinned: wait for a profile of this kind while one could take the run, then any (roadmap 24c). */
    preferKind: z.enum(PREFER_KINDS).nullable().default(null),
    reviewAfter: z.boolean().default(false),
  }),
  /**
   * A run group (roadmap 31a): several tasks, each on a machine (or any free one, picked by the hub when it is its
   * turn) and profile. The hub holds them and sends at most maxParallel at a time, the next when a run ends.
   */
  "runs.dispatchMany": z.object({
    project,
    title: z.string().max(120).default(""),
    items: z
      .array(
        z.object({
          taskId,
          /** null: any machine that takes the project's runs and has a free place when the item's turn comes. */
          machineId: machineRef.nullable().default(null),
          profileId: z.string().max(40).nullable().default(null),
          /** Unpinned: wait for a profile of this kind while one could take the run, then any (roadmap 24c). */
          preferKind: z.enum(PREFER_KINDS).nullable().default(null),
          role: z.enum(WORK_ROLES).default("implement"),
        }),
      )
      .min(1)
      .max(50),
    maxParallel: z.number().int().min(1).max(20).nullable().default(null),
    reviewAfter: z.boolean().default(false),
    instructions: z.string().max(4000).default(""),
  }),
  /**
   * One prompt for several agents at once (roadmap 31e): task P-<n> holds it, and each target gets its own task
   * P-<n>-a, -b… so they run side by side; P-<n> waits for them until one is picked (runs.pickWinner).
   */
  "runs.fanout": z.object({
    project,
    title: z.string().max(120).optional(),
    prompt: z.string().min(1).max(4000),
    targets: z
      .array(z.object({ machineId: machineRef.nullable().default(null), profileId: z.string().max(40).nullable().default(null) }))
      .min(2)
      .max(8),
    reviewAfter: z.boolean().default(false),
  }),
  /** Keeps one task of a fan-out group: the others and the prompt's task are done, the kept one goes on (review, MR). */
  "runs.pickWinner": z.object({ groupId: id, taskId }),
  /**
   * A big job in parts (roadmap 31c): task P-<n> for the job, P-<n>-1… for the parts, each run by an agent of one machine
   * at the same time (profiles in turn, or the machine's pick); when every part is done, the hub queues a run on P-<n>
   * that merges their branches, always. groupId: the parts of a group an agent split (runs.mapSplit), checked by a person.
   */
  "runs.mapReduce": z.object({
    project,
    groupId: id.optional(),
    title: z.string().max(120).optional(),
    /** The job; left out with groupId (its task's note has it). */
    prompt: z.string().max(MAX_MAP_PROMPT).default(""),
    parts: z.array(z.string().trim().min(1).max(MAX_MAP_PART)).min(2).max(MAX_MAP_PARTS),
    /** null: the machine with the most free places now. Every part and the merge run there. */
    machineId: machineRef.nullable().default(null),
    /** The parts take these in turn; none: the machine picks for each. */
    profiles: z.array(z.string().max(40)).max(MAX_MAP_PARTS).default([]),
    maxParallel: z.number().int().min(1).max(20).nullable().default(null),
    /** The merged result's cross-review (the parts get none). */
    reviewAfter: z.boolean().default(true),
  }),
  /** Asks an agent to split a big job into parts (roadmap 31c): a plan run on the job's task lists them for a person to check. */
  "runs.mapSplit": z.object({
    project,
    title: z.string().max(120).optional(),
    prompt: z.string().min(1).max(MAX_MAP_PROMPT),
    machineId: machineRef.nullable().default(null),
    profileId: z.string().max(40).nullable().default(null),
  }),
  /** Starts a stopped map-reduce group again: its failed parts, or its merge, or its split. */
  "runs.resumeGroup": z.object({ id }),
  /** Run groups, the newest first: a project's, or every project the caller sees. */
  "runs.groups": z.object({ project: project.optional(), projects: projectList, limit: z.number().int().min(1).max(100).default(30) }),
  /** Stops what a group has not started: its held items, and requests no machine took. Runs going on keep going. */
  "runs.cancelGroup": z.object({ id }),
  /** Run requests, the newest first: a project's, or every project the caller sees. */
  "runs.requests": z.object({ project: project.optional(), projects: projectList, limit: z.number().int().min(1).max(200).default(50) }),
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
    /** A Claude profile of that machine; null lets it pick. Kept for the thread. Left out: the project's default. */
    profileId: z.string().max(40).nullable().optional(),
    /** A new thread's model and effort; left out: the project's defaults. */
    model: chatModel.nullable().optional(),
    effort: z.enum(CHAT_EFFORTS).nullable().optional(),
    title: z.string().max(120).optional(),
    text: z.string().min(1).max(8000),
    /** Files the sender uploaded for this message (POST /api/chat/files) and has not sent yet. */
    files: z.array(id).max(CHAT_FILES_PER_MESSAGE).default([]),
  }),
  /** Threads, the most recently active first: a project's, or every project the caller sees. */
  "chat.threads": z.object({
    project: project.optional(),
    projects: projectList,
    /** Words in the title or any message, in any case. */
    query: z.string().max(200).optional(),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  /**
   * What leaders proposed and nobody confirmed or set aside yet, the newest first: a project's, or every project the
   * caller sees (Hôm nay, roadmap 35c).
   */
  "chat.pending": z.object({ project: project.optional(), projects: projectList, limit: z.number().int().min(1).max(200).default(100) }),
  /** What a project's new chats start with. */
  "chat.defaults": z.object({ project }),
  "chat.setDefaults": z.object({
    project,
    machineId: machineRef.nullable(),
    profileId: z.string().max(40).nullable(),
    model: chatModel.nullable(),
    effort: z.enum(CHAT_EFFORTS).nullable(),
  }),
  /** The commands a project's leader may run; [] runs none. */
  "chat.setCommands": z.object({
    project,
    commands: z.array(z.string().max(60).regex(LEADER_COMMAND, "a command: up to four lowercase words")).max(MAX_LEADER_COMMANDS),
  }),
  /** The kinds of proposal the project's leader runs without a confirm (roadmap 29c); [] for none. */
  "chat.setAutonomy": z.object({ project, kinds: z.array(z.enum(CHAT_ACTION_KINDS)).max(CHAT_ACTION_KINDS.length) }),
  /** A thread's model and effort, for its next replies. */
  "chat.configure": z.object({ threadId: id, model: chatModel.nullable(), effort: z.enum(CHAT_EFFORTS).nullable() }),
  /** A project manager names a thread. */
  "chat.rename": z.object({ threadId: id, title: z.string().min(1).max(120) }),
  /** A project manager removes a thread with its messages; not while a reply is waiting or being written. */
  "chat.delete": z.object({ threadId: id }),
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
  /** Every action of a reply still waiting, confirmed in the order they build on each other, or all set aside. */
  "chat.decideAll": z.object({ replyId: id, accept: z.boolean() }),
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
  /** Spending caps (roadmap 27b), each with what its current day or month used. */
  "budgets.list": z.object({}),
  /** Replaces every cap at once (a hub admin): one per scope and period. */
  "budgets.set": z.object({ budgets: z.array(budgetSchema).max(200) }),
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

  /**
   * Stops every agent of a project, or of the hub (null; a hub admin only), roadmap 27d: cancels the run requests and
   * chat replies still waiting, asks the machines to stop the runs (heartbeat cancelRuns) and pauses the scope.
   */
  "agents.stop": z.object({ project: project.nullable() }),
  /** Lifts that pause; a pause of the hub and one of a project are lifted apart. */
  "agents.resume": z.object({ project: project.nullable() }),
  /** What is paused now (only the projects the caller sees), for the Board's notice and the stop buttons. */
  "agents.paused": z.object({}),

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
    // Left out (an app older than 27c) keeps what is set: saving its policy page must not loosen the rule.
    selfApproval: z.enum(SELF_APPROVALS).optional(),
  }),

  /** The hub's agent policy and each visible project's part (roadmap 27a). */
  /** The lifecycle gates (roadmap 34): the hub's ceiling and each project's modes, what applies now. */
  "sdlc.get": z.object({}),
  /** The hub's ceiling: how far each gate may be left to agents. A hub admin's. */
  "sdlc.setCeiling": z.object({ ceiling: gateModesSchema }),
  /** A project's gates, held to the ceiling; null puts the project back to every gate "human". */
  "sdlc.setProject": z.object({
    project,
    settings: z
      .object({
        gates: gateModesSchema,
        maxFixRounds: z.number().int().min(0).max(MAX_FIX_ROUNDS).optional(),
        maxParallel: z.number().int().min(1).max(20).nullable().optional(),
      })
      .nullable(),
  }),
  /**
   * A Spec Kit step from the Spec page (roadmap 34b): the task (made when `title` is given), the run request, and the
   * flow the hub drives from there through the project's gates.
   */
  "specs.runStep": z.object({
    project,
    step: z.enum(SPEC_STEPS),
    taskId,
    title: z.string().min(1).max(300).optional(),
    dir: z.string().regex(SPEC_DIR).optional(),
    input: z.string().max(3000).default(""),
    machineId: machineRef,
    profileId: z.string().max(40).nullable().default(null),
  }),
  /** A person's word at a gate: pass lets the flow go on; changes runs the step again with the note as instructions. */
  "sdlc.decide": z.object({ gateId: id, decision: z.enum(["pass", "changes"]), note: z.string().max(2000).default("") }),
  /** Starts a stopped flow's step again, on the machine it ran on. */
  "sdlc.retry": z.object({ taskId }),
  /** Tasks flows gave to agents (34c, 34d) and where each is: a flow's, one task's, or every one the caller sees. */
  "sdlc.flowTasks": z.object({ project: project.optional(), projects: projectList, flowTask: taskId.optional(), taskId: taskId.optional() }),
  /** Flows, the newest first: a project's or every project the caller sees. */
  "sdlc.flows": z.object({ project: project.optional(), projects: projectList, limit: z.number().int().min(1).max(200).default(50) }),
  /** Gates reached, the newest first: a project's or every project the caller sees, those waiting for a person first. */
  "sdlc.gates": z.object({
    project: project.optional(),
    projects: projectList,
    taskId: taskId.optional(),
    status: z.enum(GATE_STATUSES).optional(),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  "agentPolicy.get": z.object({}),
  /**
   * project null: the hub's default (a hub admin; a field left out is open). A project: its own part, which only
   * tightens the default (projectSettings on it); policy null clears it.
   */
  "agentPolicy.set": z.union([
    z.object({ project: z.null(), policy: agentPolicySchema.nullable() }),
    z.object({ project, policy: agentPolicyPartSchema.nullable() }),
  ]),

  /** The tool catalog (roadmap 28a), each entry with the settings of the projects the caller may view; `project`: that one only. */
  "tools.list": z.object({ project: project.optional() }),
  /** Adds an entry (no baseVersion) or replaces one (baseVersion: the version read); a hub admin. */
  "tools.save": z.object({ entry: toolEntrySchema, baseVersion: z.number().int().positive().optional() }),
  /** Removes an entry and its projects' settings; seeds are only turned off. */
  "tools.remove": z.object({ id: z.string().min(1).max(40) }),
  /** A project's own setting (projectSettings on it); enabled null and required false: back to the tool's default. */
  "tools.setProject": z.object({ id: z.string().min(1).max(40), project, enabled: z.boolean().nullable(), required: z.boolean().default(false) }),
  /** Each tool's setting for the project and its setup items on the project's machines (roadmap 28e). */
  "tools.status": z.object({ project }),

  /** Systems (roadmap 19b), by name. */
  "systems.list": z.object({}),
  /** Creates a system or replaces its projects: needs "manage" on every project it had and gets. */
  "systems.save": z.object({ name: systemName, projects: z.array(project).min(1).max(200) }),
  "systems.remove": z.object({ name: systemName }),

  /** Every project the hub knows (roadmap 47) with what it holds and its state; a reader sees only the ones they view. */
  "projects.list": z.object({}),
  /** Hides a project and refuses writes to it; undone by projects.restore. Hub admins. */
  "projects.archive": z.object({ project }),
  /** Back in use: lifts `archived`, or takes the headstone off a deleted name so it can be used again. Hub admins. */
  "projects.restore": z.object({ project }),
  /** Deletes an archived project and everything of it, for good. `confirm` has to be the project's name. Hub admins. */
  "projects.delete": z.object({ project, confirm: z.string().min(1).max(100) }),

  "admin.machines": z.object({}),
  "admin.commandCreate": z.object({ machineId: machineRef, itemId: setupItemId }),
  "admin.commandCancel": z.object({ id }),
  "admin.audit": z.object({
    limit: z.number().int().min(1).max(1000).default(200),
    action: z.string().max(60).optional(),
    /** An agent's label; `claude-1` also finds `claude-1.<machine>`, the label a machine on a hub sends. */
    agent: z.string().min(1).max(100).optional(),
    /** The person: who acted, or the account an agent acted for. */
    user: z.string().min(1).max(100).optional(),
    run: z.string().min(1).max(60).optional(),
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
  "docs.move": DocSummary;
  "docs.links": DocLinks;
  "docs.context": AgentContext;
  /** The requests made, one per online machine that has the project (an open one is reused); [] when none is online. */
  "docs.syncRequest": MachineCommand[];
  "docs.syncStatus": ProjectSyncState[];
  "docs.assets": DocAsset[];
  "docs.assetGet": { asset: DocAsset; data: string } | null;
  "docs.assetPut": DocAsset;
  "docs.assetRemove": { removed: boolean };
  "docs.assist": DocAssist;
  "docs.assists": DocAssist[];
  "docs.assistCancel": DocAssist;
  "docs.assistSettle": DocAssist;
  "docs.assistTake": DocAssistJob | null;
  "docs.assistProgress": { cancelled: boolean };
  "docs.assistFinish": { ok: boolean };
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
  "tasks.classify": Task;
  "tasks.classifyConfig": { project: string; enabled: boolean }[];
  "tasks.setClassifyConfig": { project: string; enabled: boolean };
  "tasks.assign": Task;
  "tasks.unassign": Task;
  "tasks.agentQueue": TaskAgentQueueItem[];
  "machines.heartbeat": {
    duplicate: boolean;
    cooldowns: QuotaCooldown[];
    policy: TeamPolicy;
    /** The agent policy (roadmap 27a): the hub's default and the parts of the projects this machine has. Older apps ignore it. */
    agentPolicy: { hub: AgentPolicy; projects: Record<string, Partial<AgentPolicy>> };
    /**
     * The tool catalog (roadmap 28b) for the projects this machine has: entries on for one of them, on by default,
     * set by one of them, or with the app's own code (whose old per-repo setup still counts). Older apps ignore it.
     */
    tools: MachineTools;
    /** Install requests waiting for the machine's user. */
    commands: MachineCommand[];
    /**
     * Sync requests to run now (roadmap 22n). Apart from commands so an app older than them never shows one as an
     * install to approve: it ignores the field, and the request expires.
     */
    syncCommands: MachineCommand[];
    /** Pending run requests for this machine; only while it accepts runs from the hub. */
    runRequests: RunRequest[];
    /** Chat replies this machine is asked to write; same condition. */
    chatRequests: ChatRequest[];
    /** Its runs a project manager asked to stop; same condition. */
    cancelRuns: RunCancel[];
    /**
     * Stop-all (roadmap 27d), whether or not it accepts runs: it stops the scope's runs and starts none, Board runs
     * too. Only the projects its token sees.
     */
    paused: AgentsPaused;
    /**
     * Spending caps that are full (roadmap 27b): the machine starts no new run they bind, Board runs included; runs
     * already going go on. Sent to every machine, whether or not it takes runs from the hub. Older apps ignore it.
     */
    budgetBlocked: BudgetBlock[];
    /** Changes to this machine's profiles asked for on the web (roadmap 18d). Older apps ignore it; the hub drops them after a day. */
    profileChanges: ProfileChange[];
    /** Merges asked for on the web (roadmap 18c); only while it accepts runs from the hub. Older apps ignore it. */
    mergeRuns: RunMergeOrder[];
    /**
     * Of the repos this machine reported, the ones the hub archived or deleted (roadmap 47): the hub keeps none of
     * them, so the app marks them instead of letting the user wonder why nothing of theirs reaches the hub.
     * One list for both states — the app shows one label, and a deleted project is just as gone. Older apps ignore it.
     */
    archivedProjects: string[];
  };
  "machines.list": Machine[];
  "machines.setupMissing": MachineSetupMissing[];
  "machines.setProfile": Machine;
  "costs.summary": CostSummary;
  "budgets.list": BudgetUsage[];
  "budgets.set": BudgetUsage[];
  "runs.report": RunNotice;
  "runs.push": { stored: number };
  "specs.push": { stored: number; removed: number };
  "specs.list": SpecFeature[];
  "specs.get": SpecFeatureDetail | null;
  "specs.importTasks": { tasks: Array<SpecTaskPlan & { exists: boolean }>; warnings: string[]; created: string[] };
  "runs.list": RunRecord[];
  "runs.get": RunRecord | null;
  "runs.cancel": RunRecord;
  "runs.merge": RunRecord;
  "runs.mergeResult": RunRecord;
  "runs.dispatch": RunRequest;
  "runs.prompt": { task: Task; request: RunRequest };
  "runs.dispatchMany": RunGroup;
  "runs.fanout": RunGroup;
  "runs.pickWinner": RunGroup;
  "runs.mapReduce": RunGroup;
  "runs.mapSplit": RunGroup;
  "runs.resumeGroup": RunGroup;
  "runs.groups": RunGroup[];
  "runs.cancelGroup": RunGroup;
  "runs.requests": RunRequest[];
  "runs.cancelRequest": RunRequest;
  "runs.requestResult": RunRequest;
  "chat.send": { thread: ChatThread; message: ChatMessage; reply: ChatMessage };
  "chat.threads": ChatThread[];
  "chat.pending": ChatAction[];
  "chat.rename": ChatThread;
  "chat.defaults": ChatDefaults;
  "chat.setDefaults": ChatDefaults;
  "chat.setCommands": ChatDefaults;
  "chat.setAutonomy": ChatDefaults;
  "chat.configure": ChatThread;
  "chat.delete": { deleted: number };
  "chat.get": { thread: ChatThread; messages: ChatMessage[] } | null;
  "chat.poll": ChatRequest[];
  "chat.propose": ChatAction;
  "chat.decide": ChatAction;
  "chat.decideAll": ChatAction[];
  "chat.cancel": ChatMessage;
  "chat.progress": { cancelled: boolean };
  "chat.finish": ChatMessage;
  "machines.remove": { removed: boolean };
  "cooldowns.list": QuotaCooldown[];
  /** null when `until` is already past (nothing to rest). */
  "cooldowns.set": QuotaCooldown | null;
  "cooldowns.clear": { cleared: boolean };
  "machines.commandResult": MachineCommand;
  "agents.stop": AgentsStop;
  "agents.resume": AgentsPaused;
  "agents.paused": AgentsPaused;
  "policy.get": TeamPolicy;
  "policy.set": TeamPolicy;
  "sdlc.get": SdlcPolicyView;
  "sdlc.setCeiling": SdlcPolicyView;
  "sdlc.setProject": SdlcPolicyView;
  "sdlc.gates": SdlcGateRecord[];
  "specs.runStep": { task: Task; request: RunRequest; flow: SdlcFlow };
  "sdlc.decide": SdlcFlow;
  "sdlc.retry": SdlcFlow;
  "sdlc.flows": SdlcFlow[];
  "sdlc.flowTasks": SdlcFlowTask[];
  "agentPolicy.get": AgentPolicyView;
  "agentPolicy.set": AgentPolicyView;
  "tools.list": ToolView[];
  "tools.save": ToolView;
  "tools.remove": { removed: boolean };
  "tools.setProject": ToolView;
  "tools.status": ToolStatus[];
  "systems.list": HiveSystem[];
  "systems.save": HiveSystem;
  "systems.remove": { removed: boolean };
  "projects.list": ProjectSummary[];
  "projects.archive": ProjectSummary;
  "projects.restore": ProjectSummary;
  "projects.delete": ProjectDeleted;
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
  "docs.move": "agent",
  "docs.links": "viewer",
  "docs.context": "viewer",
  // Also contextEdit on the project: a person who may change what agents read, never an agent token.
  "docs.syncRequest": "agent",
  "docs.syncStatus": "viewer",
  "docs.assets": "viewer",
  "docs.assetGet": "viewer",
  "docs.assetPut": "agent",
  "docs.assetRemove": "agent",
  "docs.assist": "agent",
  "docs.assists": "viewer",
  "docs.assistCancel": "agent",
  "docs.assistSettle": "agent",
  "docs.assistTake": "agent",
  "docs.assistProgress": "agent",
  "docs.assistFinish": "agent",
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
  "tasks.classify": "agent",
  "tasks.classifyConfig": "viewer",
  "tasks.setClassifyConfig": "agent",
  // Also "runDispatch" on the project: giving a task to an agent is queueing its run, only without a time.
  "tasks.assign": "agent",
  "tasks.unassign": "agent",
  "tasks.agentQueue": "viewer",
  "machines.heartbeat": "agent",
  "machines.list": "viewer",
  "machines.setupMissing": "viewer",
  // Not a project right: the hub checks for a hub admin or the machine's owner, and refuses agents.
  "machines.setProfile": "agent",
  "costs.summary": "viewer",
  "budgets.list": "viewer",
  // Also no per-project grants (a hub admin), as for the hub's agent policy: a cap may bind every project.
  "budgets.set": "admin",
  "runs.report": "agent",
  "runs.push": "agent",
  "specs.push": "agent",
  "specs.list": "viewer",
  "specs.get": "viewer",
  "specs.importTasks": "agent",
  "runs.list": "viewer",
  "runs.get": "viewer",
  "runs.cancel": "agent",
  "runs.merge": "agent",
  "runs.mergeResult": "agent",
  // Also "manage" on the project: a project manager, never an agent token.
  "runs.dispatch": "agent",
  // Also "manage" on the project as runs.dispatch, and creating its tasks.
  "runs.prompt": "agent",
  // Also "runDispatch" on the project, like runs.dispatch.
  "runs.dispatchMany": "agent",
  "runs.groups": "viewer",
  "runs.cancelGroup": "agent",
  // Also "taskManage" and "runDispatch" on the project, like runs.prompt.
  "runs.fanout": "agent",
  "runs.pickWinner": "agent",
  "runs.mapReduce": "agent",
  "runs.mapSplit": "agent",
  "runs.resumeGroup": "agent",
  "runs.requests": "viewer",
  "runs.cancelRequest": "agent",
  "runs.requestResult": "agent",
  // Also "manage" on the project, like runs.dispatch.
  "chat.send": "agent",
  "chat.threads": "viewer",
  "chat.pending": "viewer",
  "chat.rename": "agent",
  "chat.defaults": "viewer",
  "chat.setDefaults": "agent",
  "chat.setCommands": "agent",
  "chat.setAutonomy": "agent",
  "chat.configure": "agent",
  "chat.delete": "agent",
  "chat.get": "viewer",
  "chat.poll": "agent",
  "chat.propose": "agent",
  "chat.decide": "agent",
  "chat.decideAll": "agent",
  "chat.cancel": "agent",
  // Only the machine the thread is on.
  "chat.progress": "agent",
  "chat.finish": "agent",
  "machines.remove": "admin",
  "cooldowns.list": "viewer",
  "cooldowns.set": "agent",
  "cooldowns.clear": "agent",
  "machines.commandResult": "agent",
  // Also runDispatch on the project, or a hub admin for the whole hub: never an agent token.
  "agents.stop": "agent",
  "agents.resume": "agent",
  "agents.paused": "viewer",
  "policy.get": "viewer",
  "policy.set": "admin",
  "sdlc.get": "viewer",
  // A hub admin's (no per-project grants), as the hub's agent policy.
  "sdlc.setCeiling": "admin",
  // Also "projectSettings" on the project.
  "sdlc.setProject": "agent",
  "sdlc.gates": "viewer",
  // Also "taskManage" and "runDispatch" on the project, as runs.prompt.
  "specs.runStep": "agent",
  // Also "runDispatch" on the project (and "taskManage" for the tasks gate, which imports tasks).
  "sdlc.decide": "agent",
  "sdlc.retry": "agent",
  "sdlc.flows": "viewer",
  "sdlc.flowTasks": "viewer",
  "agentPolicy.get": "viewer",
  // Also a hub admin for the hub's default, or projectSettings on the project: a person, never an agent token.
  "agentPolicy.set": "agent",
  "tools.list": "viewer",
  // Also no per-project grants (a hub admin): an entry is what every project's runs may get.
  "tools.save": "admin",
  "tools.remove": "admin",
  // Also projectSettings on the project: a person, never an agent token.
  "tools.setProject": "agent",
  "tools.status": "viewer",
  "systems.list": "viewer",
  // Also "manage" on each project of the system: a project manager, never an agent token.
  "systems.save": "agent",
  "systems.remove": "agent",
  // The list is for anyone (filtered to what they view); archiving and deleting are a hub admin's, checked in #check.
  "projects.list": "viewer",
  "projects.archive": "admin",
  "projects.restore": "admin",
  "projects.delete": "admin",
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
