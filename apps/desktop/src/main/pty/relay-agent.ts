// The machine's side of the terminal relay (spec 69 §6–§7, task 69e): it turns hub frames into PtySupervisor calls
// and PTY output into frames, and holds what must hold without the hub. A lease the hub stops renewing kills the
// shell; input is written once (dedup by epoch+seq) and acked only after the recorder has it; output waits in a RAM
// ring for a reattach, and stops being read while the browser is behind. Nothing here decides who may: the hub did,
// and the supervisor checks the machine's local policy again at every spawn and write.
import {
  InputGate,
  OutputRing,
  OutputWindow,
  TERMINAL_EXPIRE_REASONS,
  TERMINAL_FAIL_REASONS,
  TERMINAL_LIMITS,
  TERMINAL_REVOKE_REASONS,
  TerminalLease,
  TokenBucket,
  type TerminalHubFrame,
  type TerminalMachineFrame,
  type TerminalReason,
  type TerminalState,
} from "@xdev-hive/core";
import type { ResourceLocks } from "#desktop/main/resource-locks.ts";
import type { Audit } from "#desktop/main/pty/supervisor.ts";

/** What the agent needs of PtySupervisor; tests give it a real one over a fake backend. */
export interface AgentPty {
  spawn(project: string, cols: number, rows: number): void;
  write(data: Buffer): void;
  resize(cols: number, rows: number): void;
  pause(): void;
  resume(): void;
  stop(): Promise<void>;
}

/** What the agent needs of TerminalRecorder: synchronous, throwing when it can no longer record. */
export interface AgentRecorder {
  spawn(cols: number, rows: number): void;
  resize(cols: number, rows: number): void;
  input(bytes: number): void;
  output(data: Uint8Array): void;
  close(reason: TerminalReason, exitCode: number | null): void;
}

export interface AgentHost {
  /** A supervisor wired to these callbacks; `audit` must be passed on as its audit sink. */
  pty(cb: { audit: (e: Audit) => undefined; output: (data: string) => void; exit: (e: { exitCode: number; cleanupUncertain: boolean }) => void }): AgentPty;
  /** A fresh spool for this session; throws when the recorder is not ready (disk, key, quota). */
  recorder(sessionId: string): AgentRecorder;
  locks: ResourceLocks;
  /** The app waits to update: no new shell until it did (spec 69 §11). */
  draining(): boolean;
  clock?: () => number;
  log?: (line: string) => void;
}

interface Session {
  id: string;
  project: string;
  checkout: string;
  lease: TerminalLease;
  gate: InputGate;
  ring: OutputRing;
  window: OutputWindow;
  /** Output goes to the hub only between a replay and a detach (or a lost socket). */
  sending: boolean;
  paused: boolean;
  pty: AgentPty;
  recorder: AgentRecorder;
  unlock: () => void;
  input: TokenBucket;
  /** Set once the session is ending, with the reason the hub will hear. */
  ending: { state: TerminalState; reason: TerminalReason } | null;
  reported: boolean;
  /** The recorder refused an event: whatever the supervisor then throws is an audit failure, not a spawn one. */
  auditBroke: boolean;
}

const KILL_STATE = (reason: TerminalReason): TerminalState =>
  (TERMINAL_REVOKE_REASONS as readonly string[]).includes(reason) ? "revoked"
    : (TERMINAL_EXPIRE_REASONS as readonly string[]).includes(reason) ? "expired"
      : (TERMINAL_FAIL_REASONS as readonly string[]).includes(reason) ? "failed"
        : "closed";

export class MachineTerminalAgent {
  readonly #host: AgentHost;
  readonly #clock: () => number;
  readonly #sessions = new Map<string, Session>();
  #send: ((f: TerminalMachineFrame) => boolean) | null = null;
  /** Reports the hub has not heard yet (sent while it was away): flushed after the next hello. */
  #pending: TerminalMachineFrame[] = [];
  readonly #timer: ReturnType<typeof setInterval>;

  constructor(host: AgentHost, tickMs = 250) {
    this.#host = host;
    this.#clock = host.clock ?? (() => performance.now());
    this.#timer = setInterval(() => this.tick(), tickMs);
    this.#timer.unref();
  }

