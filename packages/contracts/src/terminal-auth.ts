import { z } from "zod";

/**
 * Xác thực điều khiển từ xa phiên terminal trên máy cá nhân (specs/010 FR-014…FR-017, FR-033…FR-037, ADR 0019).
 *
 * Worker tự kiểm mọi thứ ở đây (`worker/internal/remoteauth`), hub chỉ chuyển tiếp: hub bị chiếm cũng không ký được
 * assertion của thiết bị đã ghép, không biết bí mật ghép, không suy ra được khoá HMAC của gói nhập. Hàm viết một lần ở đây
 * (web và test dùng) và một lần trong Go; hai bên cùng đọc vector `fixtures/terminal-auth.json` nên không lệch byte.
 */

/** Thời gian lệch tối đa giữa `ts` của yêu cầu và đồng hồ worker. */
export const REMOTE_AUTH_SKEW_SEC = 120;
/** Worker nhớ `nonce` đã dùng chừng này, đủ phủ cửa sổ `ts` hai phía. */
export const REMOTE_AUTH_NONCE_TTL_SEC = 600;
/** Mã ghép (pairId + bí mật trong fragment URL) hết hạn sau 10 phút và chỉ dùng một lần. */
export const PAIR_TTL_SEC = 600;
/** Byte HMAC gắn trên mỗi gói nhập (HMAC-SHA256 cắt ngắn). */
export const INPUT_MAC_BYTES = 16;
/** `info` của HKDF khi xác thực bằng passkey. TOTP dùng `TOTP_KEY_INFO_PREFIX + mã` (plan.md D15). */
export const PASSKEY_KEY_INFO = "hive-term-input/v1";
export const TOTP_KEY_INFO_PREFIX = "hive-totp";
/**
 * `term_control` bắt buộc `deviceId` nhưng mã TOTP không gắn với thiết bị nào: hub điền mã cố định này khi khung
 * `control` không có `deviceId`. Trình duyệt cần cùng giá trị vì challenge (salt của HKDF) chứa `params.deviceId`.
 */
export const TOTP_DEVICE_ID = "totp-code";

/** TOTP theo RFC 6238 đúng như app Authenticator mặc định: HMAC-SHA1, 6 số, bước 30 giây, cho lệch ±1 bước. */
export const TOTP = {
  digits: 6,
  periodSec: 30,
  skewSteps: 1,
  maxFailures: 5,
  lockBaseSec: 300,
  lockMaxSec: 3600,
} as const;

export const base64url = (maxBytes: number) => z.base64url().max(Math.ceil((maxBytes * 4) / 3));

/** Khoá công khai ECDH P-256 dạng điểm không nén (65 byte, WebCrypto `exportKey("raw")`). */
export const ephPub = z
  .base64url()
  .length(87)
  .refine((s) => s.startsWith("B"), { message: "Khoá ECDH phải là điểm P-256 không nén." });
/** 16 byte ngẫu nhiên do trình duyệt sinh cho mỗi yêu cầu. */
export const authNonce = z.base64url().length(22);
/** Giây Unix (số nguyên) để Go và JS in giống nhau trong JSON chuẩn hoá. */
export const authTs = z
  .number()
  .int()
  .min(0)
  .max(2 ** 40);

/** Assertion WebAuthn như trình duyệt trả (mọi trường base64url). Worker kiểm ES256 bằng SPKI của thiết bị đã ghép. */
export const webauthnAssertion = z.object({
  credentialId: base64url(1024),
  authenticatorData: base64url(1024),
  clientDataJSON: base64url(4096),
  /** Chữ ký ECDSA dạng DER như WebAuthn trả (không phải r‖s của WebCrypto). */
  signature: base64url(128),
  userHandle: base64url(64).optional(),
});
export type WebauthnAssertion = z.output<typeof webauthnAssertion>;

/**
 * Bằng chứng kèm `term_start`/`term_control`. Passkey là đường chính; TOTP chỉ là đường lui khi hub chạy HTTP (Q2):
 * `ephPub` của TOTP không được ký nên khoá phiên trộn thêm mã (`TOTP_KEY_INFO_PREFIX`), xem mối đe doạ T15–T17.
 */
export const remoteAuth = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("passkey"), assertion: webauthnAssertion, ephPub, ts: authTs, nonce: authNonce }),
  z.object({ kind: z.literal("totp"), code: z.string().regex(/^\d{6}$/), ephPub, ts: authTs, nonce: authNonce }),
]);
export type RemoteAuth = z.output<typeof remoteAuth>;

export const remoteAction = z.enum(["start", "control"]);
export type RemoteAction = z.output<typeof remoteAction>;

/**
 * Mã từ chối của worker (`term_denied.code`, `term_revoked.reason`). Nhóm `AUTH_*`/`ASSERTION_*`/`DEVICE_*`/`TOTP_*` là
 * xác thực; còn lại là điều kiện của máy. Hub đổi mã thành câu tiếng Việt bằng `TERM_DENY_MESSAGES`.
 */
