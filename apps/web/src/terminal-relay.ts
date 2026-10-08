// Remote terminal relay on the hub (spec 69 §5–§7, task 69e): browser sockets that passed TerminalHub's ticket check,
// machine sockets that passed its bearer and pinned-identity check, and the frames between them. The hub keeps no
// terminal bytes: output goes straight through (the machine's ring is the replay), input is never buffered or resent.
// It owns the session's clocks the machine cannot see: who still may type, idle and absolute TTL, the detached grace,
// and the lease it renews only while all of that holds. One sweep checks it all, so a revocation reaches the machine
// within sweepMs plus one frame (≤2 s), and a partition within the lease (≤30 s) because the machine counts it too.
import {
  base64Bytes,
  canTransition,
  isTerminalFinal,
  OutputWindow,
  TERMINAL_LIMITS,
  TERMINAL_RELAY_CLOSE,
  TERMINAL_FRAME_MAX,
  terminalClientFrameSchema,
  terminalDecision,
  terminalMachineFrameSchema,
  terminalUnavailable,
  TokenBucket,
  type Actor,
  type TerminalDenial,
  type TerminalHubFrame,
  type TerminalMachineFrame,
  type TerminalReason,
  type TerminalServerFrame,
  type TerminalSession,
  type TerminalState,
} from "@xdev-hive/core";
import { WsPeer, type SqliteHive, type TerminalMachineIdentity, type TerminalStore } from "@xdev-hive/core/node";
import type { Duplex } from "node:stream";

/** The clocks of §6–§7; tests shorten them, nothing raises them past TERMINAL_LIMITS. */
const TIMING_KEYS = ["leaseMs", "leaseRenewMs", "detachedMs", "idleInputMs", "unattachedMs", "heartbeatMs", "heartbeatTimeoutMs", "slowConsumerMs", "firstFrameMs"] as const;
export type RelayTimings = Record<(typeof TIMING_KEYS)[number], number>;

export interface TerminalRelayOptions {
  hive: SqliteHive;
  store: TerminalStore;
  /** Who a machine is (SEC-machine-identity). Without it no machine socket is taken: the relay fails closed. */
  identity: TerminalMachineIdentity;
  /** The hub flag, read at every sweep: switched off, every live session is revoked. */
  enabled: () => boolean;
  /** Whether the browser session a terminal was opened from is still signed in (hub_sessions hash). */
  browserAlive: (hash: string) => boolean;
  now?: () => Date;
  /** Monotonic milliseconds for every relative deadline. */
  clock?: () => number;
  sweepMs?: number;
  timings?: Partial<RelayTimings>;
}

/** What TerminalHub hands over for a browser socket: the person, rechecked from the cookie at each sweep. */
export interface RelayBrowser {
  session: TerminalSession;
  epoch: number;
  actor: Actor;
  rest: Buffer;
  /** The person behind the socket's cookie now, or null once signed out. */
  recheck: () => Actor | null;
}

/** What TerminalHub hands over for a machine socket. */
export interface RelayMachine {
  machineId: string;
  actor: Actor;
  /** The machine's bearer now, or null once the token (or its parent) was revoked. */
  recheck: () => Actor | null;
}

interface Browser {
  peer: WsPeer;
  epoch: number;
  actor: Actor;
  recheck: () => Actor | null;
  lastFrame: number;
  /** Set by the first ack: output flows only after the browser said what it already has. */
  resumed: boolean;
  window: OutputWindow;
  input: TokenBucket;
  output: TokenBucket;
  /** Last output seq this browser got, so a machine resend never reaches it twice or out of order. */
  seen: number;
}

interface Live {
  id: string;
  machineId: string;
  browser: Browser | null;
  everAttached: boolean;
  detachedAt: number | null;
  lastInput: number;
  /** When the hub last knew a machine socket was there for it; null while one is. */
  machineLostAt: number | null;
  lastLease: number;
  killSent: boolean;
}

