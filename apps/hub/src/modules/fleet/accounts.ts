import { randomUUID } from "node:crypto";
import type { AccountLogin, AccountLoginStatus, Machine, MachineAccounts } from "@xdev-hive/contracts";
import {
  ACCOUNT_LOGIN_TIMEOUT_SEC,
  type AccountLoginCli,
  type AccountLoginEvent,
  type AccountLoginHow,
} from "@xdev-hive/contracts/worker-protocol";
import { eq } from "drizzle-orm";
import type pg from "pg";
import { recordAudit } from "../audit/index.ts";
import { type Tx, withTenant } from "../platform/index.ts";
import { requireTeamRole } from "../tenancy/index.ts";
import { isConnected, sendToMachine } from "./connections.ts";
import { FleetError } from "./errors.ts";
import { type AuthedMachine, toMachineFor } from "./machines.ts";
import { machines } from "./schema.ts";

/** Capability worker khai khi nhận `account_set` và đăng nhập gói từ web. */
export const ACCOUNTS_REMOTE = "accounts-remote";

type MachineRow = typeof machines.$inferSelect;
type Reason = MachineAccounts["reason"];

/**
 * Vì sao quản trị đội không điều khiển được gói của máy từ web. Máy cá nhân dùng tài khoản riêng của chủ máy (ADR 0017);
 * máy phải đang nối vào tiến trình này để hub chuyển lệnh; worker cũ không hiểu lệnh.
 */
function remoteReason(m: MachineRow): Reason {
  if (!m.shared || m.kind !== "worker") return "personal";
  if (m.status !== "online" || m.pausedAt !== null || !isConnected(m.id)) return "offline";
  if (!m.capabilities.includes(ACCOUNTS_REMOTE)) return "old_worker";
  return null;
}

const REASON_TEXT: Record<NonNullable<Reason>, string> = {
  personal: "Chỉ điều khiển gói từ web trên máy dùng chung; máy cá nhân do chủ máy quản lý tại máy.",
  offline: "Máy đang mất kết nối hoặc tạm dừng.",
  old_worker: "Cập nhật worker để điều khiển gói từ web.",
};

const REASON_CODE: Record<NonNullable<Reason>, string> = {
  personal: "MACHINE_NOT_SHARED",
  offline: "MACHINE_NOT_CONNECTED",
  old_worker: "WORKER_TOO_OLD",
};

/** Máy và quyền quản trị đội sở hữu máy (quản trị tổ chức được coi là quản trị mọi đội). */
async function adminMachine(tx: Tx, userId: string, machineId: string): Promise<MachineRow> {
  const [found] = await tx.select().from(machines).where(eq(machines.id, machineId));
  if (!found || found.status === "revoked")
    throw new FleetError("not_found", "MACHINE_NOT_FOUND", "Không tìm thấy máy.");
  await requireTeamRole(tx, userId, found.teamId, "admin");
  return found;
}

function requireRemote(m: MachineRow): void {
  const reason = remoteReason(m);
  if (reason) throw new FleetError("conflict", REASON_CODE[reason], REASON_TEXT[reason]);
}

export async function listMachineAccounts(tx: Tx, userId: string, machineId: string): Promise<MachineAccounts> {
  const m = await adminMachine(tx, userId, machineId);
  const view = toMachineFor(m, userId);
  const active = sessionOfMachine(m.id);
  return {
    machineId: m.id,
    accounts: view.accounts ?? null,
    accountsAt: view.accountsAt ?? null,
    remote: remoteReason(m) === null,
    reason: remoteReason(m),
    login: active ? toLogin(active) : null,
  };
}

/**
 * Kiểm quyền rồi ghi trước trạng thái bật/tắt vào tóm tắt để web thấy ngay; heartbeat kế của worker ghi đè bằng trạng
 * thái thật. Router gửi `account_set` sau khi commit.
 */
