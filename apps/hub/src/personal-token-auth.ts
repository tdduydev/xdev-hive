import { eq } from "drizzle-orm";
import type pg from "pg";
import { type Auth, authUser } from "./modules/identity/index.ts";
import { type McpToolRegistry, verifyPersonalToken } from "./modules/mcp/index.ts";
import { withTenant } from "./modules/platform/index.ts";

type GetSession = Auth["api"]["getSession"];
type Session = NonNullable<Awaited<ReturnType<GetSession>>>;

const bearer = (headers: Headers) => /^Bearer\s+(hive_pat_\S+)$/i.exec(headers.get("authorization") ?? "")?.[1];

/**
 * Cho REST API của người dùng nhận token cá nhân (`Authorization: Bearer hive_pat_…`) như một phiên đăng nhập của chủ
 * token, để app desktop dùng lại đúng hợp đồng của web (spec 008 FR-026). Token gắn với một tổ chức: request chọn tổ
 * chức khác (`x-hive-org`) thì coi như chưa đăng nhập. Không có token cá nhân thì đi đường cookie như cũ. Machine token
 * và run token không bao giờ qua đây (chỉ dùng cho kênh worker và MCP).
 */
export function withPersonalTokens(auth: Auth, pool: pg.Pool, registry: McpToolRegistry): Auth {
  const getSession = (async (input: Parameters<GetSession>[0]) => {
    const headers = new Headers(input?.headers);
    const token = bearer(headers);
    if (!token) return auth.api.getSession(input);
    const principal = await verifyPersonalToken(pool, registry, token);
    if (principal?.kind !== "user" || !principal.orgId) return null;
    const org = headers.get("x-hive-org");
    if (org && org !== principal.orgId) return null;
    const user = await withTenant(pool, { userId: principal.userId, orgId: principal.orgId }, async (tx) => {
      // hive_app chỉ được đọc các cột này của auth.user (migration 0004).
      const [row] = await tx
        .select({ id: authUser.id, name: authUser.name, email: authUser.email, image: authUser.image })
        .from(authUser)
        .where(eq(authUser.id, principal.userId));
      return row;
    });
    if (!user) return null;
    const now = new Date();
    return {
      user: { ...user, emailVerified: true, createdAt: now, updatedAt: now },
      session: {
        // Không phải phiên Better Auth: id cho biết đến từ token cá nhân, để nơi cần chặn (quản trị token) nhận ra.
        id: `pat:${principal.personalTokenId ?? ""}`,
        // Tổ chức của token: header chỉ là một cách chọn tổ chức, đường dẫn /v1/orgs/{orgId} và `?org=` là cách khác,
        // nên nơi chọn tổ chức phải so với giá trị này (spec 034 FR-094, tokenOrgMismatch).
        tokenOrgId: principal.orgId,
        token: "",
        userId: user.id,
        expiresAt: now,
        createdAt: now,
        updatedAt: now,
        ipAddress: null,
        userAgent: null,
      },
    } as unknown as Session;
  }) as GetSession;
  const api = new Proxy(auth.api, {
    get: (target, prop, receiver) => (prop === "getSession" ? getSession : Reflect.get(target, prop, receiver)),
  });
  return new Proxy(auth, {
    get: (target, prop, receiver) => (prop === "api" ? api : Reflect.get(target, prop, receiver)),
  });
}
