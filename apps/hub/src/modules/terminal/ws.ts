import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import {
  TERMINAL_WS_CLOSE,
  TERMINAL_WS_PATH,
  type TerminalClientFrame,
  type TerminalServerFrame,
  terminalClientFrame,
} from "@xdev-hive/contracts";
import type pg from "pg";
import { type WebSocket, WebSocketServer } from "ws";
import { sendToMachine } from "../fleet/index.ts";
import { onLeaderActivity } from "../leader/index.ts";
import { withTenant } from "../platform/index.ts";
import { consumeTicket, type LiveSession, liveSession, ringAfter, sessionsOfThread, type Viewer } from "./live.ts";
import { startRoleSweep } from "./mcp-tokens.ts";
import { loadSession, readChunks, sessionView } from "./service.ts";

/**
 * Giới hạn gõ mỗi kết nối: dán một đoạn dài vẫn qua (đệm 64 KiB), nhưng một trang không làm ngập kênh worker (chung
 * với run) bằng cách gửi liên tục. Bị chặn nhiều lần liền thì đóng 4429.
 */
const INPUT_RATE_BYTES = 32 * 1024;
const INPUT_BURST_BYTES = 64 * 1024;
const FRAME_RATE = 200;
const DROPS_BEFORE_CLOSE = 50;

class Bucket {
  readonly #rate: number;
  readonly #burst: number;
  #tokens: number;
  #at: number;
  constructor(rate: number, burst: number, now = Date.now()) {
    this.#rate = rate;
    this.#burst = burst;
    this.#tokens = burst;
    this.#at = now;
  }
  take(n: number, now = Date.now()): boolean {
    this.#tokens = Math.min(this.#burst, this.#tokens + ((now - this.#at) / 1000) * this.#rate);
    this.#at = now;
    if (this.#tokens < n) return false;
    this.#tokens -= n;
    return true;
  }
}

export interface TerminalGatewayOptions {
  pool: pg.Pool;
  /** HIVE_PUBLIC_URL: Origin bằng origin này hoặc trùng Host của request (cùng nguồn) mới được nối. */
  publicUrl?: string | undefined;
  logger?: Pick<Console, "info" | "warn" | "error">;
  sweepMs?: number;
}

/** Origin phải là trang của chính hub: chặn trang khác mở WS bằng cookie của người dùng (CSWSH). */
export function originAllowed(origin: string | undefined, host: string | undefined, publicUrl?: string): boolean {
  if (!origin) return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (publicUrl && parsed.origin === new URL(publicUrl).origin) return true;
  return host !== undefined && parsed.host === host;
}

/** Gắn `/ws/terminal` vào server HTTP của hub, cùng cách `/ws/worker`. */
export function attachTerminalGateway(server: Server, opts: TerminalGatewayOptions): { close: () => Promise<void> } {
  const log = opts.logger ?? console;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://hub");
    if (url.pathname !== TERMINAL_WS_PATH) return;
    socket.on("error", () => socket.destroy());
    // Dùng vé trước khi xét Origin: vé lọt sang trang lạ bị đốt luôn, không còn dùng lại được từ trang của hub.
    const ticket = consumeTicket(url.searchParams.get("ticket") ?? "");
    if (!originAllowed(req.headers.origin, req.headers.host, opts.publicUrl)) return reject(socket, 403);
    if (!ticket) return reject(socket, 401);
    wss.handleUpgrade(req, socket, head, (ws) => {
      onConnection(ws, ticket).catch((error: unknown) => {
        log.error("Lỗi mở kết nối terminal", error);
        ws.close(1011, "Hub lỗi khi mở phiên");
      });
    });
  };

  const onConnection = async (ws: WebSocket, ticket: NonNullable<ReturnType<typeof consumeTicket>>) => {
    const send = (frame: TerminalServerFrame) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
    };
    const row = await withTenant(opts.pool, { orgId: ticket.orgId, userId: ticket.userId }, (tx) =>
      loadSession(tx, ticket.sessionId),
    );
    if (!row) return ws.close(TERMINAL_WS_CLOSE.notFound, "Không tìm thấy phiên");
    send({ t: "hello", session: sessionView(row, ticket.userId), canInput: ticket.canInput });
    const live = liveSession(row.id);
    const viewer: Viewer = {
      userId: ticket.userId,
      canInput: ticket.canInput,
      send,
      close: (code, reason) => ws.close(code, reason),
    };
    live?.viewers.add(viewer);
    const bytes = new Bucket(INPUT_RATE_BYTES, INPUT_BURST_BYTES);
    const frames = new Bucket(FRAME_RATE, FRAME_RATE);
    let drops = 0;

