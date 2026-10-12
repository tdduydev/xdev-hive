import { createHash, randomBytes } from "node:crypto";
import type { McpAdminTool, McpUserToken } from "@xdev-hive/contracts";
import { createMcpTokenInput, mcpTokenLifetime } from "@xdev-hive/contracts";
import { and, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import type pg from "pg";
import { recordAudit } from "../audit/index.ts";
import { authUser } from "../identity/index.ts";
import { BadRequestError, ForbiddenError, NotFoundError, type Tx, withTenant } from "../platform/index.ts";
import type { McpPrincipal } from "./principal.ts";
import type { McpToolRegistry } from "./registry.ts";
import { mcpToolOverrides, mcpUserTokens } from "./schema.ts";

const DAY = 86_400_000;
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const tokenInfo = (r: typeof mcpUserTokens.$inferSelect, ownerName: string | null = null): McpUserToken => ({
  id: r.id,
  userId: r.userId,
  ownerName,
  prefix: r.prefix,
  clientId: r.clientId,
  createdAt: r.createdAt.toISOString(),
  expiresAt: r.expiresAt.toISOString(),
  lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
  revokedAt: r.revokedAt?.toISOString() ?? null,
});
const validToken = and(isNull(mcpUserTokens.revokedAt), gt(mcpUserTokens.expiresAt, sql`now()`));

export async function disabledTools(tx: Tx): Promise<Set<string>> {
  const rows = await tx
    .select({ name: mcpToolOverrides.toolName })
    .from(mcpToolOverrides)
    .where(eq(mcpToolOverrides.enabled, false));
  return new Set(rows.map((r) => r.name));
}

export async function requireEnabledTool(tx: Tx, name: string): Promise<void> {
  if ((await disabledTools(tx)).has(name))
    throw new ForbiddenError("TOOL_DISABLED", "Tool MCP này đã bị quản trị tắt.");
}

export async function listTools(tx: Tx, userId: string, registry: McpToolRegistry): Promise<{ tools: McpAdminTool[] }> {
  await registry.authorize(tx, userId, "member");
  const disabled = await disabledTools(tx);
  // Audit đã có sẵn từng lời gọi; không thêm kho số liệu riêng hay lưu tham số chứa token.
  const metrics = await tx.execute<{ name: string; calls: number; errors: number }>(sql`
    select target_id as name, count(*)::int as calls,
      count(*) filter (where data->>'outcome' = 'error')::int as errors
    from hive.audit_log where target_type = 'mcp_tool' and action = 'mcp.' || target_id
      and created_at >= now() - interval '7 days' group by target_id
  `);
  const byName = new Map(metrics.rows.map((r) => [r.name, r]));
  const runNames = new Set(registry.list({ kind: "run", userId, runKind: "code", scopes: [] }).map((t) => t.name));
  return {
    tools: registry.list().map((tool): McpAdminTool => {
      const group = /^(doc|skill|memory)_/.test(tool.name)
        ? "knowledge"
        : tool.name.startsWith("task_")
          ? "tasks"
          : /^(plan|review)_/.test(tool.name)
            ? "runs"
            : tool.name.startsWith("leader_")
              ? "leader"
              : "tenancy";
      return {
        id: tool.name,
        name: tool.name,
        description: tool.description,
        group,
        caller: tool.runKinds?.length ? "runs" : runNames.has(tool.name) ? "both" : "users",
        enabled: !disabled.has(tool.name),
        calls: byName.get(tool.name)?.calls ?? 0,
        errors: byName.get(tool.name)?.errors ?? 0,
      };
    }),
  };
}

export async function setTool(tx: Tx, userId: string, registry: McpToolRegistry, toolName: string, enabled: boolean) {
  await registry.authorize(tx, userId, "admin");
  if (!registry.list().some((t) => t.name === toolName))
    throw new NotFoundError("MCP_TOOL_NOT_FOUND", "Không tìm thấy tool MCP.");
  await tx
    .insert(mcpToolOverrides)
    .values({ orgId: sql`hive.ctx_org()`, toolName, enabled, updatedBy: userId })
    .onConflictDoUpdate({
      target: [mcpToolOverrides.orgId, mcpToolOverrides.toolName],
      set: { enabled, updatedBy: userId, updatedAt: sql`now()` },
    });
  await recordAudit(tx, { action: "mcp.tool_toggle", targetType: "mcp_tool", targetId: toolName, data: { enabled } });
  return { enabled };
}

export async function listTokens(tx: Tx, userId: string, registry: McpToolRegistry) {
  const role = await registry.authorize(tx, userId, "member");
  const rows = await tx
    .select({ token: mcpUserTokens, ownerName: authUser.name })
    .from(mcpUserTokens)
    .leftJoin(authUser, eq(authUser.id, mcpUserTokens.userId))
    .where(role === "member" ? eq(mcpUserTokens.userId, userId) : undefined)
    .orderBy(desc(mcpUserTokens.createdAt));
  return { tokens: rows.map((r) => tokenInfo(r.token, r.ownerName)) };
}

export async function createToken(
  tx: Tx,
  userId: string,
  registry: McpToolRegistry,
  raw: { clientId: string; lifetimeDays: number },
) {
  await registry.authorize(tx, userId, "member");
  const input = createMcpTokenInput.safeParse(raw);
  if (!input.success) throw new BadRequestError("MCP_TOKEN_INPUT", "Client và thời hạn từ 1 đến 90 ngày là bắt buộc.");
  const {
    rows: [context],
  } = await tx.execute<{ orgId: string }>(sql`select hive.ctx_org() as "orgId"`);
  if (!context?.orgId) throw new BadRequestError("MCP_ORG_REQUIRED", "Chưa chọn tổ chức.");
  // Tổ chức trong token chỉ định context RLS cho tra cứu hash; nó không cấp quyền truy cập.
  const secret = randomBytes(32).toString("base64url");
  const token = `hive_pat_${context.orgId}_${secret}`;
  const [row] = await tx
    .insert(mcpUserTokens)
    .values({
      orgId: context.orgId,
      userId,
      tokenHash: hashToken(token),
      prefix: `hive_pat_${secret.slice(0, 8)}`,
      clientId: input.data.clientId,
      expiresAt: new Date(Date.now() + input.data.lifetimeDays * DAY),
    })
    .returning();
  if (!row) throw new Error("Không tạo được token MCP.");
  await recordAudit(tx, {
    action: "mcp.token_create",
    targetType: "mcp_token",
    targetId: row.id,
    data: { clientId: row.clientId, expiresAt: row.expiresAt.toISOString() },
  });
  return { token, info: tokenInfo(row) };
}

async function managedToken(tx: Tx, userId: string, registry: McpToolRegistry, id: string, adminOnly = false) {
  const role = await registry.authorize(tx, userId, adminOnly ? "admin" : "member");
  const [row] = await tx.select().from(mcpUserTokens).where(eq(mcpUserTokens.id, id)).for("update");
  if (!row) throw new NotFoundError("MCP_TOKEN_NOT_FOUND", "Không tìm thấy token MCP.");
  if (role === "member" && row.userId !== userId)
    throw new ForbiddenError("MCP_TOKEN_OWNER_REQUIRED", "Bạn chỉ được thu hồi token của mình.");
  return row;
}

export async function revokeToken(tx: Tx, userId: string, registry: McpToolRegistry, id: string) {
  await managedToken(tx, userId, registry, id);
  await tx.update(mcpUserTokens).set({ revokedAt: sql`coalesce(revoked_at, now())` }).where(eq(mcpUserTokens.id, id));
  await recordAudit(tx, { action: "mcp.token_revoke", targetType: "mcp_token", targetId: id });
  return { revoked: true as const };
}

export async function extendToken(tx: Tx, userId: string, registry: McpToolRegistry, id: string, lifetimeDays: number) {
  const row = await managedToken(tx, userId, registry, id, true);
  if (row.revokedAt) throw new BadRequestError("MCP_TOKEN_REVOKED", "Token đã thu hồi không thể gia hạn.");
  if (!mcpTokenLifetime.safeParse(lifetimeDays).success)
    throw new BadRequestError("MCP_TOKEN_LIFETIME", "Thời hạn phải từ 1 đến 90 ngày.");
  const [updated] = await tx
    .update(mcpUserTokens)
    .set({ expiresAt: new Date(Math.max(row.expiresAt.getTime(), Date.now() + lifetimeDays * DAY)) })
    .where(eq(mcpUserTokens.id, id))
    .returning();
  if (!updated) throw new Error("Không gia hạn được token MCP.");
  await recordAudit(tx, {
    action: "mcp.token_extend",
    targetType: "mcp_token",
    targetId: id,
    data: { expiresAt: updated.expiresAt.toISOString() },
  });
  return tokenInfo(updated);
}

export async function requireActivePersonalToken(tx: Tx, principal: McpPrincipal): Promise<void> {
  if (!principal.personalTokenId) return;
  const [row] = await tx
    .select({ id: mcpUserTokens.id })
    .from(mcpUserTokens)
    .where(
      and(eq(mcpUserTokens.id, principal.personalTokenId), eq(mcpUserTokens.userId, principal.userId), validToken),
    );
  if (!row) throw new ForbiddenError("MCP_TOKEN_INVALID", "Token MCP đã hết hạn hoặc bị thu hồi.");
}

export async function verifyPersonalToken(
  pool: pg.Pool,
  registry: McpToolRegistry,
  token: string,
): Promise<McpPrincipal | null> {
  const match = /^hive_pat_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_([A-Za-z0-9_-]{43})$/.exec(
    token,
  );
  if (!match) return null;
  const orgId = match[1];
  // Không cache xác thực: lần gọi sau thu hồi phải đọc trạng thái mới từ DB.
  return withTenant(pool, { orgId }, async (tx) => {
    const [row] = await tx
      .select()
      .from(mcpUserTokens)
      .where(and(eq(mcpUserTokens.tokenHash, hashToken(token)), validToken));
    if (!row) return null;
    // Đặt user context sau khi hash khớp để RLS membership kiểm đúng chủ token.
    await tx.execute(sql`select set_config('app.user_id', ${row.userId}, true)`);
    if (!(await registry.memberships(tx, row.userId)).some((o) => o.id === row.orgId)) return null;
    await tx
      .update(mcpUserTokens)
      .set({ lastUsedAt: sql`now()` })
      .where(
        and(
          eq(mcpUserTokens.id, row.id),
          or(isNull(mcpUserTokens.lastUsedAt), sql`${mcpUserTokens.lastUsedAt} <= now() - interval '1 minute'`),
        ),
      );
    return {
      kind: "user",
      userId: row.userId,
      orgId: row.orgId,
      personalTokenId: row.id,
      clientId: row.clientId,
      scopes: [],
    };
  });
}
