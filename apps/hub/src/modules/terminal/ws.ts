import { randomBytes } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import {
  REMOTE_LIMITS,
  type RemoteClientFrame,
  type RemoteErrorCode,
  type RemoteServerFrame,
  type RemoteSession,
  remoteClientFrame,
  remoteErrors,
  TERMINAL_WS_CLOSE,
  TERMINAL_WS_PATH,
  type TerminalClientFrame,
  type TerminalServerFrame,
  terminalClientFrame,
} from "@xdev-hive/contracts";
import { type RemoteAuth, TERM_DENY_MESSAGES, termDenyCode } from "@xdev-hive/contracts/terminal-auth";
import { and, eq } from "drizzle-orm";
import type pg from "pg";
import { type WebSocket, WebSocketServer } from "ws";
import { recordAudit } from "../audit/index.ts";
import {
  type AuthedMachine,
  isConnected,
  type registerTerminalHandlers,
  sendToMachine,
  type TerminalHandlers,
  type TerminalMessage,
} from "../fleet/index.ts";
import { onLeaderActivity } from "../leader/index.ts";
import { notify } from "../notify/index.ts";
import { NotFoundError, type Tx, withTenant } from "../platform/index.ts";
import { machineRemoteDisabled } from "./close.ts";
import {
  Bucket,
  consumeTicket,
  findConn,
  findGrant,
  isRemoteTicket,
  issueRemoteTicket,
  type LiveSession,
  liveSession,
  RemoteConn,
  remoteConns,
  ringAfter,
  sessionsOfThread,
  type Ticket,
  trackSession,
  type Viewer,
} from "./live.ts";
import { startRoleSweep } from "./mcp-tokens.ts";
import { getRemoteSession } from "./queries.ts";
import { machineOwner, personal } from "./record.ts";
import { remoteDevices, terminalSessions } from "./schema.ts";
import { loadSession, readChunks, sessionView } from "./service.ts";

/**
 * Giới hạn gõ mỗi kết nối: dán một đoạn dài vẫn qua (đệm 64 KiB), nhưng một trang không làm ngập kênh worker (chung
 * với run) bằng cách gửi liên tục. Bị chặn nhiều lần liền thì đóng 4429.
 */
const INPUT_RATE_BYTES = 32 * 1024;
const INPUT_BURST_BYTES = 64 * 1024;
const FRAME_RATE = 200;
const DROPS_BEFORE_CLOSE = 50;

/** Trang đọc bản ghi khi phát lại; nhỏ để người xem chậm được kiểm đệm gửi giữa hai trang. */
const REPLAY_PAGE = 200;

type LeaderTicket = Extract<Ticket, { kind: "leader" }>;
type RemoteTicket = Extract<Ticket, { kind: "remote" }>;

