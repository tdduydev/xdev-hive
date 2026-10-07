// Remote terminal recording store on the hub (spec 69 §8, task 69d). Node only.
// Holds only the redacted transcript the machine uploads, in chunks chained to the anchor the machine reported. The
// bytes live in files encrypted with a key kept outside the database (terminal_audit_chunks has the hash and where the
// file is, never text), are not indexed or searched, and never go to artifacts, chat, memory or telemetry. There is no
// way to upload or read the raw archive: the schema below has no field for it.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { HiveError } from "./errors.ts";
import { redactLines } from "./secrets.ts";
import { assertTerminal, TERMINAL_LIMITS } from "./terminal.ts";
import { chainHash, GENESIS_HASH, openFrame, sealFrame, terminalSubkey, transcriptEventSchema, type TranscriptEvent } from "./terminal-recorder.ts";
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

export interface TerminalRecordingPage {
  events: TranscriptEvent[];
  /** Cursor of the next page (a chunk seq), or null at the end of what was uploaded so far. */
  next: number | null;
  /** Lines the hub hid again because the machine's filter let them through. */
  hubRedacted: number;
}

export class TerminalRecordingStore {
  private db: DatabaseSync;
  private dir: string;
  private master: Buffer;
  private now: () => Date;
  private sessions: TerminalStore;

