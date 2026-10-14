import {
  deriveInputKey,
  inputMac,
  inputMacPayload,
  PASSKEY_KEY_INFO,
  toBase64url,
} from "@xdev-hive/contracts/terminal-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ControlAttempt, newControlAttempt } from "@/lib/terminal/input-mac.ts";
import {
  type ControlProof,
  type ControlState,
  MAX_QUEUED_INPUTS,
  type RemoteHandlers,
  RemoteSocket,
} from "@/lib/terminal/ws-client.ts";
import { bytesToBase64 } from "@/lib/terminal.ts";
import { backoffMs, type Connection, RESIZE_DEBOUNCE_MS, type SocketLike } from "@/lib/terminal-socket.ts";

class FakeSocket implements SocketLike {
  static all: FakeSocket[] = [];
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  sent: Record<string, unknown>[] = [];
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
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
  of(t: string) {
    return this.sent.filter((f) => f.t === t);
  }
}

const SESSION_ID = "7b7b7b7b-0000-4000-8000-0000000000b1";
const MACHINE_ID = "0a0a0a0a-0000-4000-8000-0000000000c1";
const DEVICE_ID = "dev-iphone01";

const session = {
  id: SESSION_ID,
  machineId: MACHINE_ID,
  machineName: "sdlc-box-01",
  ownerId: "u1",
  ownerName: "Duy",
  isOwner: true,
  origin: "local" as const,
  cli: "claude" as const,
  accountLabel: null,
  cwdLabel: "payment-api",
  projectId: null,
  projectKey: null,
  taskId: null,
  taskKey: null,
  state: "running" as const,
  visibility: "private" as const,
  remote: true,
  controller: "local" as const,
  cols: 100,
  rows: 30,
  exitCode: null,
  endReason: null,
  bytes: 0,
  createdAt: "2026-10-15T01:00:00.000Z",
  endedAt: null,
};

const hello = (connId: string) => ({ t: "hello", session, connId, canControl: true });
const out = (seq: number, text: string) => ({ t: "out", seq, data: bytesToBase64(new TextEncoder().encode(text)) });
const text = (data: unknown) => new TextDecoder().decode(Uint8Array.from(atob(String(data)), (c) => c.charCodeAt(0)));

/** WebCrypto chạy ngoài vòng sự kiện JS: chờ tới khi điều kiện đúng thay vì đoán số lượt microtask. */
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setImmediate(r));
  expect(check()).toBe(true);
}

/** Worker giả: giữ khoá ECDH, cấp quyền và kiểm HMAC như `remoteauth`. */
class FakeWorker {
  key: CryptoKey | null = null;
  pub = "";
  async init() {
    const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, [
      "deriveBits",
    ])) as CryptoKeyPair;
    this.pub = toBase64url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
    this.private = pair.privateKey;
  }
  private private: CryptoKey | null = null;
  async grant(attempt: ControlAttempt) {
    if (!this.private) throw new Error("init trước");
    this.key = await deriveInputKey(this.private, attempt.ephPub, attempt.challengeBytes, PASSKEY_KEY_INFO);
  }
  async verify(frame: Record<string, unknown>, connId: string): Promise<boolean> {
    if (!this.key) return false;
    const base = { sessionId: SESSION_ID, connId, seq: frame.seq as number };
    const payload =
      frame.t === "in"
        ? inputMacPayload({ ...base, kind: "in", data: frame.data as string })
        : inputMacPayload({ ...base, kind: "resize", cols: frame.cols as number, rows: frame.rows as number });
    return (await inputMac(this.key, payload)) === frame.mac;
  }
}

let connections: Connection[];
let controls: ControlState[];
let revoked: string[];
let denied: string[];
let errors: string[];
let output: string[];
let resets: number[];

