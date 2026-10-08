// Remote terminal recorder (spec 69 §8, task 69d): the machine's encrypted audit spool. Node only.
// Two files per session, each its own hash chain and its own key derived from the session id:
//   archive.bin    — every event with raw output. May hold secrets nobody recognised; nothing in Hive reads it back
//                    (the raw path is OS administration outside Hive, spec §8), so no function here decrypts it.
//   transcript.bin — the same events with output through TerminalRedactor: the only thing that is viewed or uploaded.
// Input is never stored, only its byte count ("sensitive-input"): node-pty cannot tell whether echo is off (69b).
// Every write is synchronous and throws on failure, so the supervisor stops the shell instead of running unrecorded.
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import {
  closeSync, constants, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync,
  statfsSync, writeSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import { TERMINAL_LIMITS, TERMINAL_REASONS, type TerminalReason } from "./terminal.ts";
import { TerminalRedactor } from "./terminal-redact.ts";

export const RECORDER_FAILURES = ["diskFull", "quota", "writeFailed", "cryptoFailed", "closed", "keyInvalid", "notReady"] as const;
export type RecorderFailure = (typeof RECORDER_FAILURES)[number];

/** Any recorder problem. The session must end with reason "auditFailed": spec §8 forbids silently dropping recording. */
export class TerminalRecorderError extends Error {
  readonly failure: RecorderFailure;
  constructor(failure: RecorderFailure, cause?: unknown) {
    super(`terminal-recorder-${failure}`, cause === undefined ? undefined : { cause });
    this.failure = failure;
  }
}

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** Frame length header. */
const LEN_BYTES = 4;
/** Room kept under the quota so the close event of a session that hit it can still be written. */
const CLOSE_RESERVE = 4096;
export const GENESIS_HASH = "0".repeat(64);
/** A session id, the only name a spool or recording directory may have: anything else under the root is left alone. */
export const SESSION_DIR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ── key ──────────────────────────────────────────────────────────────────────

/**
 * The master key from a file of its own, created on first use (0600, owner only). Kept apart from the spool and from
 * any database so a copied spool or DB backup alone cannot be read. A key file that is a symlink, someone else's, open
 * to group/others or not exactly 32 bytes is refused rather than repaired: something touched it.
 */
export function loadTerminalKey(file: string): Buffer {
  try {
    const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeSync(fd, randomBytes(KEY_BYTES)); fsyncSync(fd); } finally { closeSync(fd); }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw new TerminalRecorderError("keyInvalid", e);
  }
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = fstatSync(fd);
    if (!st.isFile() || (process.getuid && st.uid !== process.getuid()) || (st.mode & 0o077) !== 0 || st.size !== KEY_BYTES) throw 0;
    return readFileSync(fd);
  } catch (e) {
    throw new TerminalRecorderError("keyInvalid", e);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Per session and per purpose: a transcript key cannot open the archive, so no reader can be pointed at raw data. */
export function terminalSubkey(master: Buffer, sessionId: string, purpose: "archive" | "transcript" | "recording"): Buffer {
  if (master.length !== KEY_BYTES) throw new TerminalRecorderError("keyInvalid");
  return Buffer.from(hkdfSync("sha256", master, Buffer.from(sessionId), Buffer.from(`hive-terminal-${purpose}-v1`), KEY_BYTES));
}

// ── frames ───────────────────────────────────────────────────────────────────

/** AES-256-GCM with the session and sequence as associated data: a frame moved to another place fails to open. */
export function sealFrame(key: Buffer, aad: string, plain: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad));
  const body = Buffer.concat([c.update(plain), c.final()]);
  const frame = Buffer.alloc(LEN_BYTES + IV_BYTES + body.length + TAG_BYTES);
  frame.writeUInt32BE(IV_BYTES + body.length + TAG_BYTES, 0);
  iv.copy(frame, LEN_BYTES);
  body.copy(frame, LEN_BYTES + IV_BYTES);
  c.getAuthTag().copy(frame, LEN_BYTES + IV_BYTES + body.length);
  return frame;
}

export function openFrame(key: Buffer, aad: string, sealed: Buffer): Buffer {
  const d = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, IV_BYTES));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
  return Buffer.concat([d.update(sealed.subarray(IV_BYTES, sealed.length - TAG_BYTES)), d.final()]);
}

export const chainHash = (prev: string, body: string): string => createHash("sha256").update(prev).update("\n").update(body).digest("hex");

// ── events ───────────────────────────────────────────────────────────────────

