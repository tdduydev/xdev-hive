import { implement, ORPCError } from "@orpc/server";
import { mcpAdminContract } from "@xdev-hive/contracts";
import type pg from "pg";
import type { Auth } from "../identity/index.ts";
import { type RequestContext, withTenant } from "../platform/index.ts";
import { createToken, extendToken, listTokens, listTools, revokeToken, setTool } from "./admin-service.ts";
import type { McpToolRegistry } from "./registry.ts";

export function mcpAdminRouter(deps: {
  auth?: Auth | undefined;
  pool?: pg.Pool | undefined;
  registry: McpToolRegistry;
}) {
  const base = implement(mcpAdminContract).$context<RequestContext>();
  const os = base.use(async ({ context, next }) => {
    const session = await deps.auth?.api.getSession({ headers: context.headers });
    if (!session) throw new ORPCError("UNAUTHORIZED", { message: "Chưa đăng nhập." });
    if (!deps.pool) throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Hub chưa cấu hình database." });
    const orgId = context.headers.get("x-hive-org");
    if (!orgId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orgId))
      throw new ORPCError("BAD_REQUEST", { message: "Chưa chọn tổ chức hợp lệ." });
    return withTenant(deps.pool, { userId: session.user.id, orgId }, async (tx) => {
      await deps.registry.authorize(tx, session.user.id, "member");
      return next({ context: { tx, userId: session.user.id } });
    });
  });
  const registry = deps.registry;
  return {
    listTools: os.listTools.handler(({ context: { tx, userId } }) => listTools(tx, userId, registry)),
    setTool: os.setTool.handler(({ context: { tx, userId }, input }) =>
      setTool(tx, userId, registry, input.toolName, input.enabled),
    ),
    listTokens: os.listTokens.handler(({ context: { tx, userId } }) => listTokens(tx, userId, registry)),
    createToken: os.createToken.handler(({ context: { tx, userId }, input }) =>
      createToken(tx, userId, registry, input),
    ),
    extendToken: os.extendToken.handler(({ context: { tx, userId }, input }) =>
      extendToken(tx, userId, registry, input.id, input.lifetimeDays),
    ),
    revokeToken: os.revokeToken.handler(({ context: { tx, userId }, input }) =>
      revokeToken(tx, userId, registry, input.id),
    ),
  };
}