function handlers(): RemoteHandlers {
  return {
    onConnection: (c) => connections.push(c),
    onHello: () => {},
    onOutput: (bytes) => output.push(new TextDecoder().decode(bytes)),
    onReset: (after) => resets.push(after),
    onState: () => {},
    onControl: (s) => controls.push(s),
    onRevoked: (r) => revoked.push(r),
    onDenied: (code) => denied.push(code),
    onEvent: () => {},
    onError: (code) => errors.push(code),
  };
}

function make() {
  return new RemoteSocket({
    sessionId: SESSION_ID,
    fetchTicket: async () => ({ ticket: "r.ticket" }),
    handlers: handlers(),
    createSocket: (url) => new FakeSocket(url),
    url: (ticket) => `ws://hub/ws/terminal?ticket=${ticket}`,
    visibility: null,
  });
}

const last = () => {
  const s = FakeSocket.all.at(-1);
  if (!s) throw new Error("chưa có socket");
  return s;
};

async function connected(socket: RemoteSocket, connId: string) {
  socket.start();
  await until(() => FakeSocket.all.length > 0);
  last().open();
  last().frame(hello(connId));
  return last();
}

let attempts: ControlAttempt[];
const prove = async (connId: string): Promise<ControlProof> => {
  const attempt = await newControlAttempt({
    machineId: MACHINE_ID,
    params: { userId: "u1", deviceId: DEVICE_ID, sessionId: SESSION_ID, connId },
  });
  attempts.push(attempt);
  return {
    attempt,
    deviceId: DEVICE_ID,
    // Chữ ký passkey không ảnh hưởng tới khoá gói nhập; worker giả không kiểm nó.
    auth: {
      kind: "passkey",
      assertion: { credentialId: "Y3JlZA", authenticatorData: "YQ", clientDataJSON: "YQ", signature: "YQ" },
      ephPub: attempt.ephPub,
      ts: attempt.ts,
      nonce: attempt.nonce,
    },
  };
};

async function grantedSocket(worker: FakeWorker, connId = "conn-0001aa") {
  const socket = make();
  const ws = await connected(socket, connId);
  expect(await socket.requestControl(prove)).toBe(true);
  const attempt = attempts.at(-1);
  if (!attempt) throw new Error("chưa xin quyền");
  await worker.grant(attempt);
  ws.frame({ t: "granted", workerEphPub: worker.pub, resumeToken: "dG9rMQ" });
  await until(() => socket.control === "granted");
  return { socket, ws };
}