  /** `master` comes from loadTerminalKey on a file outside `dir` and outside the database's directory. */
  constructor(db: DatabaseSync, dir: string, master: Buffer, now: () => Date) {
    this.db = db;
    this.dir = dir;
    this.master = master;
    this.now = now;
    this.sessions = new TerminalStore(db, now);
    // Probe now: a bad key must fail at startup, not on the first upload of a live session.
    terminalSubkey(master, "00000000-0000-0000-0000-000000000000", "recording");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  /**
   * One chunk from the machine the session runs on (the machineReport rule: its own credential, its own session).
   * Idempotent: the same chunk again is a no-op; a different one at the same place, or one that does not chain from
   * the last, is a conflict, so a resent or forged chunk never rewrites what was recorded.
   */
  put(actor: Actor, sessionId: string, raw: unknown): "stored" | "duplicate" {
    const session = this.sessions.get(sessionId);
    if (!session) throw notFound();
    assertTerminal({ op: "machineReport", actor, hubEnabled: true, project: session.project, machine: this.sessions.machine(session.machineId), session });
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
    const last = this.db.prepare("SELECT seq, hash, (SELECT COALESCE(SUM(bytes), 0) FROM terminal_audit_chunks WHERE session_id = ?) AS total FROM terminal_audit_chunks WHERE session_id = ? ORDER BY seq DESC LIMIT 1")
      .get(sessionId, sessionId) as Row | undefined;
    if (chunk.seq !== Number(last?.seq ?? 0) + 1 || chunk.prevHash !== String(last?.hash ?? GENESIS_HASH))
      throw new HiveError("conflict", "Terminal recording chunk does not follow the last one.", { key: "errors.terminal.chunkGap" });

    // Second filter: the machine's is the one that knows the profile's secret values, this one catches what it missed
    // (an older or broken app) with the hub's patterns. The chain hash stays the machine's, the anchor it reported.
    let hubRedacted = 0;
    const events = chunk.events.map((e) => {
      if (e.type !== "output") return e;
      const text = redactLines(e.text);
      if (text !== e.text) hubRedacted++;
      return { ...e, text };
    });
    const ref = `${sessionId}/${chunk.seq}.bin`;
    const body = Buffer.from(JSON.stringify({ events, hubRedacted }));
    const total = Number(last?.total ?? 0) + body.length;
    if (total > TERMINAL_LIMITS.auditQuotaBytes)
      throw new HiveError("conflict", "This terminal session's recording is over its quota.", { key: "errors.terminal.recordingQuota" });

    const file = path.join(this.dir, ref);
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(tmp, sealFrame(this.key(sessionId), this.aad(sessionId, chunk.seq, chunk.hash), body), { mode: 0o600, flag: "wx" });
    renameSync(tmp, file);
    this.db.prepare(`INSERT INTO terminal_audit_chunks(session_id, seq, first_event, last_event, bytes, hash, prev_hash, storage_ref, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(sessionId, chunk.seq, chunk.events[0]!.seq, chunk.events.at(-1)!.seq, body.length,
      chunk.hash, chunk.prevHash, ref, this.now().toISOString());
    return "stored";
  }

  /**
   * A page of the redacted transcript for someone the recording rule allows (creator, hub admin or the machine's
   * owner, with project access and a fresh step-up the caller already consumed). Every read is audited, success or not.
   */
  read(actor: Actor, input: { project: string; sessionId: string; cursor?: number; hubEnabled: boolean; stepUp: boolean }): TerminalRecordingPage {
    const session = this.sessions.get(input.sessionId);
    const audit = (detail: string) => this.db.prepare("INSERT INTO audit(at, actor, action, target, detail) VALUES (?, ?, 'terminal.recording.view', ?, ?)")
      .run(this.now().toISOString(), actor.name, input.sessionId, detail);
    try {
      assertTerminal({
        op: "recording", actor, hubEnabled: input.hubEnabled, project: input.project,
        machine: session ? this.sessions.machine(session.machineId) : null, session: session ?? undefined, stepUp: input.stepUp,
      });
    } catch (e) {
      audit("denied");
      throw e;
    }
    const cursor = input.cursor ?? 0;
    const rows = this.db.prepare("SELECT seq, hash, storage_ref FROM terminal_audit_chunks WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?")
      .all(input.sessionId, cursor, PAGE_CHUNKS + 1) as Row[];
    const events: TranscriptEvent[] = [];
    let hubRedacted = 0;
    let next: number | null = null;
    let bytes = 0;
    for (const [i, r] of rows.entries()) {
      if (i === PAGE_CHUNKS || bytes > TERMINAL_CHUNK_MAX_BYTES * 4) { next = Number(rows[i - 1]!.seq); break; }
      const sealed = readFileSync(path.join(this.dir, String(r.storage_ref)));
      let body: { events: TranscriptEvent[]; hubRedacted: number };
      try {
        body = JSON.parse(openFrame(this.key(input.sessionId), this.aad(input.sessionId, Number(r.seq), String(r.hash)), sealed.subarray(4)).toString());
      } catch {
        throw new HiveError("conflict", "A terminal recording chunk was altered or cannot be decrypted.", { key: "errors.terminal.recordingTampered" });
      }
      events.push(...body.events);
      hubRedacted += body.hubRedacted;
      bytes += sealed.length;
    }
    audit(`cursor=${cursor} events=${events.length}`);
    return { events, next, hubRedacted };
  }

  /**
   * Deletes the recordings of sessions closed more than retentionDays ago: files first, then rows, so a crash in
   * between leaves rows pointing at nothing (read reports it) rather than text nobody can find to delete.
   */
  purge(retentionDays: number = TERMINAL_LIMITS.retentionDays): string[] {
    const cutoff = new Date(this.now().getTime() - retentionDays * 86_400_000).toISOString();
    const ids = (this.db.prepare(`SELECT DISTINCT c.session_id AS id FROM terminal_audit_chunks c JOIN terminal_sessions s ON s.id = c.session_id
      WHERE s.closed_at IS NOT NULL AND s.closed_at < ?`).all(cutoff) as Row[]).map((r) => String(r.id));
    for (const id of ids) {
      rmSync(path.join(this.dir, id), { recursive: true, force: true });
      this.db.prepare("DELETE FROM terminal_audit_chunks WHERE session_id = ?").run(id);
    }
    return ids;
  }

  private key(sessionId: string): Buffer { return terminalSubkey(this.master, sessionId, "recording"); }
  private aad(sessionId: string, seq: number, h: string): string { return `${sessionId}:recording:${seq}:${h}`; }
}
