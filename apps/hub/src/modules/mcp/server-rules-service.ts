import {
  type JobMcpServer,
  type McpEffectiveServer,
  type McpServerLaunch,
  type McpServerRule,
  type McpServerRuleInput,
  mcpServerKey,
  mcpServerRuleInput,
  RESERVED_MCP_SERVER_KEYS,
} from "@xdev-hive/contracts";
import { and, asc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { recordAudit } from "../audit/index.ts";
import { BadRequestError, ConflictError, NotFoundError, type Tx } from "../platform/index.ts";
import type { McpToolRegistry } from "./registry.ts";
import { mcpServerRules } from "./schema.ts";
import {
  commandTokens,
  type EffectiveServer,
  identityOf,
  jobServers,
  resolveServers,
  ruleMatches,
  type ServerRule,
} from "./server-rules.ts";

type Row = typeof mcpServerRules.$inferSelect;

function launchOf(r: Row): McpServerLaunch | null {
  if (r.transport === "stdio" && r.command !== null) return { transport: "stdio", command: r.command, args: r.args };
  if (r.transport === "http" && r.url !== null) return { transport: "http", url: r.url };
  return null;
}

const toRule = (r: Row): ServerRule => ({
  id: r.id,
  name: r.name,
  rule: r.rule,
  matchType: r.matchType,
  pattern: r.pattern,
  projectId: r.projectId,
  launch: launchOf(r),
  createdAt: r.createdAt,
});

const view = (r: Row, projectKey: string | null): McpServerRule => ({
  id: r.id,
  name: r.name,
  key: mcpServerKey(r.name),
  rule: r.rule,
  matchType: r.matchType,
  pattern: r.pattern,
  projectId: r.projectId,
  projectKey,
  launch: launchOf(r),
  updatedBy: r.updatedBy,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

const effectiveView = (s: EffectiveServer): McpEffectiveServer => ({
  ruleId: s.rule.id,
  name: s.rule.name,
  key: s.key,
  projectId: s.rule.projectId,
  launch: s.launch,
  allowed: s.decision.allowed,
  decidedBy: s.decision.by
    ? { id: s.decision.by.id, name: s.decision.by.name, rule: s.decision.by.rule, projectId: s.decision.by.projectId }
    : null,
});

// Quản trị tổ chức, hoặc vai trò tự tạo có mcp.servers. Xem cũng cần quyền này: quy tắc lộ dự án của mọi đội.
const requireServerAdmin = (tx: Tx, userId: string, registry: McpToolRegistry) =>
  registry.authorize(tx, userId, "admin", "mcp.servers");

async function projectKeys(tx: Tx, registry: McpToolRegistry, ids: (string | null)[]) {
  const keys = new Map<string, string>();
  for (const id of new Set(ids)) {
    if (!id) continue;
    const project = await registry.project(tx, id);
    if (project) keys.set(id, project.key);
  }
  return keys;
}

const scopeOf = (projectId: string | null) =>
  projectId ? eq(mcpServerRules.projectId, projectId) : isNull(mcpServerRules.projectId);

/** Mẫu khớp đã chuẩn hoá; bỏ trống thì lấy theo chính server được khai báo trên dòng. */
function patternOf(input: {
  name: string;
  matchType: ServerRule["matchType"];
  pattern: string;
  launch: McpServerLaunch | null;
}): string {
  if (input.matchType === "wildcard") return "*";
  const typed = input.matchType === "command" ? commandTokens(input.pattern).join(" ") : input.pattern.trim();
  const launch = input.launch;
  if (typed || !launch) return typed;
  if (input.matchType === "name") return mcpServerKey(input.name);
  if (input.matchType === "command" && launch.transport === "stdio") return [launch.command, ...launch.args].join(" ");
  if (input.matchType === "url" && launch.transport === "http") return launch.url;
  return "";
}

async function validated(tx: Tx, registry: McpToolRegistry, raw: McpServerRuleInput, id: string | null) {
  const parsed = mcpServerRuleInput.safeParse(raw);
  if (!parsed.success)
    throw new BadRequestError(
      "MCP_SERVER_INPUT",
      parsed.error.issues[0]?.message ?? "Quy tắc MCP server không hợp lệ.",
    );
  const input = parsed.data;
  const key = mcpServerKey(input.name);
  const pattern = patternOf(input);
  if (!pattern) throw new BadRequestError("MCP_SERVER_PATTERN", "Cần mẫu khớp: tên, URL hoặc lệnh của server.");
  if (input.projectId && !(await registry.project(tx, input.projectId)))
    throw new NotFoundError("PROJECT_NOT_FOUND", "Không tìm thấy dự án trong tổ chức.");
  if (input.launch) {
    if (RESERVED_MCP_SERVER_KEYS.includes(key))
      throw new BadRequestError("MCP_SERVER_RESERVED", `Tên "${key}" dành cho cổng MCP của hub; hãy đặt tên khác.`);
    // Dòng có cấu hình là quy tắc cho chính server đó; mẫu không khớp thì quy tắc vô nghĩa với server vừa khai.
    if (!ruleMatches({ matchType: input.matchType, pattern }, identityOf(input.name, input.launch)))
      throw new BadRequestError(
        "MCP_SERVER_SELF_MATCH",
        "Mẫu khớp phải khớp chính server được khai báo trên dòng này.",
      );
    const sameScope = await tx
      .select({ id: mcpServerRules.id, name: mcpServerRules.name })
      .from(mcpServerRules)
      .where(and(scopeOf(input.projectId), isNotNull(mcpServerRules.transport)));
    if (sameScope.some((r) => r.id !== id && mcpServerKey(r.name) === key))
      throw new ConflictError("MCP_SERVER_DUPLICATE", `Phạm vi này đã có server "${key}".`);
  }
  const launch = input.launch;
  return {
    name: input.name,
    rule: input.rule,
    matchType: input.matchType,
    pattern,
    projectId: input.projectId,
    transport: launch?.transport ?? null,
    command: launch?.transport === "stdio" ? launch.command : null,
    args: launch?.transport === "stdio" ? launch.args : [],
    url: launch?.transport === "http" ? launch.url : null,
  };
}

// Không ghi cấu hình khởi chạy vào audit: người quản trị có thể đặt khoá API trong tham số hay URL.
const auditData = (r: Row) => ({
  name: r.name,
  rule: r.rule,
  matchType: r.matchType,
  pattern: r.pattern,
  projectId: r.projectId,
  transport: r.transport,
});

export async function listServerRules(tx: Tx, userId: string, registry: McpToolRegistry) {
  await requireServerAdmin(tx, userId, registry);
  const rows = await tx
    .select()
    .from(mcpServerRules)
    .orderBy(sql`${mcpServerRules.projectId} nulls first`, asc(mcpServerRules.createdAt));
  const keys = await projectKeys(
    tx,
    registry,
    rows.map((r) => r.projectId),
  );
  return { rules: rows.map((r) => view(r, r.projectId ? (keys.get(r.projectId) ?? null) : null)) };
}

export async function createServerRule(tx: Tx, userId: string, registry: McpToolRegistry, raw: McpServerRuleInput) {
  await requireServerAdmin(tx, userId, registry);
  const values = await validated(tx, registry, raw, null);
  const [row] = await tx
    .insert(mcpServerRules)
    .values({ ...values, orgId: sql`hive.ctx_org()`, updatedBy: userId })
    .returning();
  if (!row) throw new Error("Không thêm được quy tắc MCP server.");
  await recordAudit(tx, {
    action: "mcp.server_rule_create",
    targetType: "mcp_server_rule",
    targetId: row.id,
    data: auditData(row),
  });
  return view(row, (await projectKeys(tx, registry, [row.projectId])).get(row.projectId ?? "") ?? null);
}

export async function updateServerRule(
  tx: Tx,
  userId: string,
  registry: McpToolRegistry,
  id: string,
  raw: McpServerRuleInput,
) {
  await requireServerAdmin(tx, userId, registry);
  const [before] = await tx.select().from(mcpServerRules).where(eq(mcpServerRules.id, id)).for("update");
  if (!before) throw new NotFoundError("MCP_SERVER_RULE_NOT_FOUND", "Không tìm thấy quy tắc MCP server.");
  const values = await validated(tx, registry, raw, id);
  const [row] = await tx
    .update(mcpServerRules)
    .set({ ...values, updatedBy: userId, updatedAt: sql`now()` })
    .where(eq(mcpServerRules.id, id))
    .returning();
  if (!row) throw new Error("Không sửa được quy tắc MCP server.");
  await recordAudit(tx, {
    action: "mcp.server_rule_update",
    targetType: "mcp_server_rule",
    targetId: id,
    data: { before: auditData(before), after: auditData(row) },
  });
  return view(row, (await projectKeys(tx, registry, [row.projectId])).get(row.projectId ?? "") ?? null);
}

export async function deleteServerRule(tx: Tx, userId: string, registry: McpToolRegistry, id: string) {
  await requireServerAdmin(tx, userId, registry);
  const [row] = await tx.delete(mcpServerRules).where(eq(mcpServerRules.id, id)).returning();
  if (!row) throw new NotFoundError("MCP_SERVER_RULE_NOT_FOUND", "Không tìm thấy quy tắc MCP server.");
  await recordAudit(tx, {
    action: "mcp.server_rule_delete",
    targetType: "mcp_server_rule",
    targetId: id,
    data: auditData(row),
  });
  return { deleted: true as const };
}

async function rulesFor(tx: Tx, projectId: string | null): Promise<ServerRule[]> {
  const rows = await tx
    .select()
    .from(mcpServerRules)
    .where(projectId ? or(isNull(mcpServerRules.projectId), eq(mcpServerRules.projectId, projectId)) : undefined);
  return rows.map(toRule);
}

/** Xem trước server ngoài mà run của tổ chức (không chọn dự án) hoặc của một dự án sẽ nhận, kèm quy tắc quyết định. */
export async function previewServers(tx: Tx, userId: string, registry: McpToolRegistry, projectId?: string) {
  await requireServerAdmin(tx, userId, registry);
  if (projectId && !(await registry.project(tx, projectId)))
    throw new NotFoundError("PROJECT_NOT_FOUND", "Không tìm thấy dự án trong tổ chức.");
  return { servers: resolveServers(await rulesFor(tx, projectId ?? null), projectId ?? null).map(effectiveView) };
}

/**
 * Server ngoài được phép cho run của dự án (MCP-06). Gọi trong transaction giao job, nên run nhận đúng quy tắc tại lúc
 * được giao; không kiểm quyền vì người giao không phải người quản trị quy tắc.
 */
export async function mcpServersForProject(tx: Tx, projectId: string): Promise<JobMcpServer[]> {
  return jobServers(resolveServers(await rulesFor(tx, projectId), projectId));
}
