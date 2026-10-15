// Bộ đệm vòng và bơm output cho người xem phiên máy cá nhân (specs/010 T030, D9), không cần DB: bản ghi là hàm giả.
import { REMOTE_LIMITS, type RemoteServerFrame } from "@xdev-hive/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Bucket,
  type ChunkPage,
  type LiveSession,
  liveSession,
  pushOutput,
  RemoteConn,
  RING_BYTES,
  resetMachineBuckets,
  ringAfter,
  SYNC_TAIL_BYTES,
  trackSession,
  untrackSession,
} from "./live.ts";

let n = 0;
const KB = 1024;

function session(machineId = "m1"): LiveSession {
  n++;
  return trackSession({
    id: `s${n}`,
    orgId: "o",
    teamId: "t",
    machineId: `${machineId}-${n}`,
    ownerUserId: "u",
    threadId: null,
  });
}

const bytes = (size: number, fill = "x") => Buffer.alloc(size, fill);

/** Trình duyệt giả: ghi khung nhận được; `backlog` đặt tay để giả trình duyệt đọc chậm. */
function viewer(live: LiveSession, opts: { backlog?: () => number } = {}) {
  const frames: RemoteServerFrame[] = [];
  const conn = new RemoteConn({
    connId: `c${n}`,
    userId: "u",
    sessionId: live.id,
    machineId: live.machineId,
    owner: true,
    canControl: true,
    sink: { send: (f) => frames.push(f), backlog: opts.backlog ?? (() => 0) },
  });
  live.viewers.add({ userId: "u", canInput: false, send: () => {}, close: () => {}, remote: conn });
  const outs = () => frames.flatMap((f) => (f.t === "out" ? [f.seq] : []));
  return { conn, frames, outs };
}

/** Bản ghi giả theo trang như `readChunks`. */
function store(chunks: Array<{ seq: number; data: Buffer }>, page = 3) {
  const reads: number[] = [];
  const readPage = async (after: number): Promise<ChunkPage> => {
    reads.push(after);
    const rest = chunks.filter((c) => c.seq > after);
    return {
      chunks: rest.slice(0, page).map((c) => ({ seq: c.seq, data: c.data.toString("base64") })),
      more: rest.length > page,
    };
  };
  return { readPage, reads };
}