  /** A shell is open here: the update drain waits for it. */
  get busy(): boolean { return this.#sessions.size > 0; }
  get sessions(): string[] { return [...this.#sessions.keys()]; }

  // ── the hub connection ─────────────────────────────────────────────────────

  /** A socket to the hub is up: say what still runs, then what the hub missed. */
  connected(send: (f: TerminalMachineFrame) => boolean): void {
    this.#send = send;
    send({ type: "hello", protocol: 1, sessions: [...this.#sessions.keys()] });
    const pending = this.#pending;
    this.#pending = [];
    for (const f of pending) if (!send(f)) this.#pending.push(f);
  }

  /** The socket is gone: nobody reads output now, and the leases keep counting down. */
  disconnected(): void {
    this.#send = null;
    for (const s of this.#sessions.values()) this.#detach(s);
  }

  #out(f: TerminalMachineFrame): boolean {
    return !!this.#send?.(f);
  }

  #report(f: Extract<TerminalMachineFrame, { type: "report" }>): void {
    if (!this.#out(f)) this.#pending.push(f);
  }

  receive(f: TerminalHubFrame): void {
    if (f.type === "ping") {
      this.#out({ type: "pong", nonce: f.nonce });
      return;
    }
    if (f.type === "open") return this.#open(f);
    const s = this.#sessions.get(f.sessionId);
    if (!s) {
      // A kill for something already gone needs no answer; anything else for an unknown session is a stale frame.
      return;
    }
    switch (f.type) {
      case "lease":
        if (s.ending) return;
        s.lease.renew(f.leaseMs);
        s.gate.setEpoch(f.epoch);
        return;
      case "input":
        return this.#input(s, f);
      case "resize":
        if (s.ending || f.epoch !== s.gate.epoch || s.lease.expired()) return;
        try {
          s.pty.resize(f.cols, f.rows);
        } catch {
          this.#end(s, "failed", s.auditBroke ? "auditFailed" : "protocolError");
        }
        return;
      case "replay":
        return this.#replay(s, f.afterSeq);
      case "ack": {
        const state = s.window.ack(f.outputSeq);
        if (state === "flowing" && s.paused) {
          s.paused = false;
          s.pty.resume();
        }
        return;
      }
      case "detach":
        return this.#detach(s);
      case "kill":
        return this.#end(s, KILL_STATE(f.reason), f.reason);
    }
  }

  // ── sessions ───────────────────────────────────────────────────────────────

  #open(f: Extract<TerminalHubFrame, { type: "open" }>): void {
    if (this.#sessions.has(f.sessionId)) return;
    const fail = (reason: TerminalReason) =>
      this.#report({ type: "report", sessionId: f.sessionId, epoch: f.epoch, state: "failed", reason, exitCode: null, auditSeq: 0, cleanupUncertain: false });
    // One shell per machine (TERMINAL_LIMITS.maxSessionsPerMachine), and none while the app waits to update.
    if (this.#sessions.size >= TERMINAL_LIMITS.maxSessionsPerMachine || this.#host.draining()) return fail("spawnFailed");
    // A worktree needs a cwd the local policy vouches for; the supervisor knows only project roots so far.
    if (f.checkoutRef !== "repo") return fail("spawnFailed");
    const lock = this.#host.locks.acquire(f.project, f.checkoutRef, "terminal", f.sessionId);
    if ("heldBy" in lock) {
      this.#host.log?.(`terminal ${f.sessionId}: ${f.project}/${f.checkoutRef} is held by ${lock.heldBy}`);
      return fail("spawnFailed");
    }
    let recorder: AgentRecorder;
    try {
      recorder = this.#host.recorder(f.sessionId);
    } catch {
      lock.release();
      return fail("auditFailed");
    }
    let s!: Session;
    const pty = this.#host.pty({
      // The supervisor audits before it spawns, resizes or writes; a recorder that throws stops the shell.
      audit: (e) => {
        try {
          if (e.type === "spawn") recorder.spawn(e.cols!, e.rows!);
          else if (e.type === "resize") recorder.resize(e.cols!, e.rows!);
          else if (e.type === "sensitive-input") recorder.input(e.bytes!);
        } catch (err) {
          if (e.type !== "close") s.auditBroke = true;
          throw err;
        }
        return undefined;
      },
      output: (data) => this.#output(s, data),
      exit: (e) => this.#exited(s, e.exitCode, e.cleanupUncertain),
    });
    const now = this.#clock;
    s = {
      id: f.sessionId, project: f.project, checkout: f.checkoutRef, lease: new TerminalLease(now, f.leaseMs), gate: new InputGate(f.epoch),
      ring: new OutputRing(now), window: new OutputWindow(now), sending: false, paused: false, pty, recorder, unlock: lock.release,
      input: new TokenBucket(now, TERMINAL_LIMITS.inputBytesPerSecond), ending: null, reported: false, auditBroke: false,
    };
    this.#sessions.set(s.id, s);
    try {
      pty.spawn(f.project, f.cols, f.rows);
    } catch {
      const audit = s.auditBroke;
      this.#sessions.delete(s.id);
      lock.release();
      try { recorder.close(audit ? "auditFailed" : "spawnFailed", null); } catch { /* Already failed. */ }
      return fail(audit ? "auditFailed" : "spawnFailed");
    }
    this.#report({ type: "report", sessionId: s.id, epoch: f.epoch, state: "active", reason: "spawned", exitCode: null, auditSeq: 0, cleanupUncertain: false });
  }

  #input(s: Session, f: Extract<TerminalHubFrame, { type: "input" }>): void {
    const reject = (reason: "staleEpoch" | "futureEpoch" | "gap" | "rate" | "notActive" | "auditFailed"): void =>
      void this.#out({ type: "inputReject", sessionId: s.id, inputSeq: f.inputSeq, reason });
    if (s.ending || s.lease.expired()) return reject("notActive");
    const verdict = s.gate.check(f.epoch, f.inputSeq);
    // Written already, its ack lost: ack again, never write twice.
    if (verdict === "duplicate") return void this.#out({ type: "inputAck", sessionId: s.id, epoch: f.epoch, inputSeq: f.inputSeq });
    if (verdict !== "write") return reject(verdict);
    const bytes = Buffer.from(f.data, "base64");
    if (!s.input.take(bytes.length)) return reject("rate");
    try {
      // The supervisor records it (sensitive-input, byte count only) before the PTY gets it.
      s.pty.write(bytes);
    } catch {
      reject(s.auditBroke ? "auditFailed" : "notActive");
      return this.#end(s, "failed", s.auditBroke ? "auditFailed" : "protocolError");
    }
    s.gate.written();
    this.#out({ type: "inputAck", sessionId: s.id, epoch: f.epoch, inputSeq: f.inputSeq });
  }

  #output(s: Session, text: string): void {
    if (!s || s.ending) return;
    const bytes = Buffer.from(text, "utf8");
    try {
      s.recorder.output(bytes);
    } catch {
      // No output that is not recorded reaches anyone (spec §8: fail closed).
      return this.#end(s, "failed", "auditFailed");
    }
    for (let at = 0; at < bytes.length; at += TERMINAL_LIMITS.outputFrameBytes) {
      const part = bytes.subarray(at, at + TERMINAL_LIMITS.outputFrameBytes);
      const chunk = s.ring.push(part.toString("base64"));
      if (s.sending) this.#sendChunk(s, chunk.seq, chunk.data, chunk.bytes);
    }
  }

  #sendChunk(s: Session, seq: number, data: string, bytes: number): void {
    if (!this.#out({ type: "output", sessionId: s.id, epoch: s.gate.epoch, outputSeq: seq, data })) return this.#detach(s);
    const state = s.window.sent(seq, bytes);
    if (state !== "flowing" && !s.paused) {
      s.paused = true;
      s.pty.pause();
    }
  }

  #replay(s: Session, afterSeq: number): void {
    if (s.ending) return;
    s.window.reset();
    const { gap, chunks } = s.ring.since(afterSeq);
    if (gap !== null) this.#out({ type: "gap", sessionId: s.id, firstAvailableSeq: gap });
    s.sending = true;
    for (const c of chunks) {
      this.#sendChunk(s, c.seq, c.data, c.bytes);
      if (!s.sending) return;
    }
  }

  /** Nobody reads: keep the shell going into the ring (bounded), so it neither blocks forever nor grows memory. */
  #detach(s: Session): void {
    s.sending = false;
    s.window.reset();
    if (s.paused) {
      s.paused = false;
      s.pty.resume();
    }
  }

  /** Stops the shell for this reason: SIGTERM, SIGKILL after the grace, then the report. Idempotent. */
  #end(s: Session, state: TerminalState, reason: TerminalReason): void {
    if (s.ending) return;
    s.ending = { state, reason };
    s.sending = false;
    void s.pty.stop().then(() => this.#exited(s, null, true));
  }

  #exited(s: Session, exitCode: number | null, cleanupUncertain: boolean): void {
    if (!s || s.reported || this.#sessions.get(s.id) !== s) return;
    s.reported = true;
    // The shell ended by itself (exit typed), or after #end's stop.
    s.ending ??= { state: "closed", reason: "exited" };
    const { state, reason } = s.ending;
    try { s.recorder.close(reason, exitCode); } catch { /* The spool already failed; the report still goes. */ }
    this.#report({ type: "report", sessionId: s.id, epoch: s.gate.epoch, state, reason, exitCode, auditSeq: 0, cleanupUncertain });
    // The slot and the checkout stay taken until the process tree is gone (SIGKILL after the grace).
    void s.pty.stop().finally(() => {
      if (this.#sessions.get(s.id) === s) this.#sessions.delete(s.id);
      s.unlock();
    });
  }

  /** Lease watch: a hub that stopped renewing (partition, revoke it could not deliver) ends the shell here. */
  tick(): void {
    for (const s of this.#sessions.values()) if (!s.ending && s.lease.expired()) this.#end(s, "expired", "leaseLost");
  }

  /** Local emergency stop: needs no hub, and the hub hears why when it is back. */
  stopAll(reason: TerminalReason = "emergencyStop"): Promise<void> {
    const all = [...this.#sessions.values()];
    for (const s of all) this.#end(s, KILL_STATE(reason), reason);
    return Promise.all(all.map((s) => s.pty.stop())).then(() => undefined);
  }

  dispose(): void { clearInterval(this.#timer); }
}