export async function setMachineAccount(
  tx: Tx,
  userId: string,
  input: { machineId: string; accountId: string; enabled: boolean },
): Promise<Machine> {
  const m = await adminMachine(tx, userId, input.machineId);
  requireRemote(m);
  if (m.accounts && !m.accounts.some((a) => a.id === input.accountId))
    throw new FleetError("not_found", "ACCOUNT_NOT_FOUND", "Không tìm thấy gói trên máy.");
  const accounts = m.accounts?.map((a) => (a.id === input.accountId ? { ...a, enabled: input.enabled } : a)) ?? null;
  const [row] = await tx.update(machines).set({ accounts }).where(eq(machines.id, m.id)).returning();
  if (!row) throw new FleetError("not_found", "MACHINE_NOT_FOUND", "Không tìm thấy máy.");
  await recordAudit(tx, {
    action: "machine.account_set",
    targetType: "machine",
    targetId: m.id,
    data: { name: m.name, teamId: m.teamId, accountId: input.accountId, enabled: input.enabled },
  });
  return toMachineFor(row, userId);
}

// ---- Đăng nhập gói từ web (T063) ----

interface LoginSession {
  requestId: string;
  orgId: string;
  machineId: string;
  machineName: string;
  teamId: string;
  cli: AccountLoginCli;
  label: string;
  how: AccountLoginHow;
  status: AccountLoginStatus;
  url: string | null;
  code: string | null;
  needsInput: boolean;
  accountId: string | null;
  error: string | null;
  startedBy: string;
  startedAt: Date;
  expiresAt: Date;
  timer: NodeJS.Timeout;
  pool: pg.Pool;
}

/**
 * Phiên đăng nhập chỉ giữ trong bộ nhớ của tiến trình gateway mà máy đang nối vào, không ghi database: URL và mã thiết
 * bị là bí mật ngắn hạn, mất khi hub khởi động lại cũng không sao (người dùng bấm thêm gói lại). Phiên đã xong giữ
 * thêm một lúc để web kịp đọc kết quả.
 */
const sessions = new Map<string, LoginSession>();
const activeByMachine = new Map<string, string>();
const KEEP_FINISHED_MS = 5 * 60 * 1000;

const finished = (s: LoginSession) => !["starting", "waiting"].includes(s.status);

function sessionOfMachine(machineId: string): LoginSession | undefined {
  const id = activeByMachine.get(machineId);
  return id ? sessions.get(id) : undefined;
}

const toLogin = (s: LoginSession): AccountLogin => ({
  requestId: s.requestId,
  machineId: s.machineId,
  cli: s.cli,
  label: s.label,
  how: s.how,
  status: s.status,
  url: s.url,
  code: s.code,
  needsInput: s.needsInput,
  accountId: s.accountId,
  error: s.error,
  startedBy: s.startedBy,
  startedAt: s.startedAt.toISOString(),
  expiresAt: s.expiresAt.toISOString(),
});

/** Audit bước do worker hoặc hẹn giờ kết thúc phiên: không có người dùng trong context. */
async function auditFinish(s: LoginSession, action: string, data: Record<string, unknown> = {}): Promise<void> {
  await withTenant(s.pool, { orgId: s.orgId }, (tx) =>
    recordAudit(tx, {
      action,
      actorUserId: null,
      targetType: "machine",
      targetId: s.machineId,
      data: { name: s.machineName, teamId: s.teamId, requestId: s.requestId, cli: s.cli, ...data },
    }),
  );
}

function finish(s: LoginSession, status: AccountLoginStatus, patch: Partial<LoginSession> = {}): void {
  Object.assign(s, patch, { status, needsInput: false });
  clearTimeout(s.timer);
  if (activeByMachine.get(s.machineId) === s.requestId) activeByMachine.delete(s.machineId);
  // URL và mã thiết bị hết tác dụng khi phiên xong; xoá để không nằm lại trong bộ nhớ hay câu trả lời.
  s.url = null;
  s.code = null;
  setTimeout(() => sessions.delete(s.requestId), KEEP_FINISHED_MS).unref();
}

