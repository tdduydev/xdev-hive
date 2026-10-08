import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { TerminalHubFrame, TerminalMachineFrame } from "@xdev-hive/core";
import type { IPty } from "node-pty";
import { MachineTerminalAgent, type AgentHost, type AgentPty, type AgentRecorder } from "#desktop/main/pty/relay-agent.ts";
import { PtySupervisor, type Audit } from "#desktop/main/pty/supervisor.ts";
import { ResourceLocks } from "#desktop/main/resource-locks.ts";

// 69e, the machine's half: faults the hub cannot see or prevent. Partition (lease), lost acks (dedup), a recorder
// that fails (no ack, no write), a browser that stops reading (pause), checkouts already in use (locks).
const ID = "00000000-0000-4000-8000-000000000001";
const b64 = (s: string) => Buffer.from(s).toString("base64");

type Cb = Parameters<AgentHost["pty"]>[0];
class FakePty implements AgentPty {
  calls: string[] = [];
  written: string[] = [];
  cb: Cb;
  stopped = false;
  constructor(cb: Cb) { this.cb = cb; }
  spawn(_p: string, cols: number, rows: number) { this.cb.audit({ type: "spawn", cols, rows }); this.calls.push("spawn"); }
  write(data: Buffer) { this.cb.audit({ type: "sensitive-input", bytes: data.length }); this.written.push(data.toString()); this.calls.push("write"); }
  resize(cols: number, rows: number) { this.cb.audit({ type: "resize", cols, rows }); this.calls.push("resize"); }
  pause() { this.calls.push("pause"); }
  resume() { this.calls.push("resume"); }
  stop() {
    if (!this.stopped) { this.stopped = true; this.calls.push("stop"); }
    return Promise.resolve();
  }
}
class FakeRecorder implements AgentRecorder {
  events: string[] = [];
  failInput = false;
  spawn() { this.events.push("spawn"); }
  resize() { this.events.push("resize"); }
  input(bytes: number) { if (this.failInput) throw new Error("diskFull"); this.events.push(`input:${bytes}`); }
  output() { this.events.push("output"); }
  close(reason: string) { this.events.push(`close:${reason}`); }
}

function setup(o: { draining?: boolean; locks?: ResourceLocks; pty?: (cb: Cb) => AgentPty } = {}) {
  const clock = { t: 0 };
  const sent: TerminalMachineFrame[] = [];
  const ptys: FakePty[] = [];
  const recorder = new FakeRecorder();
  const locks = o.locks ?? new ResourceLocks();
  const agent = new MachineTerminalAgent({
    pty: o.pty ?? ((cb) => { const p = new FakePty(cb); ptys.push(p); return p; }),
    recorder: () => recorder,
    locks,
    draining: () => !!o.draining,
    clock: () => clock.t,
  }, 1_000_000);
  let online = true;
  agent.connected((f) => { if (!online) return false; sent.push(f); return true; });
  const of = <T extends TerminalMachineFrame["type"]>(t: T) => sent.filter((f) => f.type === t) as Array<Extract<TerminalMachineFrame, { type: T }>>;
  const open = (extra: Partial<Extract<TerminalHubFrame, { type: "open" }>> = {}) =>
    agent.receive({ type: "open", sessionId: ID, project: "app", machineId: "mini", checkoutRef: "repo", epoch: 0, leaseMs: 30_000, policyVersion: 1, cols: 80, rows: 24, ...extra });
  const input = (inputSeq: number, data: string, epoch = 0) => agent.receive({ type: "input", sessionId: ID, epoch, inputSeq, data: b64(data) });
  return { agent, clock, sent, of, ptys, recorder, locks, open, input, offline: () => { online = false; agent.disconnected(); }, online: () => { online = true; } };
}
const flush = () => new Promise((r) => setImmediate(r));