/** What the transcript holds: no input values, output only as redacted text. */
export const transcriptEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ seq: z.number().int().min(1), at: z.iso.datetime(), type: z.literal("spawn"), cols: z.number().int(), rows: z.number().int() }),
  z.strictObject({ seq: z.number().int().min(1), at: z.iso.datetime(), type: z.literal("resize"), cols: z.number().int(), rows: z.number().int() }),
  z.strictObject({ seq: z.number().int().min(1), at: z.iso.datetime(), type: z.literal("sensitive-input"), bytes: z.number().int().min(0) }),
  z.strictObject({ seq: z.number().int().min(1), at: z.iso.datetime(), type: z.literal("output"), text: z.string() }),
  z.strictObject({
    seq: z.number().int().min(1), at: z.iso.datetime(), type: z.literal("close"),
    reason: z.enum(TERMINAL_REASONS), exitCode: z.number().int().nullable(),
  }),
]);
export type TranscriptEvent = z.output<typeof transcriptEventSchema>;

/** Low-level writes, replaceable in tests to inject ENOSPC and short writes. */
export interface RecorderIo {
  writeSync(fd: number, data: Buffer): number;
  fsyncSync(fd: number): void;
}

export interface RecorderOptions {
  root: string;
  sessionId: string;
  master: Buffer;
  /** Literal secret values to hide from the transcript: the profile's secret env, the machine's Hive tokens. */
  known?: readonly string[];
  quotaBytes?: number;
  now?: () => Date;
  io?: RecorderIo;
}

class Spool {
  readonly fd: number;
  readonly key: Buffer;
  readonly aad: string;
  size = 0;
  /** Frames written; the next frame's number is in its associated data, so frames cannot be dropped or reordered. */
  frames = 0;
  hash = GENESIS_HASH;
  last = 0;
  constructor(file: string, key: Buffer, aad: string) {
    this.fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_APPEND, 0o600);
    this.key = key;
    this.aad = aad;
  }
}

/** The audit anchor of one file, what the machine reports to the hub (auditSeq) and later chunks must chain from. */
export interface RecorderAnchor { seq: number; hash: string }

export class TerminalRecorder {
  readonly sessionId: string;
  readonly dir: string;
  #archive: Spool;
  #transcript: Spool;
  #redactor: TerminalRedactor;
  #quota: number;
  #now: () => Date;
  #io: RecorderIo;
  #seq = 0;
  #failed: RecorderFailure | null = null;
  #open = true;

  private constructor(o: RecorderOptions, dir: string) {
    this.sessionId = o.sessionId;
    this.dir = dir;
    this.#redactor = new TerminalRedactor(o.known);
    this.#quota = Math.min(o.quotaBytes ?? TERMINAL_LIMITS.auditQuotaBytes, TERMINAL_LIMITS.auditQuotaBytes);
    this.#now = o.now ?? (() => new Date());
    this.#io = o.io ?? { writeSync: (fd, data) => writeSync(fd, data), fsyncSync };
    this.#archive = new Spool(path.join(dir, "archive.bin"), terminalSubkey(o.master, o.sessionId, "archive"), `${o.sessionId}:archive`);
    this.#transcript = new Spool(path.join(dir, "transcript.bin"), terminalSubkey(o.master, o.sessionId, "transcript"), `${o.sessionId}:transcript`);
  }

  /** A fresh spool for a new session; an existing one is never reopened or appended to after a restart. */
  static open(o: RecorderOptions): TerminalRecorder {
    if (!SESSION_DIR.test(o.sessionId)) throw new TerminalRecorderError("notReady");
    const reason = terminalRecorderReady(o.root, o.master);
    if (reason) throw new TerminalRecorderError(reason);
    const dir = path.join(o.root, o.sessionId);
    try {
      mkdirSync(dir, { mode: 0o700 });
      return new TerminalRecorder(o, dir);
    } catch (e) {
      throw new TerminalRecorderError(failureOf(e), e);
    }
  }

