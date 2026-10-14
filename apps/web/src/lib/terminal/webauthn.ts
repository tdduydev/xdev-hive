import type { RemotePairOptions } from "@xdev-hive/contracts";
import {
  type ChallengeInput,
  challengeBytes,
  fromBase64url,
  pairTag,
  toBase64url,
  type WebauthnAssertion,
} from "@xdev-hive/contracts/terminal-auth";

/**
 * Passkey cho điều khiển từ xa (specs/010 FR-014, plan.md D6): ghép điện thoại với máy và ký yêu cầu mở/điều khiển phiên.
 * Worker kiểm mọi thứ bằng SPKI và tag ghép, không đọc attestation, nên ở đây chỉ cần `getPublicKey()` và cờ trong
 * authenticatorData. Hàm nhận `window`/`navigator` qua tham số để test chạy trong Node mà không cần trình duyệt.
 */

export const PAIR_PATH = "/remote/pair";

/** Link QR `…/remote/pair?m=<tên máy>&p=<pairId>#s=<bí mật>` (worker `pairURL`). */
export interface PairLink {
  /** Tên máy trong hello của worker; web tra ra id trong các máy của người đang đăng nhập. */
  machine: string;
  pairId: string;
  /** base64url; null khi link thiếu hoặc đã bị xoá khỏi URL. */
  secret: string | null;
}

const STASH_PREFIX = "hive.pair.";

/** Bí mật ghép 128 bit (worker sinh 16 byte); ngắn hơn là link bị cắt. */
const MIN_SECRET_BYTES = 16;

function decodeSecret(value: string | null): Uint8Array<ArrayBuffer> | null {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const bytes = fromBase64url(value);
    return bytes.length >= MIN_SECRET_BYTES ? bytes : null;
  } catch {
    return null;
  }
}

/** `s` trong fragment; fragment theo dạng query (`#s=…`) như worker in. */
function fragmentSecret(hash: string): string | null {
  return new URLSearchParams(hash.replace(/^#/, "")).get("s");
}

/**
 * Đọc link ghép từ URL hiện tại. Bí mật lấy từ fragment, không có thì từ sessionStorage (khi phải đăng nhập trước,
 * `stashPairSecret` đã cất nó lại). Không có tác dụng phụ để gọi được trong lúc render; xoá bằng `scrubPairSecret`.
 */
export function readPairLink(href: string, storage?: Pick<Storage, "getItem">): PairLink {
  const url = new URL(href, "http://hive.invalid");
  const machine = url.searchParams.get("m")?.trim() ?? "";
  const pairId = url.searchParams.get("p")?.trim() ?? "";
  const fromHash = fragmentSecret(url.hash);
  const secret = fromHash ?? (pairId ? (storage?.getItem(STASH_PREFIX + pairId) ?? null) : null);
  return { machine, pairId, secret: decodeSecret(secret) ? secret : null };
}

/** Bí mật dạng byte để tính tag; null khi không hợp lệ. */
export const pairSecretBytes = (secret: string | null) => decodeSecret(secret);

/**
 * Xoá bí mật khỏi thanh địa chỉ và sessionStorage ngay khi trang đã giữ nó trong bộ nhớ: link còn bí mật thì lọt vào
 * lịch sử, đồng bộ tab, ảnh chụp màn hình. Giữ `history.state` vì router đặt khoá điều hướng trong đó.
 */
export function scrubPairSecret(
  pairId: string,
  win: { location: Pick<Location, "href">; history: Pick<History, "state" | "replaceState"> } = window,
  storage: Pick<Storage, "removeItem"> = sessionStorage,
): void {
  if (pairId) storage.removeItem(STASH_PREFIX + pairId);
  const url = new URL(win.location.href);
  if (!url.hash) return;
  url.hash = "";
  win.history.replaceState(win.history.state, "", url.pathname + url.search);
}

/**
 * Khi chưa đăng nhập, router chuyển sang `/login?redirect=<href>` và đăng nhập OAuth gửi đích đó lên hub làm
 * `callbackURL`: bí mật trong fragment sẽ tới hub, mất ý nghĩa của FR-014. Cất bí mật vào sessionStorage của tab (còn
 * qua vòng đăng nhập) và trả lại đường dẫn không có fragment.
 */
export function stashPairSecret(href: string, storage: Pick<Storage, "setItem"> = sessionStorage): string {
  const url = new URL(href, "http://hive.invalid");
  if (url.pathname !== PAIR_PATH || !url.hash) return href;
  const secret = fragmentSecret(url.hash);
  const pairId = url.searchParams.get("p");
  if (secret && pairId) {
    try {
      storage.setItem(STASH_PREFIX + pairId, secret);
    } catch {
      /* Không cất được thì sau đăng nhập trang báo link thiếu bí mật; vẫn không gửi bí mật đi. */
    }
  }
  return url.pathname + url.search;
}

// ---- Khả năng của trình duyệt ----

export type PasskeySupport = "ok" | "insecure" | "unsupported";

/**
 * WebAuthn chỉ có trong secure context: hub chạy HTTP (trừ localhost) thì không tạo được passkey, phải bật HTTPS hoặc
 * dùng mã Authenticator (spec "Hub chạy HTTP").
 */
export function passkeySupport(
  win: { isSecureContext: boolean; PublicKeyCredential?: unknown; navigator: { credentials?: unknown } } = window,
): PasskeySupport {
  if (!win.isSecureContext) return "insecure";
  if (!win.PublicKeyCredential || !win.navigator.credentials) return "unsupported";
  return "ok";
}

// ---- Tạo passkey khi ghép ----

export type PasskeyErrorCode =
  | "cancelled"
  | "no_public_key"
  | "wrong_algorithm"
  | "no_user_verification"
  | "unsupported";

export class PasskeyError extends Error {
  readonly code: PasskeyErrorCode;
  constructor(code: PasskeyErrorCode, message: string) {
    super(message);
    this.name = "PasskeyError";
    this.code = code;
  }
}

/** Cờ trong authenticatorData (WebAuthn §6.1): byte 32 sau rpIdHash. */
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const ES256 = -7;

export interface CreatedPasskey {
  credentialId: string;
  /** SubjectPublicKeyInfo DER, base64url: worker dùng thẳng, không cần CBOR. */
  spki: string;
  /** Passkey đồng bộ (iCloud, Google): trình duyệt báo `backupEligible`, gỡ là gỡ trên mọi thiết bị cùng tài khoản. */
  synced: boolean;
}

type Credentials = Pick<CredentialsContainer, "create" | "get">;

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "NotAllowedError" || error.name === "AbortError");
}