export const termDenyCode = z.enum([
  "REMOTE_DISABLED",
  "MACHINE_SHARED",
  "AUTH_INVALID",
  "AUTH_STALE",
  "AUTH_REPLAY",
  "DEVICE_UNKNOWN",
  "DEVICE_USER_MISMATCH",
  "ASSERTION_ORIGIN",
  "ASSERTION_RP_ID",
  "ASSERTION_FLAGS",
  "ASSERTION_SIGNATURE",
  "ASSERTION_COUNTER",
  "TOTP_DISABLED",
  "TOTP_NOT_ALLOWED",
  "TOTP_INVALID",
  "TOTP_REPLAY",
  "TOTP_LOCKED",
  "ROOT_MISSING",
  "ROOT_ESCAPE",
  "CLI_MISSING",
  "ACCOUNT_UNAVAILABLE",
  "CONFIRM_DENIED",
  "CONFIRM_TIMEOUT",
  "SESSION_UNKNOWN",
  "BUSY",
  "INPUT_REJECTED",
]);
export type TermDenyCode = z.output<typeof termDenyCode>;

export const TERM_DENY_MESSAGES: Record<TermDenyCode, string> = {
  REMOTE_DISABLED: "Máy chưa bật điều khiển từ xa. Chủ máy bật tại máy (app hoặc `hive remote on`).",
  MACHINE_SHARED: "Máy dùng chung không cho điều khiển từ xa bằng thiết bị cá nhân.",
  AUTH_INVALID: "Yêu cầu xác thực không hợp lệ.",
  AUTH_STALE: "Yêu cầu đã quá hạn hoặc đồng hồ thiết bị lệch quá 2 phút. Thử lại.",
  AUTH_REPLAY: "Yêu cầu này đã được dùng. Thử lại.",
  DEVICE_UNKNOWN: "Thiết bị chưa được ghép với máy này hoặc đã bị gỡ.",
  DEVICE_USER_MISMATCH: "Thiết bị được ghép cho người dùng khác.",
  ASSERTION_ORIGIN: "Passkey không được tạo cho địa chỉ hub này.",
  ASSERTION_RP_ID: "Passkey không thuộc địa chỉ hub này.",
  ASSERTION_FLAGS: "Cần xác minh người dùng (Face ID, vân tay hoặc mã máy) trên thiết bị.",
  ASSERTION_SIGNATURE: "Chữ ký passkey không đúng.",
  ASSERTION_COUNTER: "Bộ đếm passkey bị lùi; có thể passkey đã bị sao chép. Gỡ và ghép lại thiết bị.",
  TOTP_DISABLED: "Máy chưa bật mã Authenticator (TOTP).",
  TOTP_NOT_ALLOWED: "Tổ chức hoặc máy không cho dùng mã Authenticator (TOTP) cho hub này.",
  TOTP_INVALID: "Mã Authenticator không đúng.",
  TOTP_REPLAY: "Mã này vừa được dùng. Chờ mã mới rồi thử lại.",
  TOTP_LOCKED: "Nhập sai mã quá nhiều lần, máy tạm khoá mã Authenticator. Chờ hết khoá hoặc mở khoá tại máy.",
  ROOT_MISSING: "Thư mục không còn trong danh sách được phép hoặc không tồn tại.",
  ROOT_ESCAPE: "Đường dẫn đi ra ngoài thư mục được phép.",
  CLI_MISSING: "Máy không có CLI này.",
  ACCOUNT_UNAVAILABLE: "Không có tài khoản CLI dùng được trên máy.",
  CONFIRM_DENIED: "Chủ máy đã từ chối tại máy.",
  CONFIRM_TIMEOUT: "Không có ai xác nhận tại máy trong 60 giây.",
  SESSION_UNKNOWN: "Phiên không còn trên máy.",
  BUSY: "Máy đang chạy tối đa số phiên.",
  INPUT_REJECTED: "Phím gõ bị từ chối vì sai chữ ký; đã thu quyền điều khiển.",
};

type Canonical = string | number | boolean | null | Canonical[] | { [key: string]: Canonical | undefined };

/**
 * JSON chuẩn hoá: khoá xếp theo thứ tự byte (khoá chỉ ASCII), không khoảng trắng, chuỗi NFC, số chỉ là số nguyên an toàn,
 * bỏ khoá có giá trị `undefined`. Chuỗi in như `JSON.stringify` (Go viết lại đúng quy tắc này, kể cả U+2028).
 */
