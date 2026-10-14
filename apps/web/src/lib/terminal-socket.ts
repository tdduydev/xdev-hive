import {
  TERMINAL_WS_CLOSE,
  TERMINAL_WS_PATH,
  type TerminalClientFrame,
  type TerminalSession,
  terminalServerFrame,
} from "@xdev-hive/contracts";
import { base64ToBytes, clampSize, encodeInput, isFatalTicketError, splitInput } from "@/lib/terminal.ts";

/**
 * Vì sao dừng hẳn (không nối lại nữa):
 * - `forbidden` (4403): mất vai trò, sai Origin hoặc phiên không còn cho xem.
 * - `notFound` (4404): phiên không có hoặc đã kết thúc; trang tải nốt bản ghi.
 * - `ticket`: xin vé bị từ chối (403/404/409) hoặc vé hỏng liên tục.
 */
export type StopReason = "forbidden" | "notFound" | "ticket";

export type Connection =
  | { kind: "connecting" }
  | { kind: "connected" }
  | { kind: "reconnecting"; attempt: number }
  | { kind: "stopped"; reason: StopReason };

export interface TerminalHandlers {
  onConnection: (connection: Connection) => void;
  onHello: (session: TerminalSession, canInput: boolean) => void;
  onOutput: (bytes: Uint8Array, seq: number) => void;
  onState: (session: TerminalSession) => void;
  onActivity: () => void;
  onError: (code: string, message: string) => void;
}

/** Phần của WebSocket mà lớp này dùng; test thay bằng bản giả. */
export interface SocketLike {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: ((event: Event) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

interface VisibilitySource {
  readonly visibilityState: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export interface TerminalSocketOptions {
  /** Xin vé dùng một lần (oRPC `terminal.ticket`). Mỗi lần nối, kể cả nối lại, phải xin vé mới. */
  fetchTicket: () => Promise<{ ticket: string }>;
  handlers: TerminalHandlers;
  createSocket?: (url: string) => SocketLike;
  /** Mặc định theo `window.location`. */
  url?: (ticket: string) => string;
  visibility?: VisibilitySource | null;
  /** `seq` output cuối đã có sẵn trong terminal (phiên vừa chuyển từ phát lại bản ghi sang nối trực tiếp). */
  afterSeq?: number;
}

const OPEN = 1;
export const PING_MS = 20_000;
export const RESIZE_DEBOUNCE_MS = 150;
const BACKOFF_FIRST_MS = 1000;
const BACKOFF_MAX_MS = 10_000;
/** Vé bị từ chối (4401) liên tiếp từng này lần thì coi là hỏng thật, không xin mãi. */
const MAX_TICKET_REJECTS = 3;

export const backoffMs = (attempt: number): number =>
  Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** Math.max(0, attempt - 1));

function defaultUrl(ticket: string): string {
  const { protocol, host } = window.location;
  return `${protocol === "https:" ? "wss:" : "ws:"}//${host}${TERMINAL_WS_PATH}?ticket=${encodeURIComponent(ticket)}`;
}

/**
 * Kết nối trình duyệt ↔ hub của một phiên terminal. Không phụ thuộc React hay xterm để test được bằng WebSocket giả.
 * Nhớ `seq` cuối của output: nối lại thì gửi `resume {after}` để hub phát tiếp phần thiếu, và bỏ khung có `seq` đã
 * thấy (hub có thể phát lại đuôi bộ đệm khi vào phiên, cộng thêm phần `resume`).
 */
export class TerminalSocket {
  /** `seq` output cuối đã giao cho `onOutput`; -1 là chưa có. */
  lastSeq = -1;
  private readonly options: TerminalSocketOptions;
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
  /** Mỗi lần nối có số thứ tự: kết quả xin vé của lần nối cũ (đã bị bỏ) không được mở socket. */
  private generation = 0;
  private readonly visibility: VisibilitySource | null;
  private readonly onVisible = () => {
    if (this.visibility?.visibilityState !== "visible" || this.stopped) return;
    // Tab quay lại: không đợi hết backoff. Nếu đang nối thì gửi ping để biết kết nối có còn sống.
    if (this.socket?.readyState === OPEN) this.send({ t: "ping" });
    else if (this.reconnectTimer) this.reconnectNow();
  };

  constructor(options: TerminalSocketOptions) {
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

  /** Gõ phím (xterm `onData`). Mất kết nối thì bỏ phím, không xếp hàng: phát lại phím cũ vào CLI là nguy hiểm. */
  sendInput(data: string): void {
    if (!this.isOpen()) return;
    for (const part of splitInput(data)) this.send({ t: "in", data: encodeInput(part) });
  }

  /** Cỡ khung đổi (fit). Gom lại để kéo cửa sổ không bắn mỗi khung hình; nối lại thì gửi lại cỡ mới nhất. */
  resize(cols: number, rows: number): void {
    this.size = clampSize(cols, rows);
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = null;
      this.sendSize();
    }, RESIZE_DEBOUNCE_MS);
  }

  close(): void {
    this.stopped = true;
    this.visibility?.removeEventListener("visibilitychange", this.onVisible);
    this.clearTimers();
    this.generation += 1;
    this.detach(1000);
  }

  private isOpen(): boolean {
    return this.socket?.readyState === OPEN;
  }

  private send(frame: TerminalClientFrame): void {
    if (this.isOpen()) this.socket?.send(JSON.stringify(frame));
  }

  private sendSize(): void {
    if (this.size) this.send({ t: "resize", ...this.size });
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
      // Luôn xin phần sau `lastSeq`, kể cả lần đầu (-1): người vào sau thấy màn hình đang chạy. Khung trùng thì
      // `onmessage` bỏ nhờ `seq`.
      this.send({ t: "resume", after: this.lastSeq });
      this.sendSize();
      this.pingTimer = setInterval(() => this.tick(), PING_MS);
    };
    socket.onmessage = (event) => {
      if (this.socket === socket) this.receive(event.data);
    };
    socket.onclose = (event) => {
      if (this.socket === socket) this.closed(event.code);
    };
    // `onclose` luôn theo sau `onerror`, xử lý ở đó.
    socket.onerror = () => {};
  }

  /** Mỗi 20 s ping; lần trước không nghe gì (kể cả pong) thì kết nối đã chết ngầm, nối lại. */
  private tick(): void {
    if (!this.heard) {
      this.scheduleReconnect();
      return;
    }
    this.heard = false;
    this.send({ t: "ping" });
  }

  private closed(code: number): void {
    if (this.stopped) return;
    if (code === TERMINAL_WS_CLOSE.unauthorized) {
      // Vé hết hạn hay đã dùng: xin vé mới ngay, không chờ backoff.
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

  private receive(data: unknown): void {
    this.heard = true;
    if (typeof data !== "string") return;
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      return;
    }
    const { handlers } = this.options;
    // Khung `out` chiếm gần hết lưu lượng: kiểm nhẹ thay vì chạy cả schema (có regex base64) trên từng khung.
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
    const parsed = terminalServerFrame.safeParse(raw);
    if (!parsed.success) return;
    const frame = parsed.data;
    switch (frame.t) {
      case "hello":
        this.ticketRejects = 0;
        handlers.onHello(frame.session, frame.canInput);
        break;
      case "state":
        handlers.onState(frame.session);
        break;
      case "activity":
        handlers.onActivity();
        break;
      case "error":
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
