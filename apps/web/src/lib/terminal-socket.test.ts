import { ORPCError } from "@orpc/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bytesToBase64 } from "@/lib/terminal.ts";
import {
  backoffMs,
  type Connection,
  PING_MS,
  RESIZE_DEBOUNCE_MS,
  type SocketLike,
  type TerminalHandlers,
  TerminalSocket,
} from "@/lib/terminal-socket.ts";

class FakeSocket implements SocketLike {
  static all: FakeSocket[] = [];
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  sent: Record<string, unknown>[] = [];
  closedWith: number | undefined;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number) {
    this.closedWith = code;
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }
  frame(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  drop(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

const session = {
  id: "0a0a0a0a-0000-4000-8000-0000000000a1",
  projectId: "0a0a0a0a-0000-4000-8000-0000000000b1",
  projectKey: "PAY",
  projectName: "payment-api",
  machineId: "0a0a0a0a-0000-4000-8000-0000000000c1",
  machineName: "sdlc-box-01",
  ownerId: "u1",
  ownerName: "Duy",
  isOwner: true,
  mode: "propose" as const,
  model: "sonnet" as const,
  advisor: null,
  state: "running" as const,
  visibility: "private" as const,
  permissions: "workspace" as const,
  accountLabel: null,
  threadId: null,
  cols: 120,
  rows: 32,
  exitCode: null,
  endReason: null,
  bytes: 0,
  createdAt: "2026-10-14T01:00:00.000Z",
  endedAt: null,
};

const out = (seq: number, text: string) => ({
  t: "out",
  seq,
  data: bytesToBase64(new TextEncoder().encode(text)),
});

function setup(fetchTicket?: () => Promise<{ ticket: string }>) {
  let n = 0;
  const events: Connection[] = [];
  const output: { seq: number; text: string }[] = [];
  const handlers = {
    onConnection: vi.fn((c: Connection) => events.push(c)),
    onHello: vi.fn(),
    onOutput: vi.fn((bytes: Uint8Array, seq: number) => output.push({ seq, text: new TextDecoder().decode(bytes) })),
    onState: vi.fn(),
    onActivity: vi.fn(),
    onError: vi.fn(),
  } satisfies TerminalHandlers;
  const tickets = vi.fn(fetchTicket ?? (async () => ({ ticket: `t${++n}` })));
  const visibility = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const socket = new TerminalSocket({
    fetchTicket: tickets,
    handlers,
    createSocket: (url) => new FakeSocket(url),
    url: (ticket) => `ws://hub/ws/terminal?ticket=${ticket}`,
    visibility,
  });
  return { socket, handlers, events, output, tickets, visibility };
}

const last = () => FakeSocket.all[FakeSocket.all.length - 1] as FakeSocket;
/** Cho các promise xin vé chạy xong. */
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  FakeSocket.all = [];
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("TerminalSocket", () => {
  it("xin vé rồi mở WebSocket với vé trong URL, xin phần output từ đầu", async () => {
    const { socket, events } = setup();
    socket.start();
    await flush();
    expect(last().url).toBe("ws://hub/ws/terminal?ticket=t1");
    expect(events).toEqual([{ kind: "connecting" }]);
    last().open();
    expect(events.at(-1)).toEqual({ kind: "connected" });
    expect(last().sent).toEqual([{ t: "resume", after: -1 }]);
  });

  it("mã hoá phím gõ thành base64 của UTF-8", async () => {
    const { socket } = setup();
    socket.start();
    await flush();
    last().open();
    socket.sendInput("chào ✓");
    const frame = last().sent.at(-1) as { t: string; data: string };
    expect(frame.t).toBe("in");
    expect(new TextDecoder().decode(Uint8Array.from(atob(frame.data), (c) => c.charCodeAt(0)))).toBe("chào ✓");
  });

  it("dán đoạn dài thì cắt thành nhiều khung, mỗi khung không quá 4096 byte", async () => {
    const { socket } = setup();
    socket.start();
    await flush();
    last().open();
    socket.sendInput("ế".repeat(3000));
    const frames = last().sent.filter((f) => f.t === "in") as { data: string }[];
    expect(frames.length).toBeGreaterThan(1);
    const total = frames.map((f) => atob(f.data).length).reduce((a, b) => a + b, 0);
    expect(total).toBe(9000);
    for (const f of frames) expect(atob(f.data).length).toBeLessThanOrEqual(4096);
  });

  it("mất kết nối thì bỏ phím gõ thay vì xếp hàng", async () => {
    const { socket } = setup();
    socket.start();
    await flush();
    last().open();
    last().drop(1006);
    socket.sendInput("rm -rf\r");
    await vi.advanceTimersByTimeAsync(backoffMs(1));
    last().open();
    expect(last().sent.filter((f) => f.t === "in")).toEqual([]);
  });

  it("gom resize và gửi cỡ mới nhất, nối lại thì gửi lại cỡ", async () => {
    const { socket } = setup();
    socket.start();
    await flush();
    last().open();
    socket.resize(100, 30);
    socket.resize(101, 31);
    socket.resize(102, 32);
    expect(last().sent.filter((f) => f.t === "resize")).toEqual([]);
    await vi.advanceTimersByTimeAsync(RESIZE_DEBOUNCE_MS);
    expect(last().sent.filter((f) => f.t === "resize")).toEqual([{ t: "resize", cols: 102, rows: 32 }]);
    last().drop(1006);
    await vi.advanceTimersByTimeAsync(backoffMs(1));
    last().open();
    expect(last().sent).toContainEqual({ t: "resize", cols: 102, rows: 32 });
  });

  it("đưa cỡ ngoài khoảng của hợp đồng về trong khoảng", async () => {
    const { socket } = setup();
    socket.start();
    await flush();
    last().open();
    socket.resize(5, 1000);
    await vi.advanceTimersByTimeAsync(RESIZE_DEBOUNCE_MS);
    expect(last().sent).toContainEqual({ t: "resize", cols: 20, rows: 200 });
  });

  it("ping mỗi 20 giây", async () => {
    const { socket } = setup();
    socket.start();
    await flush();
    last().open();
    await vi.advanceTimersByTimeAsync(PING_MS);
    expect(last().sent.filter((f) => f.t === "ping")).toHaveLength(1);
    last().frame({ t: "pong" });
    await vi.advanceTimersByTimeAsync(PING_MS);
    expect(last().sent.filter((f) => f.t === "ping")).toHaveLength(2);
  });

  it("không nghe gì sau một lần ping thì coi là chết ngầm và nối lại", async () => {
    const { socket, events } = setup();
    socket.start();
    await flush();
    last().open();
    last().frame({ t: "pong" });
    await vi.advanceTimersByTimeAsync(PING_MS);
    await vi.advanceTimersByTimeAsync(PING_MS);
    expect(events.at(-1)).toEqual({ kind: "reconnecting", attempt: 1 });
  });

  it("giao output theo seq và bỏ khung đã thấy", async () => {
    const { socket, output } = setup();
    socket.start();
    await flush();
    last().open();
    last().frame(out(0, "a"));
    last().frame(out(1, "b"));
    last().frame(out(1, "b"));
    last().frame(out(0, "a"));
    last().frame(out(3, "d"));
    expect(output).toEqual([
      { seq: 0, text: "a" },
      { seq: 1, text: "b" },
      { seq: 3, text: "d" },
    ]);
    expect(socket.lastSeq).toBe(3);
  });

  it("rớt kết nối thì nối lại với backoff 1 → 10 giây và gửi resume sau seq cuối", async () => {
    const { socket, events, tickets } = setup();
    socket.start();
    await flush();
    last().open();
    last().frame(out(0, "x"));
    last().frame(out(1, "y"));
    last().drop(1006);
    expect(events.at(-1)).toEqual({ kind: "reconnecting", attempt: 1 });
    await vi.advanceTimersByTimeAsync(999);
    expect(FakeSocket.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(tickets).toHaveBeenCalledTimes(2);
    expect(last().url).toContain("ticket=t2");
    last().open();
    expect(events.at(-1)).toEqual({ kind: "connected" });
    expect(last().sent[0]).toEqual({ t: "resume", after: 1 });
    expect([1, 2, 3, 4, 5, 6].map(backoffMs)).toEqual([1000, 2000, 4000, 8000, 10_000, 10_000]);
  });

  it("nối lại thất bại nhiều lần thì tăng dần khoảng chờ, kết nối được thì về 1 giây", async () => {
    const { socket, events } = setup();
    socket.start();
    await flush();
    last().drop(1006);
    await vi.advanceTimersByTimeAsync(1000);
    last().drop(1006);
    expect(events.at(-1)).toEqual({ kind: "reconnecting", attempt: 2 });
    await vi.advanceTimersByTimeAsync(1999);
    expect(FakeSocket.all).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSocket.all).toHaveLength(3);
    last().open();
    last().drop(1006);
    expect(events.at(-1)).toEqual({ kind: "reconnecting", attempt: 1 });
  });

  it("đóng 4401 thì xin vé mới và nối lại ngay", async () => {
    const { socket, tickets } = setup();
    socket.start();
    await flush();
    last().drop(4401);
    await flush();
    expect(tickets).toHaveBeenCalledTimes(2);
    expect(last().url).toContain("ticket=t2");
  });

  it("vé bị từ chối liên tiếp thì dừng thay vì xin mãi", async () => {
    const { socket, events, tickets } = setup();
    socket.start();
    await flush();
    last().drop(4401);
    await flush();
    last().drop(4401);
    await flush();
    last().drop(4401);
    await flush();
    expect(tickets).toHaveBeenCalledTimes(3);
    expect(events.at(-1)).toEqual({ kind: "stopped", reason: "ticket" });
  });

  it.each([
    [4403, "forbidden"],
    [4404, "notFound"],
  ] as const)("đóng %i thì dừng, không nối lại", async (code, reason) => {
    const { socket, events, tickets } = setup();
    socket.start();
    await flush();
    last().open();
    last().drop(code);
    expect(events.at(-1)).toEqual({ kind: "stopped", reason });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tickets).toHaveBeenCalledTimes(1);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it("4429 (gõ quá nhanh) vẫn nối lại có backoff", async () => {
    const { socket, events } = setup();
    socket.start();
    await flush();
    last().open();
    last().drop(4429);
    expect(events.at(-1)).toEqual({ kind: "reconnecting", attempt: 1 });
  });

  it("xin vé lỗi mạng thì thử lại, lỗi 404 thì dừng", async () => {
    let calls = 0;
    const { socket, events } = setup(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("network");
      if (calls === 2) throw new ORPCError("NOT_FOUND", { status: 404, message: "Không thấy phiên." });
      return { ticket: "ok" };
    });
    socket.start();
    await flush();
    expect(events.at(-1)).toEqual({ kind: "reconnecting", attempt: 1 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(events.at(-1)).toEqual({ kind: "stopped", reason: "ticket" });
  });

  it("tab hiện lại thì nối lại ngay thay vì đợi hết backoff", async () => {
    const { socket, visibility, tickets } = setup();
    socket.start();
    await flush();
    last().open();
    last().drop(1006);
    await vi.advanceTimersByTimeAsync(400);
    visibility.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(tickets).toHaveBeenCalledTimes(2);
    expect(FakeSocket.all).toHaveLength(2);
  });

  it("chuyển các khung hello, state, activity, error cho nơi nghe", async () => {
    const { socket, handlers } = setup();
    socket.start();
    await flush();
    last().open();
    last().frame({ t: "hello", session, canInput: true });
    last().frame({ t: "state", session: { ...session, state: "closed" } });
    last().frame({ t: "activity" });
    last().frame({ t: "error", code: "INPUT_DENIED", message: "Chỉ chủ phiên được gõ." });
    last().frame({ t: "khong-biet" });
    last().onmessage?.({ data: "không phải JSON" });
    last().onmessage?.({ data: new ArrayBuffer(2) });
    expect(handlers.onHello).toHaveBeenCalledWith(session, true);
    expect(handlers.onState).toHaveBeenCalledTimes(1);
    expect(handlers.onActivity).toHaveBeenCalledTimes(1);
    expect(handlers.onError).toHaveBeenCalledWith("INPUT_DENIED", "Chỉ chủ phiên được gõ.");
  });

  it("close() dừng hẳn và đóng socket", async () => {
    const { socket, tickets } = setup();
    socket.start();
    await flush();
    last().open();
    const current = last();
    socket.close();
    expect(current.closedWith).toBe(1000);
    await vi.advanceTimersByTimeAsync(PING_MS * 3);
    expect(tickets).toHaveBeenCalledTimes(1);
  });
});
