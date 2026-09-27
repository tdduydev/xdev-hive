import { z } from "zod";
import { HiveError } from "./errors.ts";
import { PROJECT_NAME } from "./keys.ts";
import {
  MEMORY_KINDS,
  MEMORY_STATUSES,
  PROPOSAL_STATUSES,
  TASK_STATUSES,
  type Actor,
  type Doc,
  type DocSummary,
  type DocVersion,
  type Memory,
  type Proposal,
  type Role,
  type Task,
} from "./types.ts";

const docKey = z.string().min(1).max(200);
const project = z.string().regex(PROJECT_NAME, "project must be lowercase letters, digits, . _ -");
const id = z.number().int().positive();
const taskId = z.string().regex(/^[A-Za-z0-9._-]{1,100}$/, "task id: letters, digits, . _ -");
const content = z.string().max(200_000);

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

  "memory.search": z.object({
    project,
    query: z.string().max(500).default(""),
    limit: z.number().int().min(1).max(50).default(10),
  }),
  "memory.list": z.object({
    project: project.optional(),
    status: z.enum(MEMORY_STATUSES).optional(),
    limit: z.number().int().min(1).max(500).default(200),
  }),
  "memory.write": z.object({
    project,
    kind: z.enum(MEMORY_KINDS),
    content: z.string().min(1).max(4000),
    taskId: taskId.optional(),
  }),
  "memory.approve": z.object({ id }),
  "memory.remove": z.object({ id }),

  "tasks.list": z.object({
    project: project.optional(),
    status: z.enum(TASK_STATUSES).optional(),
  }),
  "tasks.create": z.object({ id: taskId, project, title: z.string().min(1).max(300) }),
  "tasks.claim": z.object({
    id: taskId,
    leaseMinutes: z.number().int().min(5).max(24 * 60).default(120),
  }),
  "tasks.update": z.object({
    id: taskId,
    status: z.enum(TASK_STATUSES),
    note: z.string().max(2000).optional(),
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
  "memory.remove": { removed: boolean };
  "tasks.list": Task[];
  "tasks.create": Task;
  "tasks.claim": { claimed: boolean; task: Task | null };
  "tasks.update": Task;
}

/** Minimum role per method. viewer < agent < admin. */
export const METHOD_ROLES: Record<Method, Role> = {
  "docs.list": "viewer",
  "docs.get": "viewer",
  "docs.history": "viewer",
  "docs.save": "admin",
  "proposals.list": "viewer",
  "proposals.create": "agent",
  "proposals.approve": "admin",
  "proposals.reject": "admin",
  "memory.search": "viewer",
  "memory.list": "viewer",
  "memory.write": "agent",
  "memory.approve": "admin",
  "memory.remove": "admin",
  "tasks.list": "viewer",
  "tasks.create": "admin",
  "tasks.claim": "agent",
  "tasks.update": "agent",
};

export const ROLE_RANK: Record<Role, number> = { viewer: 0, agent: 1, admin: 2 };
export const ROLES = Object.keys(ROLE_RANK) as Role[];

export function isMethod(value: unknown): value is Method {
  return typeof value === "string" && Object.hasOwn(schemas, value);
}

export function authorize(method: Method, actor: Actor): void {
  const needed = METHOD_ROLES[method];
  if (ROLE_RANK[actor.role] < ROLE_RANK[needed]) {
    throw new HiveError("forbidden", `${method} requires role "${needed}", you are "${actor.role}".`);
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
