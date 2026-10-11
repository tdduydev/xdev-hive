import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { mcp } from "@better-auth/mcp";
import type { ClientMetadataResourceFetch } from "@better-auth/oauth-provider";
import { sso } from "@better-auth/sso";
import { type BetterAuthPlugin, betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { deleteSessionCookie } from "better-auth/cookies";
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
  /** Hub đã có tổ chức nào chưa (hive.any_org). */
  anyOrg(): Promise<boolean>;
  /** Nhận lời mời ngay sau khi tài khoản được tạo. Lỗi thì tài khoản vừa tạo bị xoá. */
  acceptInvite(token: string, user: { id: string; email: string }): Promise<void>;
  /** Mỗi lần đăng nhập SSO thành công. Phải idempotent. */
  ssoSignedIn(input: {
    providerId: string;
    domain: string;
    /** Tên miền đã được xác minh là của tổ chức (bản ghi TXT, identity/sso.ts). */
    domainVerified: boolean;
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
   * được mời, người trong orgCreators, hoặc người vào bằng SSO đúng tên miền đã xác minh của tổ chức mới có tài khoản.
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
export const MCP_LOGIN_PAGE = "/login";
export const MCP_CONSENT_PAGE = "/mcp/consent";

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

const emailOf = (obj: unknown): string | undefined => {
  const e = (obj as { email?: unknown } | undefined)?.email;
  return typeof e === "string" ? e : undefined;
};

/**
 * Hub so email bằng chuỗi (lời mời, HIVE_ORG_CREATORS, người dùng đã có), sau khi Better Auth hạ chữ thường. Ký tự
 * ngoài ASCII có thể biến thành chữ ASCII lúc hạ chữ thường (ký hiệu Kelvin "\u212A" thành "k"), nên một địa chỉ khác
 * sẽ trùng email của người thật. Email trong lời mời luôn là ASCII, nên chặn ngay chỗ nhận vào.
 */
const notAscii = (email: string | undefined) => email !== undefined && /[^\x21-\x7e]/.test(email);

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
  // Một mã cho cả "chưa được mời" lẫn "email chưa xác minh": tách hai mã thì ai cũng dò được email nào đang có lời
  // mời ở bất kỳ tổ chức nào (hoặc nằm trong HIVE_ORG_CREATORS) bằng một tài khoản GitHub hay một IdP gắn email
  // chưa xác minh.
  notInvited: {
    code: "SIGN_UP_NOT_INVITED",
    message:
      "Hub chỉ nhận người được mời. Email của tài khoản bạn vừa dùng phải được nhà cung cấp xác minh và có lời mời còn hạn: nhờ quản trị tổ chức mời đúng email đó, hoặc tạo tài khoản bằng link mời.",
  },
  emailNotAscii: {
    code: "EMAIL_NOT_ASCII",
    message: "Hub chỉ nhận email viết bằng ký tự ASCII (không dấu, không ký tự đặc biệt). Hãy dùng địa chỉ email khác.",
  },
} as const;
type SignUpDenial = (typeof SIGN_UP_DENIED)[keyof typeof SIGN_UP_DENIED];

interface SsoProviderRow {
  providerId: string;
  domain: string;
  domainVerified?: boolean | null;
}

type ProviderFinder = {
  findOne<T>(q: { model: string; where: { field: string; value: string | boolean }[] }): Promise<T | null>;
  findMany<T>(q: { model: string; where: { field: string; value: string | boolean }[] }): Promise<T[]>;
};

/**
 * Nhà cung cấp SSO cho một tên miền email. Plugin SSO tự tìm theo hậu tố (`x@sub.congty.vn` vào IdP của `congty.vn`)
 * với mọi nhà cung cấp, nên một tổ chức khai tên miền mà không chứng minh được vẫn hứng luồng đăng nhập của tên miền
 * con. Hub chọn theo thứ tự: khớp đúng và đã xác minh; tên miền cha đã xác minh (giữ DNS của tên miền cha là giữ cả
 * tên miền con), dài nhất trước; khớp đúng nhưng chưa xác minh (vẫn đăng nhập được, chỉ không tự tạo tài khoản).
 */
export async function ssoProviderForDomain(adapter: ProviderFinder, rawDomain: string): Promise<SsoProviderRow | null> {
  const domain = rawDomain.trim().toLowerCase();
  if (!domain) return null;
  const exact = await adapter.findOne<SsoProviderRow>({
    model: "ssoProvider",
    where: [{ field: "domain", value: domain }],
  });
  if (exact?.domainVerified === true) return exact;
  const verified = await adapter.findMany<SsoProviderRow>({
    model: "ssoProvider",
    where: [{ field: "domainVerified", value: true }],
  });
  const parent = verified
    .filter((p) => domain.endsWith(`.${p.domain.toLowerCase()}`))
    .sort((a, b) => b.domain.length - a.domain.length)[0];
  return parent ?? exact;
}

interface SignUpAttempt {
  email: string;
  emailVerified: boolean;
  /** Cách đăng nhập theo Better Auth: "email-password", "oauth", "sso-oidc"... */
  method: string;
  inviteToken?: string | undefined;
  /** Nhà cung cấp SSO đang đăng nhập, nếu là SSO. */
  ssoProvider?: (() => Promise<SsoProviderRow | null>) | undefined;
}

/**
 * Cột domainVerified của plugin SSO chỉ có trong schema khi bật `domainVerification`, mà bật thì plugin chặn hẳn đăng
 * nhập qua nhà cung cấp chưa xác minh, kể cả người đã có tài khoản SSO. Hub chỉ cần cột này để quyết có tự tạo tài
 * khoản và tự xếp vào tổ chức không, nên tự khai cột bằng một plugin chỉ có schema. Plugin SSO vẫn ghi false khi đăng
 * ký hay đổi tên miền, và dùng cột để tính isTrustedProvider khi gắn tài khoản.
 */
const ssoDomainVerified = {
  id: "hive-sso-domain-verified",
  schema: {
    ssoProvider: {
      fields: { domainVerified: { type: "boolean", required: false, defaultValue: false, input: false } },
    },
  },
} satisfies BetterAuthPlugin;

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
      // Cùng lý do: ai biết email trong HIVE_ORG_CREATORS cũng đăng ký trước được rồi giữ quyền tạo tổ chức. Chỉ mở lúc
      // hub chưa có tổ chức nào (lúc dựng hub, như canCreateOrg của tenancy). Sau đó người quản trị vào bằng
      // GitHub/GitLab có email đã xác minh, hoặc bằng lời mời. Không biết được hub đã có tổ chức chưa thì từ chối.
      if (!creators.has(email) || !hooks || (await hooks.anyOrg())) return SIGN_UP_DENIED.inviteRequired;
      return undefined;
    }
    // IdP của tổ chức chứng nhận người trong tên miền của tổ chức, nhưng chỉ khi tên miền đã được xác minh là của tổ
    // chức đó: tên miền do quản trị tổ chức tự gõ, và IdP của họ phát được email bất kỳ. Chưa xác minh thì SSO đi
    // đường lời mời như GitHub/GitLab bên dưới. Chính sách sso_join (tenancy) quyết vào thẳng hay chờ duyệt.
    const sso = await a.ssoProvider?.();
    if (sso?.domainVerified === true && email.split("@").pop() === sso.domain.toLowerCase()) return undefined;
    // Xét xác minh trước khi tra lời mời, để kết quả với email chưa xác minh không phụ thuộc lời mời (xem notInvited).
    // GitHub cho gắn email chưa xác minh vào tài khoản; plugin SSO luôn coi email của IdP là chưa xác minh.
    if (!a.emailVerified) return SIGN_UP_DENIED.notInvited;
    const known = creators.has(email) || (hooks ? await hooks.invitePending(email) : false);
    return known ? undefined : SIGN_UP_DENIED.notInvited;
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
      // Better Auth gọi hook này ngay trước khi tạo người dùng ở mọi đường (email, GitHub, GitLab, SSO), và trước khi
      // gắn cách đăng nhập mới vào tài khoản có sẵn. Từ chối thì không có user, không có phiên: luồng OAuth/SSO chuyển
      // về errorCallbackURL kèm ?error=<mã>, API trả 403.
      validateUserInfo: async ({ user, source }, ctx) => {
        if (source.action !== "create-user" && source.action !== "link-account") return;
        // user.email đã bị hạ chữ thường; xét cả email gốc (body của đăng ký, hồ sơ thô của GitHub/GitLab/IdP).
        const raw = [
          String(user.email ?? ""),
          source.method === "email-password" ? emailOf(ctx.body) : undefined,
          emailOf(source.oauth?.profile),
          emailOf(source.sso?.profile),
        ];
        if (raw.some(notAscii))
          return { error: SIGN_UP_DENIED.emailNotAscii.code, errorDescription: SIGN_UP_DENIED.emailNotAscii.message };
        if (source.action !== "create-user") return;
        const providerId = source.sso?.providerId;
        const denied = await signUpDenial({
          email: String(user.email ?? ""),
          emailVerified: user.emailVerified === true,
          method: source.method,
          inviteToken: inviteTokenOf(ctx.body),
          ssoProvider: providerId
            ? () =>
                ctx.context.adapter.findOne<SsoProviderRow>({
                  model: "ssoProvider",
                  where: [{ field: "providerId", value: providerId }],
                })
            : undefined,
        });
        if (denied) return { error: denied.code, errorDescription: denied.message };
      },
    },
    socialProviders: {
      ...(o.github ? { github: { clientId: o.github.clientId, clientSecret: o.github.clientSecret } } : {}),
      ...(o.gitlab
        ? {
            gitlab: {
              clientId: o.gitlab.clientId,
              clientSecret: o.gitlab.clientSecret,
              issuer: o.gitlab.issuer,
              // Better Auth chỉ đọc email_verified, mà /api/v4/user của GitLab không có trường này: thiếu dòng dưới thì
              // mọi email GitLab đều bị coi là chưa xác minh và không ai vào bằng lời mời được. GitLab chỉ đổi email
              // chính sau khi người dùng xác nhận địa chỉ mới, nên confirmed_at có nghĩa là email hiện tại đã xác minh.
              mapProfileToUser: (profile: { email_verified?: boolean | undefined; confirmed_at?: string | null }) => ({
                emailVerified: profile.email_verified ?? Boolean(profile.confirmed_at),
              }),
            },
          }
        : {}),
    },
    disabledPaths: SSO_ADMIN_PATHS,
    hooks: {
      // Cùng quy tắc với validateUserInfo nhưng chạy trước khi Better Auth tra email: không có lời mời thì không cho
      // dò xem email nào đã có tài khoản qua lỗi "email đã tồn tại".
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === "/sign-in/sso") {
          const body = (ctx.body ?? {}) as { providerId?: unknown; organizationSlug?: unknown; domain?: unknown };
          if (body.providerId || body.organizationSlug) return;
          const domain = typeof body.domain === "string" && body.domain ? body.domain : emailOf(body)?.split("@")[1];
          if (!domain) return;
          const provider = await ssoProviderForDomain(ctx.context.adapter, domain);
          // Cùng lỗi với plugin khi không có nhà cung cấp, để web báo "chưa có SSO cho tên miền này".
          if (!provider) throw new APIError("NOT_FOUND", { message: "No provider found for the issuer" });
          return { context: { body: { ...body, providerId: provider.providerId } } };
        }
        if (ctx.path !== "/sign-up/email") return;
        const email = emailOf(ctx.body) ?? "";
        if (notAscii(email))
          throw new APIError("FORBIDDEN", {
            message: SIGN_UP_DENIED.emailNotAscii.message,
            code: SIGN_UP_DENIED.emailNotAscii.code,
          });
        const inviteToken = inviteTokenOf(ctx.body);
        let denied = await signUpDenial({ email, emailVerified: false, method: "email-password", inviteToken });
        // Người trong HIVE_ORG_CREATORS đăng ký không cần mã (lúc hub còn trống): email đã có tài khoản cũng trả đúng mã
        // như người ngoài danh sách, không thì lỗi "email đã tồn tại" cho biết ai là quản trị hub và đã đăng ký chưa.
        if (
          !denied &&
          !inviteToken &&
          !o.allowEmailSignUp &&
          (await ctx.context.internalAdapter.findUserByEmail(email.toLowerCase()))
        )
          denied = SIGN_UP_DENIED.inviteRequired;
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
          // Lời mời bị thu hồi hoặc hết hạn giữa lúc kiểm (hook before) và lúc nhận. Không gộp được vào transaction
          // tạo user: transaction đó chạy trên pool hive_auth, còn nhận lời mời chạy trên hive_app và cần user đã
          // commit (khoá ngoại của org_members). Giữ tài khoản thì có người không thuộc tổ chức nào, trái quy tắc
          // "chỉ người được mời mới có tài khoản"; xoá đi để họ đăng ký lại bằng lời mời mới.
          await ctx.context.internalAdapter.deleteUser(user.id);
          ctx.context.responseHeaders?.delete("set-cookie");
          deleteSessionCookie(ctx);
          const code = (error as { code?: unknown }).code;
          if (typeof code === "string" && code.startsWith("INVITE_"))
            throw new APIError("FORBIDDEN", {
              message: SIGN_UP_DENIED.inviteInvalid.message,
              code: SIGN_UP_DENIED.inviteInvalid.code,
            });
          ctx.context.logger.error("Không nhận được lời mời sau khi đăng ký; đã xoá tài khoản vừa tạo", error);
          throw new APIError("INTERNAL_SERVER_ERROR", {
            message: "Hub chưa tạo được tài khoản vì lỗi khi nhận lời mời. Thử lại sau ít phút.",
            code: "SIGN_UP_INVITE_ACCEPT_FAILED",
          });
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
            domainVerified: (provider as { domainVerified?: boolean | null }).domainVerified === true,
            user: { id: user.id, email: user.email, name: user.name },
          });
        },
      }),
      ssoDomainVerified,
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
