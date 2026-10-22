import { randomUUID } from "node:crypto";
import { REMOTE_LIMITS, type RemoteSession, type RemoteStartInput, remoteErrors } from "@xdev-hive/contracts";
import { TERM_DENY_MESSAGES, type TermDenyCode, TOTP_DEVICE_ID } from "@xdev-hive/contracts/terminal-auth";
import type { WorkerToHub } from "@xdev-hive/contracts/worker-protocol";
import type pg from "pg";
import { recordAudit } from "../audit/index.ts";
import { type AuthedMachine, sendToMachine } from "../fleet/index.ts";
import { loadPolicy, resolveModel, resolvePermission } from "../governance/index.ts";
import { BadRequestError, ConflictError, ForbiddenError, withTenant } from "../platform/index.ts";
import { machineRemoteDisabled } from "./close.ts";
import { conflict, forbidden, ownedMachine, requireReachable } from "./devices.ts";
import type { RemoteDeps } from "./pairing.ts";
import { getRemoteSession } from "./queries.ts";

/**
 * Mở phiên mới trên máy cá nhân từ điện thoại (specs/010 US4, T051). Hub chỉ chuyển `term_start` có chữ ký của thiết bị
 * (hay mã TOTP) và gắn model, mức quyền theo chính sách tổ chức; worker tự kiểm chữ ký, thư mục, CLI và có thể hỏi chủ
 * máy tại máy. Route chờ `term_opened`/`term_denied` cùng `requestId` để trả phiên (hay lỗi) ngay trong một lần gọi.
 */

type Denied = Extract<WorkerToHub, { type: "term_denied" }>;
type StartResult = { kind: "opened"; sessionId: string } | { kind: "denied"; code: TermDenyCode };

/** Máy có thể hỏi chủ bấm Cho phép (60 s) trước khi mở; cộng chút cho đường truyền, máy tự trả `CONFIRM_TIMEOUT` trước. */
const START_WAIT_MS = (REMOTE_LIMITS.confirmSec + 10) * 1000;

const waiters = new Map<string, (result: StartResult) => void>();
const waiterKey = (machineId: string, requestId: string) => `${machineId}:${requestId}`;

function wake(machine: AuthedMachine, requestId: string, result: StartResult): void {
  const key = waiterKey(machine.id, requestId);
  const done = waiters.get(key);
  if (!done) return;
  waiters.delete(key);
  done(result);
}

/** Chỉ đánh thức yêu cầu của đúng máy gửi gói: máy khác cùng tổ chức đoán được `requestId` cũng không trả lời thay. */
export function onStartOpened(machine: AuthedMachine, requestId: string, sessionId: string): void {
  wake(machine, requestId, { kind: "opened", sessionId });
}

export function onStartDenied(machine: AuthedMachine, msg: Denied): void {
  wake(machine, msg.requestId, { kind: "denied", code: msg.code });
}

