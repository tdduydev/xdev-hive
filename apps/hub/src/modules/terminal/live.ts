import { REMOTE_LIMITS, type RemoteServerFrame, type TerminalServerFrame } from "@xdev-hive/contracts";

export { consumeTicket, isRemoteTicket, issueRemoteTicket, issueTicket, type Ticket } from "./ticket.ts";

/**
 * Trạng thái sống của phiên terminal trong tiến trình hub giữ kết nối worker: bộ đệm vòng output (để trình duyệt nối
 * lại không phải đọc DB), danh sách trình duyệt đang xem và vé WebSocket. Như `fleet/connections.ts`, nhiều tiến trình
 * hub thì mỗi tiến trình chỉ biết phiên của máy nối vào nó (plan 010 D8).
 */

/** Đuôi output giữ trong bộ nhớ mỗi phiên; TUI vẽ lại khi đổi cỡ nên đuôi cộng một lần resize là đủ dựng màn hình. */
export const RING_BYTES = REMOTE_LIMITS.replayBytes;

/**
 * Đồng bộ lại chỉ gửi chừng này byte cuối: đủ để TUI vẽ lại màn hình, và nhỏ hơn hẳn hạn mức một giây của người xem
 * nên người xem chậm không lại tụt ngay sau khi vừa đồng bộ.
 */
export const SYNC_TAIL_BYTES = 128 * 1024;

export interface Viewer {
  userId: string;
  canInput: boolean;
  send(frame: TerminalServerFrame): void;
  close(code: number, reason: string): void;
  /** Kết nối xem phiên máy cá nhân: output đi qua giới hạn băng thông của `RemoteConn` thay vì `send`. */
  remote?: RemoteConn;
}

export interface Grant {
  userId: string;
  deviceId: string;
  connId: string;
  /** Vô hạn khi kết nối còn mở; đóng thì còn `resumeSec` như worker (FR-021). */
  expiresAt: number;
}

/** Phần điều khiển từ xa của phiên máy cá nhân. Quyền thật nằm ở worker; hub chỉ nhớ để chuyển đúng kết nối. */
export interface RemoteLive {
  controller: "local" | "remote" | null;
  /** `resumeToken` → thiết bị đã được cấp: `term_control` nối lại phải mang đúng userId/deviceId của lần cấp. */
  grants: Map<string, Grant>;
}

export interface LiveSession {
  id: string;
  orgId: string;
  teamId: string;
  machineId: string;
  ownerUserId: string;
  threadId: string | null;
  ring: Array<{ seq: number; data: Buffer }>;
  ringBytes: number;
  viewers: Set<Viewer>;
  remote: RemoteLive;
}

const sessions = new Map<string, LiveSession>();

export function trackSession(s: Omit<LiveSession, "ring" | "ringBytes" | "viewers" | "remote">): LiveSession {
  const existing = sessions.get(s.id);
  if (existing) return existing;
  const live: LiveSession = {
    ...s,
    ring: [],
    ringBytes: 0,
    viewers: new Set(),
    remote: { controller: null, grants: new Map() },
  };
  sessions.set(s.id, live);
  return live;
}

export function liveSession(id: string): LiveSession | undefined {
  return sessions.get(id);
}

export function liveSessions(): LiveSession[] {
  return [...sessions.values()];
}

/** Phiên đã kết thúc: báo trạng thái cuối cho người xem rồi bỏ bộ đệm (bản ghi vẫn còn trong DB). */
export function untrackSession(id: string): void {
  sessions.delete(id);
}

export function pushOutput(live: LiveSession, seq: number, data: Buffer): void {
  live.ring.push({ seq, data });
  live.ringBytes += data.length;
  while (live.ringBytes > RING_BYTES && live.ring.length > 1) {
    const dropped = live.ring.shift();
    live.ringBytes -= dropped?.data.length ?? 0;
  }
  let frame: TerminalServerFrame | undefined;
  for (const viewer of live.viewers) {
    if (viewer.remote) {
      viewer.remote.output(seq, data);
      continue;
    }
    frame ??= { t: "out", seq, data: data.toString("base64") };
    viewer.send(frame);
  }
}

/** Output sau `after` còn trong bộ đệm; null khi bộ đệm không còn đủ (người gọi đọc DB). */
export function ringAfter(live: LiveSession, after: number): Array<{ seq: number; data: Buffer }> | null {
  const first = live.ring[0];
  if (first && first.seq > after + 1) return null;
  return live.ring.filter((c) => c.seq > after);
}

/** Các lát cuối của bộ đệm, tổng không quá `max` byte (ít nhất một lát). */
export function ringTail(live: LiveSession, max: number): Array<{ seq: number; data: Buffer }> {
  let total = 0;
  let i = live.ring.length;
  while (i > 0) {
    const size = live.ring[i - 1]?.data.length ?? 0;
    if (total + size > max && i < live.ring.length) break;
    total += size;
    i--;
  }
  return live.ring.slice(i);
}

export function broadcast(live: LiveSession, frame: TerminalServerFrame): void {
  for (const viewer of live.viewers) viewer.send(frame);
}