async function sessionFor(tx: Tx, userId: string, machineId: string, requestId: string): Promise<LoginSession> {
  const m = await adminMachine(tx, userId, machineId);
  const s = sessions.get(requestId);
  if (!s || s.machineId !== m.id)
    throw new FleetError("not_found", "LOGIN_NOT_FOUND", "Không tìm thấy phiên đăng nhập.");
  return s;
}

const busy = () => new FleetError("conflict", "LOGIN_BUSY", "Máy đang có một phiên đăng nhập gói; huỷ phiên đó trước.");

export interface LoginStartInput {
  machineId: string;
  cli: AccountLoginCli;
  label: string;
  how: AccountLoginHow;
}

/**
 * Bắt đầu đăng nhập gói: kiểm quyền và máy trong transaction (có audit), rồi sau khi commit mới tạo phiên và gửi
 * `account_login_start`, để lỗi database không để lại lệnh đã gửi mà không có dấu vết.
 */
export async function startAccountLogin(
  pool: pg.Pool,
  ctx: { userId: string; orgId: string },
  input: LoginStartInput,
  opts: { timeoutMs?: number } = {},
): Promise<AccountLogin> {
  const requestId = randomUUID();
  const m = await withTenant(pool, ctx, async (tx) => {
    const m = await adminMachine(tx, ctx.userId, input.machineId);
    requireRemote(m);
    if (sessionOfMachine(m.id)) throw busy();
    await recordAudit(tx, {
      action: "machine.account_login.start",
      targetType: "machine",
      targetId: m.id,
      data: { name: m.name, teamId: m.teamId, requestId, cli: input.cli, how: input.how, label: input.label },
    });
    return m;
  });
  // Không có await giữa lần kiểm này và lúc ghi phiên, nên hai yêu cầu cùng lúc không cùng lọt.
  if (sessionOfMachine(m.id)) throw busy();
  const timeoutMs = opts.timeoutMs ?? ACCOUNT_LOGIN_TIMEOUT_SEC * 1000;
  const now = new Date();
  const s: LoginSession = {
    requestId,
    orgId: ctx.orgId,
    machineId: m.id,
    machineName: m.name,
    teamId: m.teamId,
    cli: input.cli,
    label: input.label,
    how: input.how,
    status: "starting",
    url: null,
    code: null,
    needsInput: false,
    accountId: null,
    error: null,
    startedBy: ctx.userId,
    startedAt: now,
    expiresAt: new Date(now.getTime() + timeoutMs),
    timer: setTimeout(() => expire(s), timeoutMs),
    pool,
  };
  s.timer.unref();
  sessions.set(requestId, s);
  activeByMachine.set(m.id, requestId);
  const sent = sendToMachine(m.id, {
    type: "account_login_start",
    requestId,
    cli: input.cli,
    label: input.label,
    how: input.how,
  });
  if (!sent) {
    finish(s, "error", { error: "Máy vừa ngắt kết nối khỏi hub; thử lại khi máy nối lại." });
    await auditFinish(s, "machine.account_login.error", { reason: "not_connected" });
  }
  return toLogin(s);
}

function expire(s: LoginSession): void {
  if (finished(s)) return;
  sendToMachine(s.machineId, { type: "account_login_cancel", requestId: s.requestId });
  finish(s, "expired", { error: "Hết thời gian đăng nhập (10 phút)." });
  auditFinish(s, "machine.account_login.expired").catch((error: unknown) =>
    console.error("Không ghi được audit đăng nhập gói", error),
  );
}

export async function getAccountLogin(
  tx: Tx,
  userId: string,
  input: { machineId: string; requestId: string },
): Promise<AccountLogin> {
  return toLogin(await sessionFor(tx, userId, input.machineId, input.requestId));
}

/**
 * Kiểm quyền và ghi audit (không có chữ người dùng dán). Trả hàm gửi để router gọi sau khi commit: chữ dán chỉ đi thẳng
 * xuống worker, không nằm trong phiên, database hay log.
 */
