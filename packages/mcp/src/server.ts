import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  WORK_ROLES,
  CLI_APPROVAL_METHODS,
  chatPlanSchema,
  researchSchema,
  AGENT_ROLES,
  ARTIFACT_DIR,
  cacheReadShare,
  effectivePolicy,
  agentPolicyPartSchema,
  MAX_CANDIDATES,
  MEMORY_KINDS,
  PAUSED_HUB,
  may,
  sees,
  skillDocKey,
  TASK_STATUSES,
  TASK_PLATFORMS,
  TASK_KINDS,
  TASK_SIZES,
  TASK_RISKS,
  toErrorPayload,
  type Actor,
  type HiveBackend,
  type Memory,
  type Method,
  type MethodInput,
  type RunRecord,
  type Task,
} from "@xdev-hive/core";
import { z } from "zod";

export interface HiveMcpOptions {
  /** Used when a tool call omits `project` (e.g. from HIVE_PROJECT). */
  defaultProject?: string;
  /** A CLI opened on a whole system (HIVE_SYSTEM, GROUP-cli): no default project, the error names the system instead. */
  system?: string;
  /**
   * The token writes a reply in the hub-wide chat (roadmap 37): there is no default project, so every tool that needs
   * one asks for it, and the reads that can answer for the whole hub do when none is given.
   */
  hubScope?: boolean;
  /** Only the read tools. Default: read-only for viewer tokens. */
  readOnly?: boolean;
  /** The hub's open alerts (apps/web keeps them, not core): alert_list, for hub admins only. */
  alerts?: { list(): Promise<unknown[]> };
}

const INSTRUCTIONS = `xDev Hive is the shared memory, docs and task board for every coding agent on this team.
Start of session: memory_search for your topic. Before working: task_claim (task_next suggests a ready task). Record decisions/conventions/gotchas with memory_write.
Never edit AGENTS.md, CLAUDE.md or docs/decisions.md directly: doc_get, then doc_propose with the baseVersion you read.
Team skills (how the team does recurring work): skill_list, then skill_get the ones that fit. A new or better skill: skill_propose.
Answers are kept short: memory_search gives 8 entries without their bookkeeping (verbose: true for every field), task_list cuts each note to 200 characters (task_get reads one task in full, full: true the whole board).
End of session: task_update to "review" with a note (done / not done / how to verify / risks); it is kept beside the handovers before it, which task_notes reads. Never store secrets.`;

const READ_ONLY_INSTRUCTIONS = `xDev Hive is the shared memory, docs and task board for every coding agent on this team.
This connection is read-only: memory_search, doc_list, doc_get, doc_asset, artifact_list, artifact_get, skill_list, skill_get, task_list, task_get, task_notes, task_next, run_list, run_count, run_get, run_requests, machine_list, setup_missing, cost_summary, token_usage, tool_list, tool_status and policy_get (alert_list for hub admins). Search memory for your topic before working.
Answers are kept short: memory_search gives 8 entries without their bookkeeping (verbose: true for every field), task_list cuts each note to 200 characters (task_get reads one task in full, full: true the whole board).
Put anything worth sharing (decisions, gotchas, the handoff) in your final message instead of writing it to Hive.`;

// A chat leader (the hub's token for one reply) changes nothing on the board itself: it proposes, a project manager confirms.
const LEADER_INSTRUCTIONS = `
You are the project's leader in the Hive chat: read skill_get hive-leader first. You cannot create or move tasks or queue runs yourself: propose them with
propose_research (read-only investigation, report artifact and draft doc), propose_plan (a short spec, tasks with acceptance criteria and dependencies, and expected batches), propose_task, propose_task_status, propose_task_classify, propose_task_agent (give a task to one agent, which the hub then starts by itself) and propose_run, and say in your reply what you proposed. A project manager confirms or
sets aside each one in the chat, and it runs with their rights; a kind the project lets you run on your own runs at once,
as the person who wrote to you (the answer says done or failed): say which ran and which wait. The same for the rest of the project's operations, always on the chat's project: propose_cancel_run (stop a queued or running run),
propose_merge (merge a run's MR/PR), propose_profile (turn a machine's plan on or off, or change its priority),
propose_policy (the project's agent policy), propose_stop_agents and propose_resume_agents (every agent of the project),
propose_install (a machine installs a setup item it reported; for a tool, the items tool_status lists), propose_tool (turn a catalog
tool on or off for the project). Look first with project_list, run_list, machine_list and tool_list: a proposal of a run, plan or tool the hub
does not know is refused.`;

// Kept apart from LEADER_INSTRUCTIONS so the proposal list there can grow (roadmap 29b) without touching this.
const LEADER_READ_INSTRUCTIONS = `
Read before you answer or propose: costs and spending caps with cost_summary; a run that does not start with run_list, run_requests
(rejected or expired requests and why) and setup_missing (what a machine lacks); the agent policy and whether agents are stopped with policy_get;
the tools runs may get with tool_list, and where each stands on the machines with tool_status; tokens and the share read from the prompt
cache with token_usage (quote its numbers: never guess what a tool saves); the hub's open alerts with alert_list when you have it.`;

const CLI_LEADER_INSTRUCTIONS = `
Interactive MCP leader: task_create and task_set_deps manage the board; plan_create creates a spec and its task graph; task_status updates a task; task_assign and run_dispatch queue work. These calls act with your account's project rights and are recorded with your agent identity. Read the board and machines first. Changes to policy, setup, tools, agent pauses and merges require a proposal for hub confirmation.`;

// Roadmap 28f: what an agent acts on. The bookkeeping (author, project, dates, use count, file shas) is for the people on the web, and twenty entries of it cost more than the facts themselves.
const compactMemory = (m: Memory) => ({
  id: m.id,
  kind: m.kind,
  content: m.content,
  files: m.files.map((f) => f.path),
  ...(m.taskId ? { taskId: m.taskId } : {}),
  ...(m.stale ? { stale: true } : {}),
  // Only the flag: which files changed is in `files`, and an agent can neither read nor compare a blob id.
  ...(m.review ? { review: true } : {}),
  ...(m.supersededBy !== null ? { supersededBy: m.supersededBy } : {}),
  ...(m.conflictsWith.length > 0 ? { conflictsWith: m.conflictsWith } : {}),
});

/** Roadmap 28f: notes are over half of a board's bytes, and a list is read to pick a task, not to work it (task_get then reads the one). */
const NOTE_IN_LIST = 200;
/**
 * A task as a list gives it: its note cut, and the agent it belongs to as one string (roadmap 50) rather than the
 * object task_get returns — an agent reading the board only needs to know whose task it is.
 */
const shortTask = (t: Task): Omit<Task, "agent" | "kind" | "size" | "risk" | "classifiedBy" | "classifiedAt"> & Partial<Pick<Task, "kind" | "size" | "risk" | "classifiedBy" | "classifiedAt">> & { noteTruncated?: true; agent?: string } => {
  const { agent, kind, size, risk, classifiedBy, classifiedAt, ...rest } = t;
  return {
    ...rest,
    ...(kind ? { kind } : {}), ...(size ? { size } : {}), ...(risk && risk !== "normal" ? { risk } : {}),
    ...(classifiedBy && classifiedBy !== "rule" ? { classifiedBy } : {}),
    ...(t.note && t.note.length > NOTE_IN_LIST ? { note: t.note.slice(0, NOTE_IN_LIST), noteTruncated: true as const } : {}),
    ...(agent ? { agent: agent.profileId ? `${agent.machine}/${agent.profileId}` : agent.machine } : {}),
  };
};
/** Null, "", [] and {} tell an agent nothing a missing key does not, and on a 100-task board they add up (roadmap 80a). */
const dropEmpty = (o: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) =>
    v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0) &&
    !(typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0)));
