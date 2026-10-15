import { randomBytes } from "node:crypto";
import { TERMINAL_TICKET_TTL_SEC } from "@xdev-hive/contracts";

/**
 * Vé dùng một lần cho `/ws/terminal`: trình duyệt lấy qua oRPC (cần phiên web và CSRF) rồi mở WS ngay. Hai loại vé đi
 * chung đường nhưng không bao giờ thay nhau: vé Leader (`terminal.ticket`) chỉ mở phiên `origin = 'hub'`, vé từ xa
 * (`remote.ticket`) chỉ mở phiên trên máy cá nhân, để quyền của bên này không lọt sang bên kia.
 */

export interface LeaderTicket {
  kind: "leader";
  sessionId: string;
  orgId: string;
  userId: string;
  canInput: boolean;
}

export interface RemoteTicket {
  kind: "remote";
  sessionId: string;
  orgId: string;
  userId: string;
  /** Chủ máy, phiên cho điều khiển từ xa, hub bật `HIVE_REMOTE_TERMINAL`; vẫn phải qua passkey/TOTP ở worker. */
  canControl: boolean;
}

export type Ticket = LeaderTicket | RemoteTicket;

/**
 * Vé từ xa mang tiền tố để hub biết loại vé cả khi vé đã dùng hay hết hạn: kết nối từ xa nhận mã đóng 4401 (điện thoại
 * xin vé mới ngay) mà vé Leader vẫn bị từ chối ở bước bắt tay như trước. Tiền tố không lộ gì; phần ngẫu nhiên vẫn 256 bit.
 */
const REMOTE_PREFIX = "r.";

const tickets = new Map<string, Ticket & { expiresAt: number }>();

function issue(t: Ticket, prefix: string, now: number): { ticket: string; expiresAt: Date } {
  for (const [key, old] of tickets) if (old.expiresAt <= now) tickets.delete(key);
  const ticket = prefix + randomBytes(32).toString("base64url");
  const expiresAt = now + TERMINAL_TICKET_TTL_SEC * 1000;
  tickets.set(ticket, { ...t, expiresAt });
  return { ticket, expiresAt: new Date(expiresAt) };
}

export function issueTicket(t: Omit<LeaderTicket, "kind">, now = Date.now()): { ticket: string; expiresAt: Date } {
  return issue({ kind: "leader", ...t }, "", now);
}

export function issueRemoteTicket(
  t: Omit<RemoteTicket, "kind">,
  now = Date.now(),
): { ticket: string; expiresAt: Date } {
  return issue({ kind: "remote", ...t }, REMOTE_PREFIX, now);
}

export const isRemoteTicket = (ticket: string): boolean => ticket.startsWith(REMOTE_PREFIX);

/** Vé bị xoá ngay lần dùng đầu, kể cả khi hết hạn hay Origin sai sau đó. */
export function consumeTicket(ticket: string, now = Date.now()): Ticket | null {
  const found = tickets.get(ticket);
  tickets.delete(ticket);
  if (!found || found.expiresAt <= now) return null;
  const { expiresAt: _, ...rest } = found;
  return rest;
}
