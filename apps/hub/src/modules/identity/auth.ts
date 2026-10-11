import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { mcp } from "@better-auth/mcp";
import type { ClientMetadataResourceFetch } from "@better-auth/oauth-provider";
import { sso } from "@better-auth/sso";
import { type BetterAuthPlugin, betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { jwt } from "better-auth/plugins";
import type pg from "pg";

export interface OAuthApp {
  clientId: string;
  clientSecret: string;
}

/**
 * Việc của tổ chức mà đăng nhập cần gọi tới. Module tenancy cài đặt rồi main.ts tiêm vào, vì tenancy đã phụ thuộc
 * identity (bảng người dùng) nên identity không import ngược được.
 */
export interface AuthHooks {
  /** Mã mời còn dùng được cho email này không. Gọi trước khi tạo tài khoản. */
  inviteValid(token: string, email: string): Promise<boolean>;
  /** Nhận lời mời ngay sau khi tài khoản được tạo. */
  acceptInvite(token: string, user: { id: string; email: string }): Promise<void>;
  /** Mỗi lần đăng nhập SSO thành công. Phải idempotent. */
  ssoSignedIn(input: {
    providerId: string;
    domain: string;
    user: { id: string; email: string; name: string };
  }): Promise<void>;
}

export interface AuthOptions {
  /** Pool của role hive_auth; search_path của role trỏ vào schema auth. */
  pool: pg.Pool;
  baseURL: string;
  secret: string;
  trustedOrigins?: string[];
  github?: OAuthApp | undefined;
  gitlab?: (OAuthApp & { issuer?: string | undefined }) | undefined;
  /** Cho tự đăng ký bằng email. Tắt mặc định: người mới vào bằng lời mời hoặc SSO. */
  allowEmailSignUp?: boolean;
  /**
   * Cách tải Client ID Metadata Document của client MCP. Mặc định dùng bản Node của @better-auth/cimd (phân giải DNS
   * một lần, chặn địa chỉ nội bộ, không theo redirect). Test thay bằng hàm giả vì CIMD từ chối URL loopback.
   */
  fetchClientMetadata?: ClientMetadataResourceFetch | undefined;
  hooks?: AuthHooks | undefined;
}

/** Trang web Better Auth chuyển người dùng tới trong luồng OAuth của client MCP. */
export const MCP_LOGIN_PAGE = "/dang-nhap";
export const MCP_CONSENT_PAGE = "/dong-y-mcp";

/** Định danh tài nguyên (RFC 8707) của cổng MCP: token cấp cho client MCP có `aud` đúng bằng chuỗi này. */
export function mcpResource(baseURL: string): string {
  return `${baseURL.replace(/\/$/, "")}/mcp`;
}

/**
 * OAuth cho client MCP chỉ chạy được khi hub có địa chỉ HTTPS (hoặc localhost khi dev): plugin mcp từ chối định danh
 * tài nguyên http khác, và token bearer đi qua http trần thì lộ. Thiếu điều kiện này hub vẫn chạy, chỉ tắt /mcp.
 */
export function mcpEnabled(baseURL: string): boolean {
  try {
    const { protocol, hostname } = new URL(baseURL);
    return protocol === "https:" || (protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(hostname));
  } catch {
    return false;
  }
}

/**
 * Chế độ của cổng /mcp: `full` nhận cả OAuth người dùng lẫn run token; `run` (chỉ khi người vận hành bật
 * HIVE_MCP_ALLOW_HTTP và URL là http) chỉ nhận run token của agent, vì OAuth qua http trần thì lộ bearer; `off` là tắt.
 */
export type McpMode = "full" | "run" | "off";

export function mcpMode(baseURL: string, allowHttp: boolean): McpMode {
  if (mcpEnabled(baseURL)) return "full";
  try {
    return allowHttp && new URL(baseURL).protocol === "http:" ? "run" : "off";
  } catch {
    return "off";
  }
}

// Quản lý nhà cung cấp SSO chỉ đi qua API của hub (ssoProviders.*), nơi kiểm quyền quản trị tổ chức. Để mở, bất kỳ ai
// đăng nhập cũng đăng ký được IdP cho một tên miền rồi chen vào luồng đăng nhập của tổ chức khác.
const SSO_ADMIN_PATHS = [
  "/sso/register",
  "/sso/update-provider",
  "/sso/delete-provider",
  "/sso/providers",
  "/sso/get-provider",
  "/sso/request-domain-verification",
  "/sso/verify-domain",
];

const inviteTokenOf = (body: unknown): string | undefined => {
  const t = (body as { inviteToken?: unknown } | undefined)?.inviteToken;
  return typeof t === "string" && t.length > 0 ? t : undefined;
};

export function authConfig(o: AuthOptions) {
  const hooks = o.hooks;
  return {
    database: o.pool,
    baseURL: o.baseURL,
    basePath: "/api/auth",
    secret: o.secret,
    trustedOrigins: o.trustedOrigins ?? [],
    // Không dùng disableSignUp: cờ đó chặn trước mọi hook, nên người có mã mời cũng không đăng ký được. Hook
    // before bên dưới tự chặn khi chưa bật đăng ký tự do.
    emailAndPassword: { enabled: true, minPasswordLength: 10 },
    socialProviders: {
      ...(o.github ? { github: { clientId: o.github.clientId, clientSecret: o.github.clientSecret } } : {}),
      ...(o.gitlab
        ? { gitlab: { clientId: o.gitlab.clientId, clientSecret: o.gitlab.clientSecret, issuer: o.gitlab.issuer } }
        : {}),
    },
    disabledPaths: SSO_ADMIN_PATHS,
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-up/email" || o.allowEmailSignUp) return;
        const token = inviteTokenOf(ctx.body);
        const email = String((ctx.body as { email?: unknown } | undefined)?.email ?? "").toLowerCase();
        if (!token || !hooks)
          throw new APIError("FORBIDDEN", {
            message: "Hub chỉ cho đăng ký bằng lời mời. Hãy mở link mời mà quản trị tổ chức gửi cho bạn.",
            code: "SIGN_UP_INVITE_REQUIRED",
          });
        if (!(await hooks.inviteValid(token, email)))
          throw new APIError("FORBIDDEN", {
            message: "Mã mời không hợp lệ, đã hết hạn, đã dùng, hoặc không dành cho email này.",
            code: "SIGN_UP_INVITE_INVALID",
          });
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-up/email" || !hooks) return;
        const token = inviteTokenOf(ctx.body);
        const user = ctx.context.newSession?.user;
        if (!token || !user) return;
        try {
          await hooks.acceptInvite(token, { id: user.id, email: user.email });
        } catch (error) {
          // Tài khoản đã tạo xong; làm hỏng phản hồi lúc này chỉ khiến người dùng tưởng đăng ký thất bại. Họ vẫn
          // nhận lại được lời mời từ link (invitations.accept), nơi lỗi được báo rõ.
          ctx.context.logger.error("Không tự nhận được lời mời sau khi đăng ký", error);
        }
      }),
    },
    plugins: [
      sso({
        // Mỗi tổ chức có đúng một nhà cung cấp, do hub quản lý; giới hạn theo người đăng ký của plugin không áp dụng.
        providersLimit: Number.MAX_SAFE_INTEGER,
        // Gọi cả ở lần đăng nhập sau: người đã có tài khoản (vd. đăng ký bằng email) lần đầu vào bằng SSO cũng phải
        // được xếp vào tổ chức. Hook phía tenancy idempotent.
        provisionUserOnEveryLogin: true,
        provisionUser: async ({ user, provider }) => {
          await hooks?.ssoSignedIn({
            providerId: provider.providerId,
            domain: provider.domain,
            user: { id: user.id, email: user.email, name: user.name },
          });
        },
      }),
      // jwt() giữ khoá ký access token; cổng MCP kiểm chữ ký bằng JWKS lấy thẳng từ Better Auth trong tiến trình.
      jwt(),
      ...(mcpEnabled(o.baseURL)
        ? [
            // Hub vừa là authorization server vừa là resource server cho /mcp. Không bật DCR: MCP spec 2026-07-28
            // dùng CIMD. Ép kiểu vì metadata OpenAPI trong kiểu endpoint của oauth-provider 1.7.7 vướng
            // exactOptionalPropertyTypes; hub không gọi endpoint OAuth qua auth.api nên mất kiểu ở đây không sao.
            mcp({
              loginPage: MCP_LOGIN_PAGE,
              consentPage: MCP_CONSENT_PAGE,
              resource: mcpResource(o.baseURL),
            }) as unknown as BetterAuthPlugin,
            cimd({
              fetchClientMetadataResource: o.fetchClientMetadata ?? fetchClientMetadataResource,
              metadataProfile: "mcp-2026-07-28",
            }),
          ]
        : []),
    ],
    telemetry: { enabled: false },
  } satisfies Parameters<typeof betterAuth>[0];
}

export function createAuth(o: AuthOptions) {
  return betterAuth(authConfig(o));
}
export type Auth = ReturnType<typeof createAuth>;