export async function inputAccountLogin(
  tx: Tx,
  userId: string,
  input: { machineId: string; requestId: string },
): Promise<{ send: (text: string) => AccountLogin }> {
  const s = await sessionFor(tx, userId, input.machineId, input.requestId);
  if (finished(s)) throw new FleetError("conflict", "LOGIN_FINISHED", "Phiên đăng nhập đã kết thúc.");
  if (!s.needsInput)
    throw new FleetError("conflict", "LOGIN_NOT_WAITING", "Máy chưa chờ mã; đợi trang đăng nhập hiện ra.");
  await recordAudit(tx, {
    action: "machine.account_login.input",
    targetType: "machine",
    targetId: s.machineId,
    data: { name: s.machineName, teamId: s.teamId, requestId: s.requestId, cli: s.cli },
  });
  return {
    send: (text) => {
      if (finished(s)) throw new FleetError("conflict", "LOGIN_FINISHED", "Phiên đăng nhập đã kết thúc.");
      if (!sendToMachine(s.machineId, { type: "account_login_input", requestId: s.requestId, text }))
        throw new FleetError("conflict", "MACHINE_NOT_CONNECTED", "Máy vừa ngắt kết nối khỏi hub; thử lại sau.");
      // Chờ worker báo bước kế (done, error hoặc nhắc nhập lại).
      s.needsInput = false;
      return toLogin(s);
    },
  };
}

export async function cancelAccountLogin(
  tx: Tx,
  userId: string,
  input: { machineId: string; requestId: string },
): Promise<{ commit: () => AccountLogin }> {
  const s = await sessionFor(tx, userId, input.machineId, input.requestId);
  if (!finished(s)) {
    await recordAudit(tx, {
      action: "machine.account_login.cancel",
      targetType: "machine",
      targetId: s.machineId,
      data: { name: s.machineName, teamId: s.teamId, requestId: s.requestId, cli: s.cli },
    });
  }
  return {
    commit: () => {
      if (!finished(s)) {
        sendToMachine(s.machineId, { type: "account_login_cancel", requestId: s.requestId });
        finish(s, "cancelled");
      }
      return toLogin(s);
    },
  };
}

/** Chỉ nhận URL https để web không mở lược đồ khác (javascript:, file:) do worker lỗi gửi lên. */
function safeUrl(text: string): string | null {
  try {
    const url = new URL(text.trim());
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Gói `account_login_event` của worker. Phiên của máy khác hoặc đã xong thì bỏ qua. */
export async function onAccountLoginEvent(machine: AuthedMachine, msg: AccountLoginEvent): Promise<void> {
  const s = sessions.get(msg.requestId);
  if (!s || s.machineId !== machine.id || finished(s)) return;
  switch (msg.kind) {
    case "url": {
      const url = safeUrl(msg.text);
      if (url) Object.assign(s, { url, status: "waiting" });
      return;
    }
    case "code":
      if (/^[A-Za-z0-9-]{4,64}$/.test(msg.text.trim())) Object.assign(s, { code: msg.text.trim(), status: "waiting" });
      return;
    case "prompt":
      Object.assign(s, { needsInput: true, status: "waiting" });
      return;
    case "done":
      finish(s, "done", { accountId: msg.accountId ?? null });
      return auditFinish(s, "machine.account_login.done", { accountId: msg.accountId ?? null });
    case "error":
      finish(s, "error", { error: msg.text.slice(0, 500) || "Đăng nhập không thành công." });
      return auditFinish(s, "machine.account_login.error", { error: msg.text.slice(0, 500) });
  }
}

/** Máy mất kết nối: worker đã huỷ phiên phía nó, nên kết thúc phiên ở hub để người dùng thử lại. */
export async function onMachineDisconnected(machineId: string): Promise<void> {
  const s = sessionOfMachine(machineId);
  if (!s || finished(s)) return;
  finish(s, "error", { error: "Máy mất kết nối giữa chừng; thử lại khi máy nối lại." });
  await auditFinish(s, "machine.account_login.error", { reason: "disconnected" });
}

/** Chỉ dùng trong test: xoá mọi phiên. */
export function resetAccountLogins(): void {
  for (const s of sessions.values()) clearTimeout(s.timer);
  sessions.clear();
  activeByMachine.clear();
}
