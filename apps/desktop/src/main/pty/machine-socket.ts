// The machine's outbound socket to the hub's terminal relay (spec 69 §5, §9): the machine opens it, nothing listens on
// the machine. The machine token goes in the Authorization header of the upgrade only, never in the URL. Lost
// sockets are retried with backoff; the agent's leases keep counting meanwhile, so a long outage still ends the shell.
import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Duplex } from "node:stream";
import { TERMINAL_FRAME_MAX, TERMINAL_MACHINE_SOCKET_PATH, TERMINAL_MACHINE_WS_PROTOCOL, terminalHubFrameSchema } from "@xdev-hive/core";
import { WsPeer } from "@xdev-hive/core/node";
import type { MachineTerminalAgent } from "#desktop/main/pty/relay-agent.ts";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface MachineSocketOptions {
  hubUrl: string;
  token: () => string;
  agent: Pick<MachineTerminalAgent, "connected" | "disconnected" | "receive">;
  log?: (line: string) => void;
  /** Plain http is only for a hub on this machine (spec §9: no terminal over plaintext LAN). */
  allowInsecure?: boolean;
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

export class MachineSocket {
  readonly #o: MachineSocketOptions;
  #peer: WsPeer | null = null;
  #stopped = false;
  #backoff: number;
  #retry: ReturnType<typeof setTimeout> | null = null;

  constructor(o: MachineSocketOptions) {
    this.#o = o;
    this.#backoff = o.minBackoffMs ?? 1000;
  }

  get connected(): boolean { return !!this.#peer && !this.#peer.closed; }

  start(): void {
    this.#stopped = false;
    this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#retry) clearTimeout(this.#retry);
    this.#peer?.close(1001, "stop");
    this.#peer = null;
  }

  #connect(): void {
    if (this.#stopped) return;
    let url: URL;
    try {
      url = new URL(TERMINAL_MACHINE_SOCKET_PATH, this.#o.hubUrl);
    } catch {
      return this.#later();
    }
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && (local || this.#o.allowInsecure))) {
      this.#o.log?.("terminal relay: hub is not https; not connecting");
      return;
    }
    const key = randomBytes(16).toString("base64");
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)({
      host: url.hostname.replace(/^\[|\]$/g, ""), port: url.port || undefined, path: url.pathname, method: "GET",
      headers: {
        connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": key,
        "sec-websocket-protocol": TERMINAL_MACHINE_WS_PROTOCOL, authorization: `Bearer ${this.#o.token()}`,
      },
    });
    req.on("upgrade", (res, socket: Duplex, head: Buffer) => {
      const accept = createHash("sha1").update(key + GUID).digest("base64");
      if (res.headers["sec-websocket-accept"] !== accept || res.headers["sec-websocket-protocol"] !== TERMINAL_MACHINE_WS_PROTOCOL) {
        socket.destroy();
        return this.#later();
      }
      this.#open(socket, head);
    });
    req.on("response", (res) => {
      res.resume();
      // 503: this hub has no relay (or no pinned identity) yet; 403/401: not this machine's token. Both retry slowly.
      this.#o.log?.(`terminal relay: hub answered ${res.statusCode}`);
      this.#backoff = this.#o.maxBackoffMs ?? 30_000;
      this.#later();
    });
    req.on("error", () => this.#later());
    req.end();
  }

  #open(socket: Duplex, head: Buffer): void {
    this.#backoff = this.#o.minBackoffMs ?? 1000;
    const peer = new WsPeer(socket, {
      maxPayload: TERMINAL_FRAME_MAX.machine, server: false,
      onText: (text) => {
        let raw: unknown;
        try { raw = JSON.parse(text); } catch { raw = null; }
        const f = terminalHubFrameSchema.safeParse(raw);
        if (!f.success) return peer.close(1002, "protocol");
        this.#o.agent.receive(f.data);
      },
      onClose: () => {
        if (this.#peer === peer) this.#peer = null;
        this.#o.agent.disconnected();
        this.#later();
      },
    }, head);
    this.#peer = peer;
    this.#o.agent.connected((f) => peer.send(f));
  }

  #later(): void {
    if (this.#stopped || this.#retry) return;
    const wait = this.#backoff;
    this.#backoff = Math.min(this.#backoff * 2, this.#o.maxBackoffMs ?? 30_000);
    this.#retry = setTimeout(() => {
      this.#retry = null;
      this.#connect();
    }, wait);
    this.#retry.unref();
  }
}
