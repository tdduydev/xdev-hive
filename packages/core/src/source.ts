// Where a write came from (web, desktop app, MCP, API) and, for agents, the machine, run and task.
// Browser-safe. Stored beside docs versions, proposals and memory.
import { z } from "zod";
import { MACHINE_ID } from "./keys.ts";
import type { Actor } from "./types.ts";

export const WRITE_VIAS = ["web", "desktop", "mcp", "api"] as const;
export type WriteVia = (typeof WRITE_VIAS)[number];

/**
 * `via` is decided by whoever receives the write (the hub, the desktop app, the MCP server).
 * Machine, run and task are reported by the client and kept as given once they have the right shape.
 */
export interface WriteSource {
  via: WriteVia;
  machine?: string;
  run?: string;
  task?: string;
}

const field = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined);

/** A run id as runners make them (HIVE_RUN, `x-hive-run`). */
export const RUN_REF = /^[\w.-]{1,60}$/;

const writeSourceSchema = z.object({
  via: z.enum(WRITE_VIAS),
  machine: field(z.string().regex(MACHINE_ID)),
  run: field(z.string().regex(RUN_REF)),
  task: field(z.string().regex(/^[A-Za-z0-9._-]{1,100}$/)),
});

/** A valid source, with fields of the wrong shape dropped; null when `via` is missing or unknown. */
export function parseSource(value: unknown): WriteSource | null {
  const parsed = writeSourceSchema.safeParse(value);
  if (!parsed.success) return null;
  const { via, machine, run, task } = parsed.data;
  return { via, ...(machine ? { machine } : {}), ...(run ? { run } : {}), ...(task ? { task } : {}) };
}

/** An MCP server started by an agent: the runner passes HIVE_RUN and HIVE_TASK to the agent it starts. */
export function agentSource(machine: string, env: Record<string, string | undefined>): WriteSource {
  return parseSource({ via: "mcp", machine, run: env.HIVE_RUN, task: env.HIVE_TASK }) ?? { via: "mcp" };
}

/** The `x-hive-source` header a hub client sends. */
export const sourceHeader = (source: WriteSource) => JSON.stringify(source);

/** Reads `x-hive-source` from a token request. Only the hub's own pages write as "web"; unknown is "api". */
export function readSourceHeader(header: string | undefined): WriteSource {
  let value: unknown = null;
  try {
    value = header ? JSON.parse(header) : null;
  } catch {
    // not JSON: nothing reported
  }
  const source = parseSource(value);
  return source && source.via !== "web" ? source : { ...source, via: "api" };
}

/** A run id from HIVE_RUN or `x-hive-run`, when it has the shape of one. */
export const readRun = (value: string | undefined): string | undefined => (value && RUN_REF.test(value) ? value : undefined);

/** The MR watcher's agent label (apps/desktop gitlab/mr.ts): the hub lets it move a merged MR's task to done. */
export const MR_WATCHER = "hive-mr";

/** Who a call counts as (roadmap 27c): an agent counts as the account whose token it runs on. */
export const principalOf = (actor: Actor): string => actor.onBehalf ?? actor.name;

/**
 * An agent rather than a person: it came through MCP, or a client labelled it. The desktop app labels its own window
 * "desktop" too, so a label from a window (via desktop or web) is a person's.
 */
export function isAgentActor(actor: Actor): boolean {
  const via = actor.source?.via;
  return via === "mcp" || (!!actor.agent && via !== "desktop" && via !== "web");
}
