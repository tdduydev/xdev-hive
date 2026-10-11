import { APIError } from "better-auth/api";
import { BadRequestError, ConflictError } from "../platform/index.ts";
import type { Auth } from "./auth.ts";

/** Cấu hình OIDC của một tổ chức. Secret không bao giờ đi ra khỏi hub. */
export interface SsoProviderView {
  issuer: string;
  domain: string;
  /** Chưa xác minh thì SSO không tự tạo tài khoản, không tự xếp người vào tổ chức; người mới phải được mời. */
  domainVerified: boolean;
  clientIdLastFour: string | null;
}

export interface SsoProviderInput {
  providerId: string;
  issuer: string;
  domain: string;
  clientId: string;
  /** Bỏ trống thì giữ secret cũ. */
  clientSecret?: string | undefined;
}

/** Người đang thao tác: plugin SSO đòi phiên, nên gọi API của plugin bằng chính header của request. */
export interface SsoActor {
  userId: string;
  headers: Headers;
}

interface StoredProvider {
  providerId: string;
  issuer: string;
  domain: string;
  domainVerified?: boolean | null;
  userId: string | null;
  oidcConfig: string | null;
}

/**
 * Tên miền thư công cộng: không tổ chức nào sở hữu, nên không cho khai làm tên miền SSO. Khai được thì IdP của tổ
 * chức đó chiếm luồng đăng nhập SSO của mọi người dùng tên miền này trên hub.
 */
const PUBLIC_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "outlook.com.vn",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "yahoo.com.vn",
  "ymail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "aol.com",
  "gmx.com",
  "gmx.net",
  "mail.com",
  "zoho.com",
  "yandex.com",
  "yandex.ru",
  "tutanota.com",
  "tuta.io",
  "fastmail.com",
  "hey.com",
  "qq.com",
  "163.com",
  "126.com",
]);

const domainTaken = (domain: string) =>
  new ConflictError(
    "SSO_DOMAIN_TAKEN",
    `Tên miền ${domain} đã được một tổ chức khác trên hub khai cho SSO. Mỗi tên miền chỉ thuộc một tổ chức; nếu tên miền là của tổ chức bạn, hãy báo quản trị hub.`,
  );

/** Unique index ssoProvider_domain_uidx: hai tổ chức khai cùng tên miền một lúc, bên ghi sau nhận lỗi này. */
function isDomainConflict(error: unknown): boolean {
  for (let e = error as { code?: unknown; constraint?: unknown; cause?: unknown } | undefined; e; e = e.cause as never)
    if (e.code === "23505" && e.constraint === "ssoProvider_domain_uidx") return true;
  return false;
}

async function findProvider(auth: Auth, providerId: string): Promise<StoredProvider | null> {
  const ctx = await auth.$context;
  return ctx.adapter.findOne<StoredProvider>({
    model: "ssoProvider",
    where: [{ field: "providerId", value: providerId }],
  });
}

/** Tên miền luôn lưu chữ thường (saveSsoProvider), nên so bằng nhau là đủ; unique index chặn nốt phần còn lại. */
async function findProviderByDomain(auth: Auth, domain: string): Promise<StoredProvider | null> {
  const ctx = await auth.$context;
  return ctx.adapter.findOne<StoredProvider>({ model: "ssoProvider", where: [{ field: "domain", value: domain }] });
}

const oidcOf = (p: StoredProvider) => JSON.parse(p.oidcConfig ?? "{}") as { clientId?: string; clientSecret?: string };

function view(p: StoredProvider): SsoProviderView {
  const clientId = oidcOf(p).clientId;
  return {
    issuer: p.issuer,
    domain: p.domain,
    domainVerified: p.domainVerified === true,
    clientIdLastFour: clientId ? clientId.slice(-4) : null,
  };
}

/**
 * Plugin SSO chỉ cho người đã đăng ký nhà cung cấp sửa hay xoá nó (không dùng plugin organization). Quyền thật là
 * "quản trị tổ chức", đã kiểm ở tenancy trước khi gọi vào đây, nên chuyển chủ sang người đang thao tác rồi mới gọi
 * API của plugin; nhờ vậy vẫn dùng được phần kiểm tra và khoá dòng của plugin thay vì tự ghi vào bảng.
 */
async function takeOver(auth: Auth, p: StoredProvider, userId: string) {
  if (p.userId === userId) return;
  const ctx = await auth.$context;
  await ctx.adapter.update({
    model: "ssoProvider",
    where: [{ field: "providerId", value: p.providerId }],
    update: { userId },
  });
}

