import { type RemoteDevice, type RemoteErrorCode, type RemoteMachine, remoteErrors } from "@xdev-hive/contracts";
import { TERMINAL_CAPABILITY } from "@xdev-hive/contracts/worker-protocol";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { recordAudit } from "../audit/index.ts";
import { sendToMachine } from "../fleet/index.ts";
import { ConflictError, ForbiddenError, NotFoundError, type Tx } from "../platform/index.ts";
import { teamRoleOf } from "../tenancy/index.ts";
import { closeMachineViewers } from "./close.ts";
import { remoteMachine } from "./queries.ts";
import { machineRemoteState, remoteDevices } from "./schema.ts";

/**
 * Thiết bị đã ghép và nút tắt khẩn cấp (specs/010 T021). Hub không có route bật từ xa hay thêm thiết bị (FR-012): chỉ
 * ghép qua mã do máy tạo (`pairing.ts`), gỡ và tắt. Mọi gói tới máy là yêu cầu; worker vẫn tự kiểm và báo lại bằng
 * `term_state`.
 */

export const forbidden = (code: RemoteErrorCode) => new ForbiddenError(code, remoteErrors[code]);
export const conflict = (code: RemoteErrorCode) => new ConflictError(code, remoteErrors[code]);

export interface OwnedMachine {
  id: string;
  name: string;
  teamId: string;
  online: boolean;
  terminal: boolean;
  ownerUserId: string;
}

/**
 * Máy cá nhân mà người gọi là chủ (người đăng ký máy). `teamAdmin` cho quản trị đội của máy qua, chỉ dùng cho tắt khẩn
 * cấp: quản trị dừng được máy của thành viên nhưng không ghép hay gỡ thiết bị thay chủ. Máy lạ báo như máy của người
 * khác để không lộ máy nào tồn tại.
 */
export async function ownedMachine(
  tx: Tx,
  userId: string,
  machineId: string,
  opts: { teamAdmin?: boolean } = {},
): Promise<OwnedMachine> {
  // Bảng máy thuộc fleet; chỉ đọc qua SQL như `machineOwner()`.
  const { rows } = await tx.execute<{
    id: string;
    name: string;
    team_id: string;
    status: string;
    shared: boolean;
    kind: string;
    registered_by: string | null;
    capabilities: string[];
  }>(
    sql`select id, name, team_id, status, shared, kind, registered_by, capabilities from hive.machines
      where id = ${machineId} and revoked_at is null`,
  );
  const m = rows[0];
  if (!m?.registered_by) throw forbidden("MACHINE_NOT_YOURS");
  if (m.registered_by !== userId) {
    const admin = opts.teamAdmin && (await teamRoleOf(tx, userId, m.team_id)) === "admin";
    if (!admin) throw forbidden("MACHINE_NOT_YOURS");
  }
  if (m.shared || m.kind !== "worker") throw forbidden("MACHINE_SHARED");
  return {
    id: m.id,
    name: m.name,
    teamId: m.team_id,
    online: m.status === "online",
    terminal: m.capabilities.includes(TERMINAL_CAPABILITY),
    ownerUserId: m.registered_by,
  };
}

/** Máy phải đang nối với hub và giữ được phiên tương tác thì gói `term_*` mới có người nhận. */
export function requireReachable(m: OwnedMachine): void {
  if (!m.online) throw conflict("MACHINE_OFFLINE");
  if (!m.terminal) throw conflict("MACHINE_NO_TERMINAL");
}

const iso = (d: Date | null) => d?.toISOString() ?? null;

export async function listDevices(tx: Tx, userId: string, machineId: string): Promise<RemoteDevice[]> {
  await ownedMachine(tx, userId, machineId);
  const rows = await tx
    .select()
    .from(remoteDevices)
    .where(and(eq(remoteDevices.machineId, machineId), isNull(remoteDevices.revokedAt)))
    .orderBy(asc(remoteDevices.createdAt), asc(remoteDevices.id));
  return rows.map((d) => ({
    id: d.id,
    label: d.label,
    userId: d.userId,
    synced: d.synced,
    createdAt: iso(d.createdAt),
    lastUsedAt: iso(d.lastUsedAt),
  }));
}

/**
 * Gỡ thiết bị: máy phải online vì quyền nằm ở `remote.json` trên máy; chỉ gạch trên hub thì điện thoại vẫn điều khiển
 * được, người dùng lại tưởng đã gỡ.
 */
export async function revokeDevice(
  tx: Tx,
  userId: string,
  machineId: string,
  deviceId: string,
): Promise<{ machineId: string; deviceId: string }> {
  const m = await ownedMachine(tx, userId, machineId);
  requireReachable(m);
  const [device] = await tx
    .update(remoteDevices)
    .set({ revokedAt: new Date() })
    .where(and(eq(remoteDevices.machineId, machineId), eq(remoteDevices.id, deviceId), isNull(remoteDevices.revokedAt)))
    .returning({ id: remoteDevices.id, label: remoteDevices.label });
  if (!device) throw new NotFoundError("DEVICE_NOT_FOUND", remoteErrors.DEVICE_NOT_FOUND);
  if (!sendToMachine(machineId, { type: "term_device_revoke", deviceId, by: userId }))
    throw conflict("MACHINE_OFFLINE");
  await recordAudit(tx, {
    action: "terminal.device_revoke",
    targetType: "machine",
    targetId: machineId,
    data: { source: "hub", deviceId, label: device.label },
  });
  return { machineId, deviceId };
}

/**
 * Tắt điều khiển từ xa ngay (FR-022). Ghi tắt lên bản sao trước khi máy xác nhận để điện thoại thôi mời mở phiên;
 * `term_state` của máy ghi đè sau đó.
 */
export async function disableRemote(tx: Tx, userId: string, machineId: string): Promise<RemoteMachine> {
  const m = await ownedMachine(tx, userId, machineId, { teamAdmin: true });
  // Worker không có `terminal` thì chưa bao giờ bật được từ xa, và có thể không hiểu gói `term_disable`.
  requireReachable(m);
  if (!sendToMachine(machineId, { type: "term_disable", by: userId })) throw conflict("MACHINE_OFFLINE");
  // Không chờ `term_state` của máy: người xem phải bị đóng trong 2 giây kể cả khi máy chậm báo lại.
  closeMachineViewers(machineId);
  await tx
    .update(machineRemoteState)
    .set({ enabled: false, updatedAt: new Date() })
    .where(eq(machineRemoteState.machineId, machineId));
  await recordAudit(tx, {
    action: "terminal.remote_disable",
    targetType: "machine",
    targetId: machineId,
    data: { source: "hub", ...(m.ownerUserId !== userId ? { ownerUserId: m.ownerUserId } : {}) },
  });
  return remoteMachine(tx, userId, m);
}
