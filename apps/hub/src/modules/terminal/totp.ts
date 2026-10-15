import { TERMINAL_CAPABILITY } from "@xdev-hive/contracts/worker-protocol";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { disconnectMachine, isConnected } from "../fleet/index.ts";
import { loadPolicy, type RemotePolicyHook } from "../governance/index.ts";
import { type Tx, withTenant } from "../platform/index.ts";

/**
 * Đường lui bằng mã Authenticator khi hub chạy HTTP (specs/010 D15, T027). Khoá TOTP chỉ nằm trên máy: hub không có
 * route nhận hay lưu khoá, mã trong khung `control` chỉ được chuyển tiếp tới worker, không ghi DB hay log. Chính sách tổ
 * chức chỉ tắt được; bật thì worker vẫn theo cài đặt tại máy.
 */

/** Mã đóng 1012 (service restart): worker nối lại ngay và nhận `welcome` mới, phiên trên máy vẫn chạy. */
const CLOSE_RECONNECT = 1012;

export async function totpAllowed(pool: pg.Pool, orgId: string): Promise<boolean> {
  return (await withTenant(pool, { orgId }, (tx) => loadPolicy(tx))).remote.totpFallback;
}

/** Máy cá nhân có phiên tương tác trong tổ chức hiện tại: những máy nhận `welcome.policy` (xem `welcomeFor`). */
async function personalTerminalMachines(tx: Tx): Promise<string[]> {
  const { rows } = await tx.execute<{ id: string }>(
    sql`select id from hive.machines
        where kind = 'worker' and not shared and registered_by is not null and revoked_at is null
          and ${TERMINAL_CAPABILITY} = any(capabilities)`,
  );
  return rows.map((r) => r.id);
}

/**
 * Đổi chính sách thì cho máy đang nối nối lại để nhận `welcome.policy` mới. Không chờ máy nối lại mới có hiệu lực: hub
 * đã chặn TOTP ngay ở khung `control` theo chính sách mới.
 */
export const remotePolicyHook: RemotePolicyHook = {
  machines: personalTerminalMachines,
  refresh(machineIds) {
    for (const id of machineIds)
      if (isConnected(id)) disconnectMachine(id, CLOSE_RECONNECT, "Chính sách điều khiển từ xa đã đổi");
  },
};

type TotpSnapshot = { enabled: boolean; lockedUntil: Date | null };

/**
 * Audit TOTP theo `term_state` (chủ máy bật/tắt tại máy, máy tự khoá khi nhập sai quá nhiều). Lần thử mã thành công hay
 * sai ghi ở `ws.ts` vì gói cấp/từ chối mang `connId` của người thử.
 */
export async function auditTotpState(
  prev: TotpSnapshot | null,
  next: TotpSnapshot,
  now: Date,
  audit: (action: string, data: Record<string, unknown>) => Promise<unknown>,
): Promise<void> {
  const was = prev?.enabled ?? false;
  if (!was && next.enabled) await audit("terminal.totp_enroll", {});
  if (was && !next.enabled) await audit("terminal.totp_disable", {});
  const lockedBefore = prev?.lockedUntil != null && prev.lockedUntil > now;
  if (next.lockedUntil && !lockedBefore) {
    await audit("terminal.totp_locked", { lockedUntil: next.lockedUntil.toISOString() });
  }
}
