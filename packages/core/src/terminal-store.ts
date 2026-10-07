import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { HiveError } from "#core/errors.ts";
import {
  assertTransition,
  isTerminalFinal,
  TERMINAL_LIMITS,
  TERMINAL_LIVE_STATES,
  type TerminalMachine,
  type TerminalReason,
  type TerminalSession,
  type TerminalState,
} from "#core/terminal.ts";

type Row = Record<string, unknown>;

export interface TerminalOpen {
  project: string;
  machineId: string;
  creator: string;
  browserSession: string;
  checkoutRef: string;
  reason: string;
  idempotencyKey: string;
}

const LIVE = TERMINAL_LIVE_STATES.map(() => "?").join(", ");

/**
 * Session metadata of the remote terminal (spec 69). Callers decide who may act (terminalDecision) and run this inside
 * their transaction; every change of state is a compare-and-set on `version`, so two writers never both win.
 */
export class TerminalStore {
  private db: DatabaseSync;
  private now: () => Date;
  constructor(db: DatabaseSync, now: () => Date) { this.db = db; this.now = now; }

  get(id: string): TerminalSession | null {
    const r = this.db.prepare("SELECT * FROM terminal_sessions WHERE id = ?").get(id) as Row | undefined;
    return r ? session(r) : null;
  }

  /** The machine as terminalDecision needs it, from the hub's own row; null once the machine was deleted. */
  machine(id: string): TerminalMachine | null {
    const r = this.db.prepare("SELECT id, owner, terminal_capability FROM machines WHERE id = ?").get(id) as Row | undefined;
    if (!r) return null;
    let capability: unknown = null;
    try { capability = r.terminal_capability == null ? null : JSON.parse(String(r.terminal_capability)); } catch { /* read as needsUpgrade */ }
    return { id: String(r.id), owner: r.owner == null ? null : String(r.owner), capability };
  }

  /**
   * A hub admin sees the project's sessions; anyone else those they opened and those on machines they own now. The
   * filter is in SQL, before the limit, so another owner's sessions never take the places of one's own.
   */
  list(project: string, viewer: { account: string; admin: boolean }): TerminalSession[] {
    const rows = viewer.admin
      ? this.db.prepare("SELECT * FROM terminal_sessions WHERE project = ? ORDER BY created_at DESC LIMIT 100").all(project)
      : this.db.prepare(`SELECT * FROM terminal_sessions WHERE project = ? AND (creator = ? OR machine_id IN (SELECT id FROM machines WHERE owner = ?))
          ORDER BY created_at DESC LIMIT 100`).all(project, viewer.account, viewer.account);
    return (rows as Row[]).map(session);
  }

  liveOnMachine(machineId: string): number {
    const r = this.db.prepare(`SELECT COUNT(*) AS n FROM terminal_sessions WHERE machine_id = ? AND state IN (${LIVE})`).get(machineId, ...TERMINAL_LIVE_STATES) as Row;
    return Number(r.n);
  }

  /** Same key from the same person: the session it made, so a retried click opens nothing twice. */
  create(o: TerminalOpen): TerminalSession {
    const old = this.db.prepare("SELECT * FROM terminal_sessions WHERE creator = ? AND idempotency_key = ?").get(o.creator, o.idempotencyKey) as Row | undefined;
    if (old) {
      const s = session(old);
      if (s.project !== o.project || s.machineId !== o.machineId || s.checkoutRef !== o.checkoutRef || s.reason !== o.reason)
        throw new HiveError("conflict", "This idempotency key opened another terminal session.", { key: "errors.terminal.idempotency" });
      return s;
    }
    if (this.liveOnMachine(o.machineId) >= TERMINAL_LIMITS.maxSessionsPerMachine)
      throw new HiveError("conflict", "This machine already has a terminal session.", { key: "errors.terminal.busy" });
    const now = this.now();
    const id = randomUUID();
    this.db.prepare(
      `INSERT INTO terminal_sessions(id, project, machine_id, creator, browser_session, checkout_ref, mode, reason, idempotency_key,
         state, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, 'shell', ?, ?, 'requested', ?, ?)`,
    ).run(id, o.project, o.machineId, o.creator, o.browserSession, o.checkoutRef, o.reason, o.idempotencyKey,
      now.toISOString(), new Date(now.getTime() + TERMINAL_LIMITS.absoluteTtlMs).toISOString());
    return this.get(id)!;
  }

  transition(id: string, expectedVersion: number, to: TerminalState, reason: TerminalReason, report: { exitCode?: number | null; cleanupUncertain?: boolean } = {}): TerminalSession {
    const s = this.get(id);
    if (!s) throw new HiveError("not_found", "Terminal session not found.", { key: "errors.terminal.notFound" });
    if (s.version !== expectedVersion) throw stale();
    assertTransition(s.state, to, reason);
    const closedAt = isTerminalFinal(to) ? this.now().toISOString() : null;
    const done = this.db.prepare(
      `UPDATE terminal_sessions SET state = ?, last_reason = ?, version = version + 1, closed_at = COALESCE(closed_at, ?),
         exit_code = COALESCE(?, exit_code), cleanup_uncertain = MAX(cleanup_uncertain, ?) WHERE id = ? AND version = ?`,
    ).run(to, reason, closedAt, report.exitCode ?? null, report.cleanupUncertain ? 1 : 0, id, expectedVersion);
    if (Number(done.changes) !== 1) throw stale();
    return this.get(id)!;
  }

  /** "Chuyển điều khiển": a new writer epoch, so input still in flight from the old tab is refused. */
  takeControl(id: string, expectedVersion: number): TerminalSession {
    const done = this.db.prepare(
      "UPDATE terminal_sessions SET writer_epoch = writer_epoch + 1, version = version + 1 WHERE id = ? AND version = ? AND state IN ('active', 'detached')",
    ).run(id, expectedVersion);
    if (Number(done.changes) !== 1) throw stale();
    return this.get(id)!;
  }
}

const stale = () => new HiveError("conflict", "Terminal session changed meanwhile; read it again.", { key: "errors.terminal.stale" });

function session(r: Row): TerminalSession {
  return {
    id: String(r.id),
    project: String(r.project),
    machineId: String(r.machine_id),
    creator: String(r.creator),
    checkoutRef: String(r.checkout_ref),
    mode: "shell",
    reason: String(r.reason),
    state: String(r.state) as TerminalState,
    lastReason: r.last_reason == null ? null : (String(r.last_reason) as TerminalReason),
    version: Number(r.version),
    writerEpoch: Number(r.writer_epoch),
    createdAt: String(r.created_at),
    expiresAt: String(r.expires_at),
    closedAt: r.closed_at == null ? null : String(r.closed_at),
    exitCode: r.exit_code == null ? null : Number(r.exit_code),
    cleanupUncertain: Number(r.cleanup_uncertain) === 1,
  };
}