export interface TerminalGatewayOptions {
  pool: pg.Pool;
  /** HIVE_PUBLIC_URL: Origin bằng origin này hoặc trùng Host của request (cùng nguồn) mới được nối. */
  publicUrl?: string | undefined;
  /** HIVE_REMOTE_TERMINAL: tắt thì vẫn xem được phiên máy cá nhân nhưng không xin quyền gõ. */
  remoteEnabled?: boolean;
  logger?: Pick<Console, "info" | "warn" | "error">;
  sweepMs?: number;
  /** Chỉ test đặt ngắn hơn `REMOTE_LIMITS.heartbeatSec`. */
  heartbeatMs?: number;
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

const ACTIVE: ReadonlyArray<RemoteSession["state"]> = ["opening", "running"];

/**
 * `term_control` bắt buộc `deviceId` nhưng mã TOTP không gắn với thiết bị nào: hub điền mã cố định này, worker bỏ qua nó
 * khi kiểm TOTP và chỉ dùng để so lúc nối lại bằng `resumeToken`.
 */
export const TOTP_DEVICE_ID = "totp-code";

/** Chủ máy theo hub (người đăng ký máy cá nhân): chỉ người này được xin quyền gõ, kể cả khi phiên cho đội xem. */
async function isMachineOwner(tx: Tx, userId: string, machineId: string): Promise<boolean> {
  const m = await machineOwner(tx, machineId);
  return personal(m) && m.ownerUserId === userId;
}

/**
 * Vì sao chủ máy chưa xin quyền gõ được; null khi được. Passkey/TOTP vẫn do worker kiểm. `machineOff`: máy đã báo tắt
 * từ xa (`term_state`), không xin để khỏi chờ worker từ chối.
 */
export function remoteControlBlock(
  s: RemoteSession,
  owner: boolean,
  enabled: boolean,
  machineOff = false,
): RemoteErrorCode | null {
  if (!owner) return "MACHINE_NOT_YOURS";
  if (!enabled) return "REMOTE_DISABLED_HUB";
  if (machineOff) return "REMOTE_NOT_ENABLED";
  if (!ACTIVE.includes(s.state)) return "SESSION_ENDED";
  if (!s.remote) return "SESSION_NOT_REMOTE";
  return null;
}

/** Route `remote.ticket`: vé xem dùng một lần; quyền gõ xin sau trong WS bằng khung `control`. */
export async function remoteTicket(
  tx: Tx,
  userId: string,
  orgId: string,
  id: string,
  deps: { enabled: boolean },
): Promise<{ ticket: string; expiresAt: string; canControl: boolean }> {
  const s = await getRemoteSession(tx, userId, id);
  const owner = s.isOwner && (await isMachineOwner(tx, userId, s.machineId));
  const off = await machineRemoteDisabled(tx, s.machineId);
  const canControl = remoteControlBlock(s, owner, deps.enabled, off) === null;
  const { ticket, expiresAt } = issueRemoteTicket({ sessionId: s.id, orgId, userId, canControl });
  return { ticket, expiresAt: expiresAt.toISOString(), canControl };
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
    const raw = url.searchParams.get("ticket") ?? "";
    const ticket = consumeTicket(raw);
    if (!originAllowed(req.headers.origin, req.headers.host, opts.publicUrl)) return reject(socket, 403);
    if (!ticket) {
      // Trang từ xa nhận mã đóng thay vì lỗi bắt tay (trình duyệt không cho đọc mã HTTP) để biết mà xin vé mới.
      if (!isRemoteTicket(raw)) return reject(socket, 401);
      return wss.handleUpgrade(req, socket, head, (ws) =>
        ws.close(TERMINAL_WS_CLOSE.unauthorized, "Vé không hợp lệ hoặc đã hết hạn"),
      );
    }
    wss.handleUpgrade(req, socket, head, (ws) =>
      ticket.kind === "remote" ? onRemoteConnection(ws, ticket) : onConnection(ws, ticket),
    );
  };

  const onConnection = (ws: WebSocket, ticket: LeaderTicket) => {
    const send = (frame: TerminalServerFrame) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
    };
    const viewer: Viewer = {
      userId: ticket.userId,
      canInput: ticket.canInput,
      send,
      close: (code, reason) => ws.close(code, reason),
    };
    let live: LiveSession | undefined;
    let closed = false;
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

