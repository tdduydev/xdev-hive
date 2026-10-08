// The part of RFC 6455 the terminal relay speaks, on both ends (hub and machine): text frames of JSON, ping/pong and
// close. No extensions, no fragmentation, no binary: a peer that sends one is broken or hostile and the socket closes.
// Lengths are checked before a payload is buffered, so a peer cannot make the other side hold a large frame.
import { randomBytes } from "node:crypto";

const UTF8 = new TextDecoder("utf-8", { fatal: true });

export const WS_OP = { text: 1, binary: 2, close: 8, ping: 9, pong: 10 } as const;

export interface WsMessage { opcode: number; payload: Buffer }

/** Encodes one final frame. A client masks (RFC 6455 §5.3), a server never does. */
export function encodeWsFrame(opcode: number, payload: Buffer | string, masked: boolean): Buffer {
  const body = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  const n = body.length;
  const head = n < 126 ? Buffer.from([0x80 | opcode, (masked ? 0x80 : 0) | n])
    : n < 65_536 ? Buffer.from([0x80 | opcode, (masked ? 0x80 : 0) | 126, n >> 8, n & 0xff])
    : (() => {
        const b = Buffer.alloc(10);
        b[0] = 0x80 | opcode;
        b[1] = (masked ? 0x80 : 0) | 127;
        b.writeBigUInt64BE(BigInt(n), 2);
        return b;
      })();
  if (!masked) return Buffer.concat([head, body]);
  const mask = randomBytes(4);
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) out[i] = body[i]! ^ mask[i % 4]!;
  return Buffer.concat([head, mask, out]);
}

export function encodeWsClose(code: number, reason: string, masked: boolean): Buffer {
  const text = Buffer.from(reason, "utf8").subarray(0, 123);
  const body = Buffer.alloc(2 + text.length);
  body.writeUInt16BE(code, 0);
  text.copy(body, 2);
  return encodeWsFrame(WS_OP.close, body, masked);
}

/**
 * Splits a byte stream into whole frames. `expectMasked` is the direction: a server reads masked client frames and
 * refuses unmasked ones; a client reads unmasked server frames. Returns "invalid" once and keeps returning it.
 */
export class WsReader {
  #buf: Buffer = Buffer.alloc(0);
  #bad = false;
  readonly #max: number;
  readonly #masked: boolean;
  constructor(maxPayload: number, expectMasked: boolean) {
    this.#max = maxPayload;
    this.#masked = expectMasked;
  }

  push(chunk: Buffer): WsMessage[] | "invalid" {
    if (this.#bad) return "invalid";
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : chunk;
    const out: WsMessage[] = [];
    for (;;) {
      const r = this.#one();
      if (r === "invalid") {
        this.#bad = true;
        this.#buf = Buffer.alloc(0);
        return "invalid";
      }
      if (!r) return out;
      out.push(r);
    }
  }

  #one(): WsMessage | null | "invalid" {
    const b = this.#buf;
    if (b.length < 2) return null;
    const fin = (b[0]! & 0x80) !== 0;
    const opcode = b[0]! & 0x0f;
    const masked = (b[1]! & 0x80) !== 0;
    if (b[0]! & 0x70 || !fin || masked !== this.#masked || ![WS_OP.text, WS_OP.close, WS_OP.ping, WS_OP.pong].includes(opcode as 1)) return "invalid";
    let len = b[1]! & 0x7f;
    let off = 2;
    if (len === 126) {
      if (b.length < 4) return null;
      len = b.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (b.length < 10) return null;
      const big = b.readBigUInt64BE(2);
      if (big > BigInt(this.#max)) return "invalid";
      len = Number(big);
      off = 10;
    }
    // Control frames are at most 125 bytes (§5.5).
    if (len > this.#max || (opcode >= 8 && len > 125)) return "invalid";
    const maskLen = masked ? 4 : 0;
    if (b.length < off + maskLen + len) return null;
    const payload = Buffer.alloc(len);
    if (masked) {
      const mask = b.subarray(off, off + 4);
      for (let i = 0; i < len; i++) payload[i] = b[off + 4 + i]! ^ mask[i % 4]!;
    } else b.copy(payload, 0, off, off + len);
    this.#buf = b.subarray(off + maskLen + len);
    return { opcode, payload };
  }
}

export interface WsPeerOptions {
  maxPayload: number;
  /** Server side: frames from the peer are masked, ours are not. */
  server: boolean;
  onText: (text: string) => void;
  onClose: (code: number | null) => void;
  /** Bytes queued in the socket beyond which the peer is dropped: a reader that stopped reading cannot grow our memory. */
  maxQueuedBytes?: number;
}

/** One WebSocket over an upgraded socket. Close is idempotent and onClose fires exactly once. */
export class WsPeer {
  readonly socket: import("node:stream").Duplex;
  #reader: WsReader;
  #o: WsPeerOptions;
  #closed = false;

  constructor(socket: import("node:stream").Duplex, o: WsPeerOptions, head?: Buffer) {
    this.socket = socket;
    this.#o = o;
    this.#reader = new WsReader(o.maxPayload, o.server);
    socket.on("data", (c: Buffer) => this.#data(c));
    socket.on("close", () => this.#gone(null));
    // An http server's sockets are half-open: the peer's FIN is only "end", and "close" would wait for ours.
    socket.on("end", () => {
      socket.end();
      this.#gone(null);
    });
    socket.on("error", () => this.#gone(null));
    if (head?.length) queueMicrotask(() => this.#data(head));
  }

  get closed(): boolean { return this.#closed; }

  send(value: unknown): boolean {
    if (this.#closed) return false;
    this.socket.write(encodeWsFrame(WS_OP.text, JSON.stringify(value), !this.#o.server));
    if (this.socket.writableLength > (this.#o.maxQueuedBytes ?? 8 * 1024 * 1024)) {
      this.socket.destroy();
      this.#gone(null);
      return false;
    }
    return true;
  }

  close(code: number, reason: string): void {
    if (this.#closed) return;
    try { this.socket.end(encodeWsClose(code, reason, !this.#o.server)); } catch { this.socket.destroy(); }
    // A peer that never answers the close does not keep the socket.
    setTimeout(() => this.socket.destroy(), 2000).unref();
    this.#gone(code);
  }

  #data(chunk: Buffer): void {
    if (this.#closed) return;
    const msgs = this.#reader.push(chunk);
    if (msgs === "invalid") return this.close(1002, "protocol");
    for (const m of msgs) {
      if (this.#closed) return;
      if (m.opcode === WS_OP.text) {
        let text: string;
        // Invalid UTF-8 is not what the peer meant, so not JSON we act on (RFC 6455 §8.1: close with 1007).
        try { text = UTF8.decode(m.payload); } catch { return this.close(1007, "utf8"); }
        this.#o.onText(text);
      } else if (m.opcode === WS_OP.ping) this.socket.write(encodeWsFrame(WS_OP.pong, m.payload, !this.#o.server));
      else if (m.opcode === WS_OP.close) return this.close(m.payload.length >= 2 ? m.payload.readUInt16BE(0) : 1000, "");
    }
  }

  #gone(code: number | null): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#o.onClose(code);
  }
}
