import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { PROTOCOL_VERSION, type WorkerToHub, workerToHub } from "@xdev-hive/contracts/worker-protocol";
import type pg from "pg";
import { type WebSocket, WebSocketServer } from "ws";
import type { Jobs } from "../platform/index.ts";
import { registerConnection, sendToMachine, unregisterConnection } from "./connections.ts";
import { type AuthedMachine, authenticateMachine, markOffline, markOnline } from "./machines.ts";

export const WORKER_WS_PATH = "/ws/worker";

/** Mã đóng kết nối (dải 4000–4999 dành cho ứng dụng). Worker đọc mã để biết nên nối lại hay dừng. */
export const CLOSE = {
  badMessage: 4400,
  revoked: 4401,
  machineMismatch: 4403,
  timeout: 4408,
  protocolUnsupported: 4426,
} as const;

type Heartbeat = Extract<WorkerToHub, { type: "heartbeat" }>;
type Hello = Extract<WorkerToHub, { type: "hello" }>;
export type RunMessage = Exclude<WorkerToHub, { type: "hello" | "heartbeat" }>;

/** Xử lý gói của run. Module runs đăng ký qua registerRunHandlers; fleet không import runs. */
export interface RunHandlers {
  /** Máy vừa qua bước hello (online, có slot trống): cơ hội giao run đang chờ. */
  onHello?: (machine: AuthedMachine, msg: Hello) => Promise<void>;
  /** Gia hạn lease và lấy lệnh huỷ cho heartbeat. */
  onHeartbeat?: (machine: AuthedMachine, msg: Heartbeat) => Promise<{ renewed: string[]; cancel: string[] }>;
  /** Gói của run (job_accept, run_event, log_chunk…). */
  onMessage?: (machine: AuthedMachine, msg: RunMessage) => Promise<void>;
}

let registered: RunHandlers = {};

/**
 * Đăng ký xử lý gói của run cho mọi gateway trong tiến trình. Trả hàm gỡ đăng ký (dùng trong test). Option truyền
 * thẳng vào attachWorkerGateway thắng handler đăng ký ở đây.
 */
export function registerRunHandlers(handlers: RunHandlers): () => void {
  registered = handlers;
  return () => {
    if (registered === handlers) registered = {};
  };
}

export interface GatewayOptions {
  /** Pool của role hive_app. */
  pool: pg.Pool;
  jobs?: Jobs | undefined;
  publicUrl?: string | undefined;
  offlineNotifySec?: number | undefined;
  heartbeatSec?: number;
  /** Thời gian chờ gói hello sau khi nâng cấp kết nối. */
  helloTimeoutMs?: number;
  /**
   * Gia hạn lease và lấy lệnh huỷ cho heartbeat. Bỏ trống thì dùng handler đăng ký qua registerRunHandlers; không có
   * handler nào thì không gia hạn lease nào, vì hub chưa giao run nào.
   */
  onHeartbeat?: RunHandlers["onHeartbeat"];
  /** Gói của run (job_accept, run_event, log_chunk…). Không có handler thì bỏ qua. */
  onMessage?: RunHandlers["onMessage"];
  onHello?: RunHandlers["onHello"];
  logger?: Pick<Console, "info" | "warn" | "error">;
}

/**
 * Gắn WSS /ws/worker vào server HTTP của @hono/node-server. Xác thực bằng machine token trong header Authorization
 * trước khi nâng cấp, để kết nối không hợp lệ bị từ chối bằng 401 thay vì mở rồi mới đóng.
 */