/**
 * Roadmap 80a: the board as task_list gives it by default. The project is the one asked for, so repeating it on every
 * row only costs tokens; a done task's note is history for task_get or task_notes, not something to pick work by.
 * Trimmed here rather than in tasks.list so the web and desktop keep the whole record, and so it works with any hub.
 */
const leanTask = (t: Task, project: string): Record<string, unknown> => {
  const { project: own, note, noteTruncated, ...rest } = shortTask(t);
  return dropEmpty({ ...rest, ...(own !== project ? { project: own } : {}), ...(t.status !== "done" ? { note, noteTruncated } : {}) });
};

/** Roadmap 80b: a log's end is where the result and the error are; 8 KB is a few hundred lines. */
const LOG_TAIL = 8_000;
const PATCH_FILES = 50;
/**
 * A run as run_get gives it by default: the patch (up to 400 KB) replaced by its size and the files it touches, and
 * only the end of the log. Done here, not in runs.get, because the web's run page shows the whole patch and log.
 */
const leanRun = (r: RunRecord): Record<string, unknown> => {
  const { log, patch, ...rest } = r;
  const out: Record<string, unknown> = { ...rest };
  if (log !== undefined && log.length > LOG_TAIL) {
    const tail = log.slice(-LOG_TAIL);
    // Start on a whole line, so the first thing the agent reads is not half a word.
    const nl = tail.indexOf("\n");
    Object.assign(out, { log: nl >= 0 && nl < 500 ? tail.slice(nl + 1) : tail, logTruncated: true, logLength: log.length });
  } else if (log !== undefined) out.log = log;
  if (patch) {
    const files = [...patch.matchAll(/^diff --git a\/(.+?) b\//gm)].map((m) => m[1]!);
    Object.assign(out, { patchLength: patch.length, patchFiles: files.slice(0, PATCH_FILES), ...(files.length > PATCH_FILES ? { patchFileCount: files.length } : {}) });
  }
  return out;
};
// Roadmap 37: the hub-wide leader works over every project at once, so nothing can be guessed from "the chat's project".
const LEADER_HUB_INSTRUCTIONS = `
This chat is the whole hub, not one project: read project_list first (every project with its tasks, runs, machines and systems), and alert_list
when you have it. There is no default project: every propose_* takes project, and it is required — name the project each proposal is for, and do
not guess one. Only machine_list, project_list and a machine's own setup item (cli:<kind>, shim, tool:<id>) belong to no project, and propose_stop_agents,
propose_resume_agents and propose_policy without project mean the whole hub, which is a much bigger thing to ask for: say so plainly.
run_list, run_count, run_requests, cost_summary and alert_list without project answer for the whole hub; the other reads need one.
Group what you propose by project, and leave merges, stopping agents and policy changes for the person to decide.`;

// GROUP-cli: one session over every repo of a system, so no tool can assume which project a write belongs to.
const systemInstructions = (system: string) => `
This session is system ${system} with several repos, not one project: there is no default project. Pass project on every task_*, memory_write
and doc_* call, the key of the repo the work is in (AGENTS.md in the working folder lists each repo with its key and folder).
memory_write with system: "${system}" records what every service of the system needs (an API contract, how the services call each other).`;

const project = z.string().optional().describe('Hive project key (see "Hive project key" in AGENTS.md)');
const reason = z.string().min(1).max(500).describe("One line for the person confirming it: why");

export function createHiveMcpServer(backend: HiveBackend, actor: Actor, opts: HiveMcpOptions = {}): McpServer {
  // Write tools are not registered at all, so a read-only agent never sees them.
  const writes = !(opts.readOnly ?? actor.role === "viewer");
  // A chat leader works on no task of its own: no claim or status change, proposals instead.
  const leader = writes && actor.chatReply !== undefined;
  const cliLeader = writes && actor.mcpCredential === true && !actor.runCredential && actor.chatReply === undefined;
  // Whether this credential may hold the right anywhere it reaches; core still checks the task's own project.
  const allowed = (permission: "taskManage" | "runDispatch" | "taskWork" | "docPropose") =>
    opts.defaultProject ? may(actor, opts.defaultProject, permission) :
      actor.access ? Object.keys(actor.access.projects).some((p) => may(actor, p, permission)) : may(actor, null, permission);
  // A run's agent works its task but never decides which OS gets it; the CLI leader of an account with taskManage may (73b).
  const taskManage = cliLeader && allowed("taskManage");
  const hubScope = opts.hubScope === true && actor.chatReply !== undefined;
  // The web derives hubScope from the authenticated reply's thread, opened only by a hub admin.
  // Broaden only these reads; proposals and every mutation retain the machine's intersected grants.
  const hubReads = new Set<Method>(["projects.list", "tasks.list", "runs.list", "runs.count", "runs.requests", "machines.list", "systems.list", "costs.summary", "budgets.list"]);
  const readActor: Actor = hubScope ? { ...actor, role: "viewer", access: undefined } : actor;
  const call: HiveBackend["call"] = (method, input, caller) =>
    backend.call(method, input, hubScope && hubReads.has(method) ? readActor : caller);
  const instructions = !writes
    ? READ_ONLY_INSTRUCTIONS
    : leader
      ? "Read Hive through its read tools. Before answering, search memory for context. Record decisions in your reply; changes are proposals for the sender to approve." + LEADER_INSTRUCTIONS + LEADER_READ_INSTRUCTIONS + (hubScope ? LEADER_HUB_INSTRUCTIONS : "")
      : INSTRUCTIONS + (cliLeader ? CLI_LEADER_INSTRUCTIONS : "") + (opts.system ? systemInstructions(opts.system) : "");
  const server = new McpServer({ name: "xdev-hive", version: "0.1.0" }, { instructions });

  // Roadmap 28f: every answer is JSON without indentation. Only an agent reads these, and the spaces are tokens it pays for.
  const json = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
  const failed = (err: unknown): CallToolResult => {
    const { code, message } = toErrorPayload(err);
    return { isError: true, content: [{ type: "text", text: `${code}: ${message}` }] };
  };

  const run = async <M extends Method>(method: M, input: MethodInput<M>): Promise<CallToolResult> => {
    try {
      return json(await call(method, input, actor));
    } catch (err) {
      return failed(err);
    }
  };
  const needProject = (p: string | undefined): string => {
    const value = p ?? (hubScope ? undefined : opts.defaultProject);
    if (!value) {
      throw new Error(
        hubScope
          ? "project is required: this chat is the whole hub and has no default project. Name one (project_list lists them)."
          : opts.system
            ? `project is required: this session is system ${opts.system}, not one project. Pass the project key of the repo you work in (AGENTS.md lists them).`
            : "project is required (pass the Hive project key from AGENTS.md)",
      );
    }
    return value;
  };
  const withProject =
    <A extends { project?: string }>(fn: (args: A & { project: string }) => Promise<CallToolResult>) =>
    async (args: A): Promise<CallToolResult> => {
      try {
        return await fn({ ...args, project: needProject(args.project) });
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: String((err as Error).message ?? err) }] };
      }
    };
  /**
   * A read that answers for one project, or for the whole hub when none is given. Only the hub-wide leader (roadmap 37)
   * may leave it out: every other token works in one project and gets the same answer as before.
   */
  const overHub =
    <A extends { project?: string }>(fn: (args: A & { project: string | undefined }) => Promise<CallToolResult>) =>
    async (args: A): Promise<CallToolResult> => {
      try {
        const p = args.project ?? (hubScope ? undefined : opts.defaultProject);
        return await fn({ ...args, project: p ?? (hubScope ? undefined : needProject(undefined)) });
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: String((err as Error).message ?? err) }] };
      }
    };

  const readOnly = { readOnlyHint: true, openWorldHint: false } as const;

  /** A file the hub keeps, as the agent can use it: an image it can look at, a PDF to hand on, text to read. */
  const fileResult = (type: string, data: string, uri: string): CallToolResult => {
    if (type.startsWith("image/")) return { content: [{ type: "image", data, mimeType: type }] };
    if (type === "application/pdf") return { content: [{ type: "resource", resource: { uri, mimeType: type, blob: data } }] };
    return { content: [{ type: "text", text: Buffer.from(data, "base64").toString("utf8") }] };
  };


  server.registerTool(
    "doc_list",
    {
      title: "List shared docs",
      description: "List org-wide docs and this project's docs (key, title, version, paths: the globs a doc applies to, [] = whole repo). Use doc_get to read one.",
      inputSchema: { project },
      annotations: readOnly,
    },
    async ({ project: p }) => run("docs.list", { project: p ?? (hubScope ? undefined : opts.defaultProject) }),
  );

  server.registerTool(
    "doc_get",
    {
      title: "Read a doc",
      description:
        "Read the current content and version of a doc, e.g. org/agent-protocol or project/<project>/agents. [[slug]] links to another doc of the same space (or the team's), [[org/<slug>]] by key; images and files show as assets/<slug>/<name>: read them with doc_asset.",
      inputSchema: { key: z.string() },
      annotations: readOnly,
    },
    // A removed page (roadmap 38g) reads as gone: an agent must not work from a page the team took out.
    async ({ key }) => {
      const doc = await call("docs.get", { key }, actor);
      if (doc?.removedAt) return { isError: true, content: [{ type: "text", text: `not_found: ${doc.key} was removed on ${doc.removedAt}` }] };
      return run("docs.get", { key });
    },
  );

  server.registerTool(
    "doc_asset",
    {
      title: "Read a file attached to a doc",
      description:
        "Read an image or file a doc shows as assets/<slug>/<name>: key is the doc of that slug (org/<slug> or project/<project>/<slug>), name the file name. Images come back as images; text files as text. Without name: the doc's files.",
      inputSchema: { key: z.string(), name: z.string().optional() },
      annotations: readOnly,
    },
    async ({ key, name }) => {
      if (!name) return run("docs.assets", { key });
      try {
        const got = await call("docs.assetGet", { key, name }, actor);
        if (!got) return { isError: true, content: [{ type: "text", text: `not_found: ${key} has no file ${name} (doc_asset without name lists them)` }] };
        return fileResult(got.asset.type, got.data, `hive://docs/${key}/assets/${encodeURIComponent(name)}`);
      } catch (err) {
        return failed(err);
      }
    },
  );

  server.registerTool(
    "artifact_list",
    {
      title: "List the files runs made",
      description:
        `Files agents made while working and the hub kept (roadmap 41c): smoke screenshots, reports, measurements, plans. Narrow to one task or one run; read one with artifact_get its id. Write your own into ${ARTIFACT_DIR} of your working copy and the run sends them here when it ends.`,
      inputSchema: { project, taskId: z.string().optional().describe("Only this task's files"), runId: z.string().optional().describe("Only this run's files"), kind: z.enum(["markdown", "log", "json", "image", "text", "pdf", "html"]).optional().describe("Only this file kind, including HTML") },
      annotations: readOnly,
    },
    withProject(async ({ project: p, taskId, runId, kind }) => run("artifacts.list", { project: p, taskId, runId, kind })),
  );

  server.registerTool(
    "artifact_get",
    {
      title: "Read a file a run made",
      description: "Read one file by the id artifact_list gives. Images come back as images, text as text.",
      inputSchema: { id: z.number().int().positive() },
      annotations: readOnly,
    },
    async ({ id }) => {
      try {
        const got = await call("artifacts.get", { id }, actor);
        if (!got) return { isError: true, content: [{ type: "text", text: `not_found: no artifact #${id} (artifact_list shows the ids)` }] };
        return fileResult(got.artifact.type, got.data, `hive://artifacts/${id}/${encodeURIComponent(got.artifact.name)}`);
      } catch (err) {
        return failed(err);
      }
    },
  );

  if (writes) server.registerTool(
    "artifact_put",
    {
      title: "Save a run artifact",
      description: "Save one report, HTML page, image or PDF to the current project and task. HTML is previewed in a network-restricted sandbox.",
      inputSchema: {
        project: z.string().optional(), taskId: z.string().min(1), runId: z.string().min(1), name: z.string().min(1).max(300),
        data: z.string().min(1).describe("File bytes encoded as base64"), versionNote: z.string().max(500).optional(),
      },
    },
    withProject(async ({ project: p, taskId, runId, name, data, versionNote }) => {
      try {
        const artifact = await call("artifacts.put", { project: p, taskId, runId, name, data, versionNote }, actor);
        return { content: [{ type: "text", text: JSON.stringify(artifact) }] };
      } catch (err) { return failed(err); }
    }),
  );

  if (writes) {
    server.registerTool(
      "doc_propose",
      {
        title: "Propose a doc change",
        description:
          "Propose new full content for a protected doc. A human admin reviews it. baseVersion must be the version you read with doc_get (0 for a new doc).",
        inputSchema: {
          key: z.string(),
          baseVersion: z.number().int().min(0),
          content: z.string().describe("The complete new document, not a diff"),
          reason: z.string().describe("One line: why this change"),
        },
      },
      async ({ key, baseVersion, content, reason }) =>
        run("proposals.create", { docKey: key, baseVersion, content, reason }),
    );
  }

  server.registerTool(
    "skill_list",
    {
      title: "List team skills",
      description:
        "List the skills this project's agents get: name and description (when to use it). The project's own skill replaces the team's skill of the same name. Read one with skill_get.",
      inputSchema: { project },
      annotations: readOnly,
    },
    async ({ project: p }) => run("skills.list", { project: p ?? (hubScope ? undefined : opts.defaultProject) }),
  );

  server.registerTool(
    "skill_get",
    {
      title: "Read a skill",
      description: "Read a skill's SKILL.md (front matter with name and description, then the instructions) and its version: the project's own first, else the team's.",
      inputSchema: { name: z.string(), project },
      annotations: readOnly,
    },
    async ({ name, project: p }) => {
      const scope = p ?? (hubScope ? undefined : opts.defaultProject);
      try {
        const own = scope ? await call("docs.get", { key: skillDocKey(name, scope) }, actor) : null;
        const doc = own ?? (await call("docs.get", { key: skillDocKey(name) }, actor));
        if (!doc) return { isError: true, content: [{ type: "text", text: `not_found: no skill ${name} (see skill_list)` }] };
        return json(doc);
      } catch (err) {
        return failed(err);
      }
    },
  );

  if (writes) {
    server.registerTool(
      "skill_propose",
      {
        title: "Propose a skill",
        description:
          "Propose a new skill, or new full content for one. A human admin reviews it. content is the complete SKILL.md: front matter (---, name: <the same name>, " +
          "description: what it does and when to use it, ---) then the steps. shared: true for the whole team, otherwise this project only. " +
          "baseVersion is the version you read with skill_get (0 for a new skill).",
        inputSchema: {
          name: z.string().describe("lowercase letters, digits and -"),
          content: z.string().describe("The complete SKILL.md, not a diff"),
          reason: z.string().describe("One line: why this skill or change"),
          baseVersion: z.number().int().min(0),
          shared: z.boolean().optional(),
          project,
        },
      },
      withProject(async ({ name, content, reason, baseVersion, shared, project: p }) =>
        run("proposals.create", { docKey: skillDocKey(name, shared ? null : p), baseVersion, content, reason }),
      ),
    );
  }

  server.registerTool(
    "memory_search",
    {
      title: "Search team memory",
      description:
        "Search decisions, conventions, gotchas and context recorded by any agent on this project, plus the team's and those of the systems the project is a service of. Empty query returns the latest entries. " +
        "On a hub with embeddings it also finds entries by meaning (other words, other language), so a short question works. " +
        "Entries no agent used for a long time are left out until a person keeps them; replaced entries too. " +
        "An entry comes back as id, kind, content, the repo files it is about and taskId, plus a flag when there is one: " +
        "review (a cited file changed since: check those files before relying on it), stale, supersededBy, conflictsWith (entries that disagree with it until a person decides). " +
        "8 entries by default; a narrower query beats a bigger limit. verbose: true adds the rest (author, project, dates, use count, file blob ids), for a person asking about the memory itself.",
      inputSchema: {
        project,
        query: z.string().optional(),
        limit: z.number().int().min(1).max(50).optional().describe("Default 8"),
        verbose: z.boolean().optional().describe("Every field of each entry, as the web shows it"),
      },
      annotations: readOnly,
    },
    withProject(async ({ project: p, query, limit, verbose }) => {
      try {
        const hits = await call("memory.search", { project: p, query, limit: limit ?? 8, includeShared: true }, actor);
        return json(verbose ? hits : hits.map(compactMemory));
      } catch (err) {
        return failed(err);
      }
    }),
  );

  if (writes && !leader) {
    server.registerTool(
      "memory_write",
      {
        title: "Record team memory",
        description:
          "Record one durable fact for every other agent: a decision, convention, gotcha or context. Keep it short. No secrets. " +
          "shared: true only for something true in every project of the team (e.g. an org-wide convention); " +
          "system: <name> for something every service of that system needs (an API contract, an event, how the services call each other); otherwise it belongs to this project. " +
          "files: the repo files the fact is about, so it gets flagged for review when they change. " +
          "When a fact changed, write the new one with supersedes (the old id) instead of leaving both; " +
          "when you find an entry that looks wrong but are not sure, write yours with contradicts (its id) and a person decides.",
        inputSchema: {
          project,
          shared: z.boolean().optional().describe("Team-wide entry seen from every project (no project then)"),
          system: z.string().optional().describe("A system's entry, seen from each of its services (no project then)"),
          kind: z.enum(MEMORY_KINDS),
          content: z.string(),
          taskId: z.string().optional(),
          files: z.array(z.string()).max(10).optional().describe("Paths from the repo root, e.g. src/db/pool.ts"),
          supersedes: z.number().int().positive().optional().describe("Id of an older entry this one replaces"),
          contradicts: z.number().int().positive().optional().describe("Id of an entry this one disagrees with"),
        },
      },
      async ({ project: p, shared, system, kind, content, taskId, files, supersedes, contradicts }) => {
        const links = { taskId, files, supersedes, contradicts };
        if (shared) return run("memory.write", { shared: true, kind, content, ...links });
        if (system) return run("memory.write", { system, kind, content, ...links });
        return withProject(async ({ project: q }: { project: string }) => run("memory.write", { project: q, kind, content, ...links }))({ project: p });
      },
    );
  }

  server.registerTool(
    "task_list",
    {
      title: "List tasks",
      description:
        "List tasks on the shared board for a project, optionally filtered by status. dependsOn: tasks that must be done first; waitingOn: those still open. " +
        "agent: the agent the task is for, as machine/plan — the hub starts it there by itself, and nobody else takes it. " +
        `The whole board is long: for what to work on next use task_next, and for one part of it status ("todo", "doing", "review"). ` +
        `Done tasks are left out unless you ask: status "done", or includeDone: true; they come without a note. Rows leave out project and empty fields. ` +
        `Each note is cut to ${NOTE_IN_LIST} characters (noteTruncated: true when it was): task_get reads one task with its whole note, full: true the whole board (done included) with every field and note.`,
      inputSchema: {
        project,
        status: z.enum(TASK_STATUSES).optional(),
        includeDone: z.boolean().optional().describe("Also list done tasks"),
        full: z.boolean().optional().describe("Every task and field as the hub has it, whole notes"),
      },
      annotations: readOnly,
    },
    withProject(async ({ project: p, status, includeDone, full }) => {
      try {
        const tasks = await call("tasks.list", { project: p, status }, actor);
        if (full) return json(tasks);
        // Most of a long-lived board is done (66 of 109 measured), and an agent picks work from what is open.
        const shown = status || includeDone ? tasks : tasks.filter((t) => t.status !== "done");
        return json(shown.map((t) => leanTask(t, p)));
      } catch (err) {
        return failed(err);
      }
    }),
  );

  // No tasks.get RPC: the board is one query and a project's tasks are few, so the one task is picked out of the list here (roadmap 28f, MCP only).
  server.registerTool(
    "task_get",
    {
      title: "Read one task",
      description:
        "One task of the board with its whole note (what another agent left: done / not done / how to verify / risks), its dependencies, who holds it, " +
        "and agent: the machine and plan it is assigned to, with hold (why the hub stopped sending it) when there is one.",
      inputSchema: { id: z.string(), project },
      annotations: readOnly,
    },
    withProject(async ({ id, project: p }) => {
      try {
        const task = (await call("tasks.list", { project: p }, actor)).find((t) => t.id === id);
        if (!task) return { isError: true, content: [{ type: "text", text: `not_found: Task ${id} not found in ${p} (task_list shows the board).` }] };
        return json(task);
      } catch (err) {
        return failed(err);
      }
    }),
  );

  server.registerTool(
    "task_notes",
    {
      title: "Read a task's handover notes",
      description:
        "The handover notes of one task, newest first: note, the status it was moved to, who wrote it, when. " +
        "The newest is the note task_list shows; the ones before it are what earlier agents left, kept as they were written.",
      inputSchema: { id: z.string(), limit: z.number().int().min(1).max(50).optional() },
      annotations: readOnly,
    },
    async ({ id, limit }) => run("tasks.notes", { id, limit: limit ?? 5 }),
  );

  server.registerTool(
    "task_next",
    {
      title: "Next ready tasks",
      description:
        "Tasks ready to start in a project: to do, nothing they depend on is open, nobody holds them. The ones that unlock the most other tasks come first. " +
        "On a machine: the tasks assigned to this machine's agents come first, and tasks assigned to another machine are left out.",
      inputSchema: { project, limit: z.number().int().min(1).max(20).optional() },
      annotations: readOnly,
    },
    withProject(async ({ project: p, limit }) => run("tasks.next", { project: p, limit })),
  );

  // Hub mode: what machines pushed (runs.push) and reported (heartbeats); a local database has none.
  server.registerTool(
    "run_count",
    {
      title: "Count active agent runs",
      description: "Exact running and queued run counts in the visible project scope, independent of run_list's limit. With no project, counts all projects this connection may read.",
      inputSchema: { project },
      annotations: readOnly,
    },
    overHub(async ({ project: p }) => run("runs.count", { project: p })),
  );

  server.registerTool(
    "run_list",
    {
      title: "List agent runs",
      description:
        "Agent runs the team's machines reported to the hub, newest first: task, role (implement, review), machine, plan, status, " +
        "activity, the result summary (a review's verdict), error, branch, MR, and what it ran on: kind, model and effort (null: the CLI's default), " +
        "attempt, parentRun, verdict. run_get reads one with the end of its log.",
      inputSchema: { project, limit: z.number().int().min(1).max(100).optional() },
      annotations: readOnly,
    },
    overHub(async ({ project: p, limit }) => run("runs.list", { project: p, limit: limit ?? 30 })),
  );

  server.registerTool(
    "run_get",
    {
      title: "Read an agent run",
      description:
        "One run from run_list (machineId and runId as listed) with the end of its log: the agent's steps and result, secrets hidden. " +
        `By default the log is its last ${LOG_TAIL / 1000} KB (logTruncated: true and logLength when cut) and the patch is left out: patchLength and patchFiles say what it changed. ` +
        "full: true gives the whole stored log and the patch. " +
        "An old run keeps its summary for good but not its log: logPrunedAt says when log and patch were dropped (empty log, no patch).",
      inputSchema: { machineId: z.string(), runId: z.string(), full: z.boolean().optional().describe("The whole stored log and the patch") },
      annotations: readOnly,
    },
    async ({ machineId, runId, full }) => {
      try {
        const got = await call("runs.get", { machineId, runId }, actor);
        return json(full || !got ? got : leanRun(got));
      } catch (err) {
        return failed(err);
      }
    },
  );

  server.registerTool(
    "machine_list",
    {
      title: "List team machines",
      description:
        "The team's machines as the hub last heard from them: online, whether they take runs from the hub, the projects they have a repo for, " +
        "their plans (signed in, resting, over their limit) and what they run now.",
      inputSchema: {},
      annotations: readOnly,
    },
    async () => run("machines.list", {}),
  );

  // Hub mode, read-only, for every token that reads (roadmap 29a): what the web's Costs, Runs, Policy and Machines pages show.
  // The methods filter by the token's rights; a project the token does not see answers not_found, as the web does.
  const unseen = (p: string): CallToolResult | null =>
    sees(actor, p) ? null : { isError: true, content: [{ type: "text", text: `not_found: Project ${p} not found.` }] };

  // Roadmap 37: where the hub-wide leader starts. Built from the lists, each already cut to what the token sees, so a
  // project it has no grant on is not even named.
  server.registerTool(
    "project_list",
    {
      title: "List the hub's projects",
      description:
        "Every project you can see, with its tasks by status (todo, doing, review, done, blocked), the runs going on now (running, queued), " +
        "the run requests still waiting for a machine, the machines that have its repo, and the systems it is a service of. " +
        "Read this first in the hub-wide chat: a proposal there has to name one of these projects.",
      inputSchema: {},
      annotations: readOnly,
    },
    async () => {
      try {
        const [projects, tasks, runs, requests, machines, systems] = await Promise.all([
          call("projects.list", {}, actor),
          call("tasks.list", {}, actor),
          call("runs.list", { limit: 200 }, actor),
          call("runs.requests", { limit: 200 }, actor),
          call("machines.list", {}, actor),
          call("systems.list", {}, actor),
        ]);
        const names = new Set(projects.filter((p) => p.state === null).map((p) => p.project));
        return json(
          [...names].sort().map((p) => ({
            project: p,
            tasks: Object.fromEntries(TASK_STATUSES.map((s) => [s, tasks.filter((t) => t.project === p && t.status === s).length])),
            runs: {
              running: runs.filter((r) => r.project === p && r.status === "running").length,
              queued: runs.filter((r) => r.project === p && r.status === "queued").length,
              pendingRequests: requests.filter((r) => r.project === p && r.status === "pending").length,
            },
            machines: machines.filter((m) => m.projects.includes(p)).map((m) => ({ machine: m.machine, id: m.id, online: m.online, acceptsRuns: m.acceptsRuns })),
            systems: systems.filter((s) => s.projects.includes(p)).map((s) => s.name),
          })),
        );
      } catch (err) {
        return failed(err);
      }
    },
  );

  server.registerTool(
    "cost_summary",
    {
      title: "Project costs and caps",
      description:
        "What the project's agent runs cost at API prices over the last 24 hours, 7 days and 30 days (usd1, usd7, usd30, runs30), " +
        "and the spending caps that apply to it (the project's, the hub's, your own) with what each period used so far (ratio 1 = full, no new run starts). " +
        "In the hub-wide chat, without project: every project you see, with the hub's total and all the caps.",
      inputSchema: { project },
      annotations: readOnly,
    },
    overHub(async ({ project: p }) => {
      const hidden = p === undefined ? null : unseen(p);
      if (hidden) return hidden;
      try {
        const [summary, budgets] = await Promise.all([call("costs.summary", {}, actor), call("budgets.list", {}, actor)]);
        const me = actor.onBehalf ?? actor.name;
        // The whole hub: costs.summary and budgets.list are already cut to what the token sees.
        if (p === undefined) return json({ project: null, total: summary.total, costs: summary.projects, budgets });
        return json({
          project: p,
          costs: summary.projects.find((c) => c.project === p) ?? { project: p, usd1: 0, usd7: 0, usd30: 0, runs30: 0 },
          budgets: budgets.filter((b) => (b.scope.kind === "project" ? b.scope.project === p : b.scope.kind === "hub" || b.scope.user === me)),
        });
      } catch (err) {
        return failed(err);
      }
    }),
  );

  server.registerTool(
    "run_requests",
    {
      title: "List run requests",
      description:
        "Runs asked for from the web or the chat, newest first: pending (the machine has not taken it), accepted, rejected (with the machine's reason), cancelled, expired. " +
        "Runs a machine took and why they wait are in run_list.",
      inputSchema: { project, limit: z.number().int().min(1).max(200).optional() },
      annotations: readOnly,
    },
    overHub(async ({ project: p, limit }) => run("runs.requests", { project: p, limit: limit ?? 30 })),
  );

  server.registerTool(
    "policy_get",
    {
      title: "Project agent policy",
      description:
        "The agent policy in force for the project (models, autonomy, network, MCP servers: the hub's default tightened by the project's own part), " +
        "the setup every machine with the project must have, and whether agents are stopped for the project or the whole hub.",
      inputSchema: { project },
      annotations: readOnly,
    },
    withProject(async ({ project: p }) => {
      const hidden = unseen(p);
      if (hidden) return hidden;
      try {
        const [agentPolicy, policy, paused] = await Promise.all([
          call("agentPolicy.get", {}, actor),
          call("policy.get", {}, actor),
          call("agents.paused", {}, actor),
        ]);
        return json({
          project: p,
          agentPolicy: {
            effective: agentPolicy.effective[p] ?? effectivePolicy(agentPolicy.hub, null),
            hub: agentPolicy.hub,
            project: agentPolicy.projects[p] ?? null,
            updatedAt: agentPolicy.updatedAt,
            updatedBy: agentPolicy.updatedBy,
          },
          required: { clis: policy.requiredClis, shim: policy.requireShim, repo: policy.projects[p] ?? [] },
          // Each scope is lifted on its own, so the leader has to say which stop holds the runs.
          paused: {
            hub: paused.hub ? (paused.by[PAUSED_HUB] ?? {}) : null,
            project: paused.projects.includes(p) ? (paused.by[p] ?? {}) : null,
          },
        });
      } catch (err) {
        return failed(err);
      }
    }),
  );

  server.registerTool(
    "setup_missing",
    {
      title: "What the project's machines lack",
      description:
        "Each machine with the project's repo and what its last setup check found not installed: the machine's (cli:<kind>, shim, tool:<id>) and the project's (<project>:<part>), " +
        "state missing, outdated or manual, with a detail. A run that cannot start on a machine often waits on one of these.",
      inputSchema: { project },
      annotations: readOnly,
    },
    withProject(async ({ project: p }) => run("machines.setupMissing", { project: p })),
  );

  // Roadmap 28e: the catalog, where its tools stand on the project's machines, and what runs used, for every token that reads.
  server.registerTool(
    "tool_list",
    {
      title: "List catalog tools",
      description:
        "The hub's tool catalog (MCP servers, Claude Code plugins, CLIs) with each entry's pinned package, the agents it is for, and the project's setting: " +
        "enabled (null: the tool's default), required, effective (whether the project's runs get it).",
      inputSchema: { project },
      annotations: readOnly,
    },
    withProject(async ({ project: p }) => run("tools.list", { project: p })),
  );

  server.registerTool(
    "tool_status",
    {
      title: "Where the project's tools stand",
      description:
        "Each catalog tool for the project: effective and required, the setup items that set it up (items: what propose_install takes), and on each machine " +
        "with the project those items as it last reported them (installed, missing, outdated, manual). A machine with no items for a tool runs an older app.",
      inputSchema: { project },
      annotations: readOnly,
    },
    withProject(async ({ project: p }) => run("tools.status", { project: p })),
  );

  server.registerTool(
    "token_usage",
    {
      title: "Project and run tokens",
      description:
        "Tokens of the project's runs: the last 30 days in total and its recent runs, each with input read fresh, written to the prompt cache, read from it, " +
        "output, and cacheReadShare (0–1, the share of input read from the cache; null when the run did not split its input). Codex runs have tokens but no price.",
      inputSchema: { project, limit: z.number().int().min(1).max(100).optional() },
      annotations: readOnly,
    },
    withProject(async ({ project: p, limit }) => {
      const hidden = unseen(p);
      if (hidden) return hidden;
      try {
        const [summary, runs] = await Promise.all([call("costs.summary", {}, actor), call("runs.list", { project: p, limit: limit ?? 20 }, actor)]);
        const totals = summary.projects.find((c) => c.project === p);
        const tokens30 = totals?.tokens30 ?? { inputTokens: null, cacheWriteTokens: null, cacheReadTokens: null, outputTokens: null };
        return json({
          project: p,
          last30: { runs: totals?.runs30 ?? 0, usd: totals?.usd30 ?? 0, ...tokens30, cacheReadShare: cacheReadShare(tokens30) },
          // Only runs that reported tokens: the rest would be rows of nulls.
          runs: runs.flatMap((r) =>
            r.tokens
              ? [{ machineId: r.machineId, runId: r.runId, taskId: r.taskId, role: r.role, profileId: r.profileId, status: r.status, finishedAt: r.finishedAt, usd: r.costUsd, ...r.tokens, cacheReadShare: cacheReadShare(r.tokens) }]
              : [],
          ),
        });
      } catch (err) {
        return failed(err);
      }
    }),
  );

  // Alerts are the hub's own (apps/web), not core's: only a hub admin sees them, as on the web. The hub-wide leader
  // gets them too (roadmap 37): its token is cut down from the machine's, but only a hub admin can open that chat at all.
  const alerts = opts.alerts;
  if (alerts && ((actor.role === "admin" && !actor.access) || (hubScope && leader))) {
    server.registerTool(
      "alert_list",
      {
        title: "Open hub alerts",
        description:
          "The hub's open alerts (machines offline, failing runs, caps near or over, waiting proposals…): rule, severity, project (null = the whole hub), vars, since when. " +
          "project narrows them to that project's and the hub-wide ones.",
        inputSchema: { project: z.string().optional().describe("Only this project's and the hub-wide alerts") },
        annotations: readOnly,
      },
      async ({ project: p }) => {
        try {
          const open = (await alerts.list()) as Array<{ project?: string | null }>;
          return json(p ? open.filter((a) => a.project == null || a.project === p) : open);
        } catch (err) {
          return failed(err);
        }
      },
    );
  }

  if (writes && !leader) {
    server.registerTool(
      "task_claim",
      {
        title: "Claim a task",
        description:
          "Take a lease on a task before working on it. Returns claimed=false if another agent holds a live lease. Fails while a task it depends on is not done, " +
          "and when the task is assigned to another machine's agent (task_list shows it as agent).",
        inputSchema: { id: z.string(), leaseMinutes: z.number().int().min(5).max(1440).optional() },
      },
      async ({ id, leaseMinutes }) => run("tasks.claim", { id, leaseMinutes }),
    );
  }

  if (writes && !leader) {
    server.registerTool(
      "task_update",
      {
        title: "Update a task",
        description:
          'Move a task to another status. Use "review" when done, with a note: done / not done / how to verify / risks. A task manager may change platforms alone.',
        inputSchema: { id: z.string(), status: z.enum(TASK_STATUSES).optional(), note: z.string().optional(), ...(taskManage ? { platforms: z.array(z.enum(TASK_PLATFORMS)).max(3).optional() } : {}) },
      },
      async ({ id, status, note, platforms }) => run("tasks.update", { id, status, note, ...(taskManage ? { platforms } : {}) }),
    );
  }

  if (cliLeader) {
    if (taskManage) {
      server.registerTool("task_create", {
        title: "Create a task", description: "Create a task on a project board with the account's taskManage right. platforms limits which machine OS may run it; empty means any OS.",
        inputSchema: { id: z.string(), project, title: z.string(), priority: z.number().int().min(0).max(100).optional(), note: z.string().optional(), dependsOn: z.array(z.string()).max(20).optional(), kind: z.enum(TASK_KINDS).optional(), size: z.enum(TASK_SIZES).optional(), risk: z.enum(TASK_RISKS).optional(), platforms: z.array(z.enum(TASK_PLATFORMS)).max(3).optional() },
      }, withProject(async ({ project: p, ...input }) => run("tasks.create", { ...input, project: p })));
      server.registerTool("task_set_deps", {
        title: "Set task dependencies", description: "Replace a task's dependencies; cycles are refused.",
        inputSchema: { id: z.string(), dependsOn: z.array(z.string()).max(20) },
      }, async ({ id, dependsOn }) => run("tasks.setDeps", { id, dependsOn }));
    }
    const canPlan = opts.defaultProject
      ? may(actor, opts.defaultProject, "taskManage") && may(actor, opts.defaultProject, "docPropose")
      : actor.access
        ? Object.keys(actor.access.projects).some((p) => may(actor, p, "taskManage") && may(actor, p, "docPropose"))
        : may(actor, null, "taskManage") && may(actor, null, "docPropose");
    if (canPlan) server.registerTool("plan_create", {
      title: "Create a plan", description: "Atomically create a new spec and its tasks with acceptance criteria, dependencies and batches. Requires document proposal and task management rights in every affected project.",
      inputSchema: { ...chatPlanSchema.shape, project: z.string() },
    }, async (plan) => run("plans.create", plan));
    if (allowed("runDispatch")) {
      server.registerTool("task_assign", {
        title: "Assign a task to an agent", description: "Assign a task to a machine's agent queue.",
        inputSchema: { id: z.string(), machineId: z.string(), profileId: z.string().nullable().optional(), before: z.string().optional() },
      }, async ({ id, machineId, profileId, before }) => run("tasks.assign", { id, machineId, profileId: profileId ?? null, before }));
      server.registerTool("run_dispatch", {
        title: "Dispatch a task run", description: "Queue a run using the account's runDispatch right.",
        inputSchema: { project, taskId: z.string(), machineId: z.string().nullable().optional(), role: z.enum(WORK_ROLES).optional(), profileId: z.string().nullable().optional(), reviewAfter: z.boolean().optional(), candidates: z.number().int().min(1).max(MAX_CANDIDATES).optional(), instructions: z.string().optional() },
      }, withProject(async ({ project: p, taskId, machineId, role, profileId, reviewAfter, candidates, instructions }) => run("runs.dispatch", { project: p, taskId, machineId: machineId ?? null, role, profileId: profileId ?? null, reviewAfter, candidates, instructions })));
    }
    if (allowed("taskWork")) server.registerTool("task_status", {
      title: "Set task status", description: "Move a task to another status with a handover note; core checks the account's taskWork and review rights.",
      inputSchema: { id: z.string(), status: z.enum(TASK_STATUSES), note: z.string().optional() },
    }, async ({ id, status, note }) => run("tasks.update", { id, status, note }));

    if (allowed("docPropose")) {
      const propose = (method: (typeof CLI_APPROVAL_METHODS)[number], input: Record<string, unknown>, project: string | null, why: string) =>
        run("proposals.create", { action: { method, input, project }, reason: why });
      const proposalProject = z.string().nullable().optional().describe("Project for this request; null means the hub or a machine-wide change");
      server.registerTool("propose_merge", {
        title: "Propose merging a run", description: "Request hub approval to merge a run's MR or PR.",
        inputSchema: { machineId: z.string(), runId: z.string(), project, reason },
      }, withProject(async ({ machineId, runId, project: p, reason: why }) => propose("runs.merge", { machineId, runId }, p, why)));
      server.registerTool("propose_cancel_run", {
        title: "Propose cancelling a run", description: "Request hub approval to cancel a queued or running run.",
        inputSchema: { machineId: z.string(), runId: z.string(), project, reason },
      }, withProject(async ({ machineId, runId, project: p, reason: why }) => propose("runs.cancel", { machineId, runId }, p, why)));
      server.registerTool("propose_stop_agents", {
        title: "Propose stopping agents", description: "Request hub approval to stop a project's agents, or the whole hub if project is null.",
        inputSchema: { project: proposalProject, reason },
      }, async ({ project: p, reason: why }) => propose("agents.stop", { project: p === undefined ? opts.defaultProject ?? null : p }, p === undefined ? opts.defaultProject ?? null : p, why));
      server.registerTool("propose_resume_agents", {
        title: "Propose resuming agents", description: "Request hub approval to resume agents.",
        inputSchema: { project: proposalProject, reason },
      }, async ({ project: p, reason: why }) => propose("agents.resume", { project: p === undefined ? opts.defaultProject ?? null : p }, p === undefined ? opts.defaultProject ?? null : p, why));
      server.registerTool("propose_policy", {
        title: "Propose agent policy", description: "Request hub approval for a project's agent policy change.",
        inputSchema: { project, policy: agentPolicyPartSchema.nullable(), reason },
      }, withProject(async ({ project: p, policy, reason: why }) => propose("agentPolicy.set", { project: p, policy }, p, why)));
      server.registerTool("propose_profile", {
        title: "Propose machine profile change", description: "Request hub approval to change a machine's agent profile.",
        inputSchema: { machineId: z.string(), profileId: z.string(), enabled: z.boolean().optional(), priority: z.number().int().min(0).max(100).optional(), reason },
      }, async ({ machineId, profileId, enabled, priority, reason: why }) => propose("machines.setProfile", { machineId, profileId, enabled, priority }, null, why));
      server.registerTool("propose_install", {
        title: "Propose setup install", description: "Request hub approval for a machine to install a setup item.",
        inputSchema: { machineId: z.string(), itemId: z.string(), project: proposalProject, reason },
      }, async ({ machineId, itemId, project: p, reason: why }) => propose("admin.commandCreate", { machineId, itemId }, p === undefined ? opts.defaultProject ?? null : p, why));
      server.registerTool("propose_tool", {
        title: "Propose tool setting", description: "Request hub approval to change a project's catalog tool setting.",
        inputSchema: { id: z.string(), enabled: z.boolean().nullable(), required: z.boolean(), project, reason },
      }, withProject(async ({ id, enabled, required, project: p, reason: why }) => propose("tools.setProject", { id, project: p, enabled, required }, p, why)));
    }
  }

  if (leader) {
    // Roadmap 29c: a project may let its leader run some kinds at once, as the person who wrote; the answer's status says.
    const confirm =
      " Nothing happens until a manager of the project confirms it in the chat; it then runs with their rights. A project may let its leader run some kinds at once," +
      " as the person who wrote to you: then the answer's status is done (or failed), not proposed.";
    // Roadmap 37: in the hub-wide chat the leader says which project each proposal is for; in a project's chat it is that project.
    const aim = hubScope
      ? z.string().describe("Required here: the project this is for (project_list)")
      : z.string().optional().describe("Left out: the chat's project");
    const aimed = (p: string | undefined) => (p ? { project: p } : {});
    server.registerTool(
      "propose_research",
      {
        title: "Propose research",
        description: "Propose a read-only research run: topic, questions, service/system/hub scope, repo/Hive/web sources and brief/comparison/tasks format. Name system for system scope. project is the anchor service (required in hub chat); hub scope is hub-admin only. The runner saves report.md and proposes a draft document; recommendations become a plan only when requested." + confirm,
        inputSchema: { ...researchSchema.omit({ project: true, machineId: true }).shape, project: aim, machine: z.string().optional(), reason },
      },
      async ({ reason: why, ...research }) => run("chat.propose", { action: { ...research, kind: "research.start" }, reason: why }),
    );
    server.registerTool(
      "propose_plan",
      {
        title: "Propose a plan",
        description: "Propose one complete plan: a NEW spec at project/<service>/<slug> or system/<system>/<slug>, tasks with acceptance criteria and dependsOn, and expected batches covering every task once. Tasks may name other services of the same system. Ask only for real decisions (design direction, dropping requirements, widening permissions or production changes). Report actual progress using task_list and run_list; never claim a batch shipped without evidence." + confirm,
        inputSchema: { ...chatPlanSchema.shape, project: aim, reason },
      },
      async ({ reason: why, ...plan }) => run("chat.propose", { action: { ...plan, kind: "plan.create" }, reason: why }),
    );
    server.registerTool(
      "propose_task",
      {
        title: "Propose a task",
        description:
          "Propose a new task on a project board (id like the project's others, e.g. T-12; dependsOn: tasks to be done first). " +
          (hubScope ? "project is required (project_list). " : "") +
          "project: another service of a system the chat's project is in, for a feature split across services; dependsOn may then name tasks of the other services. " +
          "taskKind, size, risk: what the task is, when you know (see propose_task_classify); left out, the hub's rules and a cheap classify run fill them." +
          confirm,
        inputSchema: {
          id: z.string(),
          title: z.string(),
          project: hubScope ? aim : z.string().optional().describe("Another service of the chat project's system; left out: the chat's project"),
          dependsOn: z.array(z.string()).max(20).optional(),
          taskKind: z.enum(TASK_KINDS).optional(),
          size: z.enum(TASK_SIZES).optional(),
          risk: z.enum(TASK_RISKS).optional(),
          platforms: z.array(z.enum(TASK_PLATFORMS)).max(3).optional(),
          reason,
        },
      },
      async ({ id, title, project: p, dependsOn, taskKind, size, risk, platforms, reason: why }) =>
        run("chat.propose", {
          action: { kind: "task.create", id, title, ...(p ? { project: p } : {}), dependsOn: dependsOn ?? [], ...(taskKind ? { taskKind } : {}), ...(size ? { size } : {}), ...(risk ? { risk } : {}), ...(platforms ? { platforms } : {}) },
          reason: why,
        }),
    );
    server.registerTool(
      "propose_task_status",
      {
        title: "Propose a task status",
        description: "Propose moving a task to another status, with a note. The task has to be in the project this is for." + confirm,
        inputSchema: { id: z.string(), status: z.enum(TASK_STATUSES), note: z.string().optional(), project: aim, reason },
      },
      async ({ id, status, note, project: p, reason: why }) => run("chat.propose", { action: { kind: "task.update", id, status, note, ...aimed(p) }, reason: why }),
    );
    server.registerTool(
      "propose_task_classify",
      {
        title: "Propose a task classification",
        description:
          "Propose what a task is, so its runs start on a fitting model: taskKind (docs, test, small-fix, feature, ui, refactor, debug, spec, review, merge, ops), " +
          "size (s, m, l), risk (high: a migration, security, permissions or several core packages). At least one of the three." +
          confirm,
        inputSchema: { id: z.string(), taskKind: z.enum(TASK_KINDS).optional(), size: z.enum(TASK_SIZES).optional(), risk: z.enum(TASK_RISKS).optional(), project: aim, reason },
      },
      async ({ id, taskKind, size, risk, project: p, reason: why }) => run("chat.propose", { action: { kind: "task.classify", id, taskKind, size, risk, ...aimed(p) }, reason: why }),
    );
    server.registerTool(
      "propose_run",
      {
        title: "Propose a run",
        description:
          "Propose an agent run of a task on a team machine (the chat's machine unless machine names another): role implement or review, " +
          "profileId to pin a plan (else the machine rotates), candidates for several attempts, reviewAfter to review when done, instructions for the agent." +
          confirm,
        inputSchema: {
          taskId: z.string(),
          role: z.enum(WORK_ROLES).optional(),
          machine: z.string().optional(),
          profileId: z.string().optional(),
          candidates: z.number().int().min(1).max(MAX_CANDIDATES).optional(),
          reviewAfter: z.boolean().optional(),
          instructions: z.string().optional(),
          project: aim,
          reason,
        },
      },
      async ({ taskId, role, machine, profileId, candidates, reviewAfter, instructions, project: p, reason: why }) =>
        run("chat.propose", {
          action: { kind: "run.dispatch", taskId, role, machine, profileId: profileId ?? null, candidates, reviewAfter, instructions, ...aimed(p) },
          reason: why,
        } as MethodInput<"chat.propose">),
    );
    const machine = z.string().describe("The machine's hub id or name (machine_list)");
    const runId = z.string().describe("The run's id, e.g. R-1a2b3c (run_list)");
    server.registerTool(
      "propose_task_agent",
      {
        title: "Propose giving a task to an agent",
        description:
          "Propose that a task of the chat's project belongs to one agent: the hub queues its run on that machine by itself as soon as the agent is free and " +
          "the task waits for nothing, and no other agent takes it. profileId pins a plan (machine_list); left out, any plan of that machine. " +
          'Use this for "give X to <machine>", and for work that should wait for a machine busy now; propose_run is for a run to start at once.' +
          confirm,
        inputSchema: { taskId: z.string(), machine, profileId: z.string().optional(), project: aim, reason },
      },
      async ({ taskId, machine: m, profileId, project: p, reason: why }) =>
        run("chat.propose", { action: { kind: "task.assign", taskId, machine: m, profileId: profileId ?? null, ...aimed(p) }, reason: why } as MethodInput<"chat.propose">),
    );
    server.registerTool(
      "propose_cancel_run",
      {
        title: "Propose cancelling a run",
        description: "Propose stopping a run that still waits or runs on its machine. The run has to be the project's this is for." + confirm,
        inputSchema: { machine, runId, project: aim, reason },
      },
      async ({ machine: m, runId: id, project: p, reason: why }) => run("chat.propose", { action: { kind: "run.cancel", machine: m, runId: id, ...aimed(p) }, reason: why }),
    );
    server.registerTool(
      "propose_merge",
      {
        title: "Propose merging a run's MR/PR",
        description: "Propose merging the MR or PR a run opened; the run's machine merges it with its own token. The run has to be the project's this is for." + confirm,
        inputSchema: { machine, runId, project: aim, reason },
      },
      async ({ machine: m, runId: id, project: p, reason: why }) => run("chat.propose", { action: { kind: "run.merge", machine: m, runId: id, ...aimed(p) }, reason: why }),
    );
    server.registerTool(
      "propose_profile",
      {
        title: "Propose a machine's plan change",
        description:
          "Propose turning one of a machine's plans (profiles, see machine_list) on or off, or changing its priority; give enabled, priority or both. " +
          "A plan belongs to the machine, not to any project, so this takes no project." +
          confirm,
        inputSchema: {
          machine,
          profileId: z.string(),
          enabled: z.boolean().optional(),
          priority: z.number().int().min(0).max(100).optional(),
          reason,
        },
      },
      async ({ machine: m, profileId, enabled, priority, reason: why }) =>
        run("chat.propose", { action: { kind: "machine.profile", machine: m, profileId, enabled, priority }, reason: why }),
    );
    // These three mean the whole hub when the hub-wide chat names no project: a much bigger ask, so it is said, not assumed.
    const orHub = hubScope
      ? z.string().optional().describe("The project this is for; left out: the whole hub, every project at once")
      : z.string().optional().describe("Left out: the chat's project");
    server.registerTool(
      "propose_policy",
      {
        title: "Propose an agent policy",
        description:
          "Propose a project's part of the agent policy, replacing the current part: only the fields it sets (models, autonomy, network, mcp), " +
          "which can only tighten the hub's default; null removes the project's part." +
          (hubScope ? " Without project this is the hub's own default, which binds every project: say so in your reply." : "") +
          confirm,
        inputSchema: { policy: agentPolicyPartSchema.nullable(), project: orHub, reason },
      },
      async ({ policy, project: p, reason: why }) => run("chat.propose", { action: { kind: "agent.policy", policy, ...aimed(p) }, reason: why } as MethodInput<"chat.propose">),
    );
    server.registerTool(
      "propose_stop_agents",
      {
        title: "Propose stopping every agent",
        description:
          "Propose stopping every agent of a project: running runs are cancelled, queued ones wait, no new run or chat reply starts until resumed." +
          (hubScope ? " Without project this stops every agent of the whole hub." : "") +
          confirm,
        inputSchema: { project: orHub, reason },
      },
      async ({ project: p, reason: why }) => run("chat.propose", { action: { kind: "agents.stop", ...aimed(p) }, reason: why }),
    );
    server.registerTool(
      "propose_resume_agents",
      {
        title: "Propose letting agents run again",
        description: "Propose lifting the stop on a project, so its agents run again." + (hubScope ? " Without project this lifts the hub's own stop." : "") + confirm,
        inputSchema: { project: orHub, reason },
      },
      async ({ project: p, reason: why }) => run("chat.propose", { action: { kind: "agents.resume", ...aimed(p) }, reason: why }),
    );
    server.registerTool(
      "propose_install",
      {
        title: "Propose a machine install",
        description:
          "Propose that a machine installs a setup item it reported as missing: the machine's own (cli:<kind>, shim, tool:<id>), which needs no project, " +
          "or a project's (<project>:<part>)" +
          (hubScope ? ", which needs project, the same one the item names." : ", of the chat's project.") +
          confirm,
        inputSchema: { machine, itemId: z.string(), project: orHub, reason },
      },
      async ({ machine: m, itemId, project: p, reason: why }) =>
        run("chat.propose", { action: { kind: "machine.install", machine: m, itemId, ...aimed(p) }, reason: why } as MethodInput<"chat.propose">),
    );
    server.registerTool(
      "propose_tool",
      {
        title: "Propose a tool setting",
        description:
          "Propose a project's own setting for a catalog tool (tool_list): enabled true or false, or null to follow the tool's default; required to make " +
          "every machine with the project need it (left out: as the project has it now). Approving it needs the project's settings right." +
          confirm,
        inputSchema: {
          id: z.string().describe("The tool's id (tool_list)"),
          enabled: z.boolean().nullable(),
          required: z.boolean().optional(),
          project: aim,
          reason,
        },
      },
      async ({ id, enabled, required, project: p, reason: why }) =>
        run("chat.propose", { action: { kind: "tool.enable", id, enabled, required, ...aimed(p) }, reason: why } as MethodInput<"chat.propose">),
    );
  }

  return server;
}
