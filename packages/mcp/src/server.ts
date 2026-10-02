import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  AGENT_ROLES,
  cacheReadShare,
  effectivePolicy,
  agentPolicyPartSchema,
  MAX_CANDIDATES,
  MEMORY_KINDS,
  PAUSED_HUB,
  sees,
  skillDocKey,
  TASK_STATUSES,
  toErrorPayload,
  type Actor,
  type HiveBackend,
  type Method,
  type MethodInput,
} from "@xdev-hive/core";
import { z } from "zod";

export interface HiveMcpOptions {
  /** Used when a tool call omits `project` (e.g. from HIVE_PROJECT). */
  defaultProject?: string;
  /** Only the read tools. Default: read-only for viewer tokens. */
  readOnly?: boolean;
  /** The hub's open alerts (apps/web keeps them, not core): alert_list, for hub admins only. */
  alerts?: { list(): Promise<unknown[]> };
}

const INSTRUCTIONS = `xDev Hive is the shared memory, docs and task board for every coding agent on this team.
Start of session: memory_search for your topic. Before working: task_claim (task_next suggests a ready task). Record decisions/conventions/gotchas with memory_write.
Never edit AGENTS.md, CLAUDE.md or docs/decisions.md directly: doc_get, then doc_propose with the baseVersion you read.
Team skills (how the team does recurring work): skill_list, then skill_get the ones that fit. A new or better skill: skill_propose.
End of session: task_update to "review" with a note (done / not done / how to verify / risks). Never store secrets.`;

const READ_ONLY_INSTRUCTIONS = `xDev Hive is the shared memory, docs and task board for every coding agent on this team.
This connection is read-only: memory_search, doc_list, doc_get, skill_list, skill_get, task_list, task_next, run_list, run_get, run_requests, machine_list, setup_missing, cost_summary, token_usage, tool_list, tool_status and policy_get (alert_list for hub admins). Search memory for your topic before working.
Put anything worth sharing (decisions, gotchas, the handoff) in your final message instead of writing it to Hive.`;

// A chat leader (the hub's token for one reply) changes nothing on the board itself: it proposes, a project manager confirms.
const LEADER_INSTRUCTIONS = `
You are the project's leader in the Hive chat: read skill_get hive-leader first. You cannot create or move tasks or queue runs yourself: propose them with
propose_task, propose_task_status and propose_run, and say in your reply what you proposed. A project manager confirms or
sets aside each one in the chat, and it runs with their rights; a kind the project lets you run on your own runs at once,
as the person who wrote to you (the answer says done or failed): say which ran and which wait. The same for the rest of the project's operations, always on the chat's project: propose_cancel_run (stop a queued or running run),
propose_merge (merge a run's MR/PR), propose_profile (turn a machine's plan on or off, or change its priority),
propose_policy (the project's agent policy), propose_stop_agents and propose_resume_agents (every agent of the project),
propose_install (a machine installs a setup item it reported; for a tool, the items tool_status lists), propose_tool (turn a catalog
tool on or off for the project). Look first with run_list, machine_list and tool_list: a proposal of a run, plan or tool the hub
does not know is refused.`;

// Kept apart from LEADER_INSTRUCTIONS so the proposal list there can grow (roadmap 29b) without touching this.
const LEADER_READ_INSTRUCTIONS = `
Read before you answer or propose: costs and spending caps with cost_summary; a run that does not start with run_list, run_requests
(rejected or expired requests and why) and setup_missing (what a machine lacks); the agent policy and whether agents are stopped with policy_get;
the tools runs may get with tool_list, and where each stands on the machines with tool_status; tokens and the share read from the prompt
cache with token_usage (quote its numbers: never guess what a tool saves); the hub's open alerts with alert_list when you have it.`;

const project = z.string().optional().describe('Hive project key (see "Hive project key" in AGENTS.md)');
const reason = z.string().min(1).max(500).describe("One line for the person confirming it: why");

