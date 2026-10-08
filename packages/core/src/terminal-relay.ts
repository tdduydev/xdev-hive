// Remote terminal relay, protocol v1 (spec 69 §7, task 69e): the frames between hub and machine, and the small state
// machines both ends share: output replay ring, input dedup by epoch+seq, the machine's lease, rate buckets and the
// unacked-output window. Browser-safe and clock-injected: every deadline takes a monotonic `now` in milliseconds, so a
// wall clock that jumps never extends a lease or a slow consumer's grace.
import { z } from "zod";
import { PROJECT_NAME } from "./keys.ts";
import {
  base64Bytes,
  TERMINAL_LIMITS,
  TERMINAL_REASONS,
  TERMINAL_STATES,
  terminalCheckoutRef,
  terminalSessionId,
} from "./terminal.ts";

/** WebSocket subprotocol of the machine socket; the browser's is TERMINAL_WS_PROTOCOL. */
export const TERMINAL_MACHINE_WS_PROTOCOL = "hive-terminal-machine.v1";

/**
 * Close codes once a socket is relayed. 4409: another tab took control (newer epoch); 4410: the session ended;
 * 4429: too slow to read output or over the input rate; 4408: no frame within heartbeatTimeoutMs.
 */
export const TERMINAL_RELAY_CLOSE = { superseded: 4409, ended: 4410, slow: 4429, idle: 4408, protocol: 1002, replaced: 4000 } as const;

// ── frames hub → machine ─────────────────────────────────────────────────────

const data = (max: number) =>
  z.string().refine((s) => {
    const n = base64Bytes(s);
    return n >= 0 && n <= max;
  }, `data must be base64 of at most ${max} bytes`);
const seq = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const sessionId = terminalSessionId;
const nonce = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const cols = z.number().int().min(TERMINAL_LIMITS.cols.min).max(TERMINAL_LIMITS.cols.max);
const rows = z.number().int().min(TERMINAL_LIMITS.rows.min).max(TERMINAL_LIMITS.rows.max);
/** Relative, not an absolute time: hub and machine clocks differ, and the machine counts it on its monotonic clock. */
const leaseMs = z.number().int().min(1).max(TERMINAL_LIMITS.leaseMs);

/**
 * The control envelope of §7. The machine checks project, opt-in and checkout against its own local policy again: the
 * hub vouches for the person, never for what the machine allows.
 */
export const terminalHubFrameSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("open"), sessionId, project: z.string().regex(PROJECT_NAME), machineId: z.string().min(1).max(200),
    checkoutRef: terminalCheckoutRef, epoch: seq, leaseMs, policyVersion: seq, cols, rows,
  }),
  /** Renews the lease, and carries the writer epoch: input of an older epoch is refused from then on. */
  z.strictObject({ type: z.literal("lease"), sessionId, epoch: seq, leaseMs }),
  z.strictObject({ type: z.literal("input"), sessionId, epoch: seq, inputSeq: seq, data: data(TERMINAL_LIMITS.inputFrameBytes) }),
  z.strictObject({ type: z.literal("resize"), sessionId, epoch: seq, cols, rows }),
  /** A browser (re)attached having seen output up to afterSeq: send what the ring still has after it, then live. */
  z.strictObject({ type: z.literal("replay"), sessionId, afterSeq: seq }),
  z.strictObject({ type: z.literal("ack"), sessionId, outputSeq: seq }),
  /** No browser reads now: stop sending, keep reading into the ring. */
  z.strictObject({ type: z.literal("detach"), sessionId }),
  z.strictObject({ type: z.literal("kill"), sessionId, reason: z.enum(TERMINAL_REASONS) }),
  z.strictObject({ type: z.literal("ping"), nonce }),
]);
export type TerminalHubFrame = z.output<typeof terminalHubFrameSchema>;

// ── frames machine → hub ─────────────────────────────────────────────────────

export const TERMINAL_INPUT_REJECTS = ["staleEpoch", "futureEpoch", "gap", "rate", "notActive", "auditFailed"] as const;
export type TerminalInputReject = (typeof TERMINAL_INPUT_REJECTS)[number];