    // Khung đầu tiên (resume, phím) có thể tới ngay khi mở, trước lúc hub đọc xong phiên: gắn handler ngay và xếp mọi
    // khung sau bước dựng, nếu không ws bỏ mất các khung tới khi chưa có listener.
    let queue: Promise<unknown> = (async () => {
      const row = await withTenant(opts.pool, { orgId: ticket.orgId, userId: ticket.userId }, (tx) =>
        loadSession(tx, ticket.sessionId),
      );
      if (!row) return ws.close(TERMINAL_WS_CLOSE.notFound, "Không tìm thấy phiên");
      send({ t: "hello", session: sessionView(row, ticket.userId), canInput: ticket.canInput });
      live = liveSession(row.id);
      if (!closed) live?.viewers.add(viewer);
    })().catch((error: unknown) => {
      log.error("Lỗi mở kết nối terminal", error);
      ws.close(1011, "Hub lỗi khi mở phiên");
    });
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
    ws.on("close", () => {
      closed = true;
      live?.viewers.delete(viewer);
    });
    ws.on("error", (error) => log.warn("Kết nối terminal của trình duyệt lỗi", error));
  };

  /**
   * Kết nối xem phiên trên máy cá nhân. Hub chỉ chuyển tiếp: worker kiểm passkey/TOTP và HMAC từng gói nhập, nên hub
   * không cần (và không được) tự cấp quyền gõ; nó chỉ chặn sớm người không phải chủ máy.
   */
  const onRemoteConnection = (ws: WebSocket, ticket: RemoteTicket) => {
    const tenant = { orgId: ticket.orgId, userId: ticket.userId };
    const connId = randomBytes(16).toString("base64url");
    const send = (frame: RemoteServerFrame) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
    };
    const error = (code: RemoteErrorCode | "TERMINAL_READ_ONLY" | "TERMINAL_RATE_LIMITED" | "TERMINAL_BAD_FRAME") =>
      send({ t: "error", code, message: ERROR_TEXT[code] });
    let conn: RemoteConn | undefined;
    let viewer: Viewer | undefined;
    let session: RemoteSession | undefined;
    let block: RemoteErrorCode | null = "SESSION_NOT_FOUND";
    let closed = false;
    const bytes = new Bucket(INPUT_RATE_BYTES, INPUT_BURST_BYTES);
    const frames = new Bucket(FRAME_RATE, FRAME_RATE);
    let drops = 0;

    const current = () => liveSession(ticket.sessionId);
    const readPage = (after: number) =>
      withTenant(opts.pool, tenant, (tx) => readChunks(tx, ticket.sessionId, after, REPLAY_PAGE));

    const detach = () => {
      if (!conn || (!conn.granted && !conn.pendingDeviceId)) return;
      conn.granted = false;
      conn.pendingDeviceId = null;
      const live = current();
      // Worker giữ quyền chờ `resumeToken` cùng hạn này; hub nhớ để biết thiết bị nào được nối lại.
      if (live) {
        const until = Date.now() + REMOTE_LIMITS.resumeSec * 1000;
        for (const g of live.remote.grants.values()) if (g.connId === connId) g.expiresAt = until;
      }
      sendToMachine(conn.machineId, { type: "term_detach", sessionId: ticket.sessionId, connId });
    };

    // Ghi audit khi cỡ đổi thật, không ghi mỗi khung: xoay điện thoại hay kéo bàn phím gửi nhiều resize liền nhau.
    let lastSize = "";
    const auditResize = (cols: number, rows: number) => {
      const size = `${cols}x${rows}`;
      if (size === lastSize || !session) return;
      lastSize = size;
      const s = session;
      withTenant(opts.pool, tenant, (tx) =>
        recordAudit(tx, {
          action: "terminal.resize",
          targetType: "terminal_session",
          targetId: s.id,
          data: { connId, machineId: s.machineId, cols, rows },
        }),
      ).catch((e: unknown) => log.error("Không ghi được audit đổi cỡ terminal", e));
    };

    const forward = (frame: Extract<RemoteClientFrame, { t: "in" | "resize" }>) => {
      if (!conn || !session) return;
      if (!conn.granted) return error("TERMINAL_READ_ONLY");
      const size = frame.t === "in" ? Math.ceil((frame.data.length * 3) / 4) : 0;
      if (!frames.take(1) || !bytes.take(size)) {
        drops++;
        if (drops >= DROPS_BEFORE_CLOSE) return ws.close(TERMINAL_WS_CLOSE.rateLimited, "Gõ quá nhanh");
        return error("TERMINAL_RATE_LIMITED");
      }
      drops = 0;
      const proof = { connId, seq: frame.seq, mac: frame.mac };
      if (frame.t === "in") {
        sendToMachine(conn.machineId, { type: "term_input", sessionId: session.id, data: frame.data, ...proof });
      } else {
        sendToMachine(conn.machineId, {
          type: "term_resize",
          sessionId: session.id,
          cols: frame.cols,
          rows: frame.rows,
          ...proof,
        });
        auditResize(frame.cols, frame.rows);
      }
    };

    const control = (deviceId: string, proof: { auth: RemoteAuth } | { resumeToken: string }) => {
      if (!conn || !session) return;
      if (!isConnected(conn.machineId)) return error("MACHINE_OFFLINE");
      conn.pendingDeviceId = deviceId;
      sendToMachine(conn.machineId, {
        type: "term_control",
        sessionId: session.id,
        connId,
        userId: ticket.userId,
        deviceId,
        ...proof,
      });
    };

    const onFrame = async (frame: RemoteClientFrame) => {
      if (!conn || !session) return;
      if ((frame.t === "control" || frame.t === "in" || frame.t === "resize") && !conn.owner) {
        return ws.close(TERMINAL_WS_CLOSE.forbidden, "Chỉ chủ máy điều khiển được máy này");
      }
      switch (frame.t) {
        case "ping":
          return send({ t: "pong" });
        case "resume": {
          await conn.resume(frame.after, readPage, current);
          if (!frame.resumeToken || closed) return;
          const live = current();
          const grant = live && findGrant(live, frame.resumeToken);
          // Hub khởi động lại thì mất bảng quyền đã cấp nhưng worker còn giữ: chuyển tiếp với thiết bị trình duyệt nhớ,
          // worker vẫn so token với đúng userId/deviceId của lần cấp nên trình duyệt không mạo danh được thiết bị khác.
          const deviceId = grant ? grant.deviceId : (frame.deviceId ?? TOTP_DEVICE_ID);
          if (!conn.canControl || (grant && grant.userId !== ticket.userId)) {
            return send({ t: "denied", code: "AUTH_STALE", message: TERM_DENY_MESSAGES.AUTH_STALE });
          }
          return control(deviceId, { resumeToken: frame.resumeToken });
        }
        case "control": {
          if (block) return error(block);
          const deviceId = frame.deviceId ?? (frame.auth.kind === "totp" ? TOTP_DEVICE_ID : undefined);
          if (!deviceId) return error("DEVICE_NOT_FOUND");
          return control(deviceId, { auth: frame.auth });
        }
        case "release":
          return detach();
        case "in":
        case "resize":
          return forward(frame);
      }
    };

    let queue: Promise<unknown> = (async () => {
      const opened = await withTenant(opts.pool, tenant, async (tx) => {
        let s: RemoteSession;
        try {
          s = await getRemoteSession(tx, ticket.userId, ticket.sessionId);
        } catch (e) {
          if (e instanceof NotFoundError) return null;
          throw e;
        }
        const owner = s.isOwner && (await isMachineOwner(tx, ticket.userId, s.machineId));
        const [row] = await tx
          .select({ teamId: terminalSessions.teamId, threadId: terminalSessions.threadId })
          .from(terminalSessions)
          .where(eq(terminalSessions.id, s.id));
        return { s, owner, teamId: row?.teamId ?? "", off: await machineRemoteDisabled(tx, s.machineId) };
      });
      if (!opened) return ws.close(TERMINAL_WS_CLOSE.notFound, "Không tìm thấy phiên");
      if (closed) return;
      const { s, owner } = opened;
      // Hub vừa khởi động lại thì chưa theo dõi phiên đang chạy tới khi worker gửi output: theo dõi ngay để người
      // xem nhận được output đầu tiên đó.
      const live = ACTIVE.includes(s.state)
        ? trackSession({
            id: s.id,
            orgId: ticket.orgId,
            teamId: opened.teamId,
            machineId: s.machineId,
            ownerUserId: s.ownerId,
            threadId: null,
          })
        : undefined;
      if (live) {
        const others = remoteConns(live);
        const guests = others.filter((c) => !c.owner).length;
        if (others.length >= REMOTE_LIMITS.viewersPerSession || (!owner && guests >= REMOTE_LIMITS.teamViewers)) {
          return ws.close(TERMINAL_WS_CLOSE.rateLimited, "Phiên đã đủ người xem");
        }
      }
      block = remoteControlBlock(s, owner, opts.remoteEnabled ?? false, opened.off);
      session = s;
      conn = new RemoteConn({
        connId,
        userId: ticket.userId,
        sessionId: s.id,
        machineId: s.machineId,
        owner,
        canControl: ticket.canControl && block === null,
        sink: { send, backlog: () => ws.bufferedAmount },
      });
      viewer = {
        userId: ticket.userId,
        canInput: false,
        // Khung của phiên Leader (activity, state) không dành cho trang từ xa.
        send: () => {},
        close: (code, reason) => ws.close(code, reason),
        remote: conn,
      };
      live?.viewers.add(viewer);
      send({
        t: "hello",
        session: { ...s, controller: live?.remote.controller ?? s.controller },
        connId,
        canControl: conn.canControl,
      });
      await withTenant(opts.pool, tenant, (tx) =>
        recordAudit(tx, {
          action: "terminal.attach",
          targetType: "terminal_session",
          targetId: s.id,
          data: { connId, machineId: s.machineId, owner },
        }),
      );
    })().catch((e: unknown) => {
      log.error("Lỗi mở kết nối terminal từ xa", e);
      ws.close(1011, "Hub lỗi khi mở phiên");
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary) return ws.close(1003, "Chỉ nhận khung JSON");
      let frame: RemoteClientFrame;
      try {
        frame = remoteClientFrame.parse(JSON.parse(data.toString()));
      } catch {
        return error("TERMINAL_BAD_FRAME");
      }
      queue = queue.then(() => onFrame(frame)).catch((e: unknown) => log.error("Lỗi xử lý khung terminal từ xa", e));
    });

    // Mạng di động hay NAT bỏ kết nối im lặng; ping của server phát hiện để trả quyền gõ cho worker sớm.
    let alive = true;
    ws.on("pong", () => {
      alive = true;
    });
    const heartbeat = setInterval(
      () => {
        if (!alive) return ws.terminate();
        alive = false;
        ws.ping();
      },
      opts.heartbeatMs ?? REMOTE_LIMITS.heartbeatSec * 1000,
    );
    heartbeat.unref();

    ws.on("close", () => {
      closed = true;
      clearInterval(heartbeat);
      if (!conn || !session) return;
      conn.close();
      if (viewer) current()?.viewers.delete(viewer);
      detach();
      const s = session;
      withTenant(opts.pool, tenant, (tx) =>
        recordAudit(tx, {
          action: "terminal.detach",
          targetType: "terminal_session",
          targetId: s.id,
          data: { connId, machineId: s.machineId },
        }),
      ).catch((e: unknown) => log.error("Không ghi được audit rời phiên terminal", e));
    });
    ws.on("error", (e) => log.warn("Kết nối terminal từ xa của trình duyệt lỗi", e));
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

