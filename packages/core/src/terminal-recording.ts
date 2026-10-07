// Remote terminal recording store on the hub (spec 69 §8, task 69d). Node only.
// Holds only the redacted transcript the machine uploads, in chunks chained to the anchor the machine reported. The
// bytes live in files encrypted with a key kept outside the database (terminal_audit_chunks has the hash and where the
// file is, never text), are not indexed or searched, and never go to artifacts, chat, memory or telemetry. There is no
// way to upload or read the raw archive: the schema below has no field for it.
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { HiveError } from "./errors.ts";
import { assertTerminal, TERMINAL_LIMITS, type TerminalMachine } from "./terminal.ts";
import { TerminalRedactor, type TerminalRedactorState } from "./terminal-redact.ts";
import {
  chainHash, GENESIS_HASH, openFrame, sealFrame, SESSION_DIR, terminalSubkey, transcriptEventSchema, type TranscriptEvent,
} from "./terminal-recorder.ts";
import { TerminalStore } from "./terminal-store.ts";
import type { Actor } from "./types.ts";

const hash = z.string().regex(/^[0-9a-f]{64}$/);
/** Of the events as JSON: a chunk is a page of transcript, not a whole session. */
export const TERMINAL_CHUNK_MAX_BYTES = 256 * 1024;
const PAGE_CHUNKS = 8;

export const terminalRecordingChunkSchema = z.strictObject({
  seq: z.number().int().min(1),
  prevHash: hash,
  /** chainHash(prevHash, JSON.stringify(events)): the next chunk must start from it. */
  hash,
  events: z.array(transcriptEventSchema).min(1).max(10_000),
});
export type TerminalRecordingChunk = z.output<typeof terminalRecordingChunkSchema>;

/** Groups transcript events into chunks for upload, chained from `from` (the hub's last chunk, or the genesis). */
export function terminalRecordingChunks(events: readonly TranscriptEvent[], from = { seq: 0, hash: GENESIS_HASH }): TerminalRecordingChunk[] {
  const chunks: TerminalRecordingChunk[] = [];
  let prev = from.hash;
  let seq = from.seq;
  let page: TranscriptEvent[] = [];
  let size = 2;
  const flush = () => {
    if (!page.length) return;
    const h = chainHash(prev, JSON.stringify(page));
    chunks.push({ seq: ++seq, prevHash: prev, hash: h, events: page });
    prev = h;
    page = [];
    size = 2;
  };
  for (const e of events) {
    const n = JSON.stringify(e).length + 1;
    if (page.length && size + n > TERMINAL_CHUNK_MAX_BYTES) flush();
    page.push(e);
    size += n;
  }
  flush();
  return chunks;
}

type Row = Record<string, unknown>;
const notFound = () => new HiveError("not_found", "Terminal recording not found.", { key: "errors.terminal.notFound" });
const tampered = () =>
  new HiveError("conflict", "A terminal recording chunk was altered or cannot be decrypted.", { key: "errors.terminal.recordingTampered" });

export interface TerminalRecordingPage {
  events: TranscriptEvent[];
  /** Cursor of the next page (a chunk seq), or null at the end of what was uploaded so far. */
  next: number | null;
  /** Lines the hub hid again because the machine's filter let them through. */
  hubRedacted: number;
}

/**
 * Who a machine is, from its pinned credential (SEC-machine-identity: SqliteHive.isMachineActor and the owner bound
 * with the token). machines.owner and the actor's name alone are not identity: any account can heartbeat under the same
 * machine name and take the row over. Without this the store uploads nothing and gives the machine's owner no reads.
 */
export interface TerminalMachineIdentity {
  /** The caller holds the very token the machine row is pinned to. */
  isMachineActor(machineId: string, actor: Actor): boolean;
  /** The owner pinned with that token, or null while the machine is not paired: a heartbeat must not change it. */
  pinnedOwner(machineId: string): string | null;
}

/** What one stored file holds; `carry` is the hub filter's state for the next chunk and is never served. */
interface ChunkBody { events: TranscriptEvent[]; hubRedacted: number; carry?: TerminalRedactorState }

export class TerminalRecordingStore {
  private db: DatabaseSync;
  private dir: string;
  private master: Buffer;
  private now: () => Date;
  private sessions: TerminalStore;
  private identity: TerminalMachineIdentity | null;