export const terminalMachineFrameSchema = z.discriminatedUnion("type", [
  /** First frame on every connection: what the supervisor still runs, so the hub reconciles after either side restarted. */
  z.strictObject({ type: z.literal("hello"), protocol: z.literal(1), sessions: z.array(sessionId).max(TERMINAL_LIMITS.maxSessionsPerMachine * 4) }),
  z.strictObject({ type: z.literal("output"), sessionId, epoch: seq, outputSeq: seq, data: data(TERMINAL_LIMITS.outputFrameBytes) }),
  /** With the epoch it was written under: after a takeover the new tab counts from 1 again, and must not get old acks. */
  z.strictObject({ type: z.literal("inputAck"), sessionId, epoch: seq, inputSeq: seq }),
  /** Metadata only, for the hub's audit; the browser sees no ack and the person types again. */
  z.strictObject({ type: z.literal("inputReject"), sessionId, inputSeq: seq, reason: z.enum(TERMINAL_INPUT_REJECTS) }),
  z.strictObject({ type: z.literal("gap"), sessionId, firstAvailableSeq: seq }),
  z.strictObject({
    type: z.literal("report"), sessionId, epoch: seq, state: z.enum(TERMINAL_STATES), reason: z.enum(TERMINAL_REASONS),
    exitCode: z.number().int().nullable().default(null), auditSeq: seq, cleanupUncertain: z.boolean().default(false),
  }),
  z.strictObject({ type: z.literal("pong"), nonce }),
]);
export type TerminalMachineFrame = z.output<typeof terminalMachineFrameSchema>;

/** Largest JSON text frame each side may send: base64 grows data by 4/3, plus the envelope. */
export const TERMINAL_FRAME_MAX = {
  browser: Math.ceil((TERMINAL_LIMITS.inputFrameBytes * 4) / 3) + 1024,
  machine: Math.ceil((TERMINAL_LIMITS.outputFrameBytes * 4) / 3) + 1024,
} as const;

// ── output replay ring (machine, RAM only) ───────────────────────────────────

export interface RingChunk { seq: number; data: string; bytes: number; at: number }

/**
 * The last replayBytes / replayMs of output, numbered from 1. A reattach after lastOutputSeq gets what is still here;
 * anything older is a gap, said out loud, never papered over with a partial transcript.
 */
export class OutputRing {
  #chunks: RingChunk[] = [];
  #bytes = 0;
  #next = 1;
  readonly #maxBytes: number;
  readonly #maxMs: number;
  readonly #now: () => number;

  constructor(now: () => number, maxBytes: number = TERMINAL_LIMITS.replayBytes, maxMs: number = TERMINAL_LIMITS.replayMs) {
    this.#now = now;
    this.#maxBytes = maxBytes;
    this.#maxMs = maxMs;
  }