/** Phiên theo cuộc trò chuyện leader, để đề xuất mới trong cuộc trò chuyện làm mới khung bên phải. */
export function sessionsOfThread(threadId: string): LiveSession[] {
  return liveSessions().filter((s) => s.threadId === threadId);
}

/** Kết nối từ xa đang xem phiên (bỏ người xem phiên Leader). */
export function remoteConns(live: LiveSession | undefined): RemoteConn[] {
  if (!live) return [];
  return [...live.viewers].flatMap((v) => (v.remote ? [v.remote] : []));
}

export function findConn(live: LiveSession | undefined, connId: string): RemoteConn | undefined {
  return remoteConns(live).find((c) => c.connId === connId);
}

/** Quyền cấp cho `resumeToken`, bỏ những quyền đã quá hạn nối lại. */
export function findGrant(live: LiveSession, resumeToken: string, now = Date.now()): Grant | undefined {
  for (const [token, g] of live.remote.grants) if (g.expiresAt <= now) live.remote.grants.delete(token);
  return live.remote.grants.get(resumeToken);
}

/** Token bucket; `spend` cho phép âm để phần phát lại cũng tính vào hạn mức của giây sau. */
export class Bucket {
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
  available(now = Date.now()): number {
    this.#tokens = Math.min(this.#burst, this.#tokens + ((now - this.#at) / 1000) * this.#rate);
    this.#at = now;
    return this.#tokens;
  }
  take(n: number, now = Date.now()): boolean {
    if (this.available(now) < n) return false;
    this.#tokens -= n;
    return true;
  }
  spend(n: number, now = Date.now()): void {
    this.available(now);
    this.#tokens -= n;
  }
}

/** Băng thông trực tiếp chung của mọi người xem các phiên trên một máy (D9). */
const machineBuckets = new Map<string, Bucket>();

function machineBucket(machineId: string): Bucket {
  let b = machineBuckets.get(machineId);
  if (!b) {
    b = new Bucket(REMOTE_LIMITS.machineRateBytes, REMOTE_LIMITS.machineRateBytes);
    machineBuckets.set(machineId, b);
  }
  return b;
}

/** Chỉ test dùng: bỏ hạn mức đã tiêu của các máy giữa hai ca. */
export function resetMachineBuckets(): void {
  machineBuckets.clear();
}

export interface RemoteSink {
  send(frame: RemoteServerFrame): void;
  /** Byte đã xếp chờ gửi tới trình duyệt (`ws.bufferedAmount`). */
  backlog(): number;
}

export interface ChunkPage {
  chunks: Array<{ seq: number; data: string }>;
  more: boolean;
}

/**
 * Một kết nối WS xem phiên máy cá nhân. Output trực tiếp qua hai hạn mức (người xem, máy) và giới hạn đệm gửi; vượt thì
 * bỏ phần giữa, chờ hồi rồi gửi `sync` kèm đuôi bộ đệm (D9). Bản ghi trong DB vẫn đủ, người dùng xem lại được.
 */
