import type { RemoteMachine } from "@xdev-hive/contracts";
import {
  type ControlParams,
  type RemoteAction,
  type RemoteAuth,
  type StartParams,
  TOTP,
  TOTP_DEVICE_ID,
} from "@xdev-hive/contracts/terminal-auth";
import { type ControlAttempt, newAuthAttempt } from "@/lib/terminal/input-mac.ts";
import { getAssertion, pairedDevices, passkeySupport, type ThisDevice } from "@/lib/terminal/webauthn.ts";

/**
 * Chọn passkey hay mã Authenticator (TOTP) cho mở phiên và xin quyền gõ (specs/010 D15, T028), một chỗ cho cả trang phiên
 * và tấm "Mở phiên mới". Passkey là đường chính; chỉ khi trang không phải secure context (hub chạy HTTP, trình duyệt
 * không cho WebAuthn) mới dùng mã. Hub HTTPS không bao giờ hỏi mã: mã TOTP không buộc vào yêu cầu như chữ ký passkey.
 */

export type RemoteAuthMethod =
  | { kind: "passkey"; device: ThisDevice }
  | { kind: "totp" }
  | { kind: "blocked"; reason: "unpaired" | "unsupported" | "totp_not_allowed" | "totp_off" };

type MachineAuth = Pick<RemoteMachine, "id" | "totpAllowed" | "remote">;

interface Env {
  isSecureContext: boolean;
  PublicKeyCredential?: unknown;
  navigator: { credentials?: unknown };
}

export function remoteAuthMethod(
  machine: MachineAuth,
  env: Env = window,
  devices: Record<string, ThisDevice> = pairedDevices(),
): RemoteAuthMethod {
  const support = passkeySupport(env);
  if (support === "unsupported") return { kind: "blocked", reason: "unsupported" };
  if (support === "ok") {
    const device = devices[machine.id];
    return device ? { kind: "passkey", device } : { kind: "blocked", reason: "unpaired" };
  }
  if (!machine.totpAllowed) return { kind: "blocked", reason: "totp_not_allowed" };
  if (!machine.remote?.totp.enabled) return { kind: "blocked", reason: "totp_off" };
  return { kind: "totp" };
}

export const isTotpCode = (code: string) => new RegExp(`^\\d{${TOTP.digits}}$`).test(code);

export interface RemoteAuthResult {
  attempt: ControlAttempt;
  auth: RemoteAuth;
  /** Passkey: thiết bị đã ghép. TOTP bỏ trống, hub điền `TOTP_DEVICE_ID`. */
  deviceId?: string;
  /** Mã TOTP để trộn vào HKDF khi máy cấp quyền gõ (`grantKey`). */
  code?: string;
}

type Params<A extends RemoteAction> = Omit<A extends "start" ? StartParams : ControlParams, "deviceId">;

/**
 * Dựng bằng chứng cho `term_start`/`term_control`. `deviceId` trong challenge là thiết bị đã ghép, hoặc `TOTP_DEVICE_ID`
 * với mã (worker cũng dùng giá trị đó làm salt của HKDF). Mã không lưu ở đâu ngoài lời gọi này.
 */
export async function requestRemoteAuth<A extends RemoteAction>(input: {
  method: Extract<RemoteAuthMethod, { kind: "passkey" | "totp" }>;
  machineId: string;
  action: A;
  params: Params<A>;
  code?: string;
}): Promise<RemoteAuthResult> {
  const { method } = input;
  const deviceId = method.kind === "passkey" ? method.device.deviceId : TOTP_DEVICE_ID;
  const params = { ...input.params, deviceId } as unknown as ControlParams | StartParams;
  const attempt = await newAuthAttempt({ machineId: input.machineId, action: input.action, params });
  const proof = { ephPub: attempt.ephPub, ts: attempt.ts, nonce: attempt.nonce };
  if (method.kind === "passkey") {
    const assertion = await getAssertion({ challenge: attempt.challenge, credentialIds: [method.device.credentialId] });
    return { attempt, deviceId, auth: { kind: "passkey", assertion, ...proof } };
  }
  const code = input.code ?? "";
  if (!isTotpCode(code)) throw new Error("Mã Authenticator gồm 6 chữ số.");
  return { attempt, code, auth: { kind: "totp", code, ...proof } };
}

// ---- Mã vừa dùng ----

/**
 * Máy nhận mỗi mã một lần (lưu bước cuối đã dùng): mã của bước vừa dùng sẽ bị từ chối `TOTP_REPLAY`. Nhớ bước trong bộ
 * nhớ trang để báo "Chờ mã mới" trước khi gửi, như khi vừa mở phiên bằng mã rồi xin quyền gõ ngay.
 */
let lastUsedStep: number | null = null;

export const totpStep = (now: number) => Math.floor(now / 1000 / TOTP.periodSec);

export function markTotpUsed(now: number = Date.now()): void {
  lastUsedStep = totpStep(now);
}

/** Số giây còn phải chờ tới mã mới; 0 khi mã hiện tại chưa dùng. */
export function totpWaitSec(now: number = Date.now()): number {
  if (lastUsedStep === null || totpStep(now) > lastUsedStep) return 0;
  return Math.max(1, Math.ceil(((lastUsedStep + 1) * TOTP.periodSec * 1000 - now) / 1000));
}

/** Chỉ test dùng. */
export function resetTotpUsed(): void {
  lastUsedStep = null;
}

/** Thời gian còn khoá, làm tròn lên phút; null khi không khoá hay đã hết. */
export function lockMinutesLeft(lockedUntil: string | null | undefined, now: number = Date.now()): number | null {
  if (!lockedUntil) return null;
  const ms = Date.parse(lockedUntil) - now;
  return ms > 0 ? Math.ceil(ms / 60_000) : null;
}