  /** `master` comes from loadTerminalKey on a file outside `dir` and outside the database's directory. */
  constructor(db: DatabaseSync, dir: string, master: Buffer, now: () => Date, identity: TerminalMachineIdentity | null = null) {
    this.db = db;
    this.dir = dir;
    this.master = master;
    this.now = now;
    this.sessions = new TerminalStore(db, now);
    this.identity = identity;
    // Probe now: a bad key must fail at startup, not on the first upload of a live session.
    terminalSubkey(master, "00000000-0000-0000-0000-000000000000", "recording");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  /** The machine row with its owner only as far as the pinned identity vouches for it. */
  private machine(id: string): TerminalMachine | null {
    const m = this.sessions.machine(id);
    return m && { ...m, owner: this.identity?.pinnedOwner(id) ?? null };
  }

  /**
   * One chunk from the machine the session runs on (the machineReport rule plus its pinned credential). Idempotent:
   * the same chunk again is a no-op; a different one at the same place, or one that does not chain from the last, is a
   * conflict, so a resent or forged chunk never rewrites what was recorded.
   */
  put(actor: Actor, sessionId: string, raw: unknown): "stored" | "duplicate" {
    const session = this.sessions.get(sessionId);
    if (!session) throw notFound();
    const machine = this.machine(session.machineId);
    assertTerminal({ op: "machineReport", actor, hubEnabled: true, project: session.project, machine, session });
    if (!this.identity?.isMachineActor(session.machineId, actor))
      throw new HiveError("forbidden", "Terminal machineReport: notMachine.", { key: "errors.terminal.notMachine" });
    const parsed = terminalRecordingChunkSchema.safeParse(raw);
    if (!parsed.success) throw new HiveError("bad_request", "Malformed terminal recording chunk.", { key: "errors.terminal.chunk" });
    const chunk = parsed.data;
    const json = JSON.stringify(chunk.events);
    if (json.length > TERMINAL_CHUNK_MAX_BYTES * 2 || chainHash(chunk.prevHash, json) !== chunk.hash)
      throw new HiveError("bad_request", "Terminal recording chunk does not match its hash.", { key: "errors.terminal.chunk" });

    const same = this.db.prepare("SELECT hash FROM terminal_audit_chunks WHERE session_id = ? AND seq = ?").get(sessionId, chunk.seq) as Row | undefined;
    if (same) {
      if (same.hash === chunk.hash) return "duplicate";
      throw new HiveError("conflict", "Another terminal recording chunk is stored at this place.", { key: "errors.terminal.chunkConflict" });
    }
    const last = this.db.prepare(`SELECT seq, hash, storage_ref, (SELECT COALESCE(SUM(bytes), 0) FROM terminal_audit_chunks WHERE session_id = ?) AS total
      FROM terminal_audit_chunks WHERE session_id = ? ORDER BY seq DESC LIMIT 1`).get(sessionId, sessionId) as Row | undefined;
    if (chunk.seq !== Number(last?.seq ?? 0) + 1 || chunk.prevHash !== String(last?.hash ?? GENESIS_HASH))
      throw new HiveError("conflict", "Terminal recording chunk does not follow the last one.", { key: "errors.terminal.chunkGap" });

    // Second filter: the machine's is the one that knows the profile's secret values, this one catches what it missed
    // (an older or broken app) with the hub's patterns. It runs over the session's text as one stream, its state carried
    // from the previous chunk, so a token or a private key split across events or chunks is still seen whole; a line
    // without its end yet waits for the next chunk. The chain hash stays the machine's, the anchor it reported.
    const carry = last ? this.body(sessionId, last).carry : undefined;
    const filter = new TerminalRedactor([], carry);
    const events: TranscriptEvent[] = [];
    for (const e of chunk.events) {
      if (e.type === "output") {
        const text = filter.writeText(e.text);
        if (text) events.push({ ...e, text });
        continue;
      }
      if (e.type === "close") {
        const rest = filter.end();
        if (rest) events.push({ seq: e.seq, at: e.at, type: "output", text: rest });
      }
      events.push(e);
    }
    const ref = `${sessionId}/${chunk.seq}-${randomBytes(6).toString("hex")}.bin`;
    const body = Buffer.from(JSON.stringify({ events, hubRedacted: filter.hidden, carry: filter.state() } satisfies ChunkBody));
    const total = Number(last?.total ?? 0) + body.length;
    if (total > TERMINAL_LIMITS.auditQuotaBytes)
      throw new HiveError("conflict", "This terminal session's recording is over its quota.", { key: "errors.terminal.recordingQuota" });

    // A name of its own per upload: a failed one removes only its own file, never the file of the chunk that won.
    const file = path.join(this.dir, ref);
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    try {
      writeFileSync(tmp, sealFrame(this.key(sessionId), this.aad(sessionId, chunk.seq, chunk.hash), body), { mode: 0o600, flag: "wx" });
      renameSync(tmp, file);
      this.db.prepare(`INSERT INTO terminal_audit_chunks(session_id, seq, first_event, last_event, bytes, hash, prev_hash, storage_ref, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(sessionId, chunk.seq, chunk.events[0]!.seq, chunk.events.at(-1)!.seq, body.length,
        chunk.hash, chunk.prevHash, ref, this.now().toISOString());
    } catch (e) {
      rmSync(tmp, { force: true });
      rmSync(file, { force: true });
      throw e;
    }
    return "stored";
  }

  /**
   * A page of the redacted transcript for someone the recording rule allows (creator, hub admin or the machine's
   * pinned owner, with project access and a fresh step-up the caller already consumed). Every read is audited: allowed,
   * denied, or failed on a missing or altered file, and a page is returned only once its audit row is written.
   */
  read(actor: Actor, input: { project: string; sessionId: string; cursor?: number; hubEnabled: boolean; stepUp: boolean }): TerminalRecordingPage {
    const cursor = input.cursor ?? 0;
    const audit = (detail: string) => this.db.prepare("INSERT INTO audit(at, actor, action, target, detail) VALUES (?, ?, 'terminal.recording.view', ?, ?)")
      .run(this.now().toISOString(), actor.name, input.sessionId, detail);
    let allowed = false;
    let page: TerminalRecordingPage;
    try {
      const session = this.sessions.get(input.sessionId);
      assertTerminal({
        op: "recording", actor, hubEnabled: input.hubEnabled, project: input.project,
        machine: session ? this.machine(session.machineId) : null, session: session ?? undefined, stepUp: input.stepUp,
      });
      allowed = true;
      const rows = this.db.prepare("SELECT seq, hash, storage_ref FROM terminal_audit_chunks WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?")
        .all(input.sessionId, cursor, PAGE_CHUNKS + 1) as Row[];
      const events: TranscriptEvent[] = [];
      let hubRedacted = 0;
      let next: number | null = null;
      let bytes = 0;
      for (const [i, r] of rows.entries()) {
        if (i === PAGE_CHUNKS || bytes > TERMINAL_CHUNK_MAX_BYTES * 4) { next = Number(rows[i - 1]!.seq); break; }
        const body = this.body(input.sessionId, r);
        events.push(...body.events);
        hubRedacted += body.hubRedacted;
        bytes += JSON.stringify(body.events).length;
      }
      page = { events, next, hubRedacted };
    } catch (e) {
      audit(allowed ? `failed cursor=${cursor}` : "denied");
      throw e;
    }
    audit(`cursor=${cursor} events=${page.events.length}`);
    return page;
  }

  /**
   * Deletes the recordings of sessions closed more than retentionDays ago, and the directories of sessions the hub no
   * longer has: by directory, not by row, so a file whose row was never written (an upload that failed or crashed
   * between file and row) goes with the rest. Files first, then rows: a crash in between leaves rows pointing at
   * nothing (read reports it) rather than text nobody can find to delete.
   */
  purge(retentionDays: number = TERMINAL_LIMITS.retentionDays): string[] {
    const cutoff = new Date(this.now().getTime() - retentionDays * 86_400_000).toISOString();
    const expired = (id: string) => {
      const s = this.sessions.get(id);
      return !s || (s.closedAt !== null && s.closedAt < cutoff);
    };
    const ids = new Set((this.db.prepare(`SELECT DISTINCT c.session_id AS id FROM terminal_audit_chunks c JOIN terminal_sessions s ON s.id = c.session_id
      WHERE s.closed_at IS NOT NULL AND s.closed_at < ?`).all(cutoff) as Row[]).map((r) => String(r.id)));
    let names: string[] = [];
    try { names = readdirSync(this.dir); } catch { /* Nothing stored yet. */ }
    for (const name of names) if (SESSION_DIR.test(name) && expired(name)) ids.add(name);
    for (const id of ids) {
      rmSync(path.join(this.dir, id), { recursive: true, force: true });
      this.db.prepare("DELETE FROM terminal_audit_chunks WHERE session_id = ?").run(id);
    }
    return [...ids];
  }

  /** One stored chunk, decrypted; a file missing or altered is the same answer: the recording cannot be trusted. */
  private body(sessionId: string, r: Row): ChunkBody {
    try {
      const sealed = readFileSync(path.join(this.dir, String(r.storage_ref)));
      return JSON.parse(openFrame(this.key(sessionId), this.aad(sessionId, Number(r.seq), String(r.hash)), sealed.subarray(4)).toString()) as ChunkBody;
    } catch {
      throw tampered();
    }
  }

  private key(sessionId: string): Buffer { return terminalSubkey(this.master, sessionId, "recording"); }
  private aad(sessionId: string, seq: number, h: string): string { return `${sessionId}:recording:${seq}:${h}`; }
}