function readFlags(authenticatorData: ArrayBuffer | undefined): number | null {
  if (!authenticatorData || authenticatorData.byteLength < 33) return null;
  return new Uint8Array(authenticatorData)[32] ?? null;
}

/** Tuỳ chọn hub trả (base64url) đổi thành tuỳ chọn WebAuthn (byte). UV luôn là `required`, không tin hub nới. */
export function creationOptions(options: RemotePairOptions["publicKey"]): PublicKeyCredentialCreationOptions {
  return {
    rp: options.rp,
    user: { ...options.user, id: fromBase64url(options.user.id) },
    challenge: fromBase64url(options.challenge),
    pubKeyCredParams: options.pubKeyCredParams,
    timeout: options.timeout,
    authenticatorSelection: { ...options.authenticatorSelection, userVerification: "required" },
    attestation: "none",
    excludeCredentials: options.excludeCredentials.map((c) => ({ type: c.type, id: fromBase64url(c.id) })),
  };
}

export async function createPasskey(
  options: RemotePairOptions["publicKey"],
  credentials: Credentials = navigator.credentials,
): Promise<CreatedPasskey> {
  let credential: Credential | null;
  try {
    credential = await credentials.create({ publicKey: creationOptions(options) });
  } catch (error) {
    if (isAbort(error)) throw new PasskeyError("cancelled", "Đã huỷ tạo passkey hoặc hết thời gian chờ xác thực.");
    throw error;
  }
  const pk = credential as PublicKeyCredential | null;
  const response = pk?.response as AuthenticatorAttestationResponse | undefined;
  if (!pk || !response) throw new PasskeyError("cancelled", "Trình duyệt không trả passkey.");
  if (typeof response.getPublicKey !== "function") {
    throw new PasskeyError(
      "unsupported",
      "Trình duyệt chưa hỗ trợ đọc khoá công khai của passkey. Cập nhật trình duyệt.",
    );
  }
  const spki = response.getPublicKey();
  if (!spki) throw new PasskeyError("no_public_key", "Passkey không có khoá công khai dùng được.");
  if (typeof response.getPublicKeyAlgorithm === "function" && response.getPublicKeyAlgorithm() !== ES256) {
    throw new PasskeyError("wrong_algorithm", "Passkey không dùng thuật toán ES256 mà máy cần.");
  }
  const flags = readFlags(response.getAuthenticatorData?.());
  // Worker từ chối mọi assertion thiếu UV; passkey tạo không có UV thì ghép xong cũng không dùng được.
  if (flags !== null && (flags & FLAG_UV) === 0) {
    throw new PasskeyError(
      "no_user_verification",
      "Thiết bị không xác minh người dùng (Face ID, vân tay hoặc mã máy). Bật khoá màn hình rồi thử lại.",
    );
  }
  return {
    credentialId: toBase64url(new Uint8Array(pk.rawId)),
    spki: toBase64url(new Uint8Array(spki)),
    synced: flags !== null && (flags & FLAG_BE) !== 0,
  };
}

