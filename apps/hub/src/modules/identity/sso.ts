import { createHmac, randomBytes } from "node:crypto";
import { Resolver } from "node:dns/promises";
import { APIError } from "better-auth/api";
import { BadRequestError, ConflictError, NotFoundError } from "../platform/index.ts";
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
    `Tên miền ${domain} đang được một tổ chức khác trên hub khai cho SSO nhưng chưa xác minh. Nếu tên miền là của tổ chức bạn, hãy xác minh bằng bản ghi TXT: xác minh xong thì tổ chức bạn giành lại tên miền.`,
  );

const domainTakenVerified = (domain: string) =>
  new ConflictError(
    "SSO_DOMAIN_TAKEN",
    `Tên miền ${domain} đã được một tổ chức khác trên hub xác minh cho SSO. Mỗi tên miền chỉ thuộc một tổ chức; nếu tên miền là của tổ chức bạn, hãy báo quản trị hub.`,
  );

const publicDomain = (domain: string) =>
  new BadRequestError(
    "SSO_DOMAIN_PUBLIC",
    `${domain} là tên miền thư công cộng, không thuộc riêng tổ chức nào nên không dùng làm tên miền SSO được. Hãy nhập tên miền email của tổ chức.`,
  );

/** Unique index ssoProvider_domain_uidx: hai tổ chức khai cùng tên miền một lúc, bên ghi sau nhận lỗi này. */
function isDomainConflict(error: unknown): boolean {
  for (let e = error as { code?: unknown; constraint?: unknown; cause?: unknown } | undefined; e; e = e.cause as never)
    if (e.code === "23505" && e.constraint === "ssoProvider_domain_uidx") return true;
  return false;
}