export class RemoteConn {
  readonly connId: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly machineId: string;
  /** Chủ máy: chỉ kết nối này được gửi `control`/`in`/`resize`; người xem khác gửi thì bị đóng 4403. */
  readonly owner: boolean;
  canControl: boolean;
  /** Thiết bị của lần `control` đang chờ worker trả lời. */
  pendingDeviceId: string | null = null;
  granted = false;
  closed = false;
  readonly #sink: RemoteSink;
  readonly #recoverMs: number;
  readonly #bucket = new Bucket(REMOTE_LIMITS.viewerRateBytes, REMOTE_LIMITS.viewerRateBytes);
  #lastSeq = -1;
  /** Chưa `resume` xong thì output trực tiếp bị bỏ: phần đó sẽ được gửi khi phát lại đuổi kịp bộ đệm. */
  #ready = false;
  #lagging = false;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(opts: {
    connId: string;
    userId: string;
    sessionId: string;
    machineId: string;
    owner: boolean;
    canControl: boolean;
    sink: RemoteSink;
    recoverMs?: number;
  }) {
    this.connId = opts.connId;
    this.userId = opts.userId;
    this.sessionId = opts.sessionId;
    this.machineId = opts.machineId;
    this.owner = opts.owner;
    this.canControl = opts.canControl;
    this.#sink = opts.sink;
    this.#recoverMs = opts.recoverMs ?? 250;
  }

  get lastSeq(): number {
    return this.#lastSeq;
  }

  get lagging(): boolean {
    return this.#lagging;
  }

  send(frame: RemoteServerFrame): void {
    if (!this.closed) this.#sink.send(frame);
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.#timer);
  }

  output(seq: number, data: Buffer): void {
    if (this.closed || !this.#ready || this.#lagging || seq <= this.#lastSeq) return;
    // Thiếu lát giữa (worker gửi lại không theo thứ tự) cũng đồng bộ lại thay vì để màn hình lệch.
    const gap = seq !== this.#lastSeq + 1 && this.#lastSeq >= 0;
    if (gap || !this.#fits(data.length)) {
      this.#lag();
      return;
    }
    this.#out(seq, data.toString("base64"));
  }

  /**
   * Gửi output sau `after`: từ bộ đệm nếu còn, không thì đọc bản ghi theo trang rồi đuổi tới bộ đệm. Không có `await`
   * giữa lần đọc bộ đệm cuối và lúc nhận output trực tiếp, nên không mất lát nào ở chỗ nối.
   */
  async resume(after: number, readPage: (after: number) => Promise<ChunkPage>, live: () => LiveSession | undefined) {
    this.#ready = false;
    this.#lagging = false;
    clearTimeout(this.#timer);
    let cursor = after;
    this.#lastSeq = after;
    for (;;) {
      if (this.closed) return;
      const now = live();
      // Bộ đệm rỗng (hub vừa khởi động lại, chưa có output mới) không nói gì về phần trước: đọc bản ghi.
      const fromRing = now && now.ring.length > 0 ? ringAfter(now, cursor) : null;
      if (fromRing) {
        for (const c of fromRing) this.#replay(c.seq, c.data.toString("base64"), c.data.length);
        this.#lastSeq = fromRing.at(-1)?.seq ?? cursor;
        this.#ready = true;
        return;
      }
      if (now && this.#sink.backlog() > REMOTE_LIMITS.viewerBacklogBytes) return this.#jump(now);
      if (!now) await this.#drained();
      const page = await readPage(cursor);
      if (this.closed) return;
      for (const c of page.chunks) this.#replay(c.seq, c.data, Math.floor((c.data.length * 3) / 4));
      cursor = page.chunks.at(-1)?.seq ?? cursor;
      this.#lastSeq = cursor;
      if (page.more) continue;
      const end = live();
      // Output mới luôn vào bộ đệm trước khi tới người xem, nên bộ đệm còn rỗng nghĩa là bản ghi vừa đọc đã đủ.
      if (!end || end.ring.length === 0) {
        this.#ready = true;
        return;
      }
      if (ringAfter(end, cursor)) continue;
      // Bản ghi không phủ khoảng trước bộ đệm (phiên không ghi đủ, đã purge): đồng bộ lại từ đầu bộ đệm.
      return this.#jump(end);
    }
  }

  #fits(n: number): boolean {
    if (this.#sink.backlog() > REMOTE_LIMITS.viewerBacklogBytes) return false;
    const machine = machineBucket(this.machineId);
    if (this.#bucket.available() < n || machine.available() < n) return false;
    this.#bucket.spend(n);
    machine.spend(n);
    return true;
  }

  #out(seq: number, data: string): void {
    this.#lastSeq = seq;
    this.send({ t: "out", seq, data });
  }

  #replay(seq: number, data: string, bytes: number): void {
    this.#bucket.spend(bytes);
    this.send({ t: "out", seq, data });
  }

  #lag(): void {
    this.#lagging = true;
    this.#schedule();
  }

  #schedule(): void {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#recover(), this.#recoverMs);
    this.#timer.unref?.();
  }

  #recover(): void {
    if (this.closed || !this.#lagging) return;
    const live = sessions.get(this.sessionId);
    if (!live) {
      // Phiên đã kết thúc: người xem tự `resume` từ bản ghi khi cần.
      this.#lagging = false;
      return;
    }
    if (this.#sink.backlog() > REMOTE_LIMITS.viewerBacklogBytes / 2) {
      this.#schedule();
      return;
    }
    const pending = ringAfter(live, this.#lastSeq);
    const pendingBytes = pending?.reduce((n, c) => n + c.data.length, 0) ?? Number.POSITIVE_INFINITY;
    const gap = !pending || pendingBytes > SYNC_TAIL_BYTES;
    const chunks = gap ? ringTail(live, SYNC_TAIL_BYTES) : pending;
    const bytes = chunks.reduce((n, c) => n + c.data.length, 0);
    if (!this.#fits(bytes)) {
      this.#schedule();
      return;
    }
    const first = chunks[0];
    if (gap && first) this.send({ t: "sync", after: first.seq - 1 });
    for (const c of chunks) this.#out(c.seq, c.data.toString("base64"));
    this.#lagging = false;
  }

  /** Bỏ phần giữa: `sync` tới đầu đuôi bộ đệm rồi gửi đuôi. */
  #jump(live: LiveSession): void {
    const chunks = ringTail(live, SYNC_TAIL_BYTES);
    const first = chunks[0];
    if (first) this.send({ t: "sync", after: first.seq - 1 });
    for (const c of chunks) this.#replay(c.seq, c.data.toString("base64"), c.data.length);
    this.#lastSeq = chunks.at(-1)?.seq ?? this.#lastSeq;
    this.#ready = true;
  }

  /** Phiên đã kết thúc thì phát lại đủ, nhưng chờ trình duyệt đọc bớt để hub không giữ cả bản ghi trong bộ nhớ. */
  async #drained(): Promise<void> {
    while (!this.closed && this.#sink.backlog() > REMOTE_LIMITS.viewerBacklogBytes) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}
