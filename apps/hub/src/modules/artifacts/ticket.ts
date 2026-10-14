import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { MasterKey } from "../platform/index.ts";

/*
 * Vé của khung cách ly (plan.md D6, FR-071): `base64url(payload) "." HMAC-SHA256(key, payload)`. Vé là quyền đọc ngắn
 * hạn của đúng một phiên bản (hay một bản xem trước): route khung không có phiên người dùng (FR-073), nên mọi thứ nó cần
 * để đặt ngữ cảnh tổ chức và tìm nội dung phải nằm trong vé và được ký.
 */

/** Hạn tối đa của vé; lộ vé (lịch sử, log) chỉ lộ đúng bản đó trong chừng này. */
export const FRAME_TICKET_TTL_SEC = 300;
// Đồng hồ của hub có thể bị chỉnh lùi giữa lúc cấp và lúc kiểm; cho lệch chừng này trước khi coi hạn là giả.
const CLOCK_SKEW_SEC = 30;

const theme = z.enum(["light", "dark"]);
const base = { o: z.uuid(), t: theme, e: z.int().positive() };

/** Vé phiên bản (`a` + `v`, kèm `s` khi trang link công khai cấp) hoặc vé bản xem trước (`p`). */
const ticketPayload = z.union([
  z.strictObject({ ...base, a: z.uuid(), v: z.int().min(1), s: z.uuid().optional() }),
  z.strictObject({ ...base, p: z.uuid() }),
]);

export type FrameTicket = z.output<typeof ticketPayload>;
export type FrameTicketInput =
  | { o: string; a: string; v: number; s?: string | undefined; t: "light" | "dark" }
  | { o: string; p: string; t: "light" | "dark" };

/** Nhãn HKDF riêng để khoá vé không thay được khoá mã hoá secret hay khoá nào khác suy từ cùng khoá chủ. */
export function frameTicketKey(master: MasterKey): Buffer {
  return Buffer.from(hkdfSync("sha256", master.key, "", "artifact-frame-v1", 32));
}

export function signFrameTicket(
  key: Buffer,
  input: FrameTicketInput,
  opts: { ttlSec?: number; now?: number } = {},
): { ticket: string; expiresAt: Date } {
  const now = opts.now ?? Date.now();
  const ttl = Math.min(opts.ttlSec ?? FRAME_TICKET_TTL_SEC, FRAME_TICKET_TTL_SEC);
  const e = Math.floor(now / 1000) + ttl;
  // Bỏ khoá undefined để payload là JSON gọn và parse lại đúng strictObject.
  const payload = Buffer.from(JSON.stringify({ ...input, e })).toString("base64url");
  return { ticket: `${payload}.${sign(key, payload)}`, expiresAt: new Date(e * 1000) };
}

/** null khi sai dạng, sai chữ ký hay hết hạn; không nói lý do để vé hỏng không giúp dò được gì. */
export function verifyFrameTicket(key: Buffer, ticket: string, now = Date.now()): FrameTicket | null {
  const parts = ticket.split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts as [string, string];
  const expected = Buffer.from(sign(key, payload), "base64url");
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let parsed: FrameTicket;
  try {
    const result = ticketPayload.safeParse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
    if (!result.success) return null;
    parsed = result.data;
  } catch {
    return null;
  }
  const nowSec = now / 1000;
  if (parsed.e <= nowSec) return null;
  // Vé hub tự ký không bao giờ dài hơn TTL; hạn xa hơn nghĩa là khoá đã lộ hoặc đồng hồ sai, đều không nên tin.
  if (parsed.e > nowSec + FRAME_TICKET_TTL_SEC + CLOCK_SKEW_SEC) return null;
  return parsed;
}

const sign = (key: Buffer, payload: string) => createHmac("sha256", key).update(payload).digest("base64url");