beforeEach(() => {
  resetMachineBuckets();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("bộ đệm vòng", () => {
  it("giữ tối đa 512 KiB; phần đã trôi thì ringAfter trả null để người gọi đọc bản ghi", () => {
    const live = session();
    for (let seq = 0; seq < 20; seq++) pushOutput(live, seq, bytes(32 * KB));
    expect(RING_BYTES).toBe(512 * KB);
    expect(live.ringBytes).toBeLessThanOrEqual(RING_BYTES);
    expect(live.ring[0]?.seq).toBe(4);
    expect(ringAfter(live, 2)).toBeNull();
    expect(ringAfter(live, 3)?.map((c) => c.seq)).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    expect(ringAfter(live, 18)?.map((c) => c.seq)).toEqual([19]);
    untrackSession(live.id);
    expect(liveSession(live.id)).toBeUndefined();
  });
});

describe("Bucket", () => {
  it("hồi theo thời gian, không vượt burst; spend cho phép âm", () => {
    const b = new Bucket(100, 200, 0);
    expect(b.take(150, 0)).toBe(true);
    expect(b.take(100, 0)).toBe(false);
    expect(b.available(500)).toBe(100);
    expect(b.available(10_000)).toBe(200);
    b.spend(500, 10_000);
    expect(b.available(10_000)).toBe(-300);
    expect(b.take(1, 12_000)).toBe(false);
    expect(b.take(1, 13_100)).toBe(true);
  });
});

describe("RemoteConn", () => {
  it("chưa resume thì bỏ output trực tiếp; resume từ bộ đệm rồi nhận tiếp không trùng không thiếu", async () => {
    const live = session();
    const v = viewer(live);
    pushOutput(live, 0, bytes(10));
    expect(v.outs()).toEqual([]);
    pushOutput(live, 1, bytes(10));
    await v.conn.resume(-1, store([]).readPage, () => liveSession(live.id));
    expect(v.outs()).toEqual([0, 1]);
    pushOutput(live, 2, bytes(10));
    pushOutput(live, 2, bytes(10));
    expect(v.outs()).toEqual([0, 1, 2]);
  });

  it("nối lại với offset: chỉ gửi phần sau `after`", async () => {
    const live = session();
    for (let seq = 0; seq < 5; seq++) pushOutput(live, seq, bytes(10));
    const v = viewer(live);
    await v.conn.resume(2, store([]).readPage, () => liveSession(live.id));
    expect(v.outs()).toEqual([3, 4]);
  });

  it("bộ đệm không phủ `after`: đọc bản ghi theo trang rồi nối sang bộ đệm", async () => {
    const live = session();
    const all = Array.from({ length: 24 }, (_, seq) => ({ seq, data: bytes(32 * KB) }));
    for (const c of all) pushOutput(live, c.seq, c.data);
    expect(live.ring[0]?.seq).toBeGreaterThan(0);
    const v = viewer(live);
    const db = store(all);
    await v.conn.resume(-1, db.readPage, () => liveSession(live.id));
    expect(v.outs()).toEqual(all.map((c) => c.seq));
    expect(db.reads.length).toBeGreaterThan(0);
    expect(v.frames.some((f) => f.t === "sync")).toBe(false);
  });

  it("hub vừa khởi động lại (bộ đệm rỗng): phát lại cả bản ghi, rồi output mới đi tiếp", async () => {
    const live = session();
    const v = viewer(live);
    const db = store(Array.from({ length: 7 }, (_, seq) => ({ seq, data: bytes(10) })));
    await v.conn.resume(-1, db.readPage, () => liveSession(live.id));
    expect(v.outs()).toEqual([0, 1, 2, 3, 4, 5, 6]);
    pushOutput(live, 7, bytes(10));
    expect(v.outs()).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("phiên đã kết thúc (không còn trong bộ nhớ): đọc hết bản ghi", async () => {
    const live = session();
    untrackSession(live.id);
    const v = viewer(live);
    const db = store(
      Array.from({ length: 5 }, (_, seq) => ({ seq, data: bytes(10) })),
      2,
    );
    await v.conn.resume(1, db.readPage, () => liveSession(live.id));
    expect(v.outs()).toEqual([2, 3, 4]);
    expect(db.reads).toEqual([1, 3]);
  });

  it("quá 512 KiB/s một người xem: bỏ phần giữa rồi gửi sync và đuôi bộ đệm", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const live = session();
    const v = viewer(live);
    await v.conn.resume(-1, store([]).readPage, () => liveSession(live.id));
    for (let seq = 0; seq < 24; seq++) pushOutput(live, seq, bytes(32 * KB));
    const direct = v.outs().length;
    expect(direct).toBe(REMOTE_LIMITS.viewerRateBytes / (32 * KB));
    expect(v.conn.lagging).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(v.conn.lagging).toBe(false);
    const sync = v.frames.find((f) => f.t === "sync");
    expect(sync).toEqual({ t: "sync", after: 23 - SYNC_TAIL_BYTES / (32 * KB) });
    expect(v.outs().at(-1)).toBe(23);
    pushOutput(live, 24, bytes(10));
    expect(v.outs().at(-1)).toBe(24);
  });

  it("2 MiB/s chung cho mọi người xem một máy", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const live = session();
    const viewers = Array.from({ length: 6 }, () => viewer(live));
    for (const v of viewers) await v.conn.resume(-1, store([]).readPage, () => liveSession(live.id));
    for (let seq = 0; seq < 16; seq++) pushOutput(live, seq, bytes(32 * KB));
    const sent = viewers.reduce((total, v) => total + v.outs().length * 32 * KB, 0);
    expect(sent).toBeLessThanOrEqual(REMOTE_LIMITS.machineRateBytes);
    expect(viewers.some((v) => v.conn.lagging)).toBe(true);
  });

  it("đệm gửi quá 1 MiB: dừng gửi, chờ trình duyệt đọc bớt rồi mới đồng bộ", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let backlog = 0;
    const live = session();
    const v = viewer(live, { backlog: () => backlog });
    await v.conn.resume(-1, store([]).readPage, () => liveSession(live.id));
    pushOutput(live, 0, bytes(10));
    backlog = REMOTE_LIMITS.viewerBacklogBytes + 1;
    pushOutput(live, 1, bytes(10));
    pushOutput(live, 2, bytes(10));
    expect(v.outs()).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(v.outs()).toEqual([0]);
    backlog = 0;
    await vi.advanceTimersByTimeAsync(300);
    // Phần thiếu nhỏ hơn đuôi đồng bộ: gửi bù thẳng, không cần xoá màn hình.
    expect(v.outs()).toEqual([0, 1, 2]);
    expect(v.frames.some((f) => f.t === "sync")).toBe(false);
  });

  it("đóng kết nối thì không gửi gì nữa", async () => {
    const live = session();
    const v = viewer(live);
    await v.conn.resume(-1, store([]).readPage, () => liveSession(live.id));
    v.conn.close();
    pushOutput(live, 0, bytes(10));
    expect(v.frames).toEqual([]);
  });
});