  get lastSeq(): number { return this.#next - 1; }
  get bytes(): number { return this.#bytes; }

  push(data: string): RingChunk {
    const bytes = base64Bytes(data);
    if (bytes < 0) throw new Error("terminal-output-not-base64");
    const chunk = { seq: this.#next++, data, bytes, at: this.#now() };
    this.#chunks.push(chunk);
    this.#bytes += bytes;
    this.#trim();
    return chunk;
  }

  /** Output after `afterSeq`: gap is the first seq still held when some were already dropped, else null. */
  since(afterSeq: number): { gap: number | null; chunks: RingChunk[] } {
    this.#trim();
    const first = this.#chunks[0]?.seq ?? this.#next;
    const chunks = this.#chunks.filter((c) => c.seq > afterSeq);
    return { gap: afterSeq + 1 < first ? first : null, chunks };
  }

  #trim(): void {
    const old = this.#now() - this.#maxMs;
    while (this.#chunks.length && (this.#bytes > this.#maxBytes || this.#chunks[0]!.at < old)) this.#bytes -= this.#chunks.shift()!.bytes;
  }
}

// ── input dedup (machine) ────────────────────────────────────────────────────

export type InputVerdict = "write" | "duplicate" | "staleEpoch" | "futureEpoch" | "gap";

/**
 * Exactly the next inputSeq of the current epoch is written. A seq already written is a duplicate: acked again,
 * never written twice. The epoch moves only when the hub says so (open/lease), never because a frame claims a newer
 * one, and a new epoch starts at inputSeq 1. Lives as long as the supervisor: after a restart there is no PTY to dedup for.
 */
export class InputGate {
  #epoch: number;
  #next = 1;
  constructor(epoch: number) { this.#epoch = epoch; }
  get epoch(): number { return this.#epoch; }

  setEpoch(epoch: number): void {
    if (epoch <= this.#epoch) return;
    this.#epoch = epoch;
    this.#next = 1;
  }

  check(epoch: number, inputSeq: number): InputVerdict {
    if (epoch < this.#epoch) return "staleEpoch";
    if (epoch > this.#epoch) return "futureEpoch";
    if (inputSeq < this.#next) return "duplicate";
    if (inputSeq > this.#next) return "gap";
    return "write";
  }

  /** After the input is audited and in the PTY: the next one may come. */
  written(): void { this.#next++; }
}

// ── lease (machine) ──────────────────────────────────────────────────────────

/**
 * Permission to keep a shell alive, renewed by the hub every leaseRenewMs. A partitioned machine stops taking input
 * and kills the shell when it runs out, whatever the hub thinks: the bound of §6 holds without the hub.
 */
export class TerminalLease {
  #until: number;
  readonly #now: () => number;
  constructor(now: () => number, ms: number) {
    this.#now = now;
    this.#until = now() + Math.min(ms, TERMINAL_LIMITS.leaseMs);
  }
  /** Never longer than leaseMs from now, whatever the hub sent. */
  renew(ms: number): void { this.#until = Math.max(this.#until, this.#now() + Math.min(ms, TERMINAL_LIMITS.leaseMs)); }
  remaining(): number { return Math.max(0, this.#until - this.#now()); }
  expired(): boolean { return this.#now() >= this.#until; }
}

// ── rate and backpressure ────────────────────────────────────────────────────

/** `rate` bytes per second, up to `burst` at once. */
export class TokenBucket {
  #tokens: number;
  #at: number;
  readonly #rate: number;
  readonly #burst: number;
  readonly #now: () => number;
  constructor(now: () => number, rate: number, burst: number = rate) {
    this.#now = now;
    this.#rate = rate;
    this.#burst = burst;
    this.#tokens = burst;
    this.#at = now();
  }
  take(n: number): boolean {
    const t = this.#now();
    this.#tokens = Math.min(this.#burst, this.#tokens + ((t - this.#at) * this.#rate) / 1000);
    this.#at = t;
    if (n > this.#tokens) return false;
    this.#tokens -= n;
    return true;
  }
}

export type WindowState = "flowing" | "paused" | "overflow" | "slow";

/**
 * Output sent but not yet acked by the browser. Over high water the sender pauses reading the PTY; over the cap, or
 * paused longer than slowConsumerMs, the reader is a slow consumer and is let go. Memory stays bounded either way.
 */
export class OutputWindow {
  #sent: Array<{ seq: number; bytes: number }> = [];
  #unacked = 0;
  #pausedAt: number | null = null;
  readonly #now: () => number;
  readonly #high: number;
  readonly #max: number;
  readonly #slowMs: number;
  constructor(now: () => number, o: { high?: number; max?: number; slowMs?: number } = {}) {
    this.#now = now;
    this.#high = o.high ?? TERMINAL_LIMITS.unackedHighWaterBytes;
    this.#max = o.max ?? TERMINAL_LIMITS.unackedMaxBytes;
    this.#slowMs = o.slowMs ?? TERMINAL_LIMITS.slowConsumerMs;
  }
  get unacked(): number { return this.#unacked; }

  sent(seq: number, bytes: number): WindowState {
    this.#sent.push({ seq, bytes });
    this.#unacked += bytes;
    return this.state();
  }

  /** Acks are cumulative; an ack for output never sent (or older than the last) changes nothing. */
  ack(outputSeq: number): WindowState {
    while (this.#sent.length && this.#sent[0]!.seq <= outputSeq) this.#unacked -= this.#sent.shift()!.bytes;
    return this.state();
  }

  reset(): void {
    this.#sent = [];
    this.#unacked = 0;
    this.#pausedAt = null;
  }

  state(): WindowState {
    if (this.#unacked > this.#max) return "overflow";
    if (this.#unacked < this.#high) {
      this.#pausedAt = null;
      return "flowing";
    }
    this.#pausedAt ??= this.#now();
    return this.#now() - this.#pausedAt >= this.#slowMs ? "slow" : "paused";
  }
}