function awaitStart(machineId: string, requestId: string, ms: number) {
  const key = waiterKey(machineId, requestId);
  let timer: NodeJS.Timeout | undefined;
  const result = new Promise<StartResult | null>((resolve) => {
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

const AUTH_CODES = /^(AUTH_|ASSERTION_|DEVICE_|TOTP_|CONFIRM_DENIED$|MACHINE_SHARED$)/;
const INPUT_CODES = new Set<TermDenyCode>(["ROOT_MISSING", "ROOT_ESCAPE", "CLI_MISSING"]);

/** Mã của máy giữ nguyên để web phân nhánh (TOTP_LOCKED, TOTP_REPLAY…); câu lấy từ hub, không chuyển chữ tự do của máy. */
function denyError(code: TermDenyCode): Error {
  const message = TERM_DENY_MESSAGES[code];
  if (AUTH_CODES.test(code)) return new ForbiddenError(code, message);
  if (INPUT_CODES.has(code)) return new BadRequestError(code, message);
  return new ConflictError(code, message);
}

export interface StartUser {
  id: string;
}

/**
 * Kiểm quyền và chính sách trong một transaction ngắn, chờ máy ngoài transaction (tới 70 s), rồi ghi kết quả. Lỗi do hub
 * chặn cũng ghi audit `terminal.deny` ở transaction riêng vì ném lỗi trong `withTenant` sẽ huỷ dòng audit.
 */
export async function startRemoteSession(
  pool: pg.Pool,
  orgId: string,
  user: StartUser,
  input: RemoteStartInput,
  deps: RemoteDeps & { startWaitMs?: number },
): Promise<RemoteSession> {
  if (!deps.enabled) throw forbidden("REMOTE_DISABLED_HUB");
  const tenant = { userId: user.id, orgId };
  const totp = input.auth.kind === "totp";
  // Passkey gắn với thiết bị đã ghép; mã TOTP thì không, nên dùng mã cố định như khung `control` (challenge chứa nó).
  const deviceId = totp ? (input.deviceId ?? TOTP_DEVICE_ID) : input.deviceId;
  if (!deviceId) throw new BadRequestError("DEVICE_NOT_FOUND", remoteErrors.DEVICE_NOT_FOUND);

  const checked = await withTenant(pool, tenant, async (tx) => {
    const m = await ownedMachine(tx, user.id, input.machineId);
    requireReachable(m);
    const policy = await loadPolicy(tx);
    let blocked: "REMOTE_NOT_ENABLED" | "TOTP_NOT_ALLOWED" | null = null;
    if (await machineRemoteDisabled(tx, m.id)) blocked = "REMOTE_NOT_ENABLED";
    else if (totp && !policy.remote.totpFallback) blocked = "TOTP_NOT_ALLOWED";
    return {
      machine: m,
      blocked,
      model: resolveModel(policy, input.cli, null).model,
      // Máy chỉ hạ `full` về `workspace` khi chưa cho toàn quyền tại máy, không bao giờ nâng.
      permissions: resolvePermission(policy, policy.defaultPermissionMode).mode,
    };
  });
  const m = checked.machine;
  const base = { machineId: m.id, deviceId, cli: input.cli, rootId: input.rootId, auth: input.auth.kind };
  const audit = (action: string, data: Record<string, unknown>) =>
    withTenant(pool, tenant, (tx) => recordAudit(tx, { action, targetType: "machine", targetId: m.id, data }));

  if (checked.blocked) {
    await audit("terminal.deny", { ...base, code: checked.blocked });
    throw checked.blocked === "TOTP_NOT_ALLOWED" ? forbidden(checked.blocked) : conflict(checked.blocked);
  }

  const requestId = randomUUID();
  const wait = awaitStart(m.id, requestId, deps.startWaitMs ?? START_WAIT_MS);
  const sent = sendToMachine(m.id, {
    type: "term_start",
    requestId,
    userId: user.id,
    deviceId,
    cli: input.cli,
    ...(input.accountId ? { accountId: input.accountId } : {}),
    rootId: input.rootId,
    ...(input.subdir ? { subdir: input.subdir } : {}),
    ...(checked.model ? { model: checked.model } : {}),
    permissions: checked.permissions,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.prompt ? { prompt: input.prompt } : {}),
    cols: input.cols,
    rows: input.rows,
    auth: input.auth,
  });
  if (!sent) {
    wait.cancel();
    throw conflict("MACHINE_OFFLINE");
  }
  const result = await wait.result;
  const request = { ...base, requestId };

  if (!result) {
    await audit("terminal.deny", { ...request, code: "START_TIMEOUT" });
    throw conflict("START_TIMEOUT");
  }
  if (result.kind === "denied") {
    await audit("terminal.deny", { ...request, code: result.code });
    // Lần thử mã bị từ chối vì điều kiện của máy (thư mục, CLI) không phải mã sai; chỉ các mã xác thực mới là totp_fail.
    if (totp && result.code.startsWith("TOTP_")) await audit("terminal.totp_fail", { ...request, code: result.code });
    throw denyError(result.code);
  }
  // `terminal.open` đã ghi khi nhận `term_opened` (record.ts, có `requestId`); ở đây chỉ ghi lần dùng mã thành công.
  if (totp) await audit("terminal.totp_ok", { ...request, sessionId: result.sessionId });
  const session = await withTenant(pool, tenant, (tx) => getRemoteSession(tx, user.id, result.sessionId)).catch(
    () => null,
  );
  if (!session) {
    // Hub không ghi phiên (đủ số phiên ghi của máy): điện thoại không xem được nên đóng thay vì để CLI chạy không ai lái.
    sendToMachine(m.id, { type: "term_close", sessionId: result.sessionId, reason: "Hub không ghi được phiên này." });
    throw denyError("BUSY");
  }
  return session;
}