export function canonicalJson(value: Canonical): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("JSON chuẩn hoá chỉ nhận số nguyên");
    return String(value);
  }
  if (typeof value === "string") {
    if (!value.isWellFormed()) throw new Error("Chuỗi không phải UTF-16 hợp lệ");
    return JSON.stringify(value.normalize("NFC"));
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  for (const k of keys) if (!/^[\x20-\x7e]+$/.test(k)) throw new Error(`Khoá phải là ASCII: ${k}`);
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k] as Canonical)}`).join(",")}}`;
}

/** Trường của `term_start` được ký (FR-016): đúng những gì worker dùng để mở phiên, không có gì tự do khác. */
export interface StartParams {
  userId: string;
  deviceId: string;
  cli: string;
  accountId?: string;
  rootId: string;
  subdir?: string;
  projectId?: string;
  taskId?: string;
  prompt?: string;
  cols: number;
  rows: number;
}

/** Trường của `term_control` được ký: quyền gõ gắn với đúng một kết nối WS của một phiên. */
export interface ControlParams {
  userId: string;
  deviceId: string;
  sessionId: string;
  connId: string;
}

export interface ChallengeInput {
  machineId: string;
  action: RemoteAction;
  params: StartParams | ControlParams;
  ephPub: string;
  ts: number;
  nonce: string;
}

/** Byte được băm thành challenge WebAuthn: JSON chuẩn hoá của `{action, ephPub, machineId, nonce, params, ts}`. */
export function canonicalChallenge(input: ChallengeInput): string {
  return canonicalJson({ ...input, params: { ...input.params } });
}

const utf8 = (s: string) => new TextEncoder().encode(s);

/** Kiểu khoá WebCrypto lấy từ chữ ký hàm, vì contracts chạy cả trên Node (không có lib DOM) lẫn trình duyệt. */
export type WebCryptoKey = Parameters<typeof crypto.subtle.sign>[1];

export function toBase64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export function fromBase64url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** challenge = SHA-256(JSON chuẩn hoá). Trình duyệt đặt làm `publicKey.challenge`; clientDataJSON chứa bản base64url. */
export async function challengeBytes(input: ChallengeInput): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(canonicalChallenge(input))));
}

/**
 * Nội dung HMAC của bằng chứng ghép (FR-014). Dùng JSON chuẩn hoá thay vì nối thẳng SPKI‖credentialId‖userId để ranh
 * giới giữa các trường không mơ hồ; thêm `pairId` để tag chỉ dùng được cho đúng lần ghép.
 */
export function pairTagPayload(input: { pairId: string; userId: string; credentialId: string; spki: string }): string {
  return canonicalJson({ ...input });
}

/** tag = base64url(HMAC-SHA256(bí mật ghép, pairTagPayload)), đủ 32 byte. Bí mật nằm trong fragment, không tới hub. */
export async function pairTag(
  secret: Uint8Array<ArrayBuffer>,
  input: Parameters<typeof pairTagPayload>[0],
): Promise<string> {
  const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toBase64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8(pairTagPayload(input)))));
}

/**
 * Nội dung HMAC của một gói nhập (FR-017): gắn phiên, kết nối, loại gói và `seq`, nên hub không đổi được gói này sang
 * phiên/kết nối khác hay đổi phím thành resize. `data` là chuỗi base64 chuẩn đúng như trong gói.
 */
export function inputMacPayload(
  input:
    | { sessionId: string; connId: string; seq: number; kind: "in"; data: string }
    | { sessionId: string; connId: string; seq: number; kind: "resize"; cols: number; rows: number },
): string {
  return canonicalJson({ ...input });
}

/** info của HKDF: passkey dùng hằng số; TOTP trộn mã đã dùng để ai không thấy mã không suy ra được khoá. */
export function sessionKeyInfo(auth: Pick<RemoteAuth, "kind"> & { code?: string }): string {
  return auth.kind === "totp" ? `${TOTP_KEY_INFO_PREFIX}${auth.code}` : PASSKEY_KEY_INFO;
}

/**
 * K = HKDF-SHA256(ikm = ECDH(khoá tạm của trình duyệt, workerEphPub), salt = challenge, info). Khoá trả về không xuất
 * được (chỉ ký HMAC), sống trong bộ nhớ trang (mối đe doạ T7).
 */
export async function deriveInputKey(
  privateKey: WebCryptoKey,
  workerEphPub: string,
  challenge: Uint8Array<ArrayBuffer>,
  info: string,
  extractable = false,
): Promise<WebCryptoKey> {
  const peer = await crypto.subtle.importKey(
    "raw",
    fromBase64url(workerEphPub),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: peer }, privateKey, 256);
  const ikm = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: challenge, info: utf8(info) },
    ikm,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    extractable,
    ["sign"],
  );
}

/** mac = base64url(16 byte đầu của HMAC-SHA256(K, inputMacPayload)). */
export async function inputMac(key: WebCryptoKey, payload: string): Promise<string> {
  const full = new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8(payload)));
  return toBase64url(full.slice(0, INPUT_MAC_BYTES));
}
