import { randomBytes } from "node:crypto";
import { TERMINAL_TICKET_TTL_SEC, type TerminalServerFrame } from "@xdev-hive/contracts";

/**
 * Trạng thái sống của phiên terminal trong tiến trình hub giữ kết nối worker: bộ đệm vòng output (để trình duyệt nối
 * lại không phải đọc DB), danh sách trình duyệt đang xem và vé WebSocket. Như `fleet/connections.ts`, nhiều tiến trình
 * hub thì mỗi tiến trình chỉ biết phiên của máy nối vào nó (plan 010 D8).
 */

/** Đuôi output giữ trong bộ nhớ mỗi phiên; TUI vẽ lại khi đổi cỡ nên đuôi cộng một lần resize là đủ dựng màn hình. */
export const RING_BYTES = 512 * 1024;

export interface Viewer {
  userId: string;
  canInput: boolean;
  send(frame: TerminalServerFrame): void;
  close(code: number, reason: string): void;
}

export interface LiveSession {
  id: string;
  orgId: string;
  teamId: string;
  machineId: string;
  ownerUserId: string;
  threadId: string | null;
  ring: Array<{ seq: number; data: Buffer }>;
  ringBytes: number;
  viewers: Set<Viewer>;
}

const sessions = new Map<string, LiveSession>();

export function trackSession(s: Omit<LiveSession, "ring" | "ringBytes" | "viewers">): LiveSession {
  const existing = sessions.get(s.id);
  if (existing) return existing;
  const live: LiveSession = { ...s, ring: [], ringBytes: 0, viewers: new Set() };
  sessions.set(s.id, live);
  return live;
}

export function liveSession(id: string): LiveSession | undefined {
  return sessions.get(id);
}

export function liveSessions(): LiveSession[] {
  return [...sessions.values()];
}

/** Phiên đã kết thúc: báo trạng thái cuối cho người xem rồi bỏ bộ đệm (bản ghi vẫn còn trong DB). */
export function untrackSession(id: string): void {
  sessions.delete(id);
}

export function pushOutput(live: LiveSession, seq: number, data: Buffer): void {
  live.ring.push({ seq, data });
  live.ringBytes += data.length;
  while (live.ringBytes > RING_BYTES && live.ring.length > 1) {
    const dropped = live.ring.shift();
    live.ringBytes -= dropped?.data.length ?? 0;
  }
  broadcast(live, { t: "out", seq, data: data.toString("base64") });
}

/** Output sau `after` còn trong bộ đệm; null khi bộ đệm không còn đủ (người gọi đọc DB). */
export function ringAfter(live: LiveSession, after: number): Array<{ seq: number; data: Buffer }> | null {
  const first = live.ring[0];
  if (first && first.seq > after + 1) return null;
  return live.ring.filter((c) => c.seq > after);
}

export function broadcast(live: LiveSession, frame: TerminalServerFrame): void {
  for (const viewer of live.viewers) viewer.send(frame);
}

/** Phiên theo cuộc trò chuyện leader, để đề xuất mới trong cuộc trò chuyện làm mới khung bên phải. */
export function sessionsOfThread(threadId: string): LiveSession[] {
  return liveSessions().filter((s) => s.threadId === threadId);
}

interface Ticket {
  sessionId: string;
  orgId: string;
  userId: string;
  canInput: boolean;
  expiresAt: number;
}

const tickets = new Map<string, Ticket>();

/** Vé dùng một lần cho `/ws/terminal`: trình duyệt lấy qua oRPC (cần phiên web và CSRF) rồi mở WS ngay. */
export function issueTicket(t: Omit<Ticket, "expiresAt">, now = Date.now()): { ticket: string; expiresAt: Date } {
  for (const [key, old] of tickets) if (old.expiresAt <= now) tickets.delete(key);
  const ticket = randomBytes(32).toString("base64url");
  const expiresAt = now + TERMINAL_TICKET_TTL_SEC * 1000;
  tickets.set(ticket, { ...t, expiresAt });
  return { ticket, expiresAt: new Date(expiresAt) };
}

export function consumeTicket(ticket: string, now = Date.now()): Omit<Ticket, "expiresAt"> | null {
  const found = tickets.get(ticket);
  tickets.delete(ticket);
  if (!found || found.expiresAt <= now) return null;
  const { expiresAt: _, ...rest } = found;
  return rest;
}