interface Machine {
  peer: WsPeer;
  id: string;
  recheck: () => Actor | null;
  lastFrame: number;
  hello: boolean;
  openedAt: number;
}

const SYSTEM: Actor = { name: "terminal-relay", role: "admin" };
const LIVE_STATES = ["requested", "starting", "active", "detached", "closing"];

/** Which revoke reason a refusal at recheck stands for. */
function revokeReason(denial: TerminalDenial): TerminalReason {
  if (denial === "hubDisabled") return "hubDisabled";
  if (denial === "disabledLocally" || denial === "projectNotAllowed" || denial === "auditNotReady" || denial === "needsUpgrade") return "localOptOut";
  return "accessRevoked";
}

export class TerminalRelayHub {
  readonly #o: TerminalRelayOptions;
  readonly #t: RelayTimings;
  readonly #now: () => Date;
  readonly #clock: () => number;
  readonly #live = new Map<string, Live>();
  readonly #machines = new Map<string, Machine>();
  readonly #startedAt: number;
  readonly #timer: ReturnType<typeof setInterval>;

  constructor(o: TerminalRelayOptions) {
    this.#o = o;
    this.#now = o.now ?? (() => new Date());
    this.#clock = o.clock ?? (() => performance.now());
    this.#t = Object.fromEntries(TIMING_KEYS.map((k) => [k, Math.min(o.timings?.[k] ?? TERMINAL_LIMITS[k], TERMINAL_LIMITS[k])])) as RelayTimings;
    this.#startedAt = this.#clock();
    this.#timer = setInterval(() => this.sweep(), o.sweepMs ?? 500);
    this.#timer.unref();
  }

  stop(): void {
    clearInterval(this.#timer);
    for (const m of this.#machines.values()) m.peer.close(1001, "shutdown");
    for (const l of this.#live.values()) l.browser?.peer.close(1001, "shutdown");
  }

  /** Live sessions this relay tracks, for tests and the admin view; metadata only. */
  status(): Array<{ id: string; attached: boolean; machineOnline: boolean }> {
    return [...this.#live.values()].map((l) => ({ id: l.id, attached: !!l.browser, machineOnline: this.#machines.has(l.machineId) }));
  }

  // ── tracking ───────────────────────────────────────────────────────────────

  #track(s: TerminalSession): Live {
    let l = this.#live.get(s.id);
    if (!l) {
      const now = this.#clock();
      // After a hub restart the machine gets one lease to say hello before its sessions are given up.
      l = {
        id: s.id, machineId: s.machineId, browser: null, everAttached: s.state !== "requested", detachedAt: s.state === "detached" ? now : null,
        lastInput: now, machineLostAt: this.#machines.get(s.machineId)?.hello ? null : Math.min(now, this.#startedAt), lastLease: 0, killSent: false,
      };
      this.#live.set(s.id, l);
    }
    return l;
  }

  /**
   * One transition through the store's compare-and-set, re-read on a lost race. Returns the session as it is after,
   * or null when the move is no longer possible (another writer got there first with something else).
   */
  #move(id: string, to: TerminalState, reason: TerminalReason, report: { exitCode?: number | null; cleanupUncertain?: boolean } = {}): TerminalSession | null {
    for (let i = 0; i < 3; i++) {
      const s = this.#o.store.get(id);
      if (!s) return null;
      if (s.state === to) return s;
      if (!canTransition(s.state, to, reason)) return null;
      try {
        const out = this.#o.store.transition(id, s.version, to, reason, report);
        this.#o.hive.audit(SYSTEM, "terminal.state", `${out.project}/${out.machineId}`, `${out.id} · ${s.state}→${to} · ${reason}`);
        this.#tellBrowser(out);
        return out;
      } catch {
        /* Lost the race: read again. */
      }
    }
    return null;
  }

  #tellBrowser(s: TerminalSession): void {
    const l = this.#live.get(s.id);
    if (!l?.browser) return;
    this.#toBrowser(l.browser, { type: "state", state: s.state, ...(s.lastReason ? { reason: s.lastReason } : {}) });
    if (isTerminalFinal(s.state)) {
      l.browser.peer.close(TERMINAL_RELAY_CLOSE.ended, "ended");
      l.browser = null;
    }
  }

  /** Ends a session for a reason only the hub knows, and tells the machine to kill it now. */
  #end(l: Live, to: "expired" | "revoked" | "failed", reason: TerminalReason): void {
    this.#move(l.id, to, reason);
    this.#kill(l, reason);
  }

