import { TERMINAL_LIMITS, TERMINAL_SOCKET_PATH, TERMINAL_WS_PROTOCOL, terminalServerFrameSchema, type TerminalClientFrame, type TerminalSession, type TerminalStepUpInput, type TerminalStepUpResult, type TerminalUnavailable, terminalInputs } from "@xdev-hive/core";
import type { z } from "zod";

export interface TerminalAttachment { session: TerminalSession; ticket: string | null; osUser?: string | null }
export interface TerminalApi {
  capabilities(input: z.input<typeof terminalInputs.capabilities>): Promise<{ unavailable: TerminalUnavailable | null; busy: boolean; osUser?: string | null }>;
  create(input: z.input<typeof terminalInputs.create>): Promise<TerminalAttachment>;
  attach(input: z.input<typeof terminalInputs.attach>): Promise<TerminalAttachment>;
  list(project: string): Promise<TerminalSession[]>;
  get(project: string, sessionId: string): Promise<TerminalSession>;
  terminate(sessionId: string): Promise<TerminalSession>;
  recording(input: z.input<typeof terminalInputs.recording>): Promise<{ chunks: Array<{ seq: number; bytes: number; createdAt: string }>; next: number | null }>;
  stepUp(input: TerminalStepUpInput): Promise<TerminalStepUpResult>;
  socket(): WebSocket;
}

export function terminalSecure(url: URL): boolean {
  return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
}

export function terminalSocketUrl(base: string): string {
  const url = new URL(TERMINAL_SOCKET_PATH, base);
  if (!terminalSecure(url)) throw new Error("HTTPS required");
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

/** Split UTF-8 at code point boundaries, so paste never changes command/path normalization. */
export function terminalChunks(text: string, limit: number = TERMINAL_LIMITS.inputFrameBytes): string[] {
  const encoder = new TextEncoder();
  const chunks: string[] = [];
  let chunk = "", bytes = 0;
  for (const char of text) {
    const size = encoder.encode(char).length;
    if (bytes + size > limit) { chunks.push(chunk); chunk = ""; bytes = 0; }
    chunk += char; bytes += size;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

/** xterm's paste line endings, normalized before splitting so CRLF at a boundary remains one Enter. */
export function terminalPasteChunks(text: string): string[] {
  return terminalChunks(text.replace(/\r?\n/g, "\r"), 12 * 1024);
}

export const encodeTerminal = (s: string): string => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
export const decodeTerminal = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const pasteDisplay = (s: string): string => s.replace(/[\x00-\x1f\x7f]/g, c => c === "\n" ? "↵\n" : c === "\r" ? "␍" : c === "\t" ? "⇥" : `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);

/** I/O stays in this instance only. No retry queue, storage, console or telemetry. */
export class TerminalConnection {
  #socket: WebSocket | null = null;
  #timer: ReturnType<typeof setInterval> | undefined;
  #epoch = 0;
  #inputSeq = 0;
  #seen = 0;
  #rendered = 0;
  #active = false;
  #generation = 0;
  #lastFrame = 0;
  #resumed = false;
  readonly handlers: {
    output: (bytes: Uint8Array, rendered: () => void) => void;
    status: (state: TerminalSession["state"] | "connecting" | "disconnected", reason?: string) => void;
    gap: () => void;
  };
  constructor(handlers: TerminalConnection["handlers"]) { this.handlers = handlers; }
  get lastOutputSeq(): number { return this.#rendered; }
  get writable(): boolean { return this.#active && this.#socket?.readyState === 1; }
  get generation(): number { return this.#generation; }
  connect(socket: WebSocket, ticket: string, epoch: number): void {
    this.detach();
    this.#socket = socket; this.#epoch = epoch; this.#inputSeq = 0; this.#lastFrame = Date.now(); this.#resumed = false;
    this.handlers.status("connecting");
    socket.onopen = () => {
      if (this.#socket !== socket) return;
      socket.send(JSON.stringify({ type: "auth", ticket }));
    };
    socket.onmessage = (event) => {
      if (this.#socket !== socket) return;
      let raw: unknown;
      try { raw = JSON.parse(String(event.data)); } catch { socket.close(1002); return; }
      const parsed = terminalServerFrameSchema.safeParse(raw);
      if (!parsed.success) { socket.close(1002); return; }
      this.#lastFrame = Date.now();
      const f = parsed.data;
      if (f.type === "state") {
        this.#active = f.state === "active";
        // Resume after spawn/attach, so an ack cannot arrive before the machine owns the session.
        if (this.#active && !this.#resumed) { this.#resumed = true; this.#send({ type: "ack", outputSeq: this.#rendered }); }
        this.handlers.status(f.state, f.reason);
      } else if (f.type === "gap") {
        this.#seen = this.#rendered = f.firstAvailableSeq - 1;
        this.handlers.gap();
      } else if (f.type === "output") {
        if (f.epoch !== this.#epoch) return;
        if (f.outputSeq <= this.#seen) { this.#send({ type: "ack", outputSeq: this.#rendered }); return; }
        if (f.outputSeq !== this.#seen + 1) { socket.close(1002); return; }
        this.#seen = f.outputSeq;
        this.handlers.output(decodeTerminal(f.data), () => {
          this.#rendered = Math.max(this.#rendered, f.outputSeq);
          // xterm may finish an old socket's queued write after reconnect: acknowledge its render on the new one.
          if (this.#resumed) this.#send({ type: "ack", outputSeq: this.#rendered });
        });
      }
    };
    socket.onclose = () => {
      if (this.#socket !== socket) return;
      this.#active = false;
      clearInterval(this.#timer);
      this.handlers.status("disconnected");
    };
    socket.onerror = () => socket.close();
    this.#timer = setInterval(() => {
      if (Date.now() - this.#lastFrame > TERMINAL_LIMITS.heartbeatTimeoutMs) { socket.close(); return; }
      this.#send({ type: "ping", nonce: `p${Date.now()}` });
    }, TERMINAL_LIMITS.heartbeatMs);
  }
  #send(frame: TerminalClientFrame): boolean {
    if (this.#socket?.readyState !== 1 || this.#socket.bufferedAmount > TERMINAL_LIMITS.inputFrameBytes) return false;
    this.#socket.send(JSON.stringify(frame)); return true;
  }
  input(text: string): boolean {
    if (!this.writable || new TextEncoder().encode(text).length > TERMINAL_LIMITS.inputFrameBytes) return false;
    if (!this.#send({ type: "input", epoch: this.#epoch, inputSeq: this.#inputSeq + 1, data: encodeTerminal(text) })) return false;
    this.#inputSeq++; return true;
  }
  resize(cols: number, rows: number): void {
    if (this.writable) this.#send({ type: "resize", epoch: this.#epoch,
      cols: Math.max(20, Math.min(400, cols)), rows: Math.max(5, Math.min(200, rows)) });
  }
  detach(): void {
    this.#generation++;
    const socket = this.#socket;
    this.#socket = null; this.#active = false; clearInterval(this.#timer);
    socket?.close();
  }
}

export function newTerminalSocket(base: string): WebSocket {
  return new WebSocket(terminalSocketUrl(base), TERMINAL_WS_PROTOCOL);
}
