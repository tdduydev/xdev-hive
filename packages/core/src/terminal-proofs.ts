import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { TERMINAL_LIMITS } from "#core/terminal.ts";
import {
  TERMINAL_STEPUP_PREFIX,
  TERMINAL_TICKET_PREFIX,
  type TerminalStepUpMethod,
  type TerminalStepUpOperation,
} from "#core/terminal-auth.ts";

type Row = Record<string, unknown>;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Who proved themselves again, from which browser session, for what. A proof works for this context and no other. */
export interface TerminalStepUpContext {
  account: string;
  /** Actor.humanSession: the stored hash of the cookie's session, never the cookie. */
  browserSession: string;
  machineId: string;
  project: string;
  operation: TerminalStepUpOperation;
  /** The session attach and recording act on; null for create. */
  sessionId: string | null;
}

/**
 * The one-time secrets of the remote terminal (spec 69, 69c): step-up proofs (5 minutes) and socket tickets (30
 * seconds). Only their SHA-256 is stored. Each is spent by one UPDATE that checks every binding and the clock in its
 * WHERE, so two requests racing with the same one cannot both win, and a use in the wrong context spends nothing.
 */
export class TerminalProofs {
  private db: DatabaseSync;
  private now: () => Date;
  constructor(db: DatabaseSync, now: () => Date) { this.db = db; this.now = now; }

  /** The proof id of a step-up the caller just verified (password checked, or the provider's fresh auth_time). */
  issueStepUp(ctx: TerminalStepUpContext, method: TerminalStepUpMethod, authenticatedAt: Date, stepUpId = newStepUpId()): { stepUpId: string; expiresAt: string } {
    const now = this.now();
    // Spent and expired proofs are no audit: the hub's audit log has the step-up and what it opened.
    this.db.prepare("DELETE FROM terminal_stepups WHERE expires_at < ?").run(new Date(now.getTime() - 86_400_000).toISOString());
    const expiresAt = new Date(now.getTime() + TERMINAL_LIMITS.stepUpTtlMs).toISOString();
    this.db.prepare(
      `INSERT INTO terminal_stepups(hash, account, browser_session, machine_id, project, operation, session_id, method, authenticated_at, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(sha256(stepUpId), ctx.account, ctx.browserSession, ctx.machineId, ctx.project, ctx.operation, ctx.sessionId, method,
      authenticatedAt.toISOString(), now.toISOString(), expiresAt);
    return { stepUpId, expiresAt };
  }

  /** True once: the first use, within its TTL, in exactly the context it was issued for. */
  consumeStepUp(stepUpId: string, ctx: TerminalStepUpContext): boolean {
    const done = this.db.prepare(
      `UPDATE terminal_stepups SET used_at = ? WHERE hash = ? AND used_at IS NULL AND expires_at > ? AND account = ? AND browser_session = ?
         AND machine_id = ? AND project = ? AND operation = ? AND session_id IS ?`,
    ).run(this.now().toISOString(), sha256(stepUpId), this.now().toISOString(), ctx.account, ctx.browserSession, ctx.machineId, ctx.project,
      ctx.operation, ctx.sessionId);
    return Number(done.changes) === 1;
  }

  /** A ticket for the browser socket of this session, at this writer epoch. Handed out by create and attach only. */
  issueTicket(t: { sessionId: string; account: string; browserSession: string; epoch: number }): { ticket: string; expiresAt: string } {
    const now = this.now();
    this.db.prepare("DELETE FROM terminal_tickets WHERE expires_at < ?").run(new Date(now.getTime() - 86_400_000).toISOString());
    const ticket = `${TERMINAL_TICKET_PREFIX}${randomBytes(32).toString("base64url")}`;
    const expiresAt = new Date(now.getTime() + TERMINAL_LIMITS.ticketTtlMs).toISOString();
    this.db.prepare("INSERT INTO terminal_tickets(hash, session_id, account, browser_session, epoch, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(sha256(ticket), t.sessionId, t.account, t.browserSession, t.epoch, expiresAt);
    return { ticket, expiresAt };
  }

  /** Spends a ticket presented by this person from this browser session; null when it is not theirs to spend. */
  redeemTicket(ticket: string, by: { account: string; browserSession: string }): { sessionId: string; epoch: number } | null {
    const now = this.now().toISOString();
    const r = this.db.prepare(
      `UPDATE terminal_tickets SET used_at = ? WHERE hash = ? AND used_at IS NULL AND expires_at > ? AND account = ? AND browser_session = ?
       RETURNING session_id, epoch`,
    ).get(now, sha256(ticket), now, by.account, by.browserSession) as Row | undefined;
    return r ? { sessionId: String(r.session_id), epoch: Number(r.epoch) } : null;
  }

  /** Nothing still unspent of this browser session works any more (it signed out). */
  forgetBrowserSession(browserSession: string): void {
    this.db.prepare("DELETE FROM terminal_stepups WHERE browser_session = ? AND used_at IS NULL").run(browserSession);
    this.db.prepare("DELETE FROM terminal_tickets WHERE browser_session = ? AND used_at IS NULL").run(browserSession);
  }

  /** Nothing still unspent of this account works any more (password changed, sessions ended). */
  forgetAccount(account: string): void {
    this.db.prepare("DELETE FROM terminal_stepups WHERE account = ? AND used_at IS NULL").run(account);
    this.db.prepare("DELETE FROM terminal_tickets WHERE account = ? AND used_at IS NULL").run(account);
  }

  /** A session that ended takes its unspent tickets with it. */
  forgetSession(sessionId: string): void {
    this.db.prepare("DELETE FROM terminal_tickets WHERE session_id = ? AND used_at IS NULL").run(sessionId);
  }
}

export const newStepUpId = (): string => `${TERMINAL_STEPUP_PREFIX}${randomBytes(32).toString("base64url")}`;
