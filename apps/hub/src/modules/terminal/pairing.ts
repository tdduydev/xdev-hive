import { randomBytes } from "node:crypto";
import {
  REMOTE_LIMITS,
  type RemoteDevice,
  type RemoteErrorCode,
  type RemotePairOptions,
  remoteErrors,
} from "@xdev-hive/contracts";
import type { WorkerToHub } from "@xdev-hive/contracts/worker-protocol";
import type pg from "pg";
import { recordAudit } from "../audit/index.ts";
import { type AuthedMachine, sendToMachine } from "../fleet/index.ts";
import { BadRequestError, ConflictError, ForbiddenError, type Tx, withTenant } from "../platform/index.ts";
import { conflict, forbidden, ownedMachine, requireReachable } from "./devices.ts";
import { remoteDevices } from "./schema.ts";

/**
 * Ghép điện thoại với máy (specs/010 FR-014, plan "Luồng: ghép điện thoại"). Hub chỉ chuyển gói: bí mật ghép nằm trong
 * fragment URL của mã QR nên hub không biết, không giả được tag, và máy vẫn hỏi chủ bấm Cho phép tại máy.
 */

type PairResult = Extract<WorkerToHub, { type: "term_pair_result" }>;

export interface RemoteDeps {
  /** HIVE_REMOTE_TERMINAL: tắt thì không ghép hay mở phiên từ xa; gỡ thiết bị và tắt khẩn cấp vẫn chạy. */
  enabled: boolean;
  publicUrl: string;
  /** Chỉ test đặt ngắn hơn. */
  pairWaitMs?: number;
}

interface PairUser {
  id: string;
  name: string;
  email: string;
}

/** Chờ máy bấm Cho phép (60 s) cộng chút cho đường truyền; máy tự trả `timeout` trước mốc này. */
const PAIR_WAIT_MS = (REMOTE_LIMITS.confirmSec + 10) * 1000;

const waiters = new Map<string, (result: PairResult | null) => void>();
const waiterKey = (machineId: string, pairId: string) => `${machineId}:${pairId}`;

/** Kết quả ghép từ máy: chỉ đánh thức yêu cầu của đúng máy đó; gói lạc (yêu cầu đã hết giờ) thì `term_state` lo. */
export function onPairResult(machine: AuthedMachine, msg: PairResult): void {
  const key = waiterKey(machine.id, msg.pairId);
  const wake = waiters.get(key);
  if (!wake) return;
  waiters.delete(key);
  wake(msg);
}

function awaitPairResult(
  machineId: string,
  pairId: string,
  ms: number,
): { result: Promise<PairResult | null>; cancel: () => void } {
  const key = waiterKey(machineId, pairId);
  // Mã ghép dùng một lần: yêu cầu thứ hai cùng mã trong lúc chờ là dùng lại mã.
  if (waiters.has(key)) throw new BadRequestError("PAIR_EXPIRED", remoteErrors.PAIR_EXPIRED);
  let timer: NodeJS.Timeout | undefined;
  const result = new Promise<PairResult | null>((resolve) => {
    timer = setTimeout(() => {
      waiters.delete(key);
      resolve(null);
    }, ms);
    timer.unref();
    waiters.set(key, (r) => {
      clearTimeout(timer);
      resolve(r);
    });
  });
  const cancel = () => {
    clearTimeout(timer);
    waiters.delete(key);
  };
  return { result, cancel };
}

function requireEnabled(deps: RemoteDeps): void {
  if (!deps.enabled) throw forbidden("REMOTE_DISABLED_HUB");
}

/**
 * Tuỳ chọn tạo passkey. `rp.id` là host của hub (`HIVE_PUBLIC_URL`) vì worker kiểm `rpIdHash` và `origin` theo URL hub
 * nó nối tới. Worker không đọc attestation nên `challenge` chỉ cần ngẫu nhiên. `excludeCredentials` để trống: hub không
 * giữ id passkey (chỉ máy giữ), trình duyệt tạo trùng thì máy vẫn ghép thành thiết bị mới.
 */