  get failed(): RecorderFailure | null { return this.#failed; }
  get bytes(): number { return this.#archive.size + this.#transcript.size; }
  anchors(): { archive: RecorderAnchor; transcript: RecorderAnchor } {
    return {
      archive: { seq: this.#archive.last, hash: this.#archive.hash },
      transcript: { seq: this.#transcript.last, hash: this.#transcript.hash },
    };
  }

  spawn(cols: number, rows: number): void { this.#control({ type: "spawn", cols, rows }); }
  resize(cols: number, rows: number): void { this.#control({ type: "resize", cols, rows }); }
  /** Before the bytes go to the PTY, durably: spec §7 acks input only after it is audited. */
  input(bytes: number): void { this.#control({ type: "sensitive-input", bytes }); }

  output(data: Uint8Array): void {
    this.#ready();
    const text = this.#redactor.write(data);
    this.#event({ type: "output", data: Buffer.from(data).toString("base64") }, text ? { type: "output", text } : null, false);
  }

  /** Writes what the redactor still held and the close event, then closes the files. Safe to call twice. */
  close(reason: TerminalReason, exitCode: number | null = null): void {
    if (!this.#open) return;
    try {
      // Runtime callers can bypass TypeScript; never persist arbitrary close metadata.
      transcriptEventSchema.parse({ seq: this.#seq + 1, at: this.#now().toISOString(), type: "close", reason, exitCode });
      // After a quota stop the files are still whole and the close event fits in the reserve; after a write or
      // cipher failure nothing more is written.
      if (!this.#failed || this.#failed === "quota") {
        const rest = this.#redactor.end();
        // The held line can be as long as the reserve itself, so it gets only what is left outside it: when it does
        // not fit it is lost from the transcript (the archive has the raw bytes) and the close event still is written.
        if (rest) {
          try {
            this.#write(this.#transcript, { seq: this.#seq + 1, at: this.#now().toISOString(), type: "output", text: rest }, true);
            this.#seq++;
          } catch (e) {
            if (!(e instanceof TerminalRecorderError && e.failure === "quota")) throw e;
          }
        }
        this.#event({ type: "close", reason, exitCode }, { type: "close", reason, exitCode }, true, true);
      }
    } finally {
      this.#shut("closed");
    }
  }

  #ready(): void {
    if (this.#failed) throw new TerminalRecorderError(this.#failed);
  }

  #control(event: Record<string, unknown>): void {
    this.#ready();
    this.#event(event, event, true);
  }

  #event(archive: Record<string, unknown>, transcript: Record<string, unknown> | null, sync: boolean, closing = false): void {
    const seq = ++this.#seq;
    const at = this.#now().toISOString();
    this.#write(this.#archive, { seq, at, ...archive }, sync, closing);
    if (transcript) this.#write(this.#transcript, { seq, at, ...transcript }, sync, closing);
  }

  #write(spool: Spool, record: Record<string, unknown> & { seq: number }, sync: boolean, closing = false): void {
    let frame: Buffer;
    let hash: string;
    try {
      const body = JSON.stringify({ ...record, prev: spool.hash });
      hash = chainHash(spool.hash, body);
      frame = sealFrame(spool.key, `${spool.aad}:${spool.frames + 1}`, Buffer.from(body));
    } catch (e) {
      this.#shut("cryptoFailed");
      throw new TerminalRecorderError("cryptoFailed", e);
    }
    const limit = closing ? this.#quota : this.#quota - CLOSE_RESERVE;
    if (this.bytes + frame.length > limit) {
      // Files stay open: close() still records why the session ended.
      if (!this.#failed) this.#failed = "quota";
      throw new TerminalRecorderError("quota");
    }
    try {
      let done = 0;
      while (done < frame.length) {
        const n = this.#io.writeSync(spool.fd, frame.subarray(done));
        if (n <= 0) throw Object.assign(new Error("short write"), { code: "EIO" });
        done += n;
      }
      if (sync) this.#io.fsyncSync(spool.fd);
    } catch (e) {
      // Cut a half-written frame off so the file still reads up to the last whole event.
      try { ftruncateSync(spool.fd, spool.size); } catch { /* The reader stops at the torn frame anyway. */ }
      const failure = failureOf(e);
      this.#shut(failure);
      throw new TerminalRecorderError(failure, e);
    }
    spool.size += frame.length;
    spool.frames++;
    spool.hash = hash;
    spool.last = record.seq;
  }

  #shut(failure: RecorderFailure): void {
    if (failure === "closed" || !this.#failed || this.#failed === "quota") this.#failed = failure;
    if (!this.#open) return;
    // Once only: a descriptor number closed twice may already belong to another file.
    this.#open = false;
    for (const s of [this.#archive, this.#transcript]) try { closeSync(s.fd); } catch { /* Nothing more to do. */ }
  }
}

function failureOf(e: unknown): RecorderFailure {
  const code = (e as NodeJS.ErrnoException)?.code;
  return code === "ENOSPC" || code === "EDQUOT" ? "diskFull" : "writeFailed";
}

// ── readiness, reading, retention ────────────────────────────────────────────

/**
 * Why the spool cannot record now, or null: the machine reports auditReady = (this === null) and refuses to open a
 * terminal otherwise. Needs a private directory (0700, ours, not a symlink), room for a whole session's quota and a
 * working cipher.
 */
export function terminalRecorderReady(root: string, master: Buffer): RecorderFailure | null {
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const st = lstatSync(root);
    if (!st.isDirectory() || (process.getuid && st.uid !== process.getuid()) || (st.mode & 0o077) !== 0) return "notReady";
  } catch {
    return "notReady";
  }
  try {
    const fs = statfsSync(root);
    if (Number(fs.bavail) * Number(fs.bsize) < TERMINAL_LIMITS.auditQuotaBytes + CLOSE_RESERVE) return "diskFull";
  } catch {
    return "notReady";
  }
  try {
    const key = terminalSubkey(master, "00000000-0000-0000-0000-000000000000", "transcript");
    const probe = Buffer.from("probe");
    if (!openFrame(key, "probe", sealFrame(key, "probe", probe).subarray(LEN_BYTES)).equals(probe)) return "cryptoFailed";
  } catch {
    return "cryptoFailed";
  }
  return null;
}

/** Thrown when a spool does not open or its chain is broken: a transcript is never shown with holes papered over. */
export class TerminalTranscriptTampered extends Error {
  constructor(seq: number) { super(`terminal-transcript-tampered-at-${seq}`); }
}

export interface TranscriptRead {
  events: TranscriptEvent[];
  /** The last whole event and its chain hash. */
  head: RecorderAnchor;
  /** A frame cut short at the end: the machine stopped mid-write (crash, disk full). Not tampering. */
  torn: boolean;
}

/**
 * The redacted transcript of one session, its chain checked from the first event. There is deliberately no reader for
 * archive.bin: it would need the archive subkey, and this module only ever derives that one to write.
 */
export function readTerminalTranscript(root: string, sessionId: string, master: Buffer): TranscriptRead {
  if (!SESSION_DIR.test(sessionId)) throw new TerminalTranscriptTampered(0);
  const key = terminalSubkey(master, sessionId, "transcript");
  const file = path.join(root, sessionId, "transcript.bin");
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { throw new TerminalTranscriptTampered(0); }
  let data: Buffer;
  try { data = readFileSync(fd); } finally { closeSync(fd); }
  const events: TranscriptEvent[] = [];
  let hash = GENESIS_HASH;
  let last = 0;
  let frames = 0;
  let at = 0;
  while (at < data.length) {
    if (at + LEN_BYTES > data.length) return { events, head: { seq: last, hash }, torn: true };
    const len = data.readUInt32BE(at);
    if (at + LEN_BYTES + len > data.length) return { events, head: { seq: last, hash }, torn: true };
    const sealed = data.subarray(at + LEN_BYTES, at + LEN_BYTES + len);
    at += LEN_BYTES + len;
    // The frame number is in the associated data: a frame dropped, repeated or moved fails to open here.
    frames++;
    let body: string;
    try { body = openFrame(key, `${sessionId}:transcript:${frames}`, sealed).toString(); } catch { throw new TerminalTranscriptTampered(last + 1); }
    const parsed = JSON.parse(body) as Record<string, unknown>;
    // Event seqs are shared with the archive, so the transcript skips those whose output redacted to nothing.
    if (parsed.prev !== hash || typeof parsed.seq !== "number" || parsed.seq <= last) throw new TerminalTranscriptTampered(last + 1);
    hash = chainHash(hash, body);
    last = parsed.seq;
    const { prev: _prev, ...event } = parsed;
    events.push(transcriptEventSchema.parse(event));
  }
  return { events, head: { seq: last, hash }, torn: false };
}

/**
 * Deletes the spools of sessions last written more than retentionDays ago. Only directories named like a session id
 * directly under root; symlinks and anything else are left alone. Deleting the files is the purge: their subkeys
 * exist nowhere else. Returns the session ids removed.
 */
export function purgeTerminalSpools(root: string, now: Date, retentionDays: number = TERMINAL_LIMITS.retentionDays): string[] {
  const cutoff = now.getTime() - retentionDays * 86_400_000;
  const removed: string[] = [];
  let names: string[];
  try { names = readdirSync(root); } catch { return removed; }
  for (const name of names) {
    if (!SESSION_DIR.test(name)) continue;
    const dir = path.join(root, name);
    try {
      const st = lstatSync(dir);
      if (!st.isDirectory()) continue;
      let newest = st.mtimeMs;
      for (const f of readdirSync(dir)) newest = Math.max(newest, lstatSync(path.join(dir, f)).mtimeMs);
      if (newest >= cutoff) continue;
      rmSync(dir, { recursive: true, force: true });
      removed.push(name);
    } catch { /* Raced with another purge or a live session: try next time. */ }
  }
  return removed;
}