/** Gói gửi `remote.pairComplete` (trừ machineId và nhãn): tag tính tại trình duyệt vì hub không được biết bí mật. */
export async function pairProof(input: {
  secret: Uint8Array<ArrayBuffer>;
  pairId: string;
  userId: string;
  passkey: CreatedPasskey;
}): Promise<{ pairId: string; credentialId: string; spki: string; synced: boolean; tag: string }> {
  const { passkey } = input;
  const tag = await pairTag(input.secret, {
    pairId: input.pairId,
    userId: input.userId,
    credentialId: passkey.credentialId,
    spki: passkey.spki,
  });
  return { pairId: input.pairId, credentialId: passkey.credentialId, spki: passkey.spki, synced: passkey.synced, tag };
}

// ---- Assertion khi mở/điều khiển phiên (T032) ----

/**
 * Ký yêu cầu bằng passkey đã ghép: challenge là SHA-256 của JSON chuẩn hoá (contracts), nên worker tự dựng lại và so
 * mà không tin gì hub gửi. `credentialIds` giới hạn đúng passkey đã ghép với máy, để trình duyệt không hỏi passkey khác.
 */
export async function getAssertion(
  input: { challenge: ChallengeInput; rpId?: string; credentialIds?: readonly string[]; timeoutMs?: number },
  credentials: Credentials = navigator.credentials,
): Promise<WebauthnAssertion> {
  const challenge = await challengeBytes(input.challenge);
  let credential: Credential | null;
  try {
    credential = await credentials.get({
      publicKey: {
        challenge,
        ...(input.rpId ? { rpId: input.rpId } : {}),
        allowCredentials: (input.credentialIds ?? []).map((id) => ({ type: "public-key", id: fromBase64url(id) })),
        userVerification: "required",
        timeout: input.timeoutMs ?? 60_000,
      },
    });
  } catch (error) {
    if (isAbort(error)) throw new PasskeyError("cancelled", "Đã huỷ xác thực passkey hoặc hết thời gian chờ.");
    throw error;
  }
  const pk = credential as PublicKeyCredential | null;
  const response = pk?.response as AuthenticatorAssertionResponse | undefined;
  if (!pk || !response) throw new PasskeyError("cancelled", "Trình duyệt không trả chữ ký passkey.");
  const b64 = (buffer: ArrayBuffer) => toBase64url(new Uint8Array(buffer));
  return {
    credentialId: b64(pk.rawId),
    authenticatorData: b64(response.authenticatorData),
    clientDataJSON: b64(response.clientDataJSON),
    signature: b64(response.signature),
    ...(response.userHandle ? { userHandle: b64(response.userHandle) } : {}),
  };
}

// ---- Thiết bị này ----

const DEVICES_KEY = "hive.remote.devices";

export interface ThisDevice {
  deviceId: string;
  credentialId: string;
}

/**
 * Thiết bị đã ghép của trình duyệt này theo máy. Hub không giữ id passkey (chỉ máy giữ), nên trình duyệt phải tự nhớ
 * để đánh dấu "Thiết bị này" và để ký bằng đúng passkey khi mở phiên.
 */
export function pairedDevices(storage: Pick<Storage, "getItem"> = localStorage): Record<string, ThisDevice> {
  try {
    const raw = storage.getItem(DEVICES_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, ThisDevice> = {};
    for (const [machineId, value] of Object.entries(parsed)) {
      const v = value as Partial<ThisDevice> | null;
      if (typeof v?.deviceId === "string" && typeof v.credentialId === "string") {
        out[machineId] = { deviceId: v.deviceId, credentialId: v.credentialId };
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function rememberDevice(
  machineId: string,
  device: ThisDevice | null,
  storage: Pick<Storage, "getItem" | "setItem"> = localStorage,
): void {
  const all = pairedDevices(storage);
  if (device) all[machineId] = device;
  else delete all[machineId];
  try {
    storage.setItem(DEVICES_KEY, JSON.stringify(all));
  } catch {
    /* Chỉ mất dấu "Thiết bị này"; thiết bị vẫn ghép trên máy. */
  }
}

/** Tên gợi ý cho thiết bị; người dùng sửa được trước khi ghép. */
export function suggestDeviceLabel(userAgent: string): string {
  if (/iPhone/i.test(userAgent)) return "iPhone";
  if (/iPad/i.test(userAgent)) return "iPad";
  if (/Android/i.test(userAgent)) return /Mobile/i.test(userAgent) ? "Điện thoại Android" : "Máy tính bảng Android";
  if (/Macintosh|Mac OS X/i.test(userAgent)) return "Mac";
  if (/Windows/i.test(userAgent)) return "Windows";
  if (/CrOS/i.test(userAgent)) return "Chromebook";
  if (/Linux/i.test(userAgent)) return "Linux";
  return "Trình duyệt";
}