export function createHiveMcpServer(backend: HiveBackend, actor: Actor, opts: HiveMcpOptions = {}): McpServer {
  // Write tools are not registered at all, so a read-only agent never sees them.
  const writes = !(opts.readOnly ?? actor.role === "viewer");
  // A chat leader works on no task of its own: no claim or status change, proposals instead.
  const leader = writes && actor.chatReply !== undefined;
  const instructions = !writes ? READ_ONLY_INSTRUCTIONS : leader ? INSTRUCTIONS + LEADER_INSTRUCTIONS + LEADER_READ_INSTRUCTIONS : INSTRUCTIONS;
  const server = new McpServer({ name: "xdev-hive", version: "0.1.0" }, { instructions });

  const run = async <M extends Method>(method: M, input: MethodInput<M>): Promise<CallToolResult> => {
    try {
      const result = await backend.call(method, input, actor);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      const { code, message } = toErrorPayload(err);
      return { isError: true, content: [{ type: "text", text: `${code}: ${message}` }] };
    }
  };
  const needProject = (p: string | undefined): string => {
    const value = p ?? opts.defaultProject;
    if (!value) throw new Error("project is required (pass the Hive project key from AGENTS.md)");
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

  const readOnly = { readOnlyHint: true, openWorldHint: false } as const;

  server.registerTool(
    "doc_list",
    {
      title: "List shared docs",
      description: "List org-wide docs and this project's docs (key, title, version, paths: the globs a doc applies to, [] = whole repo). Use doc_get to read one.",
      inputSchema: { project },
      annotations: readOnly,
    },
    async ({ project: p }) => run("docs.list", { project: p ?? opts.defaultProject }),
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
    async ({ key }) => run("docs.get", { key }),
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
        const got = await backend.call("docs.assetGet", { key, name }, actor);
        if (!got) return { isError: true, content: [{ type: "text", text: `not_found: ${key} has no file ${name} (doc_asset without name lists them)` }] };
        const { type } = got.asset;
        if (type.startsWith("image/")) return { content: [{ type: "image", data: got.data, mimeType: type }] };
        if (type === "application/pdf") {
          return { content: [{ type: "resource", resource: { uri: `hive://docs/${key}/assets/${encodeURIComponent(name)}`, mimeType: type, blob: got.data } }] };
        }
        return { content: [{ type: "text", text: Buffer.from(got.data, "base64").toString("utf8") }] };
      } catch (err) {
        const { code, message } = toErrorPayload(err);
        return { isError: true, content: [{ type: "text", text: `${code}: ${message}` }] };
      }
    },
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
    async ({ project: p }) => run("skills.list", { project: p ?? opts.defaultProject }),
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
      const scope = p ?? opts.defaultProject;
      try {
        const own = scope ? await backend.call("docs.get", { key: skillDocKey(name, scope) }, actor) : null;
        const doc = own ?? (await backend.call("docs.get", { key: skillDocKey(name) }, actor));
        if (!doc) return { isError: true, content: [{ type: "text", text: `not_found: no skill ${name} (see skill_list)` }] };
        return { content: [{ type: "text", text: JSON.stringify(doc, null, 2) }] };
      } catch (err) {
        const { code, message } = toErrorPayload(err);
        return { isError: true, content: [{ type: "text", text: `${code}: ${message}` }] };
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
        'Search decisions, conventions, gotchas and context recorded by any agent on this project, plus team-wide entries (project: null means shared by every project) and those of the systems the project is a service of (project: "sys:<system>"). Empty query returns the latest entries. ' +
        "On a hub with embeddings it also finds entries by meaning (other words, other language), so a short question works. " +
        "Entries no agent used for a long time are left out until a person keeps them. An entry with review set cites files that changed since: check them before relying on it. " +
        "conflictsWith lists entries that disagree with it until a person decides; replaced entries are left out.",
      inputSchema: { project, query: z.string().optional(), limit: z.number().int().min(1).max(50).optional() },
      annotations: readOnly,
    },
    withProject(async ({ project: p, query, limit }) => run("memory.search", { project: p, query, limit, includeShared: true })),
  );

  if (writes) {
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
        "List tasks on the shared board for a project, optionally filtered by status. dependsOn: tasks that must be done first; waitingOn: those still open.",
      inputSchema: { project, status: z.enum(TASK_STATUSES).optional() },
      annotations: readOnly,
    },
    withProject(async ({ project: p, status }) => run("tasks.list", { project: p, status })),
  );

  server.registerTool(
    "task_next",
    {
      title: "Next ready tasks",
      description:
        "Tasks ready to start in a project: to do, nothing they depend on is open, nobody holds them. The ones that unlock the most other tasks come first.",
      inputSchema: { project, limit: z.number().int().min(1).max(20).optional() },
      annotations: readOnly,
    },
    withProject(async ({ project: p, limit }) => run("tasks.next", { project: p, limit })),
  );

  // Hub mode: what machines pushed (runs.push) and reported (heartbeats); a local database has none.
  server.registerTool(
    "run_list",
    {
      title: "List agent runs",
      description:
        "Agent runs the team's machines reported to the hub, newest first: task, role (implement, review), machine, plan, status, " +
        "activity, the result summary (a review's verdict), error, branch, MR. run_get reads one with the end of its log.",
      inputSchema: { project, limit: z.number().int().min(1).max(100).optional() },
      annotations: readOnly,
    },
    withProject(async ({ project: p, limit }) => run("runs.list", { project: p, limit: limit ?? 30 })),
  );

  server.registerTool(
    "run_get",
    {
      title: "Read an agent run",
      description: "One run from run_list (machineId and runId as listed) with the end of its log: the agent's steps and result, secrets hidden.",
      inputSchema: { machineId: z.string(), runId: z.string() },
      annotations: readOnly,
    },
    async ({ machineId, runId }) => run("runs.get", { machineId, runId }),
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
  const json = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
  const failed = (err: unknown): CallToolResult => {
    const { code, message } = toErrorPayload(err);
    return { isError: true, content: [{ type: "text", text: `${code}: ${message}` }] };
  };

  server.registerTool(
    "cost_summary",
    {
      title: "Project costs and caps",
      description:
        "What the project's agent runs cost at API prices over the last 24 hours, 7 days and 30 days (usd1, usd7, usd30, runs30), " +
        "and the spending caps that apply to it (the project's, the hub's, your own) with what each period used so far (ratio 1 = full, no new run starts).",
      inputSchema: { project },
      annotations: readOnly,
    },
    withProject(async ({ project: p }) => {
      const hidden = unseen(p);
      if (hidden) return hidden;
      try {
        const [summary, budgets] = await Promise.all([backend.call("costs.summary", {}, actor), backend.call("budgets.list", {}, actor)]);
        const me = actor.onBehalf ?? actor.name;
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
    withProject(async ({ project: p, limit }) => run("runs.requests", { project: p, limit: limit ?? 30 })),
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
          backend.call("agentPolicy.get", {}, actor),
          backend.call("policy.get", {}, actor),
          backend.call("agents.paused", {}, actor),
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
        "Each machine with the project's repo and what its last setup check found not installed: the machine's (cli:<kind>, shim) and the project's (<project>:<part>), " +
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
        const [summary, runs] = await Promise.all([backend.call("costs.summary", {}, actor), backend.call("runs.list", { project: p, limit: limit ?? 20 }, actor)]);
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

  // Alerts are the hub's own (apps/web), not core's: only a hub admin sees them, as on the web.
  const alerts = opts.alerts;
  if (alerts && actor.role === "admin" && !actor.access) {
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
          "Take a lease on a task before working on it. Returns claimed=false if another agent holds a live lease. Fails while a task it depends on is not done.",
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
          'Move a task to another status. Use "review" when done, with a note: done / not done / how to verify / risks.',
        inputSchema: { id: z.string(), status: z.enum(TASK_STATUSES), note: z.string().optional() },
      },
      async ({ id, status, note }) => run("tasks.update", { id, status, note }),
    );
  }

  if (leader) {
    // Roadmap 29c: a project may let its leader run some kinds at once, as the person who wrote; the answer's status says.
    const confirm =
      " Nothing happens until a manager of the project confirms it in the chat; it then runs with their rights. A project may let its leader run some kinds at once," +
      " as the person who wrote to you: then the answer's status is done (or failed), not proposed.";
    server.registerTool(
      "propose_task",
      {
        title: "Propose a task",
        description:
          "Propose a new task on the chat's project board (id like the project's others, e.g. T-12; dependsOn: tasks to be done first). " +
          "project: another service of a system the chat's project is in, for a feature split across services; dependsOn may then name tasks of the other services." +
          confirm,
        inputSchema: {
          id: z.string(),
          title: z.string(),
          project: z.string().optional().describe("Another service of the chat project's system; left out: the chat's project"),
          dependsOn: z.array(z.string()).max(20).optional(),
          reason,
        },
      },
      async ({ id, title, project: p, dependsOn, reason: why }) =>
        run("chat.propose", { action: { kind: "task.create", id, title, ...(p ? { project: p } : {}), dependsOn: dependsOn ?? [] }, reason: why }),
    );
    server.registerTool(
      "propose_task_status",
      {
        title: "Propose a task status",
        description: "Propose moving a task of the chat's project to another status, with a note." + confirm,
        inputSchema: { id: z.string(), status: z.enum(TASK_STATUSES), note: z.string().optional(), reason },
      },
      async ({ id, status, note, reason: why }) => run("chat.propose", { action: { kind: "task.update", id, status, note }, reason: why }),
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
          role: z.enum(AGENT_ROLES).optional(),
          machine: z.string().optional(),
          profileId: z.string().optional(),
          candidates: z.number().int().min(1).max(MAX_CANDIDATES).optional(),
          reviewAfter: z.boolean().optional(),
          instructions: z.string().optional(),
          reason,
        },
      },
      async ({ taskId, role, machine, profileId, candidates, reviewAfter, instructions, reason: why }) =>
        run("chat.propose", {
          action: { kind: "run.dispatch", taskId, role, machine, profileId: profileId ?? null, candidates, reviewAfter, instructions },
          reason: why,
        } as MethodInput<"chat.propose">),
    );
    const machine = z.string().describe("The machine's hub id or name (machine_list)");
    const runId = z.string().describe("The run's id, e.g. R-1a2b3c (run_list)");
    server.registerTool(
      "propose_cancel_run",
      {
        title: "Propose cancelling a run",
        description: "Propose stopping a run of the chat's project that still waits or runs on its machine." + confirm,
        inputSchema: { machine, runId, reason },
      },
      async ({ machine: m, runId: id, reason: why }) => run("chat.propose", { action: { kind: "run.cancel", machine: m, runId: id }, reason: why }),
    );
    server.registerTool(
      "propose_merge",
      {
        title: "Propose merging a run's MR/PR",
        description: "Propose merging the MR or PR a run of the chat's project opened; the run's machine merges it with its own token." + confirm,
        inputSchema: { machine, runId, reason },
      },
      async ({ machine: m, runId: id, reason: why }) => run("chat.propose", { action: { kind: "run.merge", machine: m, runId: id }, reason: why }),
    );
    server.registerTool(
      "propose_profile",
      {
        title: "Propose a machine's plan change",
        description: "Propose turning one of a machine's plans (profiles, see machine_list) on or off, or changing its priority; give enabled, priority or both." + confirm,
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
    server.registerTool(
      "propose_policy",
      {
        title: "Propose the project's agent policy",
        description:
          "Propose the chat's project part of the agent policy, replacing the current part: only the fields it sets (models, autonomy, network, mcp), " +
          "which can only tighten the hub's default; null removes the project's part." +
          confirm,
        inputSchema: { policy: agentPolicyPartSchema.nullable(), reason },
      },
      async ({ policy, reason: why }) => run("chat.propose", { action: { kind: "agent.policy", policy }, reason: why } as MethodInput<"chat.propose">),
    );
    server.registerTool(
      "propose_stop_agents",
      {
        title: "Propose stopping every agent",
        description: "Propose stopping every agent of the chat's project: running runs are cancelled, queued ones wait, no new run or chat reply starts until resumed." + confirm,
        inputSchema: { reason },
      },
      async ({ reason: why }) => run("chat.propose", { action: { kind: "agents.stop" }, reason: why }),
    );
    server.registerTool(
      "propose_resume_agents",
      {
        title: "Propose letting agents run again",
        description: "Propose lifting the stop on the chat's project, so its agents run again." + confirm,
        inputSchema: { reason },
      },
      async ({ reason: why }) => run("chat.propose", { action: { kind: "agents.resume" }, reason: why }),
    );
    server.registerTool(
      "propose_install",
      {
        title: "Propose a machine install",
        description:
          "Propose that a machine installs a setup item it reported as missing: the machine's own (cli:<kind>, shim) or the chat project's (<project>:<part>)." + confirm,
        inputSchema: { machine, itemId: z.string(), reason },
      },
      async ({ machine: m, itemId, reason: why }) => run("chat.propose", { action: { kind: "machine.install", machine: m, itemId }, reason: why } as MethodInput<"chat.propose">),
    );
    server.registerTool(
      "propose_tool",
      {
        title: "Propose a tool setting",
        description:
          "Propose the chat project's own setting for a catalog tool (tool_list): enabled true or false, or null to follow the tool's default; required to make " +
          "every machine with the project need it (left out: as the project has it now). Approving it needs the project's settings right." +
          confirm,
        inputSchema: {
          id: z.string().describe("The tool's id (tool_list)"),
          enabled: z.boolean().nullable(),
          required: z.boolean().optional(),
          reason,
        },
      },
      async ({ id, enabled, required, reason: why }) => run("chat.propose", { action: { kind: "tool.enable", id, enabled, required }, reason: why } as MethodInput<"chat.propose">),
    );
  }

  return server;
}
