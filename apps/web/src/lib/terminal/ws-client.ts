import {
  type RemoteClientFrame,
  type RemoteServerFrame,
  type RemoteSession,
  remoteServerFrame,
  TERMINAL_WS_CLOSE,
  TERMINAL_WS_PATH,
} from "@xdev-hive/contracts";
import type { RemoteAuth } from "@xdev-hive/contracts/terminal-auth";
import { type ControlAttempt, grantKey, InputSigner } from "@/lib/terminal/input-mac.ts";
import { base64ToBytes, clampSize, encodeInput, isFatalTicketError, splitInput } from "@/lib/terminal.ts";
import {
  backoffMs,
  type Connection,
  PING_MS,
  RESIZE_DEBOUNCE_MS,
  type SocketLike,
  type StopReason,
} from "@/lib/terminal-socket.ts";

/**
 * Kết nối trình duyệt ↔ hub của một phiên trên máy cá nhân (specs/010 T032, khung `remoteClientFrame`). Như
 * `TerminalSocket` của Leader (vé, `resume {after}`, ping, backoff, `visibilitychange`) cộng quyền gõ: xin bằng passkey
 * hoặc TOTP, ký từng gói `in`/`resize` bằng khoá HMAC chỉ trang này có, và nối lại bằng `resumeToken` để mất sóng
 * không phải quét Face ID lại. Không phụ thuộc React hay xterm để test bằng WebSocket giả.
 */

/**
 * - `none`: chỉ xem.
 * - `requesting`: đã gửi `control`, chờ worker.
 * - `resuming`: vừa nối lại, đã gửi `resumeToken`, chờ worker cấp lại.
 * - `granted`: đang giữ quyền gõ.
 */
export type ControlState = "none" | "requesting" | "resuming" | "granted";

export type RevokeReason = Extract<RemoteServerFrame, { t: "revoked" }>["reason"];

export interface RemoteHandlers {
  onConnection: (connection: Connection) => void;
  onHello: (session: RemoteSession, canControl: boolean) => void;
  onOutput: (bytes: Uint8Array, seq: number) => void;
  /** Hub bỏ phần output client chưa nhận (client chậm): xoá màn hình, output sau `after` sẽ tới tiếp. */
  onReset: (after: number) => void;
  onState: (session: RemoteSession) => void;
  onControl: (state: ControlState) => void;
  onRevoked: (reason: RevokeReason) => void;
  onDenied: (code: string, message: string) => void;
  onEvent: (event: string, data: Record<string, unknown> | undefined) => void;
  onError: (code: string, message: string) => void;
}

/** Bằng chứng cho một lần xin quyền; trang dựng bằng passkey (`getAssertion`) hoặc mã TOTP. */
export interface ControlProof {
  attempt: ControlAttempt;
  auth: RemoteAuth;
  /** Thiết bị đã ghép (passkey). TOTP bỏ trống: hub điền `TOTP_DEVICE_ID`. */
  deviceId?: string;
}