/** Có tổ chức nào đã khai SSO chưa; chưa có thì trang đăng nhập không hiện ô SSO. */
export async function anySsoProvider(auth: Auth): Promise<boolean> {
  const ctx = await auth.$context;
  return (await ctx.adapter.count({ model: "ssoProvider" })) > 0;
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

export interface SavedSsoProvider {
  provider: SsoProviderView;
  /** providerId của tổ chức bị giành tên miền (tổ chức chưa xác minh), để ghi audit cho cả tổ chức đó. */
  claimedFrom?: string | undefined;
}

export async function saveSsoProvider(auth: Auth, actor: SsoActor, input: SsoProviderInput): Promise<SavedSsoProvider> {
  const domain = input.domain.toLowerCase();
  if (PUBLIC_EMAIL_DOMAINS.has(domain)) throw publicDomain(domain);
  const claim = await findVerification(auth, input.providerId);
  const claimed = claim?.verifiedAt !== undefined && claim.domain === domain ? claim : undefined;
  let claimedFrom: string | undefined;
  const owner = await findProviderByDomain(auth, domain);
  if (owner && owner.providerId !== input.providerId) {
    if (owner.domainVerified === true) throw domainTakenVerified(domain);
    // Tổ chức này đã chứng minh giữ tên miền bằng DNS (checkDomainVerification) mà chưa lưu cấu hình, và trong lúc đó
    // một tổ chức chưa xác minh lại khai tên miền này: bên có bằng chứng thắng.
    if (!claimed) throw domainTaken(domain);
    await removeSsoProvider(auth, actor, owner.providerId);
    claimedFrom = owner.providerId;
  }
  try {
    await writeProvider(auth, actor, { ...input, domain });
  } catch (error) {
    if (isDomainConflict(error)) throw domainTaken(domain);
    throw error;
  }
  // Lưu sau khi xác minh: plugin vừa ghi domainVerified = false, đặt lại theo bằng chứng đã có.
  if (claimed) await markVerified(auth, input.providerId, domain);
  const saved = await findProvider(auth, input.providerId);
  if (!saved) throw new Error("Không lưu được cấu hình SSO.");
  return { provider: view(saved), claimedFrom };
}

async function writeProvider(auth: Auth, actor: SsoActor, input: SsoProviderInput): Promise<void> {
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
}

/** Gỡ nhà cung cấp. Plugin xoá luôn liên kết tài khoản SSO; người dùng và tư cách thành viên vẫn giữ. */
export async function removeSsoProvider(auth: Auth, actor: SsoActor, providerId: string): Promise<boolean> {
  const current = await findProvider(auth, providerId);
  if (!current) return false;
  await takeOver(auth, current, actor.userId);
  await mapErrors(() => auth.api.deleteSSOProvider({ headers: actor.headers, body: { providerId } }));
  return true;
}

// --- Xác minh tên miền bằng bản ghi TXT ---
//
// Không dùng request-domain-verification/verify-domain của plugin: hai endpoint đó chỉ có khi bật domainVerification,
// mà bật thì plugin chặn đăng nhập qua mọi nhà cung cấp chưa xác minh (xem ssoDomainVerified trong auth.ts).

/** Phân giải bản ghi TXT, như `resolveTxt` của node:dns/promises. Test thay bằng DNS giả. */
export type TxtResolver = (hostname: string) => Promise<string[][]>;

export function systemTxtResolver(): TxtResolver {
  // Resolver mặc định thử lại lâu (vài chục giây) khi máy chủ DNS không trả lời; người bấm "Kiểm tra" đang chờ.
  const resolver = new Resolver({ timeout: 5000, tries: 2 });
  return (hostname) => resolver.resolveTxt(hostname);
}

export const DOMAIN_VERIFICATION_LABEL = "_xdev-hive-verification";
const RECORD_PREFIX = "xdev-hive-verification=";
/** Mã xác minh dùng được 7 ngày, đủ cho quản trị tổ chức nhờ bộ phận quản lý DNS thêm bản ghi. */
const VERIFICATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const verificationId = (providerId: string) => `hive-sso-domain-verification:${providerId}`;

/** Lưu trong bảng verification của Better Auth, mỗi tổ chức (providerId) một dòng. */
interface StoredVerification {
  domain: string;
  nonce: string;
  /** DNS đã khớp nhưng tổ chức chưa lưu cấu hình SSO với tên miền này. */
  verifiedAt?: string | undefined;
  expiresAt: Date;
}

export interface DomainVerificationView {
  domain: string;
  recordName: string;
  recordValue: string;
  expiresAt: string;
  verified: boolean;
}

export interface DomainVerificationResult {
  /** Đã đặt domainVerified cho cấu hình SSO đang lưu; false là chờ lưu cấu hình với tên miền này. */
  applied: boolean;
  domain: string;
  claimedFrom?: string | undefined;
}

async function findVerification(auth: Auth, providerId: string): Promise<StoredVerification | null> {
  const ctx = await auth.$context;
  const row = await ctx.internalAdapter.findVerificationValue(verificationId(providerId));
  if (!row || new Date(row.expiresAt) <= new Date()) return null;
  try {
    const value = JSON.parse(row.value) as Omit<StoredVerification, "expiresAt">;
    return { ...value, expiresAt: new Date(row.expiresAt) };
  } catch {
    return null;
  }
}

/**
 * Hub không lưu mã: mã là HMAC theo secret của hub, gắn với tổ chức và tên miền, nên dòng trong database chỉ có nonce.
 * Vẫn hiện lại được bản ghi cần thêm mỗi lần mở trang, và mã của tổ chức này không dùng được cho tổ chức khác hay tên
 * miền khác. Đổi HIVE_AUTH_SECRET thì mã đang chờ hết dùng được; tạo mã mới là xong.
 */
async function tokenOf(auth: Auth, providerId: string, v: Pick<StoredVerification, "domain" | "nonce">) {
  const ctx = await auth.$context;
  return createHmac("sha256", ctx.secret)
    .update(`sso-domain-verification\0${providerId}\0${v.domain}\0${v.nonce}`)
    .digest("base64url");
}

async function verificationView(
  auth: Auth,
  providerId: string,
  v: StoredVerification,
): Promise<DomainVerificationView> {
  return {
    domain: v.domain,
    recordName: `${DOMAIN_VERIFICATION_LABEL}.${v.domain}`,
    recordValue: `${RECORD_PREFIX}${await tokenOf(auth, providerId, v)}`,
    expiresAt: v.expiresAt.toISOString(),
    verified: v.verifiedAt !== undefined,
  };
}

/** Bản ghi TXT đang chờ của tổ chức, hoặc null. */
export async function getDomainVerification(auth: Auth, providerId: string): Promise<DomainVerificationView | null> {
  const v = await findVerification(auth, providerId);
  return v && verificationView(auth, providerId, v);
}

/** Chỉ đặt khi tên miền chưa đổi: quản trị đổi tên miền giữa lúc kiểm thì bằng chứng không áp cho tên miền mới. */
async function markVerified(auth: Auth, providerId: string, domain: string): Promise<boolean> {
  const ctx = await auth.$context;
  const updated = await ctx.adapter.update({
    model: "ssoProvider",
    where: [
      { field: "providerId", value: providerId },
      { field: "domain", value: domain },
    ],
    update: { domainVerified: true },
  });
  if (updated) await ctx.internalAdapter.deleteVerificationByIdentifier(verificationId(providerId));
  return Boolean(updated);
}

/**
 * Lấy bản ghi TXT để chứng minh tổ chức giữ `domain` (mặc định là tên miền của cấu hình đang lưu). Gọi lại với cùng
 * tên miền trả đúng bản ghi cũ tới khi hết hạn, để bấm lại không làm hỏng bản ghi đã thêm vào DNS.
 */
export async function requestDomainVerification(
  auth: Auth,
  providerId: string,
  requested: string | undefined,
): Promise<DomainVerificationView> {
  const own = await findProvider(auth, providerId);
  const domain = (requested ?? own?.domain ?? "").toLowerCase();
  if (!domain)
    throw new BadRequestError("SSO_DOMAIN_REQUIRED", "Nhập tên miền email của tổ chức trước khi lấy bản ghi TXT.");
  if (PUBLIC_EMAIL_DOMAINS.has(domain)) throw publicDomain(domain);
  if (own?.domain.toLowerCase() === domain && own.domainVerified === true)
    throw new ConflictError("SSO_DOMAIN_ALREADY_VERIFIED", `Tên miền ${domain} đã được xác minh cho tổ chức.`);
  const owner = await findProviderByDomain(auth, domain);
  if (owner && owner.providerId !== providerId && owner.domainVerified === true) throw domainTakenVerified(domain);

  const current = await findVerification(auth, providerId);
  if (current?.domain === domain) return verificationView(auth, providerId, current);
  const ctx = await auth.$context;
  await ctx.internalAdapter.deleteVerificationByIdentifier(verificationId(providerId));
  const next = { domain, nonce: randomBytes(16).toString("base64url") };
  const expiresAt = new Date(Date.now() + VERIFICATION_TTL_MS);
  await ctx.internalAdapter.createVerificationValue({
    identifier: verificationId(providerId),
    value: JSON.stringify(next),
    expiresAt,
  });
  return verificationView(auth, providerId, { ...next, expiresAt });
}

/**
 * Tra DNS. Khớp thì: tên miền đang bị một tổ chức chưa xác minh giữ sẽ bị gỡ khỏi tổ chức đó (tổ chức này có bằng
 * chứng, bên kia không); cấu hình SSO đang dùng đúng tên miền thì được đánh dấu đã xác minh, còn không thì giữ bằng
 * chứng tới khi hết hạn để lần lưu cấu hình kế tiếp với tên miền này nhận xác minh luôn.
 */
export async function checkDomainVerification(
  auth: Auth,
  actor: SsoActor,
  providerId: string,
  resolveTxt: TxtResolver,
): Promise<DomainVerificationResult> {
  const pending = await findVerification(auth, providerId);
  if (!pending)
    throw new NotFoundError(
      "SSO_VERIFICATION_NOT_FOUND",
      "Chưa có bản ghi TXT đang chờ, hoặc bản ghi đã hết hạn. Bấm “Lấy bản ghi TXT” để lấy bản ghi mới.",
    );
  const { domain } = pending;
  const expected = await verificationView(auth, providerId, pending);
  let records: string[] = [];
  try {
    records = (await resolveTxt(expected.recordName)).map((chunks) => chunks.join("").trim());
  } catch {
    // ENOTFOUND, ENODATA, hết giờ: với người dùng đều là "chưa thấy bản ghi".
  }
  if (!records.includes(expected.recordValue))
    throw new BadRequestError(
      "SSO_VERIFICATION_FAILED",
      `Chưa thấy bản ghi TXT ${expected.recordName} có giá trị ${expected.recordValue}. Bản ghi mới có thể mất vài phút tới vài giờ mới hiện trên DNS; thử lại sau.`,
    );

  let claimedFrom: string | undefined;
  const owner = await findProviderByDomain(auth, domain);
  if (owner && owner.providerId !== providerId) {
    if (owner.domainVerified === true) throw domainTakenVerified(domain);
    await removeSsoProvider(auth, actor, owner.providerId);
    claimedFrom = owner.providerId;
  }
  const own = await findProvider(auth, providerId);
  if (own?.domain === domain && (await markVerified(auth, providerId, domain)))
    return { applied: true, domain, claimedFrom };
  const ctx = await auth.$context;
  await ctx.internalAdapter.updateVerificationByIdentifier(verificationId(providerId), {
    value: JSON.stringify({ domain, nonce: pending.nonce, verifiedAt: new Date().toISOString() }),
  });
  return { applied: false, domain, claimedFrom };
}