describe("69e machine agent: input", () => {
  it("writes each input once, after the recorder has it, and acks a duplicate without writing it again", () => {
    const t = setup();
    t.open();
    assert.equal(t.of("report")[0]!.state, "active");
    t.input(1, "ls\r");
    t.input(1, "ls\r");
    t.input(3, "skipped");
    t.input(2, "pwd\r", 5);
    assert.deepEqual(t.ptys[0]!.written, ["ls\r"]);
    assert.deepEqual(t.recorder.events, ["spawn", "input:3"]);
    assert.deepEqual(t.of("inputAck").map((f) => f.inputSeq), [1, 1]);
    assert.deepEqual(t.of("inputReject").map((f) => f.reason), ["gap", "futureEpoch"]);
    t.agent.dispose();
  });

  it("takes a new writer epoch only from the hub's lease, and refuses the old one", () => {
    const t = setup();
    t.open();
    t.input(1, "a");
    t.agent.receive({ type: "lease", sessionId: ID, epoch: 1, leaseMs: 30_000 });
    t.input(2, "late from old tab", 0);
    t.input(1, "b", 1);
    assert.deepEqual(t.ptys[0]!.written, ["a", "b"]);
    assert.equal(t.of("inputReject")[0]!.reason, "staleEpoch");
    t.agent.dispose();
  });

  it("does not ack or write input the recorder could not record, and ends the session", async () => {
    const t = setup();
    t.open();
    t.recorder.failInput = true;
    t.input(1, "secret\r");
    await flush();
    assert.deepEqual(t.ptys[0]!.written, []);
    assert.equal(t.of("inputAck").length, 0);
    assert.equal(t.of("inputReject")[0]!.reason, "auditFailed");
    const end = t.of("report").at(-1)!;
    assert.deepEqual([end.state, end.reason], ["failed", "auditFailed"]);
    t.agent.dispose();
  });
});

describe("69e machine agent: lease", () => {
  it("kills the shell when the hub stops renewing, and tells the hub after it is back", async () => {
    const t = setup();
    t.open({ leaseMs: 30_000 });
    t.offline();
    t.clock.t = 29_999;
    t.agent.tick();
    assert.equal(t.ptys[0]!.stopped, false);
    // No input is taken once the lease is gone, even before the tick kills.
    t.clock.t = 30_000;
    t.online();
    t.input(1, "x");
    assert.deepEqual(t.ptys[0]!.written, []);
    t.offline();
    t.agent.tick();
    await flush();
    assert.equal(t.ptys[0]!.stopped, true);
    const before = t.sent.length;
    t.online();
    t.agent.connected((f) => { t.sent.push(f); return true; });
    const after = t.sent.slice(before);
    assert.equal(after[0]!.type, "hello");
    const report = after.find((f) => f.type === "report") as Extract<TerminalMachineFrame, { type: "report" }>;
    assert.deepEqual([report.state, report.reason, report.cleanupUncertain], ["expired", "leaseLost", true]);
    assert.equal(t.agent.busy, false);
    t.agent.dispose();
  });

  it("stops everything locally without the hub", async () => {
    const t = setup();
    t.open();
    t.offline();
    await t.agent.stopAll();
    assert.equal(t.ptys[0]!.stopped, true);
    assert.ok(t.recorder.events.includes("close:emergencyStop"));
    t.agent.dispose();
  });
});