interface VisibilitySource {
  readonly visibilityState: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export interface RemoteSocketOptions {
  sessionId: string;
  /** Vé `r.` dùng một lần (oRPC `remote.ticket`). Mỗi lần nối, kể cả nối lại, phải xin vé mới. */
  fetchTicket: () => Promise<{ ticket: string }>;
  handlers: RemoteHandlers;
  createSocket?: (url: string) => SocketLike;
  url?: (ticket: string) => string;
  visibility?: VisibilitySource | null;
  afterSeq?: number;
}

const OPEN = 1;
const MAX_TICKET_REJECTS = 3;
/**
 * Phím gõ trong lúc chờ worker cấp lại quyền sau khi nối lại (thường dưới 1 giây). Có trần để giữ máy không bị dồn một
 * tràng phím cũ; mất kết nối thì bỏ hết như Leader, vì phát lại phím cũ vào CLI là nguy hiểm.
 */
export const MAX_QUEUED_INPUTS = 64;

interface Grant {
  signer: InputSigner;
  resumeToken: string;
  deviceId: string | undefined;
}

type Pending = { proof: ControlProof; code: string | undefined };

function defaultUrl(ticket: string): string {
  const { protocol, host } = window.location;
  return `${protocol === "https:" ? "wss:" : "ws:"}//${host}${TERMINAL_WS_PATH}?ticket=${encodeURIComponent(ticket)}`;
}

export class RemoteSocket {
  lastSeq = -1;
  /** `connId` của kết nối hiện tại (từ `hello`); challenge và HMAC gắn với nó. */
  connId: string | null = null;
  control: ControlState = "none";
  private readonly options: RemoteSocketOptions;
  private socket: SocketLike | null = null;
  private attempt = 0;
  private ticketRejects = 0;
  private stopped = false;
  private started = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private size: { cols: number; rows: number } | null = null;
  private heard = true;
  private generation = 0;
  private grant: Grant | null = null;
  private pending: Pending | null = null;
  private queue: string[] = [];
  /** Tăng mỗi lần bỏ quyền: `granted` đang suy khoá dở thì biết đã bị thu (revoked tới ngay sau). */
  private epoch = 0;
  private readonly visibility: VisibilitySource | null;
  private readonly onVisible = () => {
    if (this.visibility?.visibilityState !== "visible" || this.stopped) return;
    // Điện thoại mở lại trình duyệt: kết nối thường đã chết ngầm. Nối ngay thay vì chờ hết backoff hay ping 20 s.
    if (this.socket?.readyState === OPEN) this.raw({ t: "ping" });
    else if (this.reconnectTimer) this.reconnectNow();
  };

  constructor(options: RemoteSocketOptions) {
    this.options = options;
    this.lastSeq = options.afterSeq ?? -1;
    this.visibility = options.visibility === undefined ? (globalThis.document ?? null) : options.visibility;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.visibility?.addEventListener("visibilitychange", this.onVisible);
    void this.connect();
  }

  close(): void {
    this.stopped = true;
    this.visibility?.removeEventListener("visibilitychange", this.onVisible);
    this.clearTimers();
    this.generation += 1;
    this.detach(1000);
    this.forget();
  }

  /**
   * Xin quyền gõ. `prove` nhận `connId` của kết nối hiện tại (nằm trong challenge) và trả bằng chứng đã ký. `code` là mã
   * TOTP (trộn vào khoá); passkey thì bỏ trống. Trả false nếu chưa nối, đang xin dở hay đang giữ hoặc lấy lại quyền.
   */
  async requestControl(prove: (connId: string) => Promise<ControlProof>, code?: string): Promise<boolean> {
    const connId = this.connId;
    if (!connId || !this.isOpen() || this.control !== "none") return false;
    this.setControl("requesting");
    let proof: ControlProof;
    try {
      proof = await prove(connId);
    } catch (error) {
      if (this.requesting()) this.setControl("none");
      throw error;
    }
    // Kết nối đổi trong lúc chờ Face ID: challenge gắn `connId` cũ, worker sẽ từ chối. Người dùng bấm lại.
    if (this.connId !== connId || !this.isOpen() || this.stopped) {
      if (this.requesting()) this.setControl("none");
      return false;
    }
    this.pending = { proof, code };
    this.raw({ t: "control", auth: proof.auth, ...(proof.deviceId ? { deviceId: proof.deviceId } : {}) });
    return true;
  }

  /** Trả quyền gõ cho terminal tại máy. */
  release(): void {
    if (this.grant) this.raw({ t: "release" });
    this.forget();
    this.setControl("none");
  }

  /** Phím từ xterm, thanh phím hay ô soạn. Chỉ gửi khi đang giữ quyền; chờ cấp lại sau khi nối thì xếp hàng. */
  sendInput(data: string): void {
    if (!this.isOpen() || !this.grant) return;
    if (this.control === "resuming") {
      for (const part of splitInput(data)) if (this.queue.length < MAX_QUEUED_INPUTS) this.queue.push(part);
      return;
    }
    if (this.control !== "granted") return;
    for (const part of splitInput(data)) this.signAndSend({ t: "in", data: encodeInput(part) });
  }

