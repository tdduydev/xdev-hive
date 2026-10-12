import type { AuditExportInput, AuditFilters, AuditLogItem, AuditQueryInput } from "@xdev-hive/contracts";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { z } from "zod";
import { BadRequestError, ForbiddenError, type TenantContext, type Tx, withTenant } from "../platform/index.ts";
import { csvRow } from "./csv.ts";
import { recordAudit } from "./record.ts";

const cursorSchema = z.object({ at: z.iso.datetime(), id: z.uuid(), asOf: z.iso.datetime(), range: z.number() });
type Cursor = z.output<typeof cursorSchema>;
export const EXPORT_LIMIT = 20_000;
const CHUNK_SIZE = 500;

// Keep microseconds: converting PostgreSQL timestamps to Date would skip rows within the same millisecond.
const timestamp = sql`to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const actorType = sql`CASE WHEN a.data->>'via' = 'run' OR (a.actor_user_id IS NULL AND a.action ~ '^(memory|doc|skill|proposal)\\.' AND a.data->>'runId' IS NOT NULL) THEN 'run'
  WHEN a.actor_user_id IS NULL THEN 'system' ELSE 'user' END`;
const actorId = sql`CASE WHEN (${actorType}) = 'run' THEN a.data->>'runId' ELSE a.actor_user_id END`;
const actor = sql`CASE WHEN (${actorType}) = 'run' THEN 'run ' || coalesce(a.data->>'runId', '')
  WHEN a.actor_user_id IS NULL THEN 'xDev Hive' ELSE coalesce(u.name, a.actor_user_id) END`;
const source = sql`CASE WHEN a.action LIKE 'mcp.%' OR a.data->>'via' IN ('run', 'user') OR (${actorType}) = 'run'
  THEN 'mcp' WHEN a.actor_user_id IS NULL THEN 'hub' ELSE 'web' END`;
const result = sql`CASE WHEN a.data->>'result' = 'denied' OR a.action ~ '\\.denied$' THEN 'denied' ELSE 'ok' END`;
const area = sql`CASE
  WHEN a.action ~ '^(task|run|plan|approval|leader)\\.' OR a.action ~ '^mcp\\.(task|tasks|run|runs|plan|plans|review|approval|approvals|leader)_' THEN 'work'
  WHEN a.action ~ '^(memory|doc|skill|proposal)\\.' OR a.action ~ '^mcp\\.(memory|doc|docs|skill|skills|proposal|proposals)_' THEN 'know'
  WHEN a.action ~ '^(project|machine|scm|scm_connection|merge_queue|system)\\.' OR a.action ~ '^mcp\\.(projects|machines|systems)_' THEN 'proj'
  WHEN a.action ~ '^(org|org_member|team|team_member|invitation|sso)\\.' OR a.action ~ '^mcp\\.(orgs|teams|members)_' THEN 'people'
  WHEN a.action ~ '^(sandbox|mcp|policy)\\.' THEN 'agent' ELSE 'other' END`;
// Deliberately project only typed metadata; MCP args and free-form content can contain credentials under any key.
const ip = sql`CASE WHEN coalesce(a.data->>'ip', '') ~ '^[0-9a-fA-F:.]{3,45}$' THEN a.data->>'ip' ELSE NULL END`;
const fields = sql`a.id, ${timestamp} AS "createdAt", ${actorId} AS "actorId", ${actor} AS actor,
  ${actorType} AS "actorType", a.action, ${area} AS area, a.target_type AS "targetType",
  a.target_id AS "targetId", ${result} AS result, ${source} AS source, ${ip} AS ip`;

function decodeCursor(value: string, range: number): Cursor {
  try {
    const cursor = cursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    if (cursor.range !== range || cursor.at > cursor.asOf) throw new Error();
    return cursor;
  } catch {
    throw new BadRequestError("INVALID_AUDIT_CURSOR", "Con trỏ nhật ký không hợp lệ.");
  }
}

async function snapshot(tx: Tx): Promise<string> {
  const { rows } = await tx.execute<{ at: string }>(sql`select to_char(clock_timestamp() AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`);
  return rows[0]?.at ?? new Date().toISOString();
}

async function readPage(tx: Tx, filters: AuditFilters, limit: number, asOf: string, cursor?: Cursor) {
  const conditions = [
    sql`a.created_at <= ${asOf}::timestamptz`,
    sql`a.created_at >= ${asOf}::timestamptz - ${filters.range} * interval '1 day'`,
  ];
  for (const [value, field] of [
    [filters.actorType, actorType],
    [filters.actorId, actorId],
    [filters.area, area],
    [filters.action, sql`a.action`],
    [filters.source, source],
    [filters.result, result],
  ] as const) {
    if (value !== undefined) conditions.push(sql`${field} = ${value}`);
  }
  if (filters.q?.trim()) {
    // Literal substring search so user-entered % and _ cannot widen an investigation unexpectedly.
    const q = filters.q.trim().toLowerCase();
    conditions.push(
      sql`strpos(lower(concat_ws(' ', ${actor}, ${actorId}, a.target_type, a.target_id, ${ip})), ${q}) > 0`,
    );
  }
  if (cursor) conditions.push(sql`(a.created_at, a.id) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`);
  const { rows } = await tx.execute<AuditLogItem>(sql`SELECT ${fields} FROM hive.audit_log a
    LEFT JOIN auth."user" u ON u.id = a.actor_user_id
    WHERE ${sql.join(conditions, sql` AND `)} ORDER BY a.created_at DESC, a.id DESC LIMIT ${limit}`);
  return rows;
}

export async function queryAudit(tx: Tx, input: AuditQueryInput) {
  const cursor = input.cursor ? decodeCursor(input.cursor, input.range) : undefined;
  const asOf = cursor?.asOf ?? (await snapshot(tx));
  const rows = await readPage(tx, input, input.limit + 1, asOf, cursor);
  const items = rows.slice(0, input.limit);
  const last = items.at(-1);
  const nextCursor =
    rows.length > input.limit && last
      ? Buffer.from(JSON.stringify({ at: last.createdAt, id: last.id, asOf, range: input.range })).toString("base64url")
      : null;
  return { items, nextCursor };
}

export async function exportAudit(tx: Tx, input: AuditExportInput): Promise<File> {
  const asOf = await snapshot(tx);
  const parts: string[] = [
    input.format === "csv" ? csvRow(["timestamp", "actor", "action", "target", "result", "source", "ip"]) : "[",
  ];
  let cursor: Cursor | undefined;
  let count = 0;
  while (count < EXPORT_LIMIT) {
    const rows = await readPage(tx, input, Math.min(CHUNK_SIZE, EXPORT_LIMIT - count), asOf, cursor);
    for (const row of rows) {
      parts.push(
        input.format === "csv"
          ? csvRow([
              row.createdAt,
              row.actor,
              row.action,
              [row.targetType, row.targetId].filter(Boolean).join(":"),
              row.result,
              row.source,
              row.ip ?? "",
            ])
          : `${count ? "," : ""}${JSON.stringify(row)}`,
      );
      count++;
    }
    const last = rows.at(-1);
    if (!last) break;
    cursor = { at: last.createdAt, id: last.id, asOf, range: input.range };
    if (rows.length < CHUNK_SIZE) break;
  }
  const truncated = count === EXPORT_LIMIT && (await readPage(tx, input, 1, asOf, cursor)).length > 0;
  if (input.format === "json") parts.push("]");
  await recordAudit(tx, {
    action: "audit.export",
    targetType: "audit_log",
    data: { format: input.format, count, truncated, range: input.range },
  });
  return new File(parts, `audit${truncated ? "-limit-20000" : ""}.${input.format}`, {
    type: input.format === "csv" ? "text/csv;charset=utf-8" : "application/json",
  });
}

// Authorization is injected by the composition root: audit writers must not depend back on tenancy.
export async function withAuditAccess<T>(
  pool: pg.Pool,
  context: TenantContext,
  authorize: (tx: Tx) => Promise<unknown>,
  run: (tx: Tx) => Promise<T>,
): Promise<T> {
  const outcome = await withTenant(pool, context, async (tx) => {
    try {
      await authorize(tx);
    } catch (error) {
      if (!(error instanceof ForbiddenError) || error.code !== "ORG_ROLE_REQUIRED") throw error;
      await recordAudit(tx, { action: "audit.denied", targetType: "audit_log", data: { result: "denied" } });
      return { denied: error };
    }
    return { value: await run(tx) };
  });
  // Throw after commit so rejected member access remains auditable.
  if ("denied" in outcome) throw outcome.denied;
  return outcome.value;
}