export function attachWorkerGateway(server: Server, opts: GatewayOptions): { close: () => Promise<void> } {
  const log = opts.logger ?? console;
  const heartbeatSec = opts.heartbeatSec ?? 30;
  // Không nhận gói nào trong ba chu kỳ heartbeat thì coi máy đã mất (kết nối TCP có thể treo mà không báo đóng).
  const idleMs = heartbeatSec * 3 * 1000;
  const helloTimeoutMs = opts.helloTimeoutMs ?? 10_000;
  // Gói lớn nhất là log_chunk (~1 MB base64); chặn trên để worker lỗi không làm hub hết bộ nhớ.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = new URL(req.url ?? "/", "http://hub").pathname;
    if (path !== WORKER_WS_PATH) return;
    socket.on("error", () => socket.destroy());
    const token = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "")?.[1];
    if (!token) return reject(socket, 401, "Thiếu machine token.");
    authenticateMachine(opts.pool, token).then(
      (machine) => {
        if (!machine) return reject(socket, 401, "Machine token không hợp lệ hoặc đã bị thu hồi.");
        wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, machine));
      },
      (error: unknown) => {
        log.error("Lỗi xác thực worker", error);
        reject(socket, 500, "Hub lỗi khi xác thực máy.");
      },
    );
  };

  const onConnection = (ws: WebSocket, machine: AuthedMachine) => {
    let session: string | undefined;
    let idle: NodeJS.Timeout | undefined;
    const helloTimer = setTimeout(() => ws.close(CLOSE.timeout, "Không nhận được hello"), helloTimeoutMs);
    const touch = () => {
      clearTimeout(idle);
      idle = setTimeout(() => ws.close(CLOSE.timeout, "Mất heartbeat"), idleMs);
    };
    // Xử lý tuần tự từng gói của một kết nối để giữ thứ tự (hello trước heartbeat, run_event theo seq).
    let queue = Promise.resolve();

    const handle = async (raw: string) => {
      let msg: WorkerToHub;
      try {
        msg = workerToHub.parse(JSON.parse(raw));
      } catch {
        return ws.close(CLOSE.badMessage, "Gói tin không hợp lệ");
      }
      if (!session) {
        if (msg.type !== "hello") return ws.close(CLOSE.badMessage, "Cần gửi hello trước");
        clearTimeout(helloTimer);
        if (msg.machineId !== machine.name) return ws.close(CLOSE.machineMismatch, "machineId không khớp token");
        if ((msg.runnerMode ?? "worker") !== machine.kind) {
          return ws.close(CLOSE.machineMismatch, "Chế độ runner không khớp loại máy đã đăng ký");
        }
        const [lo, hi] = msg.protoRange;
        // Chưa có kênh phát hành worker để gửi upgrade_required (cần url, sha256, chữ ký), nên đóng kèm mã riêng.
        if (lo > PROTOCOL_VERSION || hi < PROTOCOL_VERSION) {
          return ws.close(CLOSE.protocolUnsupported, `Hub dùng giao thức v${PROTOCOL_VERSION}`);
        }
        const { os, version, clis, capacity, capabilities } = msg;
        // Worker cũ không báo dự án đã gắn: xoá danh sách của lần nối trước, vì bản cũ không còn áp công tắc của máy.
        const projects = { boundProjects: msg.localProjects?.bound ?? [], fullProjects: msg.localProjects?.full ?? [] };
        if (!(await markOnline(opts.pool, machine, { os, version, clis, capacity, capabilities, ...projects }))) {
          return ws.close(CLOSE.revoked, "Máy đã bị thu hồi");
        }
        if (ws.readyState !== ws.OPEN) return;
        session = randomUUID();
        registerConnection(machine.id, ws);
        sendToMachine(machine.id, { type: "welcome", sessionId: session, heartbeatSec });
        log.info(`Máy ${machine.name} (${machine.id}) đã kết nối, phiên ${session}`);
        touch();
        await (opts.onHello ?? registered.onHello)?.(machine, msg);
        return;
      }
      touch();
      switch (msg.type) {
        case "hello":
          return ws.close(CLOSE.badMessage, "Đã gửi hello rồi");
        case "heartbeat": {
          const projects = msg.localProjects && {
            boundProjects: msg.localProjects.bound,
            fullProjects: msg.localProjects.full,
          };
          if (!(await markOnline(opts.pool, machine, projects))) return ws.close(CLOSE.revoked, "Máy đã bị thu hồi");
          const onHeartbeat = opts.onHeartbeat ?? registered.onHeartbeat;
          const { renewed, cancel } = (await onHeartbeat?.(machine, msg)) ?? { renewed: [], cancel: [] };
          sendToMachine(machine.id, { type: "heartbeat_ack", renewed, cancel });
          return;
        }
        default:
          await (opts.onMessage ?? registered.onMessage)?.(machine, msg);
      }
    };

    ws.on("message", (data, isBinary) => {
      if (isBinary) return ws.close(CLOSE.badMessage, "Chỉ nhận gói văn bản JSON");
      const raw = data.toString();
      queue = queue.then(() =>
        handle(raw).catch((error: unknown) => {
          log.error(`Lỗi xử lý gói từ máy ${machine.id}`, error);
          ws.close(1011, "Hub lỗi khi xử lý gói");
        }),
      );
    });
    ws.on("close", () => {
      clearTimeout(helloTimer);
      clearTimeout(idle);
      if (!session || !unregisterConnection(machine.id, ws)) return;
      // Đợi các gói đang xử lý xong để markOffline không bị một heartbeat chạy sau ghi đè thành online.
      queue = queue.then(() =>
        markOffline(opts.pool, machine, { jobs: opts.jobs, notifyAfterSec: opts.offlineNotifySec }).catch(
          (error: unknown) => log.error("Không ghi được máy offline", error),
        ),
      );
    });
    ws.on("error", (error) => log.warn(`Kết nối của máy ${machine.id} lỗi`, error));
  };

  server.on("upgrade", onUpgrade);
  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.off("upgrade", onUpgrade);
        for (const ws of wss.clients) ws.close(1001, "Hub đang tắt");
        wss.close(() => resolve());
      }),
  };
}

function reject(socket: Duplex, status: 401 | 500, message: string) {
  const body = Buffer.from(message);
  const reason = status === 401 ? "Unauthorized" : "Internal Server Error";
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
  );
}