describe("69e machine agent: output", () => {
  it("keeps output in the ring until a replay, then sends from there with a gap when it no longer reaches back", () => {
    const t = setup();
    t.open();
    t.ptys[0]!.cb.output("one");
    t.ptys[0]!.cb.output("two");
    assert.equal(t.of("output").length, 0);
    t.agent.receive({ type: "replay", sessionId: ID, afterSeq: 1 });
    assert.deepEqual(t.of("output").map((f) => [f.outputSeq, Buffer.from(f.data, "base64").toString()]), [[2, "two"]]);
    t.ptys[0]!.cb.output("three");
    assert.equal(t.of("output").at(-1)!.outputSeq, 3);
    // 5 minutes later the ring is empty: a reattach is told about the gap.
    t.agent.receive({ type: "detach", sessionId: ID });
    t.clock.t = 5 * 60_000 + 1;
    t.agent.receive({ type: "lease", sessionId: ID, epoch: 0, leaseMs: 30_000 });
    t.agent.receive({ type: "replay", sessionId: ID, afterSeq: 1 });
    assert.equal(t.of("gap")[0]!.firstAvailableSeq, 4);
    assert.ok(t.recorder.events.filter((e) => e === "output").length === 3);
    t.agent.dispose();
  });

  it("pauses the PTY while the browser is behind and resumes on its ack", () => {
    const t = setup();
    t.open();
    t.agent.receive({ type: "replay", sessionId: ID, afterSeq: 0 });
    const big = "y".repeat(32 * 1024);
    for (let i = 0; i < 33; i++) t.ptys[0]!.cb.output(big);
    assert.ok(t.ptys[0]!.calls.includes("pause"));
    t.agent.receive({ type: "ack", sessionId: ID, outputSeq: 33 });
    assert.equal(t.ptys[0]!.calls.at(-1), "resume");
    t.agent.dispose();
  });
});

describe("69e machine agent: locks and drain", () => {
  it("refuses a checkout another job holds, and holds it until the shell is gone", async () => {
    const locks = new ResourceLocks();
    let merging = true;
    locks.probe((project, checkout) => (merging && project === "app" && checkout === "repo" ? "merge" : null));
    const t = setup({ locks });
    t.open();
    assert.deepEqual([t.of("report")[0]!.state, t.of("report")[0]!.reason], ["failed", "spawnFailed"]);
    assert.equal(t.ptys.length, 0);
    merging = false;
    t.open();
    assert.equal(locks.holder("app", "repo"), "terminal");
    assert.equal(locks.holder("other", "repo"), null);
    assert.ok(locks.has("terminal"));
    t.ptys[0]!.cb.exit({ exitCode: 0, cleanupUncertain: true });
    await flush();
    assert.equal(locks.holder("app", "repo"), null);
    assert.equal(t.of("report").at(-1)!.reason, "exited");
    t.agent.dispose();
  });

  it("opens no shell while the app waits to update, and no worktree it cannot vouch for", () => {
    const t = setup({ draining: true });
    t.open();
    assert.equal(t.ptys.length, 0);
    const u = setup();
    u.open({ checkoutRef: "worktree:R-1" });
    assert.equal(u.ptys.length, 0);
    assert.equal(u.of("report")[0]!.reason, "spawnFailed");
    t.agent.dispose();
    u.agent.dispose();
  });
});

describe("69e machine agent with the real supervisor", { skip: process.platform === "win32" }, () => {
  it("audits through the supervisor before the PTY gets the bytes, and fails closed on audit failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hive-relay-agent-"));
    const file = join(dir, "policy.json");
    writeFileSync(file, JSON.stringify({ enabled: true, osUser: userInfo().username, projects: { app: dir }, maxSessionMs: 60_000 }), { mode: 0o600 });
    const order: string[] = [];
    const fake = { pid: 2 ** 22 + 12345, write: (d: string | Buffer) => order.push(`pty:${d.length}`), resize() {}, pause() {}, resume() {}, onData() {}, onExit() {} } as unknown as IPty;
    let fail = false;
    const t = setup({
      pty: (cb) => new PtySupervisor({
        policyFile: file, backend: { spawn: () => fake },
        audit: (e: Audit) => { if (fail && e.type === "sensitive-input") throw new Error("diskFull"); order.push(e.type); return cb.audit(e); },
        output: cb.output, exit: cb.exit,
      }),
    });
    try {
      t.open();
      t.input(1, "abc");
      assert.deepEqual(order, ["spawn", "sensitive-input", "pty:3"]);
      assert.equal(t.of("inputAck").length, 1);
      fail = true;
      t.input(2, "nope");
      assert.equal(order.filter((o) => o.startsWith("pty:")).length, 1);
      assert.equal(t.of("inputAck").length, 1);
    } finally {
      t.agent.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