const ERROR_TEXT: Record<
  RemoteErrorCode | "TERMINAL_READ_ONLY" | "TERMINAL_RATE_LIMITED" | "TERMINAL_BAD_FRAME",
  string
> = {
  ...remoteErrors,
  TERMINAL_READ_ONLY: "Chưa có quyền gõ. Xác thực bằng passkey hoặc mã Authenticator trước.",
  TERMINAL_RATE_LIMITED: "Gõ quá nhanh, phím vừa rồi bị bỏ.",
  TERMINAL_BAD_FRAME: "Khung không hợp lệ.",
};

type Handlers = Parameters<typeof registerTerminalHandlers>[0];
type RemoteMessage = Parameters<NonNullable<Handlers["onRemote"]>>[1];

/**
 * Bọc handler ghi phiên (`createTerminalHandlers`) bằng phần chuyển tới trình duyệt: sự kiện quyền gõ đi đúng kết nối,
 * phiên kết thúc thì người xem nhận trạng thái cuối. Hai phần tách nhau để ghi phiên không phụ thuộc WS.
 */
export function withRemoteLive(
  pool: pg.Pool,
  base: Required<TerminalHandlers>,
  logger: Pick<Console, "error"> = console,
  opts: { publicUrl?: string | undefined } = {},
): Handlers {
  const audit = (machine: AuthedMachine, userId: string | null, action: string, sessionId: string, data: object) =>
    withTenant(pool, { orgId: machine.orgId }, (tx) =>
      recordAudit(tx, {
        action,
        actorUserId: userId,
        targetType: "terminal_session",
        targetId: sessionId,
        data: { ...data, machineId: machine.id },
      }),
    );
  /**
   * Hộp thư của chủ máy (OPS-02): ai đó cầm được passkey hay mã thì chủ máy vẫn thấy ngay trên mọi thiết bị đang đăng
   * nhập. Sự kiện riêng nên không đi ra kênh chung của tổ chức.
   */
  const notifyControl = (machine: AuthedMachine, live: LiveSession, connId: string, deviceId: string) =>
    withTenant(pool, { orgId: machine.orgId }, async (tx) => {
      const [device] = await tx
        .select({ label: remoteDevices.label })
        .from(remoteDevices)
        .where(and(eq(remoteDevices.machineId, machine.id), eq(remoteDevices.id, deviceId)));
      const who = device?.label ?? (deviceId === TOTP_DEVICE_ID ? "mã Authenticator" : "thiết bị đã ghép");
      const base = opts.publicUrl?.replace(/\/+$/, "");
      await notify(tx, {
        orgId: machine.orgId,
        event: "terminal.remote_session",
        recipientIds: [live.ownerUserId],
        title: `Phiên trên ${machine.name} đang được điều khiển từ xa`,
        body: `Quyền gõ vừa được cấp qua ${who}. Không phải bạn thì tắt điều khiển từ xa ngay trên app hoặc trang Máy của tôi.`,
        eventKey: `terminal.remote_session:${live.id}:${connId}`,
        link: base ? `${base}/remote/${live.id}` : null,
      });
    });
  const ownLive = (machine: AuthedMachine, sessionId: string) => {
    const live = liveSession(sessionId);
    return live && live.machineId === machine.id ? live : undefined;
  };

  async function onEvent(machine: AuthedMachine, msg: Extract<TerminalMessage, { type: "term_event" }>) {
    const live = ownLive(machine, msg.sessionId);
    if (!live) return;
    const data = msg.data ?? {};
    const conn = typeof data.connId === "string" ? findConn(live, data.connId) : undefined;
    if (msg.event === "controller" && data.denied !== undefined) {
      // Worker từ chối `control` bằng sự kiện (không có requestId cho `term_denied`); chỉ kết nối xin mới cần biết.
      const code = termDenyCode.safeParse(data.denied).data ?? "AUTH_INVALID";
      const message = typeof data.reason === "string" ? data.reason : TERM_DENY_MESSAGES[code];
      if (conn) {
        conn.pendingDeviceId = null;
        conn.send({ t: "denied", code, message });
      }
      await audit(machine, conn?.userId ?? null, "terminal.deny", msg.sessionId, { connId: data.connId, code });
      return;
    }
    if (msg.event === "controller") {
      const c = data.controller;
      live.remote.controller = c === "local" || c === "remote" ? c : null;
    }
    if (msg.event === "input_rejected") {
      conn?.send({ t: "event", event: msg.event, data });
      await audit(machine, conn?.userId ?? null, "terminal.input_rejected", msg.sessionId, {
        connId: data.connId,
        count: data.count,
      });
      return;
    }
    for (const c of remoteConns(live)) c.send({ t: "event", event: msg.event, data });
  }

  async function onExit(machine: AuthedMachine, msg: Extract<TerminalMessage, { type: "term_exit" }>) {
    const conns = remoteConns(ownLive(machine, msg.sessionId));
    await base.onMessage(machine, msg);
    for (const conn of conns) {
      conn.granted = false;
      conn.pendingDeviceId = null;
      conn.canControl = false;
      const session = await withTenant(pool, { orgId: machine.orgId, userId: conn.userId }, (tx) =>
        getRemoteSession(tx, conn.userId, msg.sessionId),
      ).catch(() => null);
      if (session) conn.send({ t: "state", session });
    }
  }

  async function onRemote(machine: AuthedMachine, msg: RemoteMessage) {
    // `term_denied` mang requestId của `term_start` (T051); từ chối `control` đi bằng `term_event`.
    if (msg.type === "term_denied") return;
    const live = ownLive(machine, msg.sessionId);
    const conn = findConn(live, msg.connId);
    if (msg.type === "term_granted") {
      if (!live || !conn || conn.closed || !conn.pendingDeviceId) {
        // Kết nối đã rời: worker giữ quyền chờ nối lại, nhưng không ai nhận được khoá nên báo rời luôn.
        sendToMachine(machine.id, { type: "term_detach", sessionId: msg.sessionId, connId: msg.connId });
        return;
      }
      const deviceId = conn.pendingDeviceId;
      for (const [token, g] of live.remote.grants) {
        if (g.connId === conn.connId || (g.userId === conn.userId && g.deviceId === deviceId)) {
          live.remote.grants.delete(token);
        }
      }
      live.remote.grants.set(msg.resumeToken, {
        userId: conn.userId,
        deviceId,
        connId: conn.connId,
        expiresAt: Number.POSITIVE_INFINITY,
      });
      conn.granted = true;
      conn.pendingDeviceId = null;
      conn.send({ t: "granted", workerEphPub: msg.workerEphPub, resumeToken: msg.resumeToken });
      await audit(machine, conn.userId, "terminal.control_grant", msg.sessionId, { connId: conn.connId, deviceId });
      await notifyControl(machine, live, conn.connId, deviceId);
      return;
    }
    // term_revoked: khoá cũ hết hiệu lực ở worker nên token nối lại cũng bỏ.
    if (live)
      for (const [token, g] of live.remote.grants) if (g.connId === msg.connId) live.remote.grants.delete(token);
    if (conn) {
      conn.granted = false;
      conn.pendingDeviceId = null;
      conn.send({ t: "revoked", reason: msg.reason });
    }
    const action = msg.reason === "taken" ? "terminal.control_take" : "terminal.control_revoke";
    await audit(machine, conn?.userId ?? null, action, msg.sessionId, { connId: msg.connId, reason: msg.reason });
  }

  return {
    ...base,
    onMessage: async (machine, msg) => {
      if (msg.type === "term_exit") return onExit(machine, msg);
      await base.onMessage(machine, msg);
      if (msg.type === "term_event") {
        await onEvent(machine, msg).catch((e: unknown) => logger.error("Không chuyển được sự kiện terminal", e));
      }
    },
    onRemote: (machine, msg) =>
      onRemote(machine, msg).catch((e: unknown) => logger.error("Không chuyển được quyền gõ terminal", e)),
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
      readChunks(tx, ticket.sessionId, cursor, REPLAY_PAGE),
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
