import type { Tx } from "../platform/index.ts";
import { effectivePermissions } from "../tenancy/index.ts";

/** Quyền mở terminal Leader: quản trị đội (và quản trị tổ chức) có sẵn, BA/PO qua vai trò `team-ba` hay vai trò tự tạo. */
export const TERMINAL_PERMISSION = "leader.terminal";

/**
 * Người dùng mở được terminal Leader cho dự án của đội này. Kiểm lại mỗi lần cổng MCP nhận token của phiên và định kỳ
 * khi phiên đang chạy: mất vai trò là mất phiên.
 */
export async function canOpenTerminal(tx: Tx, userId: string, teamId: string): Promise<boolean> {
  return (await effectivePermissions(tx, userId, teamId)).has(TERMINAL_PERMISSION);
}