beforeEach(() => {
  FakeSocket.all = [];
  connections = [];
  controls = [];
  revoked = [];
  denied = [];
  errors = [];
  output = [];
  resets = [];
  attempts = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("RemoteSocket: xem", () => {
  it("nối bằng vé, xin output từ đầu, chỉ xem thì không gửi phím", async () => {
    const socket = make();
    const ws = await connected(socket, "conn-0001aa");
    expect(ws.url).toBe("ws://hub/ws/terminal?ticket=r.ticket");
    expect(ws.sent[0]).toEqual({ t: "resume", after: -1 });
    expect(socket.connId).toBe("conn-0001aa");
    socket.sendInput("ls\r");
    expect(ws.of("in")).toEqual([]);
    ws.frame(out(0, "a"));
    ws.frame(out(0, "a"));
    ws.frame(out(1, "b"));
    expect(output).toEqual(["a", "b"]);
    socket.close();
  });

  it("`sync` xoá màn hình và nhận lại output sau mốc hub chọn", async () => {
    const socket = make();
    const ws = await connected(socket, "conn-0001aa");
    ws.frame(out(5, "x"));
    ws.frame({ t: "sync", after: 2 });
    expect(resets).toEqual([2]);
    ws.frame(out(3, "y"));
    expect(output).toEqual(["x", "y"]);
    socket.close();
  });

  it("4403 (chủ máy tắt từ xa) thì dừng hẳn", async () => {
    const socket = make();
    const ws = await connected(socket, "conn-0001aa");
    ws.drop(4403);
    expect(connections.at(-1)).toEqual({ kind: "stopped", reason: "forbidden" });
  });
});

describe("RemoteSocket: quyền gõ", () => {
  it("xin quyền với connId hiện tại, ký phím và cỡ khung đúng như worker kiểm", async () => {
    const worker = new FakeWorker();
    await worker.init();
    const socket = make();
    const ws = await connected(socket, "conn-0001aa");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    socket.resize(44, 30);
    vi.advanceTimersByTime(RESIZE_DEBOUNCE_MS);
    // Chưa có quyền: người xem không đổi cỡ phiên.
    expect(ws.of("resize")).toEqual([]);
    vi.useRealTimers();

    expect(await socket.requestControl(prove)).toBe(true);
    expect(controls).toEqual(["requesting"]);
    const control = ws.of("control")[0];
    expect(control).toMatchObject({ t: "control", deviceId: DEVICE_ID, auth: { kind: "passkey" } });
    expect(attempts[0]?.challenge.params).toMatchObject({ connId: "conn-0001aa", deviceId: DEVICE_ID });

    const attempt = attempts[0];
    if (!attempt) throw new Error("chưa xin quyền");
    await worker.grant(attempt);
    ws.frame({ t: "granted", workerEphPub: worker.pub, resumeToken: "dG9rMQ" });
    await until(() => ws.of("resize").length === 1);
    expect(controls.at(-1)).toBe("granted");

    socket.sendInput("\x03");
    socket.sendInput("ls\r");
    await until(() => ws.of("in").length === 2);
    const frames = [...ws.of("resize"), ...ws.of("in")];
    expect(frames.map((f) => f.seq)).toEqual([1, 2, 3]);
    expect(ws.of("resize")[0]).toMatchObject({ cols: 44, rows: 30 });
    expect(ws.of("in").map((f) => text(f.data))).toEqual(["\x03", "ls\r"]);
    for (const f of frames) expect(await worker.verify(f, "conn-0001aa")).toBe(true);
    socket.close();
  });

  it("không gửi `control` khi kết nối đổi trong lúc chờ passkey", async () => {
    const socket = make();
    const ws = await connected(socket, "conn-0001aa");
    let resolve: (p: ControlProof) => void = () => {};
    const result = socket.requestControl(() => new Promise((r) => (resolve = r)));
    ws.frame(hello("conn-0002bb"));
    resolve(await prove("conn-0001aa"));
    expect(await result).toBe(false);
    expect(ws.of("control")).toEqual([]);
    expect(socket.control).toBe("none");
    socket.close();
  });

  it("huỷ passkey thì về chỉ xem", async () => {
    const socket = make();
    await connected(socket, "conn-0001aa");
    await expect(socket.requestControl(() => Promise.reject(new Error("huỷ")))).rejects.toThrow("huỷ");
    expect(socket.control).toBe("none");
    socket.close();
  });

  it("mất mạng rồi nối lại: gửi resumeToken, không xin passkey lại, seq đi tiếp với connId mới", async () => {
    const worker = new FakeWorker();
    await worker.init();
    const { socket, ws } = await grantedSocket(worker);
    socket.sendInput("a");
    await until(() => ws.of("in").length === 1);
    ws.frame(out(0, "a"));

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    ws.drop(1006);
    expect(connections.at(-1)).toEqual({ kind: "reconnecting", attempt: 1 });
    // Phím gõ khi mất mạng bị bỏ: phát lại phím cũ vào CLI là nguy hiểm.
    socket.sendInput("lost");
    await vi.advanceTimersByTimeAsync(backoffMs(1));
    vi.useRealTimers();
    await until(() => FakeSocket.all.length === 2);
    const ws2 = last();
    ws2.open();
    expect(ws2.sent[0]).toEqual({ t: "resume", after: 0, resumeToken: "dG9rMQ", deviceId: DEVICE_ID });
    expect(socket.control).toBe("resuming");
    ws2.frame(hello("conn-0003cc"));
    // Gõ trong lúc chờ worker cấp lại: xếp hàng, gửi sau khi có quyền.
    socket.sendInput("b");
    expect(ws2.of("in")).toEqual([]);
    ws2.frame({ t: "granted", workerEphPub: worker.pub, resumeToken: "dG9rMQ" });
    await until(() => ws2.of("in").length === 1);
    expect(attempts).toHaveLength(1);
    const frame = ws2.of("in")[0] ?? {};
    expect(text(frame.data)).toBe("b");
    expect(frame.seq).toBe(2);
    expect(await worker.verify(frame, "conn-0003cc")).toBe(true);
    socket.close();
  });

  it("hàng đợi khi nối lại có trần", async () => {
    const worker = new FakeWorker();
    await worker.init();
    const { socket, ws } = await grantedSocket(worker);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    ws.drop(1006);
    await vi.advanceTimersByTimeAsync(backoffMs(1));
    vi.useRealTimers();
    await until(() => FakeSocket.all.length === 2);
    const ws2 = last();
    ws2.open();
    ws2.frame(hello("conn-0003cc"));
    for (let i = 0; i < MAX_QUEUED_INPUTS + 10; i++) socket.sendInput("x");
    ws2.frame({ t: "granted", workerEphPub: worker.pub, resumeToken: "dG9rMg" });
    await until(() => ws2.of("in").length === MAX_QUEUED_INPUTS);
    socket.close();
  });

  it("worker từ chối nối lại: bỏ khoá, lần nối sau không gửi token", async () => {
    const worker = new FakeWorker();
    await worker.init();
    const { socket, ws } = await grantedSocket(worker);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    ws.drop(1006);
    await vi.advanceTimersByTimeAsync(backoffMs(1));
    vi.useRealTimers();
    await until(() => FakeSocket.all.length === 2);
    const ws2 = last();
    ws2.open();
    ws2.frame(hello("conn-0003cc"));
    ws2.frame({ t: "denied", code: "AUTH_STALE", message: "Hết hạn" });
    expect(denied).toEqual(["AUTH_STALE"]);
    expect(socket.control).toBe("none");
    socket.sendInput("x");
    expect(ws2.of("in")).toEqual([]);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    ws2.drop(1006);
    await vi.advanceTimersByTimeAsync(backoffMs(1));
    vi.useRealTimers();
    await until(() => FakeSocket.all.length === 3);
    last().open();
    expect(last().sent[0]).toEqual({ t: "resume", after: -1 });
    socket.close();
  });

  it("bị giành quyền (`revoked taken`) thì thôi gõ", async () => {
    const worker = new FakeWorker();
    await worker.init();
    const { socket, ws } = await grantedSocket(worker);
    ws.frame({ t: "revoked", reason: "taken" });
    expect(revoked).toEqual(["taken"]);
    expect(socket.control).toBe("none");
    socket.sendInput("x");
    await new Promise((r) => setImmediate(r));
    expect(ws.of("in")).toEqual([]);
    socket.close();
  });

  it("trả quyền gửi `release`", async () => {
    const worker = new FakeWorker();
    await worker.init();
    const { socket, ws } = await grantedSocket(worker);
    socket.release();
    expect(ws.of("release")).toHaveLength(1);
    expect(socket.control).toBe("none");
    socket.close();
  });

  it("hub báo lỗi khi đang xin quyền thì về chỉ xem", async () => {
    const socket = make();
    const ws = await connected(socket, "conn-0001aa");
    await socket.requestControl(prove);
    ws.frame({ t: "error", code: "MACHINE_OFFLINE", message: "Máy offline" });
    expect(errors).toEqual(["MACHINE_OFFLINE"]);
    expect(socket.control).toBe("none");
    socket.close();
  });
});
