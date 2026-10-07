// The bit of RFC 6455 the terminal's socket needs before any terminal byte flows: the handshake, one client frame
// (the ticket) and a close. The relay of 69e brings the rest; nothing here buffers more than one small frame.
import { createHash } from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** A Sec-WebSocket-Key a client may send: 16 random bytes in base64. */
export const validKey = (key: unknown): key is string => typeof key === "string" && /^[A-Za-z0-9+/]{22}==$/.test(key);

export function handshake(key: string, protocol: string): string {
  const accept = createHash("sha1").update(key + GUID).digest("base64");
  return ["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${accept}`, `Sec-WebSocket-Protocol: ${protocol}`, "", ""].join("\r\n");
}

export interface WsFrame { fin: boolean; opcode: number; payload: Buffer }

/**
 * The client frame at the start of buf: null while it is incomplete, "invalid" for what a client must never send
 * (an unmasked frame, reserved bits no extension was agreed for, a payload over maxPayload). The length is checked
 * before the payload arrives, so a client cannot make the hub wait for a large one.
 */
export function readFrame(buf: Buffer, maxPayload: number): { frame: WsFrame; rest: Buffer } | null | "invalid" {
  if (buf.length < 2) return null;
  if (buf[0]! & 0x70 || !(buf[1]! & 0x80)) return "invalid";
  let len = buf[1]! & 0x7f;
  let off = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    off = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    const big = buf.readBigUInt64BE(2);
    if (big > BigInt(maxPayload)) return "invalid";
    len = Number(big);
    off = 10;
  }
  if (len > maxPayload) return "invalid";
  if (buf.length < off + 4 + len) return null;
  const mask = buf.subarray(off, off + 4);
  const payload = Buffer.alloc(len);
  for (let i = 0; i < len; i++) payload[i] = buf[off + 4 + i]! ^ mask[i % 4]!;
  return { frame: { fin: (buf[0]! & 0x80) !== 0, opcode: buf[0]! & 0x0f, payload }, rest: buf.subarray(off + 4 + len) };
}

/** A server close frame (unmasked); the reason is a short code word, never what was refused. */
export function closeFrame(code: number, reason = ""): Buffer {
  const text = Buffer.from(reason, "utf8").subarray(0, 123);
  return Buffer.concat([Buffer.from([0x88, 2 + text.length, code >> 8, code & 0xff]), text]);
}
