import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  InputGate,
  OutputRing,
  OutputWindow,
  TERMINAL_LIMITS,
  TerminalLease,
  terminalHubFrameSchema,
  terminalMachineFrameSchema,
  TokenBucket,
} from "@xdev-hive/core";
import { encodeWsFrame, WS_OP, WsReader } from "@xdev-hive/core/node";

const b64 = (n: number, fill = "a") => Buffer.from(fill.repeat(n)).toString("base64");
const clock = (t = 0) => {
  const c = { t, now: () => c.t };
  return c;
};

describe("69e output ring", () => {
  it("numbers output from 1 and replays only what came after", () => {
    const c = clock();
    const ring = new OutputRing(c.now);
    for (let i = 0; i < 3; i++) ring.push(b64(10));
    assert.equal(ring.lastSeq, 3);
    assert.deepEqual(ring.since(1).chunks.map((x) => x.seq), [2, 3]);
    assert.equal(ring.since(0).gap, null);
    assert.deepEqual(ring.since(3).chunks, []);
  });

  it("drops the oldest past its byte or time budget and says where the gap is", () => {
    const c = clock();
    const ring = new OutputRing(c.now, 25, 1000);
    for (let i = 0; i < 3; i++) ring.push(b64(10));
    assert.equal(ring.bytes, 20);
    assert.deepEqual(ring.since(0), { gap: 2, chunks: ring.since(1).chunks });
    c.t = 2000;
    // Everything aged out: a reattach gets a gap at the next seq, not stale output.
    assert.deepEqual(ring.since(0), { gap: 4, chunks: [] });
    assert.equal(ring.bytes, 0);
    assert.throws(() => ring.push("not base64!"));
  });
});

describe("69e input gate", () => {
  it("writes each seq of the current epoch once, in order", () => {
    const g = new InputGate(0);
    assert.equal(g.check(0, 1), "write");
    g.written();
    assert.equal(g.check(0, 1), "duplicate");
    assert.equal(g.check(0, 3), "gap");
    assert.equal(g.check(0, 2), "write");
  });

  it("moves epoch only when the hub says so, and refuses the old writer", () => {
    const g = new InputGate(1);
    assert.equal(g.check(2, 1), "futureEpoch");
    g.setEpoch(2);
    assert.equal(g.check(1, 1), "staleEpoch");
    assert.equal(g.check(2, 1), "write");
    g.setEpoch(1);
    assert.equal(g.epoch, 2);
  });
});

describe("69e lease and flow control", () => {
  it("lease runs out on the monotonic clock and never extends past leaseMs", () => {
    const c = clock();
    const l = new TerminalLease(c.now, 10 * TERMINAL_LIMITS.leaseMs);
    assert.equal(l.remaining(), TERMINAL_LIMITS.leaseMs);
    c.t = TERMINAL_LIMITS.leaseMs - 1;
    assert.equal(l.expired(), false);
    l.renew(1);
    c.t = TERMINAL_LIMITS.leaseMs;
    assert.equal(l.expired(), true);
  });

  it("token bucket allows the burst, then the rate", () => {
    const c = clock();
    const b = new TokenBucket(c.now, 1000, 2000);
    assert.equal(b.take(2000), true);
    assert.equal(b.take(1), false);
    c.t = 500;
    assert.equal(b.take(500), true);
    assert.equal(b.take(1), false);
  });

  it("window pauses at high water, lets go of a slow or overflowing reader", () => {
    const c = clock();
    const w = new OutputWindow(c.now, { high: 100, max: 300, slowMs: 1000 });
    assert.equal(w.sent(1, 60), "flowing");
    assert.equal(w.sent(2, 60), "paused");
    c.t = 999;
    assert.equal(w.state(), "paused");
    c.t = 1000;
    assert.equal(w.state(), "slow");
    assert.equal(w.ack(1), "flowing");
    assert.equal(w.unacked, 60);
    // A cumulative ack for output never sent changes nothing beyond what was sent.
    assert.equal(w.ack(99), "flowing");
    assert.equal(w.unacked, 0);
    w.sent(3, 400);
    assert.equal(w.state(), "overflow");
  });
});

describe("69e frames", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  it("refuses oversize data, unknown fields and a lease longer than the bound", () => {
    assert.equal(terminalMachineFrameSchema.safeParse({ type: "output", sessionId: id, epoch: 0, outputSeq: 1, data: b64(TERMINAL_LIMITS.outputFrameBytes) }).success, true);
    assert.equal(terminalMachineFrameSchema.safeParse({ type: "output", sessionId: id, epoch: 0, outputSeq: 1, data: b64(TERMINAL_LIMITS.outputFrameBytes + 1) }).success, false);
    assert.equal(terminalHubFrameSchema.safeParse({ type: "lease", sessionId: id, epoch: 0, leaseMs: TERMINAL_LIMITS.leaseMs + 1 }).success, false);
    assert.equal(terminalHubFrameSchema.safeParse({ type: "kill", sessionId: id, reason: "userClosed", command: "rm" }).success, false);
    // The open envelope names a checkout, never a path.
    assert.equal(terminalHubFrameSchema.safeParse({ type: "open", sessionId: id, project: "app", machineId: "m", checkoutRef: "/etc", epoch: 0, leaseMs: 1000, policyVersion: 1, cols: 80, rows: 24 }).success, false);
  });
});

describe("69e websocket codec", () => {
  it("reads masked frames split anywhere, and refuses unmasked, fragmented, binary and oversize ones", () => {
    const r = new WsReader(1024, true);
    const f = Buffer.concat([encodeWsFrame(WS_OP.text, "hello", true), encodeWsFrame(WS_OP.ping, "p", true)]);
    const got = [...f].flatMap((byte) => {
      const out = r.push(Buffer.from([byte]));
      assert.notEqual(out, "invalid");
      return out as Array<{ opcode: number; payload: Buffer }>;
    });
    assert.deepEqual(got.map((m) => [m.opcode, m.payload.toString()]), [[1, "hello"], [9, "p"]]);
    assert.equal(new WsReader(1024, true).push(encodeWsFrame(WS_OP.text, "x", false)), "invalid");
    assert.equal(new WsReader(1024, true).push(encodeWsFrame(WS_OP.binary, "x", true)), "invalid");
    const fragment = encodeWsFrame(WS_OP.text, "x", true);
    fragment[0] = fragment[0]! & 0x7f;
    assert.equal(new WsReader(1024, true).push(fragment), "invalid");
    // The declared length alone is enough to refuse: no payload is waited for.
    assert.equal(new WsReader(1024, true).push(encodeWsFrame(WS_OP.text, "x".repeat(2000), true).subarray(0, 4)), "invalid");
    const big = new WsReader(100_000, false);
    assert.equal((big.push(encodeWsFrame(WS_OP.text, "y".repeat(70_000), false)) as unknown[]).length, 1);
  });
});
