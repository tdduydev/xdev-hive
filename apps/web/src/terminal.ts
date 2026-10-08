// Remote terminal on the hub (spec 69, task 69c): the person's step-up (password or a fresh OIDC login), the
// terminal.* RPCs that spend its one-time proof, and the browser socket's upgrade that spends a one-time ticket.
// Who may do what is core's terminalDecision; this file gathers what it needs from the hub's own rows, and spends
// proofs and tickets in the same transaction as the change they allow. No PTY here (69b); the relay is terminal-relay.ts (69e).
import { createHash } from "node:crypto";
import { STATUS_CODES, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import {
  assertNoSecret,
  assertTerminal,
  HiveError,
  isAgentActor,
  isTerminalAdmin,
  isTerminalHuman,
  TERMINAL_CLOSE,
  TERMINAL_LIMITS,
  TERMINAL_MACHINE_SOCKET_PATH,
  TERMINAL_MACHINE_WS_PROTOCOL,
  TERMINAL_SOCKET_PATH,
  TERMINAL_WS_PROTOCOL,
  terminalAuthFrameSchema,
  terminalCapabilitySchema,
  terminalDecision,
  terminalInputs,
  terminalStepUpInput,
  terminalUnavailable,
  type Actor,
  type TerminalCheck,
  type TerminalOp,
  type TerminalSession,
  type TerminalStepUpResult,
} from "@xdev-hive/core";
import { newStepUpId, TerminalProofs, TerminalStore, type SqliteHive, type TerminalStepUpContext } from "@xdev-hive/core/node";
import type { z } from "zod";
import type { OidcClient, OidcIdentity, OidcReauth } from "./oidc.ts";
import type { LoginThrottle, UserInfo, UserStore } from "./users.ts";
import { closeFrame, handshake, readFrame, validKey } from "./ws.ts";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** What the relay (69e) gets once a socket passed every check here; until there is one, such a socket is closed. */
export interface TerminalRelayContext {
  session: TerminalSession;
  epoch: number;
  actor: Actor;
  /** Bytes the client sent after its auth frame. */
  rest: Buffer;
  /** The person behind the socket's cookie now, or null once signed out: the relay asks again at every sweep. */
  recheck: () => Actor | null;
}
export type TerminalRelay = (socket: Duplex, ctx: TerminalRelayContext) => void;

/** The relay's machine side (69e): it decides who a machine is, from the credential the machine row is pinned to. */
export interface TerminalMachineRelay {
  vouches(machineId: string, actor: Actor): boolean;
  machine(socket: Duplex, head: Buffer, ctx: { machineId: string; actor: Actor; recheck: () => Actor | null }): void;
}

export interface TerminalHubOptions {
  hive: SqliteHive;
  users: UserStore;
  oidc: OidcClient | null;
  /** The sign-in throttle itself: a password guessed at the step-up counts against the same lock as at sign-in. */
  throttle: LoginThrottle;
  /** HIVE_REMOTE_TERMINAL=1. Off: no proof, no session, no socket (terminate, list, get still work). */
  enabled: boolean;
  /** The person behind a session cookie, built as the hub's cookie middleware builds them. */
  cookieActor: (cookieHeader: string | undefined) => { user: UserInfo; actor: Actor } | null;
  /** The caller of a bearer token, built as the hub's token middleware builds it. */
  bearerActor: (req: IncomingMessage, token: string) => Actor | null;
  allowedHosts?: string[];
  relay?: TerminalRelay;
  /** Without one (no pinned machine identity on this hub), a machine socket is refused with 503. */
  machineRelay?: TerminalMachineRelay;
  now?: () => Date;
}

/** What a terminal step-up through the provider carries to the callback, in the OIDC client's memory only. */
interface OidcStepUp {
  ctx: TerminalStepUpContext;
  stepUpId: string;
}

const MAX_AUTH_FRAME = 1024;
const INVALID_STEPUP = () => new HiveError("bad_request", "Invalid terminal step-up request.", { key: "errors.terminal.stepUpRequest" });

function parse<T extends z.ZodType>(schema: T, raw: unknown): z.output<T> {
  const r = schema.safeParse(raw ?? {});
  if (!r.success) throw new HiveError("bad_request", `Invalid terminal request: ${r.error.issues.map((i) => i.path.join(".") || i.message).join(", ")}`);
  return r.data;
}

/** The hostname of a Host header, as the hub's Host check compares it ([::1] keeps its brackets). */
function hostnameOf(host: string): string {
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return "";
  }
}