export async function pairOptions(
  tx: Tx,
  user: PairUser,
  input: { machineId: string; pairId: string },
  deps: RemoteDeps,
): Promise<RemotePairOptions> {
  requireEnabled(deps);
  const m = await ownedMachine(tx, user.id, input.machineId);
  requireReachable(m);
  return {
    machineName: m.name,
    userId: user.id,
    publicKey: {
      rp: { id: new URL(deps.publicUrl).hostname, name: "xDev Hive" },
      user: { id: Buffer.from(user.id).toString("base64url"), name: user.email, displayName: user.name || user.email },
      challenge: randomBytes(32).toString("base64url"),
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      timeout: REMOTE_LIMITS.confirmSec * 1000,
      authenticatorSelection: { userVerification: "required", residentKey: "preferred" },
      attestation: "none",
      excludeCredentials: [],
    },
  };
}

export interface PairCompleteInput {
  machineId: string;
  pairId: string;
  label: string;
  credentialId: string;
  spki: string;
  tag: string;
  synced: boolean;
}

const DENY: Record<NonNullable<PairResult["reason"]>, RemoteErrorCode> = {
  expired: "PAIR_EXPIRED",
  bad_tag: "PAIR_BAD_TAG",
  denied: "PAIR_DENIED",
  timeout: "PAIR_TIMEOUT",
  user_mismatch: "PAIR_USER_MISMATCH",
  disabled: "REMOTE_NOT_ENABLED",
};

function denyError(code: RemoteErrorCode): Error {
  if (code === "PAIR_DENIED") return new ForbiddenError(code, remoteErrors[code]);
  if (code === "PAIR_TIMEOUT" || code === "REMOTE_NOT_ENABLED") return new ConflictError(code, remoteErrors[code]);
  return new BadRequestError(code, remoteErrors[code]);
}

/**
 * Chuyển `term_pair` tới máy rồi chờ chủ máy bấm Cho phép. Không giữ transaction trong lúc chờ (tới 70 s): kiểm quyền
 * và ghi kết quả là hai transaction ngắn.
 */
export async function pairComplete(
  pool: pg.Pool,
  orgId: string,
  user: PairUser,
  input: PairCompleteInput,
  deps: RemoteDeps,
): Promise<RemoteDevice> {
  requireEnabled(deps);
  const tenant = { userId: user.id, orgId };
  const m = await withTenant(pool, tenant, (tx) => ownedMachine(tx, user.id, input.machineId));
  requireReachable(m);
  const wait = awaitPairResult(m.id, input.pairId, deps.pairWaitMs ?? PAIR_WAIT_MS);
  const sent = sendToMachine(m.id, {
    type: "term_pair",
    pairId: input.pairId,
    userId: user.id,
    label: input.label,
    credentialId: input.credentialId,
    spki: input.spki,
    tag: input.tag,
  });
  if (!sent) {
    wait.cancel();
    throw conflict("MACHINE_OFFLINE");
  }
  const result = await wait.result;
  const code: RemoteErrorCode | null = !result
    ? "PAIR_TIMEOUT"
    : !result.ok || !result.deviceId
      ? DENY[result.reason ?? "denied"]
      : null;
  const now = new Date();
  await withTenant(pool, tenant, async (tx) => {
    if (code || !result?.deviceId) {
      await recordAudit(tx, {
        action: "terminal.pair_denied",
        targetType: "machine",
        targetId: m.id,
        data: { pairId: input.pairId, label: input.label, reason: result?.reason ?? "timeout" },
      });
      return;
    }
    const device = { userId: user.id, label: input.label, synced: input.synced, revokedAt: null };
    await tx
      .insert(remoteDevices)
      .values({ orgId, machineId: m.id, id: result.deviceId, createdAt: now, ...device })
      .onConflictDoUpdate({ target: [remoteDevices.machineId, remoteDevices.id], set: device });
    await recordAudit(tx, {
      action: "terminal.pair",
      targetType: "machine",
      targetId: m.id,
      data: { deviceId: result.deviceId, label: input.label, synced: input.synced },
    });
  });
  if (code || !result?.deviceId) throw denyError(code ?? "PAIR_DENIED");
  return {
    id: result.deviceId,
    label: input.label,
    userId: user.id,
    synced: input.synced,
    createdAt: now.toISOString(),
    lastUsedAt: null,
  };
}