    const onFrame = async (frame: TerminalClientFrame) => {
      switch (frame.t) {
        case "ping":
          return send({ t: "pong" });
        case "resume":
          return replay(opts.pool, ticket, live, frame.after, send);
        case "resize":
          if (!viewer.canInput || !live) return;
          sendToMachine(live.machineId, {
            type: "term_resize",
            sessionId: live.id,
            cols: frame.cols,
            rows: frame.rows,
          });
          return;
        case "in": {
          if (!viewer.canInput || !live || !liveSession(live.id)) {
            return send({
              t: "error",
              code: "TERMINAL_READ_ONLY",
              message: "Chỉ chủ phiên được gõ vào phiên đang chạy.",
            });
          }
          const size = Math.ceil((frame.data.length * 3) / 4);
          if (!frames.take(1) || !bytes.take(size)) {
            drops++;
            if (drops >= DROPS_BEFORE_CLOSE) return ws.close(TERMINAL_WS_CLOSE.rateLimited, "Gõ quá nhanh");
            return send({ t: "error", code: "TERMINAL_RATE_LIMITED", message: "Gõ quá nhanh, phím vừa rồi bị bỏ." });
          }
          drops = 0;
          sendToMachine(live.machineId, { type: "term_input", sessionId: live.id, data: frame.data });
          return;
        }
      }
    };

    let queue = Promise.resolve();
    ws.on("message", (data, isBinary) => {
      if (isBinary) return ws.close(1003, "Chỉ nhận khung JSON");
      let frame: TerminalClientFrame;
      try {
        frame = terminalClientFrame.parse(JSON.parse(data.toString()));
      } catch {
        return send({ t: "error", code: "TERMINAL_BAD_FRAME", message: "Khung không hợp lệ." });
      }
      queue = queue.then(() => onFrame(frame)).catch((error: unknown) => log.error("Lỗi xử lý khung terminal", error));
    });
    ws.on("close", () => live?.viewers.delete(viewer));
    ws.on("error", (error) => log.warn("Kết nối terminal của trình duyệt lỗi", error));
  };

  const offActivity = onLeaderActivity((threadId) => {
    for (const live of sessionsOfThread(threadId)) for (const v of live.viewers) v.send({ t: "activity" });
  });
  const stopSweep = startRoleSweep(opts.pool, opts.sweepMs);
  server.on("upgrade", onUpgrade);
  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.off("upgrade", onUpgrade);
        offActivity();
        stopSweep();
        for (const ws of wss.clients) ws.close(1001, "Hub đang tắt");
        wss.close(() => resolve());
      }),
  };
}

/** Gửi lại output sau `after`: từ bộ đệm vòng nếu còn, không thì từ bản ghi (phiên đã đóng hay bộ đệm đã trôi). */
async function replay(
  pool: pg.Pool,
  ticket: { orgId: string; userId: string; sessionId: string },
  live: LiveSession | undefined,
  after: number,
  send: (frame: TerminalServerFrame) => void,
) {
  const fromRing = live ? ringAfter(live, after) : null;
  if (fromRing) {
    for (const c of fromRing) send({ t: "out", seq: c.seq, data: c.data.toString("base64") });
    return;
  }
  let cursor = after;
  for (;;) {
    const page = await withTenant(pool, { orgId: ticket.orgId, userId: ticket.userId }, (tx) =>
      readChunks(tx, ticket.sessionId, cursor, 200),
    );
    for (const c of page.chunks) send({ t: "out", seq: c.seq, data: c.data });
    const last = page.chunks.at(-1);
    if (!page.more || !last) return;
    cursor = last.seq;
  }
}

function reject(socket: Duplex, status: 401 | 403) {
  const body = Buffer.from(status === 401 ? "Vé terminal không hợp lệ hoặc đã hết hạn." : "Nguồn không được phép.");
  const reason = status === 401 ? "Unauthorized" : "Forbidden";
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
  );
}