export class TerminalHub {
  readonly store: TerminalStore;
  readonly proofs: TerminalProofs;
  readonly #o: TerminalHubOptions;
  readonly #now: () => Date;

  constructor(o: TerminalHubOptions) {
    this.#o = o;
    this.#now = o.now ?? (() => new Date());
    this.store = new TerminalStore(o.hive.db, this.#now);
    this.proofs = new TerminalProofs(o.hive.db, this.#now);
  }

  get enabled(): boolean {
    return this.#o.enabled;
  }

  #tx<T>(fn: () => T): T {
    const db = this.#o.hive.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      db.exec("COMMIT");
      return out;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * The check for one operation, from the hub's rows: the session by id, the machine by the session's (or the
   * request's) id, the project the request names or the session's. An unknown session leaves `session` out, which
   * terminalDecision answers with notFound, after it refused callers that are not a person.
   */
  #check(op: TerminalOp, actor: Actor, target: { project?: string; machineId?: string; sessionId?: string }): { check: TerminalCheck; session: TerminalSession | null } {
    const session = target.sessionId ? this.store.get(target.sessionId) : null;
    const machineId = session?.machineId ?? target.machineId ?? null;
    const check: TerminalCheck = {
      op, actor, hubEnabled: this.#o.enabled,
      project: target.project ?? session?.project ?? "",
      machine: machineId ? this.store.machine(machineId) : null,
      ...(session ? { session } : {}),
    };
    return { check, session };
  }

  #context(actor: Actor, c: { machineId: string; project: string; operation: TerminalStepUpContext["operation"]; sessionId: string | null }): TerminalStepUpContext {
    return { account: actor.account!, browserSession: actor.humanSession!, ...c };
  }

  /**
   * Everything but the proof must allow the operation; then the proof is spent, or the answer is stepUpRequired.
   * Called inside the transaction of the change, so a change that fails leaves the proof unspent.
   */
  #spend(check: TerminalCheck, stepUpId: string, ctx: TerminalStepUpContext): void {
    assertTerminal({ ...check, stepUp: true });
    if (!this.proofs.consumeStepUp(stepUpId, ctx)) assertTerminal({ ...check, stepUp: false });
  }

