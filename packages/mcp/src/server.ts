import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  AGENT_ROLES,
  MAX_CANDIDATES,
  MEMORY_KINDS,
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
}

const INSTRUCTIONS = `xDev Hive is the shared memory, docs and task board for every coding agent on this team.
Start of session: memory_search for your topic. Before working: task_claim (task_next suggests a ready task). Record decisions/conventions/gotchas with memory_write.
Never edit AGENTS.md, CLAUDE.md or docs/decisions.md directly: doc_get, then doc_propose with the baseVersion you read.
Team skills (how the team does recurring work): skill_list, then skill_get the ones that fit. A new or better skill: skill_propose.
End of session: task_update to "review" with a note (done / not done / how to verify / risks). Never store secrets.`;

const READ_ONLY_INSTRUCTIONS = `xDev Hive is the shared memory, docs and task board for every coding agent on this team.
This connection is read-only: memory_search, doc_list, doc_get, skill_list, skill_get, task_list, task_next, run_list, run_get and machine_list. Search memory for your topic before working.
Put anything worth sharing (decisions, gotchas, the handoff) in your final message instead of writing it to Hive.`;

// A chat leader (the hub's token for one reply) changes nothing on the board itself: it proposes, a project manager confirms.
const LEADER_INSTRUCTIONS = `
You are the project's leader in the Hive chat: read skill_get hive-leader first. You cannot create or move tasks or queue runs yourself: propose them with
propose_task, propose_task_status and propose_run, and say in your reply what you proposed. A project manager confirms or
sets aside each one in the chat, and it runs with their rights.`;

const project = z.string().optional().describe('Hive project key (see "Hive project key" in AGENTS.md)');
const reason = z.string().min(1).max(500).describe("One line for the person confirming it: why");

export function createHiveMcpServer(backend: HiveBackend, actor: Actor, opts: HiveMcpOptions = {}): McpServer {
  // Write tools are not registered at all, so a read-only agent never sees them.
  const writes = !(opts.readOnly ?? actor.role === "viewer");
  // A chat leader works on no task of its own: no claim or status change, proposals instead.
  const leader = writes && actor.chatReply !== undefined;
  const instructions = !writes ? READ_ONLY_INSTRUCTIONS : leader ? INSTRUCTIONS + LEADER_INSTRUCTIONS : INSTRUCTIONS;
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
    const confirm = " Nothing happens until a manager of the project confirms it in the chat; it then runs with their rights.";
    server.registerTool(
      "propose_task",
      {
        title: "Propose a task",
        description: "Propose a new task on the chat's project board (id like the project's others, e.g. T-12; dependsOn: tasks to be done first)." + confirm,
        inputSchema: { id: z.string(), title: z.string(), dependsOn: z.array(z.string()).max(20).optional(), reason },
      },
      async ({ id, title, dependsOn, reason: why }) => run("chat.propose", { action: { kind: "task.create", id, title, dependsOn: dependsOn ?? [] }, reason: why }),
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
  }

  return server;
}
