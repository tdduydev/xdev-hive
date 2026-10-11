import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { mcp } from "@better-auth/mcp";
import type { ClientMetadataResourceFetch } from "@better-auth/oauth-provider";
import { sso } from "@better-auth/sso";
import { type BetterAuthPlugin, betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";
import type pg from "pg";

export interface OAuthApp {
  clientId: string;
  clientSecret: string;
}

export interface AuthOptions {
  /** Pool của role hive_auth; search_path của role trỏ vào schema auth. */
  pool: pg.Pool;
  baseURL: string;
  secret: string;
  trustedOrigins?: string[];
  github?: OAuthApp | undefined;
  gitlab?: (OAuthApp & { issuer?: string | undefined }) | undefined;
  /** Cho tự đăng ký bằng email. Tắt mặc định: người mới vào bằng lời mời (M1c) hoặc SSO. */
  allowEmailSignUp?: boolean;
  /**
   * Cách tải Client ID Metadata Document của client MCP. Mặc định dùng bản Node của @better-auth/cimd (phân giải DNS
   * một lần, chặn địa chỉ nội bộ, không theo redirect). Test thay bằng hàm giả vì CIMD từ chối URL loopback.
   */
  fetchClientMetadata?: ClientMetadataResourceFetch | undefined;
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

export function authConfig(o: AuthOptions) {
  return {
    database: o.pool,
    baseURL: o.baseURL,
    basePath: "/api/auth",
    secret: o.secret,
    trustedOrigins: o.trustedOrigins ?? [],
    emailAndPassword: { enabled: true, disableSignUp: !o.allowEmailSignUp, minPasswordLength: 10 },
    socialProviders: {
      ...(o.github ? { github: { clientId: o.github.clientId, clientSecret: o.github.clientSecret } } : {}),
      ...(o.gitlab
        ? { gitlab: { clientId: o.gitlab.clientId, clientSecret: o.gitlab.clientSecret, issuer: o.gitlab.issuer } }
        : {}),
    },
    plugins: [
      sso(),
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