  #audit(actor: Actor, action: string, session: Pick<TerminalSession, "project" | "machineId" | "id">, detail: string): void {
    this.#o.hive.audit(actor, action, `${session.project}/${session.machineId}`, `${session.id} · ${detail}`);
  }

  // ── step-up (POST /api/terminal/step-up) ───────────────────────────────────

  /**
   * A person proves themselves again for one operation on one target. Nothing is asked before the hub knows the
   * operation would be allowed with a proof: a password is never checked for a terminal its owner cannot open.
   */
  async stepUp(r: { user: UserInfo; actor: Actor; body: unknown; clientIp: string }): Promise<{ result: TerminalStepUpResult; oidcState?: string }> {
    const parsed = terminalStepUpInput.safeParse(r.body ?? {});
    // Never the zod message: it is about a body that may hold a password.
    if (!parsed.success) throw INVALID_STEPUP();
    const i = parsed.data;
    const { actor, user } = r;
    const op = i.operation;
    const { check, session } = this.#check(op, actor, op === "create" ? { project: i.project, machineId: i.machineId } : { sessionId: i.sessionId! });
    assertTerminal({ ...check, stepUp: true });
    // The session must be on the machine and in the project the request names, so one target is never asked for and another proved.
    if (session && (session.project !== i.project || session.machineId !== i.machineId)) assertTerminal({ ...check, session: undefined });
    const ctx = this.#context(actor, { machineId: i.machineId, project: i.project, operation: op, sessionId: i.sessionId ?? null });
    const target = `${i.project}/${i.machineId}`;

    if (i.method === "password") {
      const key = `${r.clientIp}|${user.username}`;
      const wait = this.#o.throttle.blockedFor(key);
      if (wait) {
        const minutes = Math.ceil(wait / 60_000);
        throw new HiveError("forbidden", `Too many attempts. Try again in ${minutes} minutes.`, { key: "errors.tooManyAttempts", vars: { minutes } });
      }
      const verified = this.#o.users.verify(user.username, i.password!);
      if (!verified || verified.id !== user.id) {
        this.#o.throttle.fail(key);
        this.#o.hive.audit(actor, "terminal.stepUpFailed", target, `${op} · password`);
        // forbidden, not unauthorized: the page must not read a wrong password here as being signed out.
        throw new HiveError("forbidden", "Wrong password.", { key: "errors.terminal.stepUpPassword" });
      }
      this.#o.throttle.reset(key);
      const proof = this.proofs.issueStepUp(ctx, "password", this.#now());
      this.#o.hive.audit(actor, "terminal.stepUp", target, `${op} · password`);
      return { result: { method: "password", stepUpId: proof.stepUpId, expiresAt: proof.expiresAt } };
    }

    // A provider login only proves this account when the provider account is linked to it.
    if (!this.#o.oidc || !user.sso) throw new HiveError("forbidden", "This account cannot verify through SSO.", { key: "errors.terminal.stepUpUnavailable" });
    const stepUpId = newStepUpId();
    const reauth: OidcReauth<OidcStepUp> = { userId: user.id, context: { ctx, stepUpId } };
    const { url, state } = await this.#o.oidc.start({ returnTo: i.returnTo, reauth });
    return { result: { method: "oidc", stepUpId, url }, oidcState: state };
  }

  /**
   * The provider sent the person back (OidcClient.finish already refused a login older than the attempt). The proof
   * is born only now, for the account the attempt started from, if its browser session is still signed in.
   */
  finishOidcStepUp(reauth: OidcReauth, identity: OidcIdentity, authTime: number): void {
    const { ctx, stepUpId } = reauth.context as OidcStepUp;
    const user = this.#o.users.get(reauth.userId);
    if (!user || user.disabled) throw new HiveError("forbidden", "Account disabled", { key: "errors.ssoDisabled" });
    if (this.#o.users.byIdentity(identity)?.id !== user.id)
      throw new HiveError("forbidden", "Signed in to the provider as someone else", { key: "errors.terminal.stepUpWrongAccount" });
    if (!this.#o.users.sessionAlive(ctx.browserSession))
      throw new HiveError("forbidden", "The browser session that asked has ended", { key: "errors.terminal.stepUpRequired" });
    this.proofs.issueStepUp(ctx, "oidc", new Date(authTime * 1000), stepUpId);
    this.#o.hive.audit({ name: user.username, role: user.admin ? "admin" : "member", account: user.username }, "terminal.stepUp",
      `${ctx.project}/${ctx.machineId}`, `${ctx.operation} · oidc`);
  }

  // ── terminal.* RPCs ─────────────────────────────────────────────────────────

  /**
   * terminal.machineReport is not here: which machine a token is cannot be told yet (SEC-machine-identity), and the
   * relay that needs the report is 69e's.
   */
  async rpc(method: string, input: unknown, actor: Actor): Promise<unknown> {
    switch (method) {
      case "terminal.capabilities": {
        const i = parse(terminalInputs.capabilities, input);
        const { check } = this.#check("capabilities", actor, i);
        assertTerminal(check);
        const m = check.machine!;
        return { machineId: m.id, unavailable: terminalUnavailable(m.capability, i.project), busy: this.store.liveOnMachine(m.id) >= TERMINAL_LIMITS.maxSessionsPerMachine, osUser: terminalCapabilitySchema.safeParse(m.capability).data?.osUser ?? null };
      }
      case "terminal.create": {
        const i = parse(terminalInputs.create, input);
        assertNoSecret(i.reason, "reason");
        const { check } = this.#check("create", actor, i);
        assertTerminal({ ...check, stepUp: true });
        return this.#tx(() => {
          const open = { project: i.project, machineId: i.machineId, creator: actor.account!, browserSession: actor.humanSession!, checkoutRef: i.checkoutRef, reason: i.reason, idempotencyKey: i.idempotencyKey };
          // A retried click gets the session it opened (or a conflict for another scope), but no ticket: a ticket
          // without a fresh proof would let anyone holding the cookie skip the step-up through a replay.
          const replay = this.#o.hive.db.prepare("SELECT 1 FROM terminal_sessions WHERE creator = ? AND idempotency_key = ?").get(open.creator, open.idempotencyKey);
          if (replay) return { session: this.store.create(open), ticket: null, ticketExpiresAt: null };
          this.#spend(check, i.stepUpId, this.#context(actor, { machineId: i.machineId, project: i.project, operation: "create", sessionId: null }));
          const session = this.store.create(open);
          const t = this.proofs.issueTicket({ sessionId: session.id, account: open.creator, browserSession: open.browserSession, epoch: session.writerEpoch });
          this.#audit(actor, "terminal.create", session, session.checkoutRef);
          return { session, ticket: t.ticket, ticketExpiresAt: t.expiresAt };
        });
      }
      case "terminal.attach": {
        const i = parse(terminalInputs.attach, input);
        const { check, session } = this.#check("attach", actor, { sessionId: i.sessionId });
        assertTerminal({ ...check, stepUp: true });
        const s0 = session!;
        return this.#tx(() => {
          this.#spend(check, i.stepUpId, this.#context(actor, { machineId: s0.machineId, project: s0.project, operation: "attach", sessionId: s0.id }));
          // Only a running shell has a writer to take over; before it runs, the next epoch would mean nothing.
          const s = i.takeControl && (s0.state === "active" || s0.state === "detached") ? this.store.takeControl(s0.id, s0.version) : s0;
          const t = this.proofs.issueTicket({ sessionId: s.id, account: actor.account!, browserSession: actor.humanSession!, epoch: s.writerEpoch });
          this.#audit(actor, "terminal.attach", s, i.takeControl ? `epoch ${s.writerEpoch} · takeControl` : `epoch ${s.writerEpoch}`);
          return { session: s, epoch: s.writerEpoch, ticket: t.ticket, ticketExpiresAt: t.expiresAt };
        });
      }
      case "terminal.list": {
        const i = parse(terminalInputs.list, input);
        const { check } = this.#check("list", actor, i);
        assertTerminal(check);
        return this.store.list(i.project, { account: actor.account!, admin: isTerminalAdmin(actor) });
      }
      case "terminal.get": {
        const i = parse(terminalInputs.get, input);
        const { check, session } = this.#check("get", actor, i);
        assertTerminal(check);
        return session!;
      }
      case "terminal.terminate": {
        const i = parse(terminalInputs.terminate, input);
        const { check, session } = this.#check("terminate", actor, { sessionId: i.sessionId });
        assertTerminal(check);
        const s0 = session!;
        return this.#tx(() => {
          // An emergency stop revokes from any live state; a normal close of a shell goes through closing (the
          // machine kills it, 69e), and one that never spawned has nothing to kill.
          const s =
            i.reason === "emergencyStop"
              ? this.store.transition(s0.id, s0.version, "revoked", "emergencyStop")
              : s0.state === "closing"
                ? s0
                : this.store.transition(s0.id, s0.version, s0.state === "requested" ? "closed" : "closing", "userClosed");
          this.proofs.forgetSession(s.id);
          this.#audit(actor, "terminal.terminate", s, i.reason);
          return s;
        });
      }
      case "terminal.recording": {
        const i = parse(terminalInputs.recording, input);
        const { check, session } = this.#check("recording", actor, { sessionId: i.sessionId });
        assertTerminal({ ...check, stepUp: true });
        const s = session!;
        return this.#tx(() => {
          this.#spend(check, i.stepUpId, this.#context(actor, { machineId: s.machineId, project: s.project, operation: "recording", sessionId: s.id }));
          // Each look is audited (spec §7). The redacted transcript itself comes with the recorder (69d): until
          // then, the chunks the machine sent, without their content.
          this.#audit(actor, "terminal.recording", s, `cursor ${i.cursor}`);
          const rows = this.#o.hive.db
            .prepare("SELECT seq, first_event, last_event, bytes, hash, created_at FROM terminal_audit_chunks WHERE session_id = ? AND seq >= ? ORDER BY seq LIMIT 101")
            .all(s.id, i.cursor) as Array<Record<string, unknown>>;
          const chunks = rows.slice(0, 100).map((r) => ({
            seq: Number(r.seq), firstEvent: Number(r.first_event), lastEvent: Number(r.last_event), bytes: Number(r.bytes), hash: String(r.hash), createdAt: String(r.created_at),
          }));
          return { chunks, next: rows.length > 100 ? Number(rows[100]!.seq) : null };
        });
      }
      default:
        throw new HiveError("bad_request", `Unknown method ${method}`);
    }
  }

  // ── sockets ────────────────────────────────────────────────────────────────

  /**
   * The http server's upgrade event. Takes the terminal's paths and returns true; any other upgrade (Vite's HMR in
   * dev) is left alone. Refusals before the handshake are bare statuses: no reason travels back.
   */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = new URL(req.url ?? "/", "http://hub");
    if (url.pathname !== TERMINAL_SOCKET_PATH && url.pathname !== TERMINAL_MACHINE_SOCKET_PATH) return false;
    socket.on("error", () => socket.destroy());
    const refuse = (status: number) => {
      socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      return true;
    };
    // Nothing is read from a query string, a ticket least of all: it would sit in proxy and access logs.
    if (url.search) return refuse(400);
    if (!this.#o.enabled) return refuse(403);
    const host = req.headers.host ?? "";
    // Express's Host check never sees an upgrade: the same allow-list, here.
    if (this.#o.allowedHosts && !this.#o.allowedHosts.includes(hostnameOf(host))) return refuse(403);
    const key = req.headers["sec-websocket-key"];
    if (req.headers.upgrade?.toLowerCase() !== "websocket" || req.headers["sec-websocket-version"] !== "13" || !validKey(key)) return refuse(400);
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "");

    if (url.pathname === TERMINAL_MACHINE_SOCKET_PATH) {
      // A machine's own bearer and nothing a page could send: a person's cookie never passes for a machine.
      if (/(?:^|;\s*)hive_session=/.test(req.headers.cookie ?? "")) return refuse(401);
      const actor = bearer ? this.#o.bearerActor(req, bearer[1]!) : null;
      if (!actor) return refuse(401);
      if (actor.humanSession || actor.runCredential || actor.mcpCredential || actor.chatReply !== undefined || isAgentActor(actor) || actor.role === "viewer")
        return refuse(403);
      const relay = this.#o.machineRelay;
      if (!relay) return refuse(503);
      // The machine is the token's name, and only if the machine row is pinned to this very credential.
      if (!relay.vouches(actor.name, actor)) return refuse(403);
      const protocols = String(req.headers["sec-websocket-protocol"] ?? "").split(",").map((p) => p.trim());
      if (!protocols.includes(TERMINAL_MACHINE_WS_PROTOCOL)) return refuse(400);
      socket.write(handshake(key, TERMINAL_MACHINE_WS_PROTOCOL));
      const token = bearer![1]!;
      relay.machine(socket, head, { machineId: actor.name, actor, recheck: () => this.#o.bearerActor(req, token) });
      return true;
    }

    // The browser socket: the hub's own page, a person's cookie, the terminal's protocol. No bearer of any kind.
    const origin = req.headers.origin;
    let sameOrigin = false;
    try {
      sameOrigin = !!origin && new URL(origin).host === host;
    } catch {
      sameOrigin = false;
    }
    if (!sameOrigin) return refuse(403);
    const protocols = String(req.headers["sec-websocket-protocol"] ?? "").split(",").map((p) => p.trim());
    if (!protocols.includes(TERMINAL_WS_PROTOCOL)) return refuse(400);
    if (req.headers.authorization) return refuse(401);
    const who = this.#o.cookieActor(req.headers.cookie);
    if (!who) return refuse(401);
    if (who.user.mustChangePassword || !isTerminalHuman(who.actor)) return refuse(403);
    socket.write(handshake(key, TERMINAL_WS_PROTOCOL));
    this.#awaitTicket(req, socket, who.actor, head);
    return true;
  }

  /** The first frame must be the ticket, within firstFrameMs; anything else closes the socket. */
  #awaitTicket(req: IncomingMessage, socket: Duplex, actor: Actor, head: Buffer): void {
    let buf = Buffer.from(head);
    let done = false;
    const stop = () => {
      done = true;
      clearTimeout(timer);
      socket.off("data", onData);
    };
    const close = (code: number, reason: string) => {
      if (done) return;
      stop();
      socket.end(closeFrame(code, reason));
    };
    const timer = setTimeout(() => close(TERMINAL_CLOSE.timeout, "timeout"), TERMINAL_LIMITS.firstFrameMs);
    timer.unref();
    const onData = (chunk: Buffer) => {
      if (done) return;
      buf = Buffer.concat([buf, chunk]);
      const read = readFrame(buf, MAX_AUTH_FRAME);
      if (read === null) return;
      if (read === "invalid" || read.frame.opcode !== 1 || !read.frame.fin) return close(TERMINAL_CLOSE.protocol, "protocol");
      this.#redeem(req, socket, actor, read.frame.payload, read.rest, close, stop);
    };
    socket.on("data", onData);
    socket.on("close", () => clearTimeout(timer));
    if (buf.length) onData(Buffer.alloc(0));
  }

  #redeem(req: IncomingMessage, socket: Duplex, actor: Actor, payload: Buffer, rest: Buffer, close: (code: number, reason: string) => void, stop: () => void): void {
    let ticket: string;
    try {
      ticket = terminalAuthFrameSchema.parse(JSON.parse(payload.toString("utf8"))).ticket;
    } catch {
      return close(TERMINAL_CLOSE.ticket, "ticket");
    }
    // The cookie again, now: signing out between the upgrade and this frame ends here too.
    const now = this.#o.cookieActor(req.headers.cookie);
    if (!now || now.actor.account !== actor.account || now.actor.humanSession !== actor.humanSession) return close(TERMINAL_CLOSE.ticket, "ticket");
    const redeemed = this.proofs.redeemTicket(ticket, { account: actor.account!, browserSession: actor.humanSession! });
    if (!redeemed) return close(TERMINAL_CLOSE.ticket, "ticket");
    // Everything attach checked, checked again with the person's rights of now: a grant lost, a machine opted out, a
    // session ended or taken over by a newer epoch since the ticket was issued all end here.
    const session = this.store.get(redeemed.sessionId);
    const allowed = !!session && redeemed.epoch === session.writerEpoch && terminalDecision({
      op: "attach", actor: now.actor, hubEnabled: this.#o.enabled, project: session.project, machine: this.store.machine(session.machineId), session, stepUp: true,
    }).ok;
    if (!allowed) return close(TERMINAL_CLOSE.denied, "denied");
    if (!this.#o.relay) return close(TERMINAL_CLOSE.unavailable, "relay");
    stop();
    const recheck = () => {
      const again = this.#o.cookieActor(req.headers.cookie);
      return again && again.actor.account === actor.account && again.actor.humanSession === actor.humanSession && !again.user.mustChangePassword ? again.actor : null;
    };
    this.#o.relay(socket, { session: session!, epoch: redeemed.epoch, actor: now.actor, rest, recheck });
  }
}

/** Actor.humanSession of a session cookie's token. */
export const browserSessionOf = (token: string): string => sha256(token);
