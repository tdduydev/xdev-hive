import { type RemoteSession, remoteErrors, TERMINAL_WS_CLOSE } from "@xdev-hive/contracts";
import { eq } from "drizzle-orm";
import { recordAudit } from "../audit/index.ts";
import { isConnected, sendToMachine } from "../fleet/index.ts";
import { ConflictError, NotFoundError, type Tx } from "../platform/index.ts";
import { teamRoleOf } from "../tenancy/index.ts";
import { liveSessions } from "./live.ts";
import { remoteRow, remoteView } from "./queries.ts";
import { machineRemoteState } from "./schema.ts";

/**
 * Ngắt phiên và đóng người xem khi tắt từ xa (specs/010 T041, FR-022, FR-024). Hub chỉ gửi yêu cầu: worker kết thúc
 * tiến trình rồi báo `term_exit`, nên trạng thái trả về vẫn là "đang chạy" tới khi gói đó tới.
 */

const ACTIVE: ReadonlyArray<RemoteSession["state"]> = ["opening", "running"];

// Không lấy từ devices.ts: devices.ts gọi `closeMachineViewers` ở đây.
const conflict = (code: "SESSION_ENDED" | "MACHINE_OFFLINE") => new ConflictError(code, remoteErrors[code]);
const notFound = () => new NotFoundError("SESSION_NOT_FOUND", remoteErrors.SESSION_NOT_FOUND);

/**
 * Chủ phiên hoặc quản trị đội của máy (FR-024). Quản trị ngắt được cả phiên riêng tư nhưng vẫn không đọc được nội dung;
 * người khác nhận như phiên không tồn tại để không lộ mã phiên.
 */
export async function closeRemoteSession(tx: Tx, userId: string, id: string): Promise<RemoteSession> {
  const r = await remoteRow(tx, id);
  if (!r) throw notFound();
  const owner = r.owner_user_id === userId;
  if (!owner && (await teamRoleOf(tx, userId, r.team_id)) !== "admin") throw notFound();
  if (!ACTIVE.includes(r.state)) throw conflict("SESSION_ENDED");
  if (!isConnected(r.machine_id)) throw conflict("MACHINE_OFFLINE");
  if (!sendToMachine(r.machine_id, { type: "term_close", sessionId: id, reason: "user", by: userId })) {
    throw conflict("MACHINE_OFFLINE");
  }
  await recordAudit(tx, {
    action: "terminal.close",
    targetType: "terminal_session",
    targetId: id,
    data: { source: "hub", machineId: r.machine_id, ...(owner ? {} : { ownerUserId: r.owner_user_id }) },
  });
  return remoteView(r, userId);
}

/**
 * Tắt từ xa (web, app, khay hay `hive remote off`): bỏ mọi quyền gõ hub đang nhớ và đóng mọi người xem phiên trên máy
 * này. Worker tự thu quyền và kết thúc phiên mở từ xa, nhưng không biết người xem trên hub nên hub phải tự đóng.
 */
export function closeMachineViewers(machineId: string): number {
  let closed = 0;
  for (const live of liveSessions()) {
    if (live.machineId !== machineId) continue;
    live.remote.grants.clear();
    live.remote.controller = live.remote.controller === "remote" ? null : live.remote.controller;
    for (const viewer of [...live.viewers]) {
      const conn = viewer.remote;
      if (!conn) continue;
      if (conn.granted) conn.send({ t: "revoked", reason: "disabled" });
      conn.granted = false;
      conn.pendingDeviceId = null;
      conn.canControl = false;
      viewer.close(TERMINAL_WS_CLOSE.forbidden, "Chủ máy đã tắt điều khiển từ xa.");
      closed++;
    }
  }
  return closed;
}

/** Máy chưa từng báo `term_state` thì hub không biết, để worker quyết; chỉ chặn sớm khi máy đã báo tắt. */
export async function machineRemoteDisabled(tx: Tx, machineId: string): Promise<boolean> {
  const [s] = await tx
    .select({ enabled: machineRemoteState.enabled })
    .from(machineRemoteState)
    .where(eq(machineRemoteState.machineId, machineId));
  return s !== undefined && !s.enabled;
}