  resize(cols: number, rows: number): void {
    this.size = clampSize(cols, rows);
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = null;
      this.sendSize();
    }, RESIZE_DEBOUNCE_MS);
  }

  private sendSize(): void {
    // Người xem không đổi cỡ phiên: chỉ người giữ quyền gõ quyết cỡ PTY (gói ký như phím).
    if (this.size && this.control === "granted") this.signAndSend({ t: "resize", ...this.size });
  }

  private signAndSend(frame: { t: "in"; data: string } | { t: "resize"; cols: number; rows: number }): void {
    const grant = this.grant;
    const connId = this.connId;
    if (!grant || !connId) return;
    const socket = this.socket;
    grant.signer.sign(connId, frame).then(
      (signed) => {
        // Kết nối đã đổi thì gói mang `connId` cũ: worker coi là giả mạo và thu quyền. Bỏ, `seq` hở không sao.
        if (this.socket !== socket || this.connId !== connId || this.grant !== grant) return;
        this.raw(signed);
      },
      () => {},
    );
  }

  private raw(frame: RemoteClientFrame): void {
    if (this.isOpen()) this.socket?.send(JSON.stringify(frame));
  }

  /** Đọc lại sau `await`: trạng thái có thể đã đổi (nối lại, bị thu quyền) trong lúc chờ passkey. */
  private requesting(): boolean {
    return this.control === "requesting";
  }

  private isOpen(): boolean {
    return this.socket?.readyState === OPEN;
  }

  private setControl(state: ControlState): void {
    if (this.control === state) return;
    this.control = state;
    this.options.handlers.onControl(state);
  }

  private forget(): void {
    this.epoch += 1;
    this.grant = null;
    this.pending = null;
    this.queue = [];
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.reconnectTimer = this.pingTimer = this.resizeTimer = null;
  }

  private detach(code?: number): void {
    const socket = this.socket;
    this.socket = null;
    this.connId = null;
    this.pending = null;
    this.queue = [];
    if (!socket) return;
    socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
    try {
      socket.close(code);
    } catch {
      /* Đã đóng rồi. */
    }
  }

  private stop(reason: StopReason): void {
    this.stopped = true;
    this.visibility?.removeEventListener("visibilitychange", this.onVisible);
    this.clearTimers();
    this.detach(1000);
    this.forget();
    this.setControl("none");
    this.options.handlers.onConnection({ kind: "stopped", reason });
  }

  private reconnectNow(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    void this.connect();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.detach();
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    // Quyền gõ vẫn còn ở worker (ResumeTTL); trang chỉ không gõ được tới khi nối lại.
    if (this.control === "requesting") this.setControl("none");
    this.attempt += 1;
    this.options.handlers.onConnection({ kind: "reconnecting", attempt: this.attempt });
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, backoffMs(this.attempt));
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const generation = ++this.generation;
    this.detach();
    if (this.attempt === 0) this.options.handlers.onConnection({ kind: "connecting" });
    let ticket: string;
    try {
      ticket = (await this.options.fetchTicket()).ticket;
    } catch (error) {
      if (generation !== this.generation || this.stopped) return;
      if (isFatalTicketError(error)) this.stop("ticket");
      else this.scheduleReconnect();
      return;
    }
    if (generation !== this.generation || this.stopped) return;
    const create = this.options.createSocket ?? ((url: string) => new WebSocket(url) as unknown as SocketLike);
    const socket = create((this.options.url ?? defaultUrl)(ticket));
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.attempt = 0;
      this.heard = true;
      this.options.handlers.onConnection({ kind: "connected" });
      const grant = this.grant;
      if (grant) this.setControl("resuming");
      this.raw({
        t: "resume",
        after: this.lastSeq,
        ...(grant ? { resumeToken: grant.resumeToken } : {}),
        ...(grant?.deviceId ? { deviceId: grant.deviceId } : {}),
      });
      this.pingTimer = setInterval(() => this.tick(), PING_MS);
    };
    socket.onmessage = (event) => {
      if (this.socket === socket) void this.receive(event.data);
    };
    socket.onclose = (event) => {
      if (this.socket === socket) this.closed(event.code);
    };
    socket.onerror = () => {};
  }

  private tick(): void {
    if (!this.heard) {
      this.scheduleReconnect();
      return;
    }
    this.heard = false;
    this.raw({ t: "ping" });
  }

  private closed(code: number): void {
    if (this.stopped) return;
    if (code === TERMINAL_WS_CLOSE.unauthorized) {
      this.ticketRejects += 1;
      if (this.ticketRejects >= MAX_TICKET_REJECTS) {
        this.stop("ticket");
        return;
      }
      this.detach();
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      void this.connect();
      return;
    }
    if (code === TERMINAL_WS_CLOSE.forbidden) {
      this.stop("forbidden");
      return;
    }
    if (code === TERMINAL_WS_CLOSE.notFound) {
      this.stop("notFound");
      return;
    }
    this.scheduleReconnect();
  }

  private async granted(workerEphPub: string, resumeToken: string): Promise<void> {
    const pending = this.pending;
    const socket = this.socket;
    const epoch = this.epoch;
    if (pending) {
      this.pending = null;
      const key = await grantKey(pending.proof.attempt, workerEphPub, pending.code);
      if (this.socket !== socket || this.epoch !== epoch || this.stopped) return;
      this.grant = {
        signer: new InputSigner(key, this.options.sessionId),
        resumeToken,
        deviceId: pending.proof.deviceId,
      };
    } else if (this.grant) {
      // Nối lại: worker giữ khoá và `seq` cũ, chỉ có thể đổi token.
      this.grant.resumeToken = resumeToken;
    } else {
      return;
    }
    this.setControl("granted");
    this.sendSize();
    const queued = this.queue;
    this.queue = [];
    for (const part of queued) this.signAndSend({ t: "in", data: encodeInput(part) });
  }

  private async receive(data: unknown): Promise<void> {
    this.heard = true;
    if (typeof data !== "string") return;
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      return;
    }
    const { handlers } = this.options;
    if (isRecord(raw) && raw.t === "out") {
      const { seq, data: payload } = raw;
      if (typeof seq !== "number" || typeof payload !== "string" || seq <= this.lastSeq) return;
      let bytes: Uint8Array;
      try {
        bytes = base64ToBytes(payload);
      } catch {
        return;
      }
      this.lastSeq = seq;
      handlers.onOutput(bytes, seq);
      return;
    }
    const parsed = remoteServerFrame.safeParse(raw);
    if (!parsed.success) return;
    const frame = parsed.data;
    switch (frame.t) {
      case "hello":
        this.ticketRejects = 0;
        this.connId = frame.connId;
        handlers.onHello(frame.session, frame.canControl);
        break;
      case "sync":
        this.lastSeq = frame.after;
        handlers.onReset(frame.after);
        break;
      case "state":
        handlers.onState(frame.session);
        break;
      case "granted":
        await this.granted(frame.workerEphPub, frame.resumeToken);
        break;
      case "revoked":
        this.forget();
        this.setControl("none");
        handlers.onRevoked(frame.reason);
        break;
      case "denied":
        // Từ chối lúc nối lại (hết ResumeTTL, worker khởi động lại): khoá cũ vô dụng, phải xác thực lại.
        this.forget();
        this.setControl("none");
        handlers.onDenied(frame.code, frame.message);
        break;
      case "event":
        handlers.onEvent(frame.event, frame.data);
        break;
      case "error":
        // Lỗi của hub khi đang xin hay nối lại quyền (máy offline, không bật từ xa): về chỉ xem, người dùng xin lại.
        if (this.control === "requesting" || this.control === "resuming") {
          this.forget();
          this.setControl("none");
        }
        handlers.onError(frame.code, frame.message);
        break;
      case "pong":
      case "out":
        break;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
