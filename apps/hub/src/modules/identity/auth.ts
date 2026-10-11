import { sso } from "@better-auth/sso";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
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
  ssoSignedIn(input: { providerId: string; domain: string; user: { id: string; email: string } }): Promise<void>;
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
  hooks?: AuthHooks | undefined;
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
            user: { id: user.id, email: user.email },
          });
        },
      }),
    ],
    telemetry: { enabled: false },
  } satisfies Parameters<typeof betterAuth>[0];
}

export function createAuth(o: AuthOptions) {
  return betterAuth(authConfig(o));
}
export type Auth = ReturnType<typeof createAuth>;
