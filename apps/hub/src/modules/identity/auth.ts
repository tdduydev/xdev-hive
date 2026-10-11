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
  /** Email này có lời mời còn hạn, chưa dùng ở tổ chức nào không (đăng nhập GitHub/GitLab không mang mã mời). */
  invitePending(email: string): Promise<boolean>;
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
  /**
   * Cho tự tạo tài khoản bằng mọi cách đăng nhập (HIVE_ALLOW_EMAIL_SIGNUP=1, dùng khi dev). Tắt mặc định: chỉ người
   * được mời, người trong orgCreators, hoặc người vào bằng SSO đúng tên miền của tổ chức mới có tài khoản.
   */
  allowEmailSignUp?: boolean;
  /** Email người quản trị hub (HIVE_ORG_CREATORS, chữ thường). Được tạo tài khoản dù chưa ai mời. */
  orgCreators?: string[] | undefined;
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

/** Lý do không tạo tài khoản. Web đổi mã thành câu hiển thị (apps/web, lib/auth-errors.ts). */
const SIGN_UP_DENIED = {
  inviteRequired: {
    code: "SIGN_UP_INVITE_REQUIRED",
    message: "Hub chỉ cho đăng ký bằng lời mời. Hãy mở link mời mà quản trị tổ chức gửi cho bạn.",
  },
  inviteInvalid: {
    code: "SIGN_UP_INVITE_INVALID",
    message: "Mã mời không hợp lệ, đã hết hạn, đã dùng, hoặc không dành cho email này.",
  },
  notInvited: {
    code: "SIGN_UP_NOT_INVITED",
    message:
      "Hub chỉ nhận người được mời. Email của tài khoản này chưa có lời mời còn hạn: nhờ quản trị tổ chức mời đúng email bạn dùng để đăng nhập.",
  },
  emailUnverified: {
    code: "SIGN_UP_EMAIL_UNVERIFIED",
    message:
      "Email của tài khoản này chưa được nhà cung cấp xác minh nên hub không dùng nó để đối chiếu lời mời. Xác minh email rồi thử lại.",
  },
} as const;
type SignUpDenial = (typeof SIGN_UP_DENIED)[keyof typeof SIGN_UP_DENIED];

interface SignUpAttempt {
  email: string;
  emailVerified: boolean;
  /** Cách đăng nhập theo Better Auth: "email-password", "oauth", "sso-oidc"... */
  method: string;
  inviteToken?: string | undefined;
  /** Tên miền đã khai của nhà cung cấp SSO đang đăng nhập, nếu là SSO. */
  ssoDomain?: (() => Promise<string | undefined>) | undefined;
}

export function authConfig(o: AuthOptions) {
  const hooks = o.hooks;
  const creators = new Set((o.orgCreators ?? []).map((e) => e.toLowerCase()));

  /**
   * Quy tắc chung cho mọi cách tạo tài khoản: hub không cho tự đăng ký. undefined nghĩa là được tạo.
   * Đăng nhập lại hay gắn thêm cách đăng nhập cho tài khoản đã có không đi qua đây.
   */
  async function signUpDenial(a: SignUpAttempt): Promise<SignUpDenial | undefined> {
    if (o.allowEmailSignUp) return undefined;
    const email = a.email.toLowerCase();
    if (a.method === "email-password") {
      // Mật khẩu không chứng minh ai giữ hộp thư, nên lời mời chỉ tính khi kèm mã trong link mời; khớp email thôi thì
      // ai biết email người được mời cũng chiếm trước được tài khoản đó.
      if (a.inviteToken)
        return hooks && (await hooks.inviteValid(a.inviteToken, email)) ? undefined : SIGN_UP_DENIED.inviteInvalid;
      return creators.has(email) ? undefined : SIGN_UP_DENIED.inviteRequired;
    }
    // IdP của tổ chức chứng nhận người trong tên miền đã khai; chính sách sso_join (tenancy) quyết vào thẳng hay chờ
    // duyệt. Chỉ hub đăng ký được nhà cung cấp SSO (API của plugin bị tắt) nên mọi nhà cung cấp đều là của tổ chức.
    const ssoDomain = await a.ssoDomain?.();
    if (ssoDomain && email.split("@").pop() === ssoDomain.toLowerCase()) return undefined;
    const known = creators.has(email) || (hooks ? await hooks.invitePending(email) : false);
    if (!known) return SIGN_UP_DENIED.notInvited;
    // GitHub cho gắn email chưa xác minh vào tài khoản; tin email đó thì ai cũng nhận được lời mời của người khác.
    return a.emailVerified ? undefined : SIGN_UP_DENIED.emailUnverified;
  }
  return {
    database: o.pool,
    baseURL: o.baseURL,
    basePath: "/api/auth",
    secret: o.secret,
    trustedOrigins: o.trustedOrigins ?? [],
    // Không dùng disableSignUp: cờ đó chặn trước mọi hook, nên người có mã mời cũng không đăng ký được.
    // user.validateUserInfo bên dưới tự chặn khi chưa bật đăng ký tự do.
    emailAndPassword: { enabled: true, minPasswordLength: 10 },
    user: {
      // Better Auth gọi hook này ngay trước khi tạo người dùng ở mọi đường (email, GitHub, GitLab, SSO). Từ chối thì
      // không có user, không có phiên: luồng OAuth/SSO chuyển về errorCallbackURL kèm ?error=<mã>, API trả 403.
      validateUserInfo: async ({ user, source }, ctx) => {
        if (source.action !== "create-user") return;
        const providerId = source.sso?.providerId;
        const denied = await signUpDenial({
          email: String(user.email ?? ""),
          emailVerified: user.emailVerified === true,
          method: source.method,
          inviteToken: inviteTokenOf(ctx.body),
          ssoDomain: providerId
            ? async () =>
                (
                  await ctx.context.adapter.findOne<{ domain: string }>({
                    model: "ssoProvider",
                    where: [{ field: "providerId", value: providerId }],
                  })
                )?.domain
            : undefined,
        });
        if (denied) return { error: denied.code, errorDescription: denied.message };
      },
    },
    socialProviders: {
      ...(o.github ? { github: { clientId: o.github.clientId, clientSecret: o.github.clientSecret } } : {}),
      ...(o.gitlab
        ? { gitlab: { clientId: o.gitlab.clientId, clientSecret: o.gitlab.clientSecret, issuer: o.gitlab.issuer } }
        : {}),
    },
    disabledPaths: SSO_ADMIN_PATHS,
    hooks: {
      // Cùng quy tắc với validateUserInfo nhưng chạy trước khi Better Auth tra email: không có lời mời thì không cho
      // dò xem email nào đã có tài khoản qua lỗi "email đã tồn tại".
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-up/email") return;
        const denied = await signUpDenial({
          email: String((ctx.body as { email?: unknown } | undefined)?.email ?? ""),
          emailVerified: false,
          method: "email-password",
          inviteToken: inviteTokenOf(ctx.body),
        });
        if (denied) throw new APIError("FORBIDDEN", { message: denied.message, code: denied.code });
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