  #kill(l: Live, reason: TerminalReason): void {
    // Not delivered while the machine is away: its hello gets the kill, or its lease runs out.
    l.killSent = this.#toMachine(l.machineId, { type: "kill", sessionId: l.id, reason });
  }

  #toBrowser(b: Browser, f: TerminalServerFrame): void { b.peer.send(f); }

  #toMachine(machineId: string, f: TerminalHubFrame): boolean {
    const m = this.#machines.get(machineId);
    return !!m?.hello && m.peer.send(f);
  }

  #auditCount(s: { id: string; project?: string; machineId: string }, action: string, detail: string): void {
    this.#o.hive.audit(SYSTEM, action, `${s.project ?? ""}/${s.machineId}`, `${s.id} · ${detail}`);
  }

  // ── browser sockets ────────────────────────────────────────────────────────

  browser(socket: Duplex, ctx: RelayBrowser): void {
    const s0 = this.#o.store.get(ctx.session.id);
    if (!s0 || isTerminalFinal(s0.state) || s0.state === "closing" || ctx.epoch !== s0.writerEpoch) {
      new WsPeer(socket, { maxPayload: 125, server: true, onText: () => undefined, onClose: () => undefined }).close(TERMINAL_RELAY_CLOSE.ended, "ended");
      return;
    }
    const l = this.#track(s0);
    const now = this.#clock();
    const b: Browser = {
      peer: undefined as unknown as WsPeer, epoch: ctx.epoch, actor: ctx.actor, recheck: ctx.recheck, lastFrame: now, resumed: false,
      window: new OutputWindow(this.#clock, { slowMs: this.#t.slowConsumerMs }),
      input: new TokenBucket(this.#clock, TERMINAL_LIMITS.inputBytesPerSecond, TERMINAL_LIMITS.inputBytesPerSecond),
      output: new TokenBucket(this.#clock, TERMINAL_LIMITS.outputBytesPerSecond, TERMINAL_LIMITS.outputBurstBytes),
      seen: 0,
    };
    b.peer = new WsPeer(socket, {
      maxPayload: TERMINAL_FRAME_MAX.browser, server: true,
      onText: (text) => this.#fromBrowser(l, b, text),
      onClose: () => this.#browserGone(l, b),
    }, ctx.rest);
    // One writer: the tab before this one (same epoch after a reconnect, or an older one after a takeover) goes.
    if (l.browser) {
      const old = l.browser;
      l.browser = null;
      old.peer.close(old.epoch < b.epoch ? TERMINAL_RELAY_CLOSE.superseded : TERMINAL_RELAY_CLOSE.replaced, "replaced");
    }
    l.browser = b;
    l.everAttached = true;
    l.detachedAt = null;
    let s = s0;
    if (s.state === "detached") s = this.#move(s.id, "active", "reattached") ?? s;
    this.#toBrowser(b, { type: "state", state: s.state, ...(s.lastReason ? { reason: s.lastReason } : {}) });
    if (s.state === "requested") this.#open(l, s);
  }

  /** Asks the machine to spawn: once a person is attached and the machine is there to hear it. */
  #open(l: Live, s: TerminalSession): void {
    const m = this.#machines.get(l.machineId);
    if (!m?.hello || !l.browser) return;
    const started = this.#move(s.id, "starting", "spawning");
    if (!started) return;
    m.peer.send({
      type: "open", sessionId: s.id, project: s.project, machineId: s.machineId, checkoutRef: s.checkoutRef as "repo",
      epoch: s.writerEpoch, leaseMs: this.#t.leaseMs, policyVersion: started.version, cols: 80, rows: 24,
    } satisfies TerminalHubFrame);
    l.lastLease = this.#clock();
  }

  #fromBrowser(l: Live, b: Browser, text: string): void {
    if (l.browser !== b) return;
    b.lastFrame = this.#clock();
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { raw = null; }
    const parsed = terminalClientFrameSchema.safeParse(raw);
    if (!parsed.success) {
      this.#auditCount(l, "terminal.frameRejected", "browser · protocol");
      return b.peer.close(TERMINAL_RELAY_CLOSE.protocol, "protocol");
    }
    const f = parsed.data;
    switch (f.type) {
      case "ping":
        return this.#toBrowser(b, { type: "pong", nonce: f.nonce });
      case "ack": {
        if (!b.resumed) {
          // The browser says what it has; the machine replays from there (a gap if its ring no longer reaches back).
          b.resumed = true;
          b.seen = f.outputSeq;
          b.window.reset();
          this.#toMachine(l.machineId, { type: "replay", sessionId: l.id, afterSeq: f.outputSeq });
          return;
        }
        b.window.ack(f.outputSeq);
        this.#toMachine(l.machineId, { type: "ack", sessionId: l.id, outputSeq: f.outputSeq });
        return;
      }
      case "input":
      case "resize": {
        const s = this.#o.store.get(l.id);
        // Input of an older epoch (a tab that lost control) or for a session not running is refused, and counted.
        const why = !s || f.epoch !== b.epoch || f.epoch !== s.writerEpoch ? "staleEpoch" : s.state !== "active" ? "notActive" : null;
        if (why) {
          this.#auditCount(l, "terminal.inputRejected", `${f.type} · ${why}`);
          if (s && s.writerEpoch > b.epoch) b.peer.close(TERMINAL_RELAY_CLOSE.superseded, "superseded");
          return;
        }
        if (f.type === "resize") {
          this.#toMachine(l.machineId, { type: "resize", sessionId: l.id, epoch: f.epoch, cols: f.cols, rows: f.rows });
          return;
        }
        if (!b.input.take(base64Bytes(f.data))) {
          this.#auditCount(l, "terminal.inputRejected", "input · rate");
          return;
        }
        l.lastInput = this.#clock();
        // No machine: the keystroke is dropped here and never acked, so the page says it was not sent.
        if (!this.#toMachine(l.machineId, { type: "input", sessionId: l.id, epoch: f.epoch, inputSeq: f.inputSeq, data: f.data }))
          this.#auditCount(l, "terminal.inputRejected", "input · machineOffline");
        return;
      }
    }
  }

  #browserGone(l: Live, b: Browser): void {
    if (l.browser !== b) return;
    l.browser = null;
    l.detachedAt = this.#clock();
    this.#toMachine(l.machineId, { type: "detach", sessionId: l.id });
    const s = this.#o.store.get(l.id);
    if (s?.state === "active") this.#move(l.id, "detached", "detached");
  }

  // ── machine sockets ────────────────────────────────────────────────────────

  /** False when the caller is not the machine it claims to be; the upgrade then refuses before the handshake. */
  vouches(machineId: string, actor: Actor): boolean {
    return this.#o.identity.isMachineActor(machineId, actor);
  }

  machine(socket: Duplex, head: Buffer, ctx: RelayMachine): void {
    const now = this.#clock();
    const m: Machine = { peer: undefined as unknown as WsPeer, id: ctx.machineId, recheck: ctx.recheck, lastFrame: now, hello: false, openedAt: now };
    m.peer = new WsPeer(socket, {
      maxPayload: TERMINAL_FRAME_MAX.machine, server: true,
      onText: (text) => this.#fromMachine(m, text),
      onClose: () => this.#machineGone(m),
    }, head);
    const old = this.#machines.get(ctx.machineId);
    this.#machines.set(ctx.machineId, m);
    if (old) old.peer.close(TERMINAL_RELAY_CLOSE.replaced, "replaced");
  }

  #fromMachine(m: Machine, text: string): void {
    if (this.#machines.get(m.id) !== m) return;
    m.lastFrame = this.#clock();
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { raw = null; }
    const parsed = terminalMachineFrameSchema.safeParse(raw);
    if (!parsed.success || (!m.hello && parsed.data.type !== "hello") || (m.hello && parsed.data.type === "hello")) {
      this.#o.hive.audit(SYSTEM, "terminal.frameRejected", `/${m.id}`, "machine · protocol");
      return m.peer.close(TERMINAL_RELAY_CLOSE.protocol, "protocol");
    }
    const f = parsed.data;
    if (f.type === "hello") return this.#hello(m, f.sessions);
    if (f.type === "pong") return;
    const s = this.#o.store.get(f.sessionId);
    // A frame about a session of another machine is never relayed, whatever id it names.
    if (!s || s.machineId !== m.id) {
      this.#o.hive.audit(SYSTEM, "terminal.frameRejected", `/${m.id}`, `machine · foreignSession`);
      return;
    }
    const l = this.#live.get(s.id);
    switch (f.type) {
      case "output":
        return l ? this.#output(l, f) : undefined;
      case "gap":
        if (l?.browser?.resumed) {
          l.browser.seen = Math.max(l.browser.seen, f.firstAvailableSeq - 1);
          this.#toBrowser(l.browser, { type: "gap", firstAvailableSeq: f.firstAvailableSeq });
        }
        return;
      case "inputAck":
        if (l?.browser && l.browser.epoch === f.epoch) this.#toBrowser(l.browser, { type: "inputAck", inputSeq: f.inputSeq });
        return;
      case "inputReject":
        return this.#auditCount(s, "terminal.inputRejected", `machine · ${f.reason}`);
      case "report":
        return this.#report(s, f);
    }
  }

  #output(l: Live, f: Extract<TerminalMachineFrame, { type: "output" }>): void {
    const b = l.browser;
    if (!b?.resumed || f.outputSeq <= b.seen) return;
    const bytes = base64Bytes(f.data);
    // Over the output rate the machine did not hold back: the browser is told what it lost, never sent more.
    if (!b.output.take(bytes)) {
      b.seen = f.outputSeq;
      this.#toBrowser(b, { type: "gap", firstAvailableSeq: f.outputSeq + 1 });
      return;
    }
    b.seen = f.outputSeq;
    this.#toBrowser(b, { type: "output", epoch: f.epoch, outputSeq: f.outputSeq, data: f.data });
    const state = b.window.sent(f.outputSeq, bytes);
    if (state === "overflow" || state === "slow") this.#slow(l, b);
  }

  /** A browser that stopped reading: let go (detached), never buffered without bound. The shell keeps running. */
  #slow(l: Live, b: Browser): void {
    this.#auditCount(l, "terminal.slowConsumer", `unacked ${b.window.unacked}`);
    b.peer.close(TERMINAL_RELAY_CLOSE.slow, "slow");
    this.#browserGone(l, b);
  }

  #report(s: TerminalSession, f: Extract<TerminalMachineFrame, { type: "report" }>): void {
    const extra = { exitCode: f.exitCode, cleanupUncertain: f.cleanupUncertain };
    if (isTerminalFinal(s.state)) {
      // Already over on the hub (revoked, expired): what the machine learned while killing still belongs in the row.
      this.#o.store.noteExit(s.id, f.exitCode, f.cleanupUncertain);
      this.#forget(s.id);
      return;
    }
    if (f.state === "active" && s.state === "starting") {
      const l = this.#live.get(s.id);
      // Spawned without anyone attached any more: it waits detached, under the same grace as any other.
      this.#move(s.id, "active", "spawned");
      if (l && !l.browser) {
        l.detachedAt ??= this.#clock();
        this.#move(s.id, "detached", "detached");
      }
      return;
    }
    if (f.state === "closed" || f.state === "closing") {
      if (s.state !== "closing") this.#move(s.id, "closing", f.reason === "userClosed" ? "userClosed" : "exited", extra);
      if (f.state === "closed") {
        this.#move(s.id, "closed", f.reason === "userClosed" ? "userClosed" : "exited", extra);
        this.#forget(s.id);
      }
      return;
    }
    if (f.state === "failed" || f.state === "expired" || f.state === "revoked") {
      this.#move(s.id, f.state, f.reason, extra);
      this.#forget(s.id);
      return;
    }
    this.#auditCount(s, "terminal.reportIgnored", `${s.state}→${f.state}`);
  }

  #forget(id: string): void {
    const l = this.#live.get(id);
    if (!l) return;
    l.browser?.peer.close(TERMINAL_RELAY_CLOSE.ended, "ended");
    this.#live.delete(id);
  }

  /**
   * The machine says what it still runs. Sessions the hub thinks live but the machine lost (it restarted) are failed,
   * never respawned; sessions it runs that the hub ended are killed; the rest get a lease and their replay.
   */
  #hello(m: Machine, running: string[]): void {
    m.hello = true;
    const held = new Set(running);
    for (const s of this.#liveOn(m.id)) {
      const l = this.#track(s);
      l.machineLostAt = null;
      if (s.state === "requested") {
        if (l.browser) this.#open(l, s);
        continue;
      }
      if (!held.has(s.id)) {
        this.#move(s.id, "failed", "supervisorRestart", { cleanupUncertain: true });
        this.#forget(s.id);
        continue;
      }
      this.#renew(l, s);
      if (s.state === "closing") this.#kill(l, "userClosed");
      else if (l.browser?.resumed) this.#toMachine(m.id, { type: "replay", sessionId: s.id, afterSeq: l.browser.seen });
    }
    for (const id of held) {
      const s = this.#o.store.get(id);
      if (!s || s.machineId !== m.id || isTerminalFinal(s.state)) m.peer.send({ type: "kill", sessionId: id, reason: s?.lastReason ?? "orphaned" } satisfies TerminalHubFrame);
    }
  }

  #machineGone(m: Machine): void {
    if (this.#machines.get(m.id) !== m) return;
    this.#machines.delete(m.id);
    const now = this.#clock();
    for (const l of this.#live.values()) if (l.machineId === m.id) l.machineLostAt ??= now;
  }

  #renew(l: Live, s: TerminalSession): void {
    if (this.#toMachine(l.machineId, { type: "lease", sessionId: l.id, epoch: s.writerEpoch, leaseMs: this.#t.leaseMs })) l.lastLease = this.#clock();
  }

  #liveOn(machineId: string): TerminalSession[] {
    const ids = this.#o.hive.db.prepare(`SELECT id FROM terminal_sessions WHERE machine_id = ? AND state IN (${LIVE_STATES.map(() => "?").join(", ")})`)
      .all(machineId, ...LIVE_STATES) as Array<{ id: string }>;
    return ids.map((r) => this.#o.store.get(r.id)!).filter(Boolean);
  }

  // ── the sweep ──────────────────────────────────────────────────────────────

  /** Every deadline and every right, checked again. Public for tests that drive the clock. */
  sweep(): void {
    const now = this.#clock();
    const wall = this.#now().getTime();
    const enabled = this.#o.enabled();
    for (const m of [...this.#machines.values()]) {
      // A machine token revoked (or its parent) loses its socket, and so its leases.
      if (!m.recheck() || now - m.lastFrame > this.#t.heartbeatTimeoutMs || (!m.hello && now - m.openedAt > this.#t.firstFrameMs)) {
        m.peer.close(TERMINAL_RELAY_CLOSE.idle, "gone");
        this.#machineGone(m);
      } else if (m.hello && now - m.lastFrame > this.#t.heartbeatMs) m.peer.send({ type: "ping", nonce: `h${Math.floor(now)}` } satisfies TerminalHubFrame);
    }
    const rows = this.#o.hive.db.prepare(`SELECT id, browser_session FROM terminal_sessions WHERE state IN (${LIVE_STATES.map(() => "?").join(", ")})`)
      .all(...LIVE_STATES) as Array<{ id: string; browser_session: string }>;
    const live = new Set(rows.map((r) => r.id));
    // Ended through an RPC (terminate, emergency stop) or by another hub process: kill what may still run.
    for (const l of [...this.#live.values()]) {
      if (live.has(l.id)) continue;
      const s = this.#o.store.get(l.id);
      this.#kill(l, s?.lastReason ?? "userClosed");
      this.#forget(l.id);
    }
    for (const r of rows) {
      const s = this.#o.store.get(r.id);
      if (!s) continue;
      const l = this.#track(s);
      const b = l.browser;
      if (b && now - b.lastFrame > this.#t.heartbeatTimeoutMs) {
        b.peer.close(TERMINAL_RELAY_CLOSE.idle, "idle");
        this.#browserGone(l, b);
      }
      const end = this.#deadline(l, s, r.browser_session, enabled, now, wall);
      if (end) {
        this.#end(l, end.to, end.reason);
        // A machine that missed the kill hears it at its hello (the hub ended it), or kills at its own lease end.
        this.#forget(l.id);
        continue;
      }
      if (s.state === "closing") {
        if (!l.killSent) this.#kill(l, s.lastReason ?? "userClosed");
        continue;
      }
      if (l.browser && s.writerEpoch > l.browser.epoch) {
        l.browser.peer.close(TERMINAL_RELAY_CLOSE.superseded, "superseded");
        this.#browserGone(l, l.browser);
      }
      if (s.state !== "requested" && now - l.lastLease >= this.#t.leaseRenewMs) this.#renew(l, s);
    }
  }

  /** Why this session must end now, or null. Order: the switch, rights, then the clocks. */
  #deadline(l: Live, s: TerminalSession, browserSession: string, enabled: boolean, now: number, wall: number): { to: "expired" | "revoked"; reason: TerminalReason } | null {
    if (!enabled) return { to: "revoked", reason: "hubDisabled" };
    if (!this.#o.browserAlive(browserSession)) return { to: "revoked", reason: "logout" };
    const machine = this.#o.store.machine(s.machineId);
    if (!machine) return { to: "revoked", reason: "accessRevoked" };
    if (terminalUnavailable(machine.capability, s.project)) return { to: "revoked", reason: "localOptOut" };
    if (l.browser) {
      const actor = l.browser.recheck();
      if (!actor) return { to: "revoked", reason: "logout" };
      const d = terminalDecision({ op: "attach", actor, hubEnabled: enabled, project: s.project, machine: { ...machine, owner: this.#o.identity.pinnedOwner(s.machineId) }, session: s, stepUp: true });
      if (!d.ok && d.denial !== "sessionClosed") return { to: "revoked", reason: revokeReason(d.denial) };
    }
    if (wall >= Date.parse(s.expiresAt)) return { to: "expired", reason: "absoluteTimeout" };
    // The machine away for a whole lease has killed the shell by now (or never got to spawn it).
    if (l.machineLostAt !== null && now - l.machineLostAt >= this.#t.leaseMs && (s.state !== "requested" || l.everAttached))
      return { to: "expired", reason: "leaseLost" };
    if (s.state === "requested") return !l.everAttached && wall - Date.parse(s.createdAt) >= this.#t.unattachedMs ? { to: "expired", reason: "unattachedTimeout" } : null;
    if (s.state === "closing") return null;
    if (now - l.lastInput >= this.#t.idleInputMs) return { to: "expired", reason: "idleTimeout" };
    if (l.detachedAt !== null && now - l.detachedAt >= this.#t.detachedMs) return { to: "expired", reason: "detachedTimeout" };
    return null;
  }
}
