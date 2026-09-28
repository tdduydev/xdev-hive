// Where a write came from (web, desktop app, MCP, API) and, for agents, the machine, run and task.
// Browser-safe. Stored beside docs versions, proposals and memory.
import { z } from "zod";
import { MACHINE_ID } from "./keys.ts";

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

const writeSourceSchema = z.object({
  via: z.enum(WRITE_VIAS),
  machine: field(z.string().regex(MACHINE_ID)),
  run: field(z.string().regex(/^[\w.-]{1,60}$/)),
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