/** Lỗi của plugin là tiếng Anh; giữ chi tiết để quản trị tra cứu, thêm câu tiếng Việt nói rõ chuyện gì hỏng. */
async function mapErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof APIError) || isDomainConflict(error)) throw error;
    const detail = error.body?.message ?? error.message;
    const code = String(error.body?.code ?? "");
    if (code.startsWith("discovery_") || code === "issuer_mismatch" || code.startsWith("oidc_"))
      throw new BadRequestError(
        "SSO_DISCOVERY_FAILED",
        `Không đọc được cấu hình OIDC từ Issuer URL. Chi tiết: ${detail}`,
      );
    if (error.status === "CONFLICT")
      throw new ConflictError(
        "SSO_HAS_ACCOUNTS",
        "Đã có người đăng nhập bằng SSO này nên không đổi được Issuer hay Client ID. Gỡ SSO rồi cấu hình lại nếu thật sự cần đổi.",
      );
    throw new BadRequestError("SSO_CONFIG_INVALID", `Cấu hình SSO không hợp lệ. Chi tiết: ${detail}`);
  }
}

/** Callback URL quản trị dán vào cấu hình app bên nhà cung cấp; cố định theo providerId. */
export async function ssoCallbackUrl(auth: Auth, providerId: string): Promise<string> {
  const ctx = await auth.$context;
  return `${ctx.baseURL}/sso/callback/${encodeURIComponent(providerId)}`;
}

export async function getSsoProvider(auth: Auth, providerId: string): Promise<SsoProviderView | null> {
  const p = await findProvider(auth, providerId);
  return p && view(p);
}

export async function saveSsoProvider(auth: Auth, actor: SsoActor, input: SsoProviderInput): Promise<SsoProviderView> {
  const domain = input.domain.toLowerCase();
  if (PUBLIC_EMAIL_DOMAINS.has(domain))
    throw new BadRequestError(
      "SSO_DOMAIN_PUBLIC",
      `${domain} là tên miền thư công cộng, không thuộc riêng tổ chức nào nên không dùng làm tên miền SSO được. Hãy nhập tên miền email của tổ chức.`,
    );
  const owner = await findProviderByDomain(auth, domain);
  if (owner && owner.providerId !== input.providerId) throw domainTaken(domain);
  try {
    return await writeProvider(auth, actor, { ...input, domain });
  } catch (error) {
    if (isDomainConflict(error)) throw domainTaken(domain);
    throw error;
  }
}

async function writeProvider(auth: Auth, actor: SsoActor, input: SsoProviderInput): Promise<SsoProviderView> {
  const { domain } = input;
  const current = await findProvider(auth, input.providerId);
  const register = (clientSecret: string) =>
    mapErrors(() =>
      auth.api.registerSSOProvider({
        headers: actor.headers,
        body: {
          providerId: input.providerId,
          issuer: input.issuer,
          domain,
          oidcConfig: { clientId: input.clientId, clientSecret, pkce: true },
        },
      }),
    );

  if (!current) {
    if (!input.clientSecret)
      throw new BadRequestError("SSO_SECRET_REQUIRED", "Cần nhập Client secret khi cấu hình SSO lần đầu.");
    await register(input.clientSecret);
  } else if (current.issuer !== input.issuer) {
    // Plugin chỉ chạy discovery lúc đăng ký; sửa issuer bằng update sẽ giữ endpoint của issuer cũ. Vì vậy đổi issuer
    // là đăng ký lại, và chỉ làm khi chưa có tài khoản nào gắn với nhà cung cấp cũ (xoá sẽ cắt liên kết của họ).
    const ctx = await auth.$context;
    const linked = await ctx.adapter.findOne({
      model: "account",
      where: [{ field: "providerId", value: input.providerId }],
    });
    if (linked)
      throw new ConflictError(
        "SSO_HAS_ACCOUNTS",
        "Đã có người đăng nhập bằng SSO này nên không đổi được Issuer. Gỡ SSO rồi cấu hình lại nếu thật sự cần đổi.",
      );
    const secret = input.clientSecret ?? oidcOf(current).clientSecret;
    if (!secret) throw new BadRequestError("SSO_SECRET_REQUIRED", "Cần nhập Client secret.");
    await removeSsoProvider(auth, actor, input.providerId);
    await register(secret);
  } else {
    await takeOver(auth, current, actor.userId);
    await mapErrors(() =>
      auth.api.updateSSOProvider({
        headers: actor.headers,
        body: {
          providerId: input.providerId,
          domain,
          oidcConfig: {
            clientId: input.clientId,
            ...(input.clientSecret ? { clientSecret: input.clientSecret } : {}),
          },
        },
      }),
    );
  }
  const saved = await findProvider(auth, input.providerId);
  if (!saved) throw new Error("Không lưu được cấu hình SSO.");
  return view(saved);
}

/** Gỡ nhà cung cấp. Plugin xoá luôn liên kết tài khoản SSO; người dùng và tư cách thành viên vẫn giữ. */
export async function removeSsoProvider(auth: Auth, actor: SsoActor, providerId: string): Promise<boolean> {
  const current = await findProvider(auth, providerId);
  if (!current) return false;
  await takeOver(auth, current, actor.userId);
  await mapErrors(() => auth.api.deleteSSOProvider({ headers: actor.headers, body: { providerId } }));
  return true;
}
