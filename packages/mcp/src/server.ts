import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  MEMORY_KINDS,
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
Start of session: memory_search for your topic. Before working: task_claim. Record decisions/conventions/gotchas with memory_write.
Never edit AGENTS.md, CLAUDE.md or docs/decisions.md directly: doc_get, then doc_propose with the baseVersion you read.
End of session: task_update to "review" with a note (done / not done / how to verify / risks). Never store secrets.`;

const READ_ONLY_INSTRUCTIONS = `xDev Hive is the shared memory, docs and task board for every coding agent on this team.
This connection is read-only: memory_search, doc_list, doc_get and task_list. Search memory for your topic before working.
Put anything worth sharing (decisions, gotchas, the handoff) in your final message instead of writing it to Hive.`;

const project = z.string().optional().describe('Hive project key (see "Hive project key" in AGENTS.md)');

export function createHiveMcpServer(backend: HiveBackend, actor: Actor, opts: HiveMcpOptions = {}): McpServer {
  // Write tools are not registered at all, so a read-only agent never sees them.
  const writes = !(opts.readOnly ?? actor.role === "viewer");
  const server = new McpServer({ name: "xdev-hive", version: "0.1.0" }, { instructions: writes ? INSTRUCTIONS : READ_ONLY_INSTRUCTIONS });

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
      description: "List org-wide docs and this project's docs (key, title, version). Use doc_get to read one.",
      inputSchema: { project },
      annotations: readOnly,
    },
    async ({ project: p }) => run("docs.list", { project: p ?? opts.defaultProject }),
  );

  server.registerTool(
    "doc_get",
    {
      title: "Read a doc",
      description: "Read the current content and version of a doc, e.g. org/agent-protocol or project/<project>/agents.",
      inputSchema: { key: z.string() },
      annotations: readOnly,
    },
    async ({ key }) => run("docs.get", { key }),
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
    "memory_search",
    {
      title: "Search team memory",
      description:
        'Search decisions, conventions, gotchas and context recorded by any agent on this project, plus team-wide entries (project: null means shared by every project). Empty query returns the latest entries. ' +
        "Entries no agent used for a long time are left out until a person keeps them.",
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
          "shared: true only for something true in every project of the team (e.g. an org-wide convention); otherwise it belongs to this project.",
        inputSchema: {
          project,
          shared: z.boolean().optional().describe("Team-wide entry seen from every project (no project then)"),
          kind: z.enum(MEMORY_KINDS),
          content: z.string(),
          taskId: z.string().optional(),
        },
      },
      async ({ project: p, shared, kind, content, taskId }) => {
        if (shared) return run("memory.write", { shared: true, kind, content, taskId });
        return withProject(async ({ project: q }: { project: string }) => run("memory.write", { project: q, kind, content, taskId }))({ project: p });
      },
    );
  }

  server.registerTool(
    "task_list",
    {
      title: "List tasks",
      description: "List tasks on the shared board for a project, optionally filtered by status.",
      inputSchema: { project, status: z.enum(TASK_STATUSES).optional() },
      annotations: readOnly,
    },
    withProject(async ({ project: p, status }) => run("tasks.list", { project: p, status })),
  );

  if (writes) {
    server.registerTool(
      "task_claim",
      {
        title: "Claim a task",
        description:
          "Take a lease on a task before working on it. Returns claimed=false if another agent holds a live lease.",
        inputSchema: { id: z.string(), leaseMinutes: z.number().int().min(5).max(1440).optional() },
      },
      async ({ id, leaseMinutes }) => run("tasks.claim", { id, leaseMinutes }),
    );
  }

  if (writes) {
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

  return server;
}
