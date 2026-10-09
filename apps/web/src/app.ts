import type { Automation } from "./automation.ts";
import { hubLog } from "#web/deploy-log.ts";
import { createHash, type Hash } from "node:crypto";
import { createWriteStream, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform, type Duplex } from "node:stream";
import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";
import type { SetupGate } from "./hub-setup.ts";
import { hostHeaderValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CHAT_FILE_MAX_BYTES,
  compareVersions,
  grantPermissions,
  grantRole,
  HiveError,
  HTTP_STATUS,
  isImage,
  isMethod,
  may,
  MACHINE_ID,
  permissionsOn,
  HUB_SCOPE,
  PROJECT_NAME,
  sees,
  TERMINAL_STEPUP_PATH,
  readRun,
  RUN_REF,
  readSourceHeader,
  sharedPermissions,
  toErrorPayload,
  TOKEN_ROLES,
  type Actor,
  type Grant,
  type Me,
  type Role,
  type WebhookInput,
  type ChatRequest,
  type AppRollout,
  type UpdateReport,
} from "@xdev-hive/core";
import { TerminalStore, type SqliteHive, type TerminalMachineIdentity } from "@xdev-hive/core/node";
import { createHiveMcpServer } from "@xdev-hive/mcp";
import { DEVICE_CHALLENGE, DEVICE_STATE, DeviceGrants, loopbackCallback } from "./device.ts";
import { SSO_ERRORS, type OidcClient } from "./oidc.ts";
import { ChatGrants } from "./grants.ts";
import { TerminalHub, type TerminalRelay } from "./terminal.ts";
import { TerminalRelayHub, type RelayTimings } from "./terminal-relay.ts";
import type { TokenStore } from "./tokens.ts";
import { LoginThrottle, type UserInfo, type UserStore } from "./users.ts";
import type { ReleaseStore } from "./releases.ts";
import type { AlertStore } from "./alerts.ts";
import type { HubInfoSource } from "./hubinfo.ts";
import type { WebhookDispatcher, WebhookStore } from "./webhooks.ts";

export interface HubAppOptions {
  hive: SqliteHive;
  tokens: TokenStore;
  users: UserStore;
  /** Hostnames accepted in the Host header (DNS-rebinding protection). */
  allowedHosts?: string[];
  /** Built client (production) or a dev middleware such as Vite. */
  ui?: { dir: string } | { middleware: RequestHandler };
  /** Behind a TLS proxy: trust X-Forwarded-Proto/-For (Secure cookies, sign-in throttling per client). */
  trustProxy?: boolean;
  throttle?: LoginThrottle;
  /** Chat webhooks for hub events (hub admins manage them). */
  automation?: Automation;
  webhooks?: { store: WebhookStore; dispatcher: WebhookDispatcher };
  /** Sign-in through an OpenID Connect provider (HIVE_OIDC_*). */
  oidc?: OidcClient | null;
  /** Tokens for a chat reply's MCP calls; by default kept in the hub's database. */
  chatGrants?: ChatGrants;
  /** Desktop builds and their rollout (roadmap 22i). */
  releases?: ReleaseStore;
  /** Hub operator pins which service may drive the global app rollout; absent: only manual admin rollout. */
  autoReleaseProject?: string;
  /** Cảnh báo (roadmap 22m): rules, alerts, and the admin overview's feed. */
  alerts?: AlertStore;
  /** Trang Hub (roadmap 22n): what the hub is, and a backup on request. */
  hub?: HubInfoSource;
  /** Remote terminal (spec 69): HIVE_REMOTE_TERMINAL=1. Off by default. */
  remoteTerminal?: boolean;
  /** A browser-socket relay to use instead of the built-in one (tests of the ticket check). */
  terminalRelay?: TerminalRelay;
  /**
   * Who a machine is, from the credential its row is pinned to (SEC-machine-identity). The relay (69e) runs only with
   * it: without it no machine socket is taken and a browser socket that passed every check is closed.
   */
  terminalIdentity?: TerminalMachineIdentity;
  /** Shorter relay clocks, for tests. */
  terminalTimings?: Partial<RelayTimings>;
  /** First-run setup (roadmap 75): while it is pending only health and /api/setup answer. */
  setup?: SetupGate;
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  // blob: the page's own previews of images picked for a chat message, before they are uploaded.
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
const SESSION_COOKIE = "hive_session";
/** Carries the sign-in attempt to the provider and back. Lax: the way back is a cross-site navigation. */
const OIDC_COOKIE = "hive_oidc";
const OIDC_PATH = "/api/auth/oidc";
/** Header the web client adds to every cookie-authenticated write: a cross-site form or image cannot. */
const CSRF_HEADER = "x-hive-csrf";

/**
 * One entry of the allow-list as a hostname: the check compares the Host header's hostname, so an entry
 * written with a port (192.0.2.52:7780, the address a LAN browser shows) could never match. What the URL
 * parser refuses stays as it is, so a typo fails the check instead of quietly disappearing from the list.
 */
function hostnameOf(entry: string): string {
  try {
    return new URL(`http://${entry}`).hostname;
  } catch {
    return entry;
  }
}

/**
 * Host header allow-list from HIVE_ALLOWED_HOSTS, plus the LAN names and addresses of HIVE_LAN_HOSTS
 * (roadmap 43). Loopback names are always accepted, so container health checks and a proxy on the same
 * host work: DNS rebinding sends the attacker's hostname, never these.
 * Undefined (no check) only when nothing is configured and the hub listens beyond loopback.
 * The public hostname comes first: the hub's own URL is the first name of this list (server.ts).
 */
export function allowedHostsFor(configured: string | undefined, bindHost: string, lan?: string): string[] | undefined {
  const list = [configured, lan].flatMap((v) => v?.split(",").map((h) => h.trim()).filter(Boolean) ?? []).map(hostnameOf);
  if (list.length) return [...new Set([...list, ...LOOPBACK_HOSTS])];
  return ["127.0.0.1", "localhost", "::1"].includes(bindHost) ? LOOPBACK_HOSTS : undefined;
}

function sendError(res: Response, err: unknown): void {
  if (err instanceof HiveError) {
    res.status(HTTP_STATUS[err.code]).json({ error: toErrorPayload(err) });
    return;
  }
  hubLog.error("[xdev-hive]", err);
  res.status(500).json({ error: { code: "internal", message: "Internal error" } });
}

const actorOf = (res: Response) => res.locals.actor as Actor;
/** A grant for the audit log: its role, or the permissions it has. */
const grantLabel = (g: Grant) => (grantRole(g) === "custom" ? [...grantPermissions(g)].join("+") : String(grantRole(g)));
const userOf = (res: Response) => res.locals.user as UserInfo | undefined;

/** Hub admins: an admin account, or an admin token of no account (the bootstrap / pre-account tokens). */
function requireHubAdmin(res: Response): void {
  const actor = actorOf(res);
  if (actor.role !== "admin" || actor.access) throw new HiveError("forbidden", "Chỉ admin của hub.", { key: "errors.hubAdminOnly" });
}

function cookieValue(header: string | undefined, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}
const readCookie = (req: Request, name: string) => cookieValue(req.get("cookie"), name);

/** The terminal's handler for the http server's upgrade event (server.ts): true when it took the request. */
export function terminalUpgrade(app: express.Express): (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean {
  const terminal = app.locals.terminal as TerminalHub;
  return (req, socket, head) => terminal.upgrade(req, socket, head);
}

function publicUser(u: UserInfo): NonNullable<Me["user"]> {
  return { id: u.id, username: u.username, displayName: u.displayName, admin: u.admin, mustChangePassword: u.mustChangePassword };
}

/** The most a part of an uploaded build may be (under the 100 MB a Cloudflare tunnel lets through). */
export const UPLOAD_PART_BYTES = 64 * 1024 * 1024;

export function createHubApp({
  hive,
  tokens,
  users,
  allowedHosts,
  ui,
  trustProxy = false,
  throttle = new LoginThrottle(),
  automation,
  webhooks,
  oidc = null,
  chatGrants = new ChatGrants(hive.db),
  releases,
  autoReleaseProject,
  alerts,
  hub,
  remoteTerminal = false,
  terminalRelay,
  terminalIdentity,
  terminalTimings,
  setup,
}: HubAppOptions): express.Express {
  const app = express();
  app.disable("x-powered-by");
  if (allowedHosts?.length) app.use(hostHeaderValidation(allowedHosts));
  app.use((_req, res, next) => {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-frame-options", "DENY");
    if (ui && "dir" in ui) res.setHeader("content-security-policy", CSP);
    next();
  });
  // The page asks every hub first; one not started for setup simply says so.
  if (setup) setup.mount(app);
  else app.get("/api/setup", (_req, res) => void res.json({ result: { pending: false } }));

  const json = express.json({ limit: "1mb" });
  // RPC carries a doc's attached file in base64 (docs.assetPut, roadmap 22j): parsed only once the caller is known.
  const rpcJson = express.json({ limit: "8mb" });
  const secure = (req: Request) => req.secure || (trustProxy && req.get("x-forwarded-proto") === "https");
  const clientIp = (req: Request) => (trustProxy ? (req.get("x-forwarded-for") ?? "").split(",")[0]!.trim() : "") || req.socket.remoteAddress || "?";

  const setSession = (req: Request, res: Response, token: string, maxAge: number) =>
    res.append(
      "set-cookie",
      `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure(req) ? "; Secure" : ""}`,
    );
  const setOidcState = (req: Request, res: Response, state: string | null) =>
    res.append(
      "set-cookie",
      `${OIDC_COOKIE}=${state ?? ""}; Path=${OIDC_PATH}; HttpOnly; SameSite=Lax; Max-Age=${state ? 600 : 0}${secure(req) ? "; Secure" : ""}`,
    );
  const clearSession = (req: Request, res: Response) =>
    res.setHeader("set-cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure(req) ? "; Secure" : ""}`);

  /** Cookie requests must come from the hub's own page: the CSRF header, and a matching Origin when the browser sends one. */
  const sameSite = (req: Request): boolean => {
    if (req.get(CSRF_HEADER) !== "1") return false;
    const origin = req.get("origin");
    if (!origin) return true;
    try {
      return new URL(origin).host === req.get("host");
    } catch {
      return false;
    }
  };

  /**
   * A person signed in on the hub's page. humanSession is the stored hash of the session, as hub_sessions keys it:
   * the terminal (spec 69) binds proofs to it, and only a session cookie leads here, so no bearer passes for a person.
   */
  const humanActor = (user: UserInfo, session: string): Actor => ({
    name: user.username, role: user.admin ? "admin" : "member", access: users.access(user), source: { via: "web" }, account: user.username,
    humanSession: createHash("sha256").update(session).digest("hex"),
  });

  const tokenActor = (req: Request, res: Response, raw: string): Actor | null => {
    const label = (req.get("x-hive-agent") ?? "").replace(/[^\w.-]/g, "").slice(0, 80);
    const source = readSourceHeader(req.get("x-hive-source"));
    // The shim sends x-hive-run; an agent whose client only passes the source (Gemini in a container) still has it there.
    const run = readRun(req.get("x-hive-run")) ?? source.run;
    // For the audit log (roadmap 27c): which agent, for whom, in which run.
    const trail = (onBehalf: string) => ({ ...(label ? { agent: label } : {}), onBehalf, ...(run ? { run } : {}) });
    const who = tokens.verify(raw);
    if (!who) {
      // A chat reply's leader: the rights cut when the machine got the request (see ChatGrants).
      const grant = chatGrants.verify(raw);
      return grant
        ? {
            name: label ? `${label}@${grant.name}` : grant.name,
            role: grant.role,
            ...(grant.access ? { access: grant.access } : {}),
            source,
            chatReply: grant.replyId,
            ...trail(grant.name),
          }
        : null;
    }
    if (who.mcp) {
      const user = who.ownerId ? users.get(who.ownerId) : null;
      if (who.ownerId && (!user || user.disabled)) return null;
      const full = user ? users.access(user) : undefined;
      const project = who.mcp.project;
      if (project && full && !grantPermissions(full.projects[project]).has("view")) return null;
      const access = project
        ? { projects: { [project]: full?.projects[project] ?? "member" }, shared: full ? { permissions: [...sharedPermissions(full)] } : "member" } as Actor["access"]
        : full;
      if (user) res.locals.user = user;
      return {
        name: label ? `${label}@${who.name}` : who.name, role: who.role, access,
        source: { via: "mcp" }, tokenId: who.id, mcpCredential: true, agent: label || "mcp", onBehalf: user?.username ?? who.name,
        ...(user ? { account: user.username } : {}),
      };
    }
    if (who.run) {
      const { project, task, run: runId, machine } = who.run;
      const user = who.ownerId ? users.get(who.ownerId) : null;
      if (who.ownerId && (!user || user.disabled)) return null;
      const full = user ? users.access(user) : undefined;
      if (full && !grantPermissions(full.projects[project]).has("taskWork")) return null;
      const allowed = full ? grantPermissions(full.projects[project]) : new Set(["view", "taskWork", "docPropose", "memoryWrite"]);
      const shared = full ? sharedPermissions(full) : new Set(["view", "docPropose", "memoryWrite"]);
      const access = { projects: { [project]: { permissions: [...allowed] } }, shared: { permissions: [...shared] } } as Actor["access"];
      if (user) res.locals.user = user;
      return {
        name: label ? `${label}@${who.name}` : who.name, role: who.role, access,
        source: { via: "mcp", machine, run: runId, task }, run: runId,
        tokenId: who.id, runCredential: who.run, agent: label || "run", onBehalf: user?.username ?? who.name,
        ...(user ? { account: user.username } : {}),
      };
    }
    const name = label ? `${label}@${who.name}` : who.name;
    // A token of no account (CI, the CLI's) stands for itself.
    if (!who.ownerId) return { name, role: who.role, tokenId: who.id, source, ...trail(who.name) };
    const user = users.get(who.ownerId);
    if (!user || user.disabled) return null;
    res.locals.user = user;
    // An account that lost admin keeps its old admin tokens only as a member.
    const role: Role = who.role === "admin" && !user.admin ? "member" : who.role;
    // A machine's Board runs count against this person's spending cap (roadmap 27b), and their agents act for them (27c).
    return { name, role, tokenId: who.id, access: users.access(user), source, ...trail(user.username), account: user.username };
  };

  /** Bearer token (agents, machines, CI) or the session cookie (people in the web hub). */
  const authenticate =
    (opts: { cookie: boolean; allowPasswordChange?: boolean }): RequestHandler =>
    (req, res, next) => {
      const bearer = /^Bearer\s+(\S+)$/i.exec(req.get("authorization") ?? "");
      if (bearer) {
        const actor = tokenActor(req, res, bearer[1]!);
        if (!actor) {
          res.status(401).json({ error: { code: "unauthorized", message: "Missing or invalid token.", key: "errors.invalidToken" } });
          return;
        }
        if ((actor.runCredential || actor.mcpCredential) && !["/api/rpc", "/mcp", "/api/me"].includes(req.path)) {
          res.status(403).json({ error: { code: "forbidden", message: "Agent credentials are limited to agent calls." } });
          return;
        }
        res.locals.actor = actor;
        next();
        return;
      }
      const session = opts.cookie ? readCookie(req, SESSION_COOKIE) : null;
      const user = session ? users.sessionUser(session) : null;
      if (!user) {
        res.status(401).json({ error: { code: "unauthorized", message: "Chưa đăng nhập hoặc phiên đã hết hạn.", key: "errors.notSignedIn" } });
        return;
      }
      if (req.method !== "GET" && !sameSite(req)) {
        res.status(403).json({ error: { code: "forbidden", message: "Yêu cầu không đến từ trang của hub.", key: "errors.crossSite" } });
        return;
      }
      if (user.mustChangePassword && !opts.allowPasswordChange) {
        res.status(403).json({ error: { code: "forbidden", message: "Đổi mật khẩu tạm trước khi dùng hub.", key: "errors.changePasswordFirst" } });
        return;
      }
      res.locals.user = user;
      res.locals.session = session;
      res.locals.actor = humanActor(user, session!);
      next();
    };
  const auth = authenticate({ cookie: true });

  const relayHub = terminalIdentity
    ? new TerminalRelayHub({
        hive, store: new TerminalStore(hive.db, () => new Date()), identity: terminalIdentity, enabled: () => remoteTerminal,
        browserAlive: (hash) => users.sessionAlive(hash), timings: terminalTimings, ...(terminalTimings ? { sweepMs: 50 } : {}),
      })
    : null;
  app.locals.terminalRelay = relayHub;
  const terminal = new TerminalHub({
    hive, users, oidc, throttle, enabled: remoteTerminal, allowedHosts,
    relay: terminalRelay ?? (relayHub ? (socket, ctx) => relayHub.browser(socket, ctx) : undefined),
    ...(relayHub ? { machineRelay: relayHub } : {}),
    cookieActor: (header) => {
      const session = cookieValue(header, SESSION_COOKIE);
      const user = session ? users.sessionUser(session) : null;
      return user && session ? { user, actor: humanActor(user, session) } : null;
    },
    // tokenActor reads headers through req.get and keeps the account in res.locals: the upgrade has neither.
    bearerActor: (req, raw) => {
      const get = (name: string) => {
        const v = req.headers[name.toLowerCase()];
        return Array.isArray(v) ? v.join(", ") : v;
      };
      return tokenActor({ get } as unknown as Request, { locals: {} } as unknown as Response, raw);
    },
  });
  app.locals.terminal = terminal;

  app.post("/api/mcp-credentials", authenticate({ cookie: false }), json, (req, res) => {
    try {
      const actor = actorOf(res);
      if (actor.runCredential || actor.mcpCredential || actor.chatReply !== undefined)
        throw new HiveError("forbidden", "A machine credential is required.");
      const { project = null, readOnly } = req.body ?? {};
      if ((project !== null && (typeof project !== "string" || !PROJECT_NAME.test(project))) || typeof readOnly !== "boolean")
        throw new HiveError("bad_request", "Invalid MCP credential request.");
      if (project && !sees(actor, project)) throw new HiveError("forbidden", "No access to this project.");
      const bearer = /^Bearer\s+(\S+)$/i.exec(req.get("authorization") ?? "")!;
      res.json({ result: { token: tokens.issueMcp(bearer[1]!, project, readOnly) } });
    } catch (err) { sendError(res, err); }
  });

  // The runner calls this with its machine credential before starting a CLI. The returned secret is never persisted.
  app.post("/api/run-credentials", authenticate({ cookie: false }), json, (req, res) => {
    try {
      const actor = actorOf(res);
      if (!hive.isMachineActor(actor.name, actor))
        throw new HiveError("forbidden", "Only a registered machine may issue a run credential.");
      const { machine: machineName, project, task, run, minutes, readOnly } = req.body ?? {};
      if (typeof machineName !== "string" || !MACHINE_ID.test(machineName) || !actor.name.startsWith(`runner.${machineName}@`) ||
          typeof project !== "string" || !PROJECT_NAME.test(project) || typeof task !== "string" || typeof run !== "string" || !RUN_REF.test(run) ||
          !Number.isInteger(minutes) || minutes < 5 || minutes > 1440 || typeof readOnly !== "boolean")
        throw new HiveError("bad_request", "Invalid run credential request.");
      if (!may(actor, project, "taskWork")) throw new HiveError("forbidden", "No task work grant for this project.");
      // A research run has no task row (research-<id> lives only in research_runs): bind it to the request sent to this machine.
      const research = /^research-(\d+)$/.exec(task);
      const row = (research
        ? hive.db.prepare("SELECT r.project FROM research_runs r JOIN run_requests q ON q.id = r.request_id WHERE r.id = ? AND q.machine_id = ?").get(Number(research[1]), actor.name)
        : hive.db.prepare("SELECT project FROM tasks WHERE id = ?").get(task)) as { project: string } | undefined;
      if (row?.project !== project) throw new HiveError("forbidden", "Unknown machine or task.");
      const bearer = /^Bearer\s+(\S+)$/i.exec(req.get("authorization") ?? "")!;
      const token = tokens.issueRun(bearer[1]!, { machine: machineName, project, task, run, minutes, readOnly });
      res.json({ result: { token } });
    } catch (err) { sendError(res, err); }
  });
  app.delete("/api/run-credentials", authenticate({ cookie: false }), json, (req, res) => {
    try {
      const actor = actorOf(res);
      if (!hive.isMachineActor(actor.name, actor)) throw new HiveError("forbidden", "Machine credential required.");
      const run = req.body?.run;
      const machine = req.body?.machine;
      if (typeof run !== "string" || !RUN_REF.test(run) || typeof machine !== "string" || !MACHINE_ID.test(machine) ||
          !actor.name.startsWith(`runner.${machine}@`)) throw new HiveError("bad_request", "Invalid run.");
      const bearer = /^Bearer\s+(\S+)$/i.exec(req.get("authorization") ?? "");
      if (!bearer) throw new HiveError("forbidden", "Machine credential required.");
      tokens.revokeRun(bearer[1]!, machine, run);
      res.json({ result: { revoked: true } });
    } catch (err) { sendError(res, err); }
  });

  const me = (res: Response): Me => {
    const { name, role, access } = actorOf(res);
    const user = userOf(res);
    const sso = user && oidc ? { sso: { name: oidc.settings.name, linked: user.sso } } : {};
    return { name, role, mode: "hub", ...(access ? { access } : {}), ...(user ? { user: publicUser(user) } : {}), ...sso };
  };

  /** Checks a username/password pair with throttling per client address and username. */
  const signIn = (req: Request): UserInfo => {
    const { username, password } = (req.body ?? {}) as { username?: unknown; password?: unknown };
    if (typeof username !== "string" || typeof password !== "string" || !username || !password) {
      throw new HiveError("bad_request", "Nhập tên đăng nhập và mật khẩu.", { key: "errors.credentialsRequired" });
    }
    const key = `${clientIp(req)}|${username.trim().toLowerCase()}`;
    const wait = throttle.blockedFor(key);
    if (wait) {
      const minutes = Math.ceil(wait / 60_000);
      throw new HiveError("forbidden", `Sai quá nhiều lần. Thử lại sau ${minutes} phút.`, { key: "errors.tooManyAttempts", vars: { minutes } });
    }
    const user = users.verify(username, password);
    if (!user) {
      throttle.fail(key);
      throw new HiveError("unauthorized", "Sai tên đăng nhập hoặc mật khẩu.", { key: "errors.badCredentials" });
    }
    throttle.reset(key);
    return user;
  };

  app.get("/api/health", (_req, res) => {
    res.json({ result: { ok: true } });
  });

  app.post("/api/login", json, (req, res) => {
    try {
      if (!sameSite(req)) throw new HiveError("forbidden", "Yêu cầu không đến từ trang của hub.", { key: "errors.crossSite" });
      const user = signIn(req);
      const session = users.startSession(user.id);
      setSession(req, res, session.token, session.maxAge);
      hive.audit({ name: user.username, role: user.admin ? "admin" : "member" }, "auth.login", user.username, clientIp(req));
      res.locals.user = user;
      // The new session's id, as the cookie middleware sets it for the requests after this one.
      res.locals.actor = humanActor(user, session.token);
      res.json({ result: me(res) });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.post("/api/logout", (req, res) => {
    const session = readCookie(req, SESSION_COOKIE);
    if (session && sameSite(req)) {
      users.endSession(session);
      // Bound to this session, they would fail anyway; gone now, they cannot be spent on a session id reused later.
      terminal.proofs.forgetBrowserSession(createHash("sha256").update(session).digest("hex"));
    }
    clearSession(req, res);
    res.json({ result: { signedOut: true } });
  });

  app.post("/api/password", json, authenticate({ cookie: true, allowPasswordChange: true }), (req, res) => {
    try {
      const user = userOf(res);
      if (!user) throw new HiveError("bad_request", "Token không có tài khoản để đổi mật khẩu.", { key: "errors.tokenNoAccount" });
      const { current, next } = (req.body ?? {}) as { current?: unknown; next?: unknown };
      const updated = users.changePassword(user.id, String(current ?? ""), String(next ?? ""));
      // Other browsers signed in with the old password are signed out; this one gets a fresh session.
      users.endSessions(user.id);
      // A terminal proof or ticket issued under the old password goes with the sessions it was bound to.
      terminal.proofs.forgetAccount(user.username);
      const session = users.startSession(user.id);
      setSession(req, res, session.token, session.maxAge);
      hive.audit(actorOf(res), "users.password", user.username);
      res.locals.user = updated;
      res.json({ result: me(res) });
    } catch (err) {
      sendError(res, err);
    }
  });

  /** A token for one machine of the account; signing in again from the same machine replaces the old one. */
  const machineToken = (user: UserInfo, rawName: unknown) => {
    const name = String(rawName ?? "").trim();
    const created = tokens.create(name, user.admin ? "admin" : "member", user.id);
    const person: Actor = { name: user.username, role: user.admin ? "admin" : "member", account: user.username };
    for (const old of tokens.list(user.id)) if (old.name === created.info.name && old.id !== created.info.id) {
      tokens.revoke(old.id);
      hive.rebindMachineToken(old.id, created.info.id, person);
    }
    hive.audit(person, "tokens.create", created.info.name, `${created.info.role} · máy`, {
      key: "audit.machineToken",
      vars: { role: created.info.role },
    });
    return { token: created.token, info: created.info, user: publicUser(user) };
  };

  /** The desktop app signs in with username + password once and keeps a token for this machine. */
  app.post("/api/device-token", json, (req, res) => {
    try {
      const user = signIn(req);
      if (user.mustChangePassword) throw new HiveError("forbidden", "Tài khoản đang dùng mật khẩu tạm: đăng nhập hub trên trình duyệt để đổi mật khẩu trước.", {
          key: "errors.temporaryPassword",
        });
      res.json({ result: machineToken(user, (req.body as { name?: unknown }).name) });
    } catch (err) {
      sendError(res, err);
    }
  });

  // ── the desktop app signing in through the browser (device.ts) ─────────────
  const grants = new DeviceGrants();

  /** The person, signed in on the hub's page, allows the app waiting on their machine: its address gets a one-time code. */
  app.post("/api/device/authorize", json, auth, (req, res) => {
    try {
      const user = userOf(res);
      if (!user) throw new HiveError("bad_request", "Token không có tài khoản để đăng nhập máy.", { key: "errors.tokenNoAccount" });
      const { port, state, challenge, name } = (req.body ?? {}) as Record<string, unknown>;
      if (!Number.isInteger(port) || (port as number) < 1024 || (port as number) > 65535 || typeof state !== "string" || !DEVICE_STATE.test(state) || typeof challenge !== "string" || !DEVICE_CHALLENGE.test(challenge)) {
        throw new HiveError("bad_request", "Liên kết đăng nhập của app không hợp lệ.", { key: "errors.deviceRequest" });
      }
      const machine = String(name ?? "").replace(/[^\w.-]/g, "-").slice(0, 60) || "desktop";
      const code = grants.issue({ userId: user.id, challenge, name: machine });
      res.json({ result: { url: loopbackCallback(port as number, { code, state }) } });
    } catch (err) {
      sendError(res, err);
    }
  });

  /** The app trades the code and its PKCE verifier for a machine token of the account that allowed it. */
  app.post("/api/device-token/exchange", json, (req, res) => {
    try {
      const { code, verifier } = (req.body ?? {}) as Record<string, unknown>;
      const grant = typeof code === "string" && typeof verifier === "string" ? grants.redeem(code, verifier) : null;
      const user = grant ? users.get(grant.userId) : null;
      if (!grant || !user || user.disabled) throw new HiveError("unauthorized", "Mã đăng nhập hết hạn hoặc không hợp lệ: thử lại từ app.", { key: "errors.deviceCode" });
      res.json({ result: machineToken(user, grant.name) });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.get("/api/me", authenticate({ cookie: true, allowPasswordChange: true }), (_req, res) => {
    res.json({ result: me(res) });
  });

  // ── OpenID Connect ──────────────────────────────────────────────────────────

  /** What the sign-in page offers besides username + password. */
  app.get("/api/auth/providers", (_req, res) => {
    res.json({ result: { oidc: oidc ? { name: oidc.settings.name } : null } });
  });

  const ssoBack = (res: Response, err: unknown) => {
    const key = err instanceof HiveError && (SSO_ERRORS as readonly string[]).includes(err.key ?? "") ? err.key! : "errors.ssoProvider";
    if (!(err instanceof HiveError)) hubLog.error("[xdev-hive] SSO", err);
    res.redirect(302, `/?sso_error=${encodeURIComponent(key)}`);
  };

  app.get(`${OIDC_PATH}/start`, async (req, res) => {
    if (!oidc) return void res.status(404).json({ error: { code: "not_found", message: "SSO is not set up on this hub.", key: "errors.ssoNotSetUp" } });
    try {
      const { url, state } = await oidc.start({ returnTo: typeof req.query.return === "string" ? req.query.return : undefined });
      setOidcState(req, res, state);
      res.redirect(302, url);
    } catch (err) {
      ssoBack(res, err);
    }
  });

  /** A signed-in person adds the provider account to theirs; after that either way signs in. */
  app.post(`${OIDC_PATH}/link`, auth, async (req, res) => {
    try {
      const user = userOf(res);
      if (!oidc) throw new HiveError("not_found", "SSO is not set up on this hub.", { key: "errors.ssoNotSetUp" });
      if (!user) throw new HiveError("bad_request", "Token không có tài khoản để liên kết.", { key: "errors.tokenNoAccount" });
      const { url, state } = await oidc.start({ linkUserId: user.id });
      setOidcState(req, res, state);
      res.json({ result: { url } });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.get(`${OIDC_PATH}/callback`, async (req, res) => {
    if (!oidc) return void res.status(404).json({ error: { code: "not_found", message: "SSO is not set up on this hub.", key: "errors.ssoNotSetUp" } });
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const cookie = readCookie(req, OIDC_COOKIE);
    setOidcState(req, res, null);
    try {
      // The provider sends people back with error=access_denied when they cancel.
      if (typeof req.query.error === "string") throw new HiveError("unauthorized", `Provider said: ${req.query.error}`, { key: "errors.ssoProvider" });
      // Same browser that started: a link forwarded to someone else cannot sign them in to this attempt.
      if (!state || !code || cookie !== state) throw new HiveError("unauthorized", "Sign-in attempt does not match this browser", { key: "errors.ssoState" });
      const { identity, linkUserId, reauth, authTime, returnTo } = await oidc.finish(state, code);
      // A terminal step-up (69c): a proof for the person who asked, never a sign-in, a new account or a link.
      if (reauth) {
        terminal.finishOidcStepUp(reauth, identity, authTime!);
        return void res.redirect(302, returnTo);
      }
      if (linkUserId) {
        const target = users.get(linkUserId);
        if (!target || target.disabled) throw new HiveError("forbidden", "Account disabled", { key: "errors.ssoDisabled" });
        users.linkIdentity(target.id, identity);
        hive.audit({ name: target.username, role: target.admin ? "admin" : "member" }, "users.ssoLink", target.username, oidc.settings.name);
        return void res.redirect(302, "/");
      }
      let user = users.byIdentity(identity);
      if (!user) {
        user = users.createFromIdentity(identity);
        hive.audit({ name: user.username, role: "member" }, "users.create", user.username, `SSO ${oidc.settings.name}`, {
          key: "audit.ssoCreated",
          vars: { provider: oidc.settings.name },
        });
      }
      if (user.disabled) throw new HiveError("forbidden", "Account disabled", { key: "errors.ssoDisabled" });
      users.touchLogin(user.id);
      const session = users.startSession(user.id);
      setSession(req, res, session.token, session.maxAge);
      hive.audit({ name: user.username, role: user.admin ? "admin" : "member" }, "auth.login", user.username, `${clientIp(req)} · SSO`);
      res.redirect(302, returnTo);
    } catch (err) {
      ssoBack(res, err);
    }
  });

  // Remote terminal step-up (spec 69, 69c): a person at the hub's page proves themselves again for one operation.
  app.post(TERMINAL_STEPUP_PATH, json, auth, async (req, res) => {
    try {
      // A browser always sends Origin on this POST: one without it is not the hub's page, whatever its CSRF header.
      if (!req.get("origin")) throw new HiveError("forbidden", "Yêu cầu không đến từ trang của hub.", { key: "errors.crossSite" });
      const user = userOf(res);
      const actor = actorOf(res);
      if (!user || !actor.humanSession) throw new HiveError("forbidden", "Terminal step-up: notHuman.", { key: "errors.terminal.notHuman" });
      const { result, oidcState } = await terminal.stepUp({ user, actor, body: req.body, clientIp: clientIp(req) });
      if (oidcState) setOidcState(req, res, oidcState);
      res.json({ result });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.post("/api/rpc", auth, rpcJson, async (req, res) => {
    try {
      const { method, input } = (req.body ?? {}) as { method?: unknown; input?: unknown };
      const i = (input ?? {}) as Record<string, unknown>;
      const actor = actorOf(res);
      const user = userOf(res);
      // Web-only RPCs (tokens, releases, account settings) do not pass through SqliteHive.call.
      if ((actor.runCredential || actor.mcpCredential) && !isMethod(method)) throw new HiveError("forbidden", "An agent credential can call agent methods only.");

      // Tokens: admins see and manage all; a person their own (agent/viewer tokens for their machines and CI).
      if (method === "tokens.list") {
        if (actor.role === "admin" && !actor.access) {
          res.json({ result: tokens.list() });
          return;
        }
        if (!user) throw new HiveError("forbidden", "Token không thuộc tài khoản nào.", { key: "errors.tokenNoAccount" });
        res.json({ result: tokens.list(user.id) });
        return;
      }
      if (method === "tokens.create") {
        const role = (i.role as Role | undefined) ?? "agent";
        const hubAdmin = actor.role === "admin" && !actor.access;
        // An account's grants do not let a read-only credential mint a credential with write access.
        const allowed: Role[] = hubAdmin ? TOKEN_ROLES : actor.role === "viewer" ? ["viewer"] : ["viewer", "agent"];
        if (!allowed.includes(role)) throw new HiveError("forbidden", `Bạn chỉ tạo được token vai trò ${allowed.join(", ")}.`, { key: "errors.tokenRoleNotAllowed", vars: { roles: allowed.join(", ") } });
        if (!hubAdmin && !user) throw new HiveError("forbidden", "Token không thuộc tài khoản nào.", { key: "errors.tokenNoAccount" });
        const created = tokens.create(String(i.name ?? ""), role, user?.id ?? null);
        hive.audit(actor, "tokens.create", created.info.name, created.info.role, { key: `role.${created.info.role}` });
        res.json({ result: created });
        return;
      }
      if (method === "tokens.revoke") {
        if (actor.role === "viewer") throw new HiveError("forbidden", "Read-only credentials cannot revoke tokens.", { key: "errors.roleTooLow" });
        const info = tokens.get(String(i.id ?? ""));
        if (!info) throw new HiveError("not_found", "Token not found.", { key: "errors.tokenNotFound" });
        const hubAdmin = actor.role === "admin" && !actor.access;
        if (!hubAdmin && (!user || info.ownerId !== user.id)) throw new HiveError("forbidden", "Chỉ thu hồi được token của bạn.", { key: "errors.revokeOwnOnly" });
        tokens.revoke(info.id);
        hive.audit(actor, "tokens.revoke", info.name, info.role, { key: `role.${info.role}` });
        res.json({ result: { revoked: true } });
        return;
      }

      if (method === "autoRelease.rollout") {
        const r = await hive.call("autoRelease.rollout", input as never, actor);
        if (autoReleaseProject !== r.project) throw new HiveError("forbidden", "This service is not authorized by the hub operator to roll out the desktop app.");
        if (!releases) throw new HiveError("bad_request", "This hub has no app release store.");
        releases.setRollout({ target: r.batch.version, percent: 100, paused: false, autoDownload: true, installWhen: "idle" }, actor.name);
        hive.audit(actor, "autoRelease.rollout", r.batch.version, "100% · idle");
        res.json({ result: r });
        return;
      }
      // App builds and their rollout: hub admins only.
      if (typeof method === "string" && method.startsWith("releases.")) {
        requireHubAdmin(res);
        if (!releases) throw new HiveError("bad_request", `Unknown method ${method}`);
        if (method === "releases.list") {
          // uploadPart: the hub takes a build in parts of at most this size (release.mjs asks before it sends parts).
          res.json({ result: { releases: releases.list(), rollout: releases.rollout(), machines: releases.machines(), uploadPart: UPLOAD_PART_BYTES } });
        } else if (method === "releases.setRollout") {
          const r = releases.setRollout(i as Partial<AppRollout>, actor.name);
          hive.audit(actor, "releases.setRollout", r.target ?? "—", `${r.percent}%${r.paused ? " · paused" : ""} · ${r.installWhen}${r.minVersion ? ` · min ${r.minVersion}` : ""}`);
          res.json({ result: r });
        } else if (method === "releases.notes") {
          releases.setNotes(String(i.version ?? ""), String(i.notes ?? ""));
          res.json({ result: { saved: true } });
        } else {
          throw new HiveError("bad_request", `Unknown method ${method}`);
        }
        return;
      }

      // Trang Hub (roadmap 22n): hub admins only.
      if (method === "hub.info" || method === "hub.backup" || method === "hub.cleanup") {
        requireHubAdmin(res);
        if (!hub) throw new HiveError("bad_request", `Unknown method ${method}`);
        if (method === "hub.info") res.json({ result: await hub.info() });
        else if (method === "hub.cleanup") {
          const r = await hub.cleanup();
          const freed = (r.releases?.bytes ?? 0) + r.artifacts.bytes + Math.max(0, r.db.before - r.db.after);
          hive.audit(actor, "hub.cleanup", `${(freed / 1e6).toFixed(0)} MB`, `${r.releases?.versions.length ?? 0} builds · ${r.artifacts.removed} artifacts`);
          res.json({ result: r });
        } else {
          const r = await hub.backup();
          hive.audit(actor, "hub.backup", path.basename(r.file), r.removed.length ? `− ${r.removed.length}` : "");
          res.json({ result: { file: path.basename(r.file), removed: r.removed.length, files: r.files?.copied ?? null } });
        }
        return;
      }

      // Cảnh báo (roadmap 22m): hub admins only.
      if (typeof method === "string" && method.startsWith("alerts.")) {
        requireHubAdmin(res);
        if (!alerts) throw new HiveError("bad_request", `Unknown method ${method}`);
        if (method === "alerts.list") res.json({ result: await alerts.list() });
        else if (method === "alerts.feed") res.json({ result: await alerts.feed(Math.min(100, Math.max(1, Number(i.limit ?? 40)))) });
        else if (method === "alerts.ack") res.json({ result: alerts.ack(Number(i.id), actor.name) });
        else if (method === "alerts.setRule") {
          const rule = await alerts.setRule(String(i.rule ?? ""), i.enabled === true, actor.name);
          hive.audit(actor, "alerts.setRule", rule.rule, rule.enabled ? "on" : "off");
          res.json({ result: rule });
        } else throw new HiveError("bad_request", `Unknown method ${method}`);
        return;
      }

      if (typeof method === "string" && method.startsWith("automation.")) {
        requireHubAdmin(res);
        if (!automation) throw new HiveError("bad_request", "Automation unavailable");
        let result: unknown;
        if (method === "automation.list") result = automation.list();
        else if (method === "automation.history") result = automation.history();
        else if (method === "automation.save") {
          const user = res.locals.user;
          const owner = user ? `user:${user.id}` : actor.tokenId ? `token:${actor.tokenId}` : null;
          if (!owner) throw new HiveError("forbidden", "A persistent identity is required");
          result = automation.save(i, owner, actor);
        } else if (method === "automation.dryRun") result = automation.dryRun(Number(i.id), i.event as never);
        else if (method === "automation.retry") {
          result = await automation.retry(Number(i.id));
          hive.audit(actor, "automation.retry", String(i.id), "manual retry");
        } else throw new HiveError("bad_request", `Unknown method ${method}`);
        res.json({ result });
        return;
      }

      // Chat webhooks: hub admins only. The stored URL never goes back out.
      if (typeof method === "string" && method.startsWith("webhooks.")) {
        requireHubAdmin(res);
        if (!webhooks) throw new HiveError("bad_request", `Unknown method ${method}`);
        if (method === "webhooks.list") {
          res.json({ result: webhooks.store.list() });
        } else if (method === "webhooks.save") {
          const saved = webhooks.store.save(i as unknown as WebhookInput);
          hive.audit(actor, "webhooks.save", saved.name, `${saved.kind} · ${saved.events.join(", ")}`);
          res.json({ result: saved });
        } else if (method === "webhooks.remove") {
          const target = webhooks.store.get(Number(i.id));
          const removed = webhooks.store.remove(Number(i.id));
          if (target && removed) hive.audit(actor, "webhooks.remove", target.name, target.kind);
          res.json({ result: { removed } });
        } else if (method === "webhooks.test") {
          res.json({ result: await webhooks.dispatcher.test(Number(i.id)) });
        } else {
          throw new HiveError("bad_request", `Unknown method ${method}`);
        }
        return;
      }

      // Thành viên (roadmap 25): who has which role in a project, set by one who may manage its members. A lead adds
      // accounts that exist (creating one stays a hub admin's), never above their own permissions, never themselves.
      if (method === "members.list" || method === "members.set") {
        const project = i.project === null || i.project === undefined || i.project === "" ? null : String(i.project);
        // A project one cannot see is not there, as everywhere else on the hub.
        if (!sees(actor, project)) throw new HiveError("not_found", `Project ${project} not found.`, { key: "errors.notFound" });
        if (!may(actor, project, "membersManage")) throw new HiveError("forbidden", "Cần quyền quản lý thành viên.", { key: project === null ? "errors.needShared.membersManage" : "errors.need.membersManage", vars: { project: project ?? "" } });
        const grantOf = (u: UserInfo) => (project === null ? u.shared : (u.grants[project] ?? null));
        if (method === "members.list") {
          res.json({ result: users.list().filter((u) => !u.disabled).map((u) => ({ id: u.id, username: u.username, displayName: u.displayName, admin: u.admin, grant: u.admin ? "lead" : grantOf(u) })) });
          return;
        }
        const target = users.get(String(i.userId ?? ""));
        if (!target) throw new HiveError("not_found", "Không có tài khoản này.", { key: "errors.userNotFound" });
        if (target.admin) throw new HiveError("bad_request", "Admin của hub có mọi quyền.", { key: "errors.memberIsAdmin" });
        if (user && target.id === user.id) throw new HiveError("bad_request", "Không tự đổi quyền của mình.", { key: "errors.memberIsSelf" });
        const mine = permissionsOn(actor, project) ?? new Set();
        const above = (g: unknown) => [...grantPermissions(g as Grant)].filter((p) => !mine.has(p));
        const raw = i.grant ?? null;
        const over = [...above(raw), ...above(grantOf(target))];
        if (actor.access && over.length) {
          throw new HiveError("forbidden", `Vượt quyền của bạn: ${[...new Set(over)].join(", ")}`, { key: "errors.memberAboveYou", vars: { permissions: [...new Set(over)].join(", ") } });
        }
        const updated = users.setGrant(target.id, project, raw);
        const now = grantOf(updated);
        hive.audit(actor, "members.set", `${project ?? "Chung"}/${updated.username}`, now ? grantLabel(now) : "—", { key: now ? "audit.memberSet" : "audit.memberRemoved", vars: { project: project ?? "Chung", user: updated.username, role: now ? grantLabel(now) : "" } });
        res.json({ result: { id: updated.id, username: updated.username, displayName: updated.displayName, admin: updated.admin, grant: now } });
        return;
      }

      // Accounts: hub admins only.
      if (typeof method === "string" && method.startsWith("users.")) {
        requireHubAdmin(res);
        const id = String(i.id ?? "");
        const target = id ? users.get(id) : null;
        if (method === "users.list") {
          res.json({ result: users.list() });
        } else if (method === "users.create") {
          const created = users.create({ username: String(i.username ?? ""), displayName: String(i.displayName ?? ""), admin: i.admin === true });
          hive.audit(actor, "users.create", created.user.username, created.user.admin ? "admin" : "member", { key: created.user.admin ? "role.admin" : "role.member" });
          res.json({ result: created });
        } else if (method === "users.update") {
          if (!target) throw new HiveError("not_found", "Không có tài khoản này.", { key: "errors.userNotFound" });
          const updated = users.update(id, {
            displayName: typeof i.displayName === "string" ? i.displayName : undefined,
            admin: typeof i.admin === "boolean" ? i.admin : undefined,
            disabled: typeof i.disabled === "boolean" ? i.disabled : undefined,
          });
          const changes = [
            updated.admin !== target.admin ? (updated.admin ? "cấp admin" : "bỏ admin") : "",
            updated.disabled !== target.disabled ? (updated.disabled ? "khoá" : "mở khoá") : "",
          ].filter(Boolean);
          // The admin page changes one thing at a time; the key names the first change.
          const key =
            updated.admin !== target.admin
              ? updated.admin
                ? "audit.adminGranted"
                : "audit.adminRevoked"
              : updated.disabled !== target.disabled
                ? updated.disabled
                  ? "audit.disabled"
                  : "audit.enabled"
                : "audit.renamed";
          hive.audit(actor, "users.update", updated.username, changes.join(", ") || "sửa tên", { key });
          res.json({ result: updated });
        } else if (method === "users.setGrants") {
          if (!target) throw new HiveError("not_found", "Không có tài khoản này.", { key: "errors.userNotFound" });
          const updated = users.setGrants(id, (i.grants ?? {}) as Record<string, unknown>, "shared" in i ? i.shared : undefined);
          const summary = [...Object.entries(updated.grants), ...(updated.shared ? [["Chung", updated.shared] as const] : [])].map(([p, g]) => `${p}: ${grantLabel(g)}`).join(", ");
          hive.audit(actor, "users.setGrants", updated.username, summary || "không dự án nào", summary ? { key: "audit.grants", vars: { grants: summary } } : { key: "audit.noGrants" });
          res.json({ result: updated });
        } else if (method === "users.resetPassword") {
          if (!target) throw new HiveError("not_found", "Không có tài khoản này.", { key: "errors.userNotFound" });
          const password = users.resetPassword(id);
          hive.audit(actor, "users.resetPassword", target.username);
          res.json({ result: { password } });
        } else {
          throw new HiveError("bad_request", `Unknown method ${method}`);
        }
        return;
      }

      // Remote terminal (69c): web-only, as it spends proofs bound to the browser session; who may is core's terminalDecision.
      if (typeof method === "string" && method.startsWith("terminal.")) {
        res.json({ result: await terminal.rpc(method, input, actor) });
        return;
      }

      if (!isMethod(method)) throw new HiveError("bad_request", `Unknown method ${String(method)}`);
      // Each chat request gets its MCP token here; the sender's rights stay on the hub.
      const withGrants = (requests: ChatRequest[]) =>
        requests.map(({ sender, ...r }) => ({ ...r, ...(sender ? { grant: chatGrants.issue(r.replyId, sender, actor) } : {}) }));
      if (method === "machines.heartbeat") {
        if (!actor.tokenId || actor.runCredential || actor.mcpCredential || actor.chatReply !== undefined)
          throw new HiveError("forbidden", "A machine token is required.", { key: "errors.machineIdentityForbidden" });
        const out = await hive.call(method, input as never, actor);
        // App updates live on the hub, not in core: the machine's platform and update state ride along in the input.
        const beat = (input ?? {}) as { machine?: string; version?: string; platform?: string; arch?: string; updateKind?: string; update?: UpdateReport | null };
        let update = null;
        if (releases && typeof beat.version === "string") {
          releases.report(actor.name, String(beat.machine ?? actor.name), beat.version, beat.update ?? null);
          update = releases.offerFor(actor.name, beat.version, String(beat.platform ?? ""), String(beat.arch ?? ""), beat.updateKind);
        }
        res.json({ result: { ...out, chatRequests: withGrants(out.chatRequests), update } });
        return;
      }
      // A machine older than the rollout's minimum gets no runs from the hub.
      if ((method === "runs.dispatch" || method === "runs.prompt" || method === "runs.dispatchMany") && releases) {
        const min = releases.rollout().minVersion;
        const body = input as { machineId?: unknown; items?: Array<{ machineId?: unknown }> } | null;
        // A run group's pinned machines; those it leaves to the hub are picked later, in the store, which cannot see this.
        const machineIds = [body?.machineId, ...(Array.isArray(body?.items) ? body.items.map((i) => i?.machineId) : [])].filter((x): x is string => typeof x === "string" && x !== "");
        if (min && machineIds.length) {
          const machines = await hive.call("machines.list", {}, actor);
          for (const machineId of new Set(machineIds)) {
            const m = machines.find((x) => x.id === machineId);
            if (m && compareVersions(m.version, min) < 0) {
              throw new HiveError("conflict", `${m.machine} runs ${m.version}; the hub needs ${min} or newer.`, { key: "errors.machineTooOld", vars: { machine: m.machine, version: m.version, min } });
            }
          }
        }
      }
      if (method === "chat.poll") {
        res.json({ result: withGrants(await hive.call(method, input as never, actor)) });
        return;
      }
      res.json({ result: await hive.call(method, input as never, actor) });
    } catch (err) {
      sendError(res, err);
    }
  });

  // Desktop builds (roadmap 22i): the release script uploads each one (a hub admin's token); machines download the one
  // their heartbeat offered with their own token.
  if (releases) {
    // A proxy in front of the hub may refuse big bodies (Cloudflare's tunnel: 413 over 100 MB), and builds are bigger:
    // those come as the parts of one upload (?upload=<id>&part=<i>&parts=<n>&sha256=<of the whole file>), appended in
    // order; the last part adds the build. A part out of order drops the upload, and the script sends it again.
    const uploads = new Map<string, { tmp: string; next: number; parts: number; name: string; hash: Hash; at: number }>();
    const drop = (id: string) => {
      const u = uploads.get(id);
      if (u) rmSync(u.tmp, { force: true });
      uploads.delete(id);
    };
    app.post("/api/releases/upload", auth, async (req, res) => {
      const q = (k: string) => String(req.query[k] ?? "");
      const id = q("upload");
      // Parts nobody went on with for an hour are gone.
      for (const [k, u] of uploads) if (Date.now() - u.at > 3_600_000) drop(k);
      let tmp = releases.tmpFile();
      try {
        requireHubAdmin(res);
        let upload: { tmp: string; hash: Hash; next: number; parts: number } | null = null;
        if (id) {
          const part = Number(q("part"));
          const parts = Number(q("parts"));
          if (!/^[a-f0-9]{16,64}$/.test(id) || !Number.isInteger(part) || !Number.isInteger(parts) || parts < 1 || parts > 1000 || part < 0 || part >= parts) {
            throw new HiveError("bad_request", "upload, part and parts do not fit together.", { key: "errors.releasePart", vars: { part: q("part"), expected: 0 } });
          }
          if (part === 0) {
            drop(id);
            uploads.set(id, { tmp, next: 0, parts, name: q("name"), hash: createHash("sha256"), at: Date.now() });
          }
          const u = uploads.get(id);
          if (!u || u.next !== part || u.parts !== parts || u.name !== q("name")) {
            const expected = u?.next ?? 0;
            drop(id);
            throw new HiveError("conflict", `Part ${part} of ${q("name")} came, the hub waited for part ${expected}: send the file again.`, {
              key: "errors.releasePart",
              vars: { part, expected },
            });
          }
          tmp = u.tmp;
          upload = u;
        }
        const hash = upload?.hash ?? createHash("sha256");
        let receivedBytes = 0;
        const tap = new Transform({
          transform(chunk: Buffer, _enc, done) {
            // The advertised part limit must also bound streamed/chunked bodies, independent of Content-Length.
            receivedBytes += chunk.length;
            if (receivedBytes > UPLOAD_PART_BYTES) {
              done(new HiveError("bad_request", `Upload parts are at most ${UPLOAD_PART_BYTES / 1024 / 1024} MB.`));
              return;
            }
            hash.update(chunk);
            done(null, chunk);
          },
        });
        await pipeline(req, tap, createWriteStream(tmp, { flags: upload ? "a" : "w" }));
        if (upload) {
          const u = uploads.get(id)!;
          u.next++;
          u.at = Date.now();
          if (u.next < u.parts) {
            res.json({ result: { received: u.next, parts: u.parts } });
            return;
          }
          uploads.delete(id);
        }
        const sha256 = hash.digest("hex");
        if (q("sha256") && q("sha256") !== sha256) {
          throw new HiveError("bad_request", `${q("name")} arrived with another SHA-256 than it was sent with.`, { key: "errors.releaseChecksum", vars: { name: q("name") } });
        }
        const file = releases.add({ version: q("version"), channel: q("channel"), platform: q("platform"), arch: q("arch"), kind: q("kind"), name: q("name"), tmpFile: tmp, sha256 });
        hive.audit(actorOf(res), "releases.upload", `${file.version}/${file.name}`, `${file.platform}-${file.arch} · ${(file.size / 1e6).toFixed(0)} MB`);
        res.json({ result: file });
      } catch (err) {
        rmSync(tmp, { force: true });
        if (id) drop(id);
        sendError(res, err);
      }
    });
    app.get("/api/releases/files/:id", auth, (req, res) => {
      const id = String(req.params.id ?? "");
      const found = /^\d+$/.test(id) ? releases.stream(Number(id)) : null;
      if (!found) {
        res.status(404).json({ error: { code: "not_found", message: "No such build.", key: "errors.notFound" } });
        return;
      }
      res.set({
        "content-type": "application/octet-stream",
        "content-length": String(found.file.size),
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(found.file.name)}`,
        "x-hive-sha256": found.file.sha256,
      });
      found.body.pipe(res);
    });
  }

  // Chat attachments (roadmap 17g): the bytes go over plain HTTP, not JSON-RPC. A file is uploaded first, then sent
  // with chat.send; whoever sees the project's chats reads it (people by their session, machines by their token).
  const fileBody = express.raw({ type: () => true, limit: CHAT_FILE_MAX_BYTES + 1 });
  app.post("/api/chat/files", auth, fileBody, (req, res) => {
    try {
      const project = String(req.query.project ?? "");
      if (project !== HUB_SCOPE && !PROJECT_NAME.test(project)) throw new HiveError("bad_request", "Pick the chat's project.", { key: "errors.chatFileProject" });
      const bytes = Buffer.isBuffer(req.body) ? new Uint8Array(req.body) : new Uint8Array();
      res.json({ result: hive.putChatFile({ project, name: String(req.query.name ?? "file"), bytes }, actorOf(res)) });
    } catch (err) {
      sendError(res, err);
    }
  });
  // Over the size the body parser takes: the same answer the hub gives for a big file it has read.
  app.use("/api/chat/files", (err: { type?: string }, _req: Request, res: Response, next: NextFunction) => {
    if (err?.type !== "entity.too.large") return next(err);
    const mb = CHAT_FILE_MAX_BYTES / 1024 / 1024;
    res.status(413).json({ error: { code: "bad_request", message: `Files are at most ${mb} MB.`, key: "errors.chatFileTooBig", vars: { name: "", mb } } });
  });
  app.get("/api/chat/files/:id", auth, (req, res) => {
    const id = String(req.params.id ?? "");
    const file = /^\d+$/.test(id) ? hive.chatFile(Number(id), actorOf(res)) : null;
    if (!file) {
      res.status(404).json({ error: { code: "not_found", message: "No such file.", key: "errors.notFound" } });
      return;
    }
    // Never run as a page of the hub: text is served as plain text, and a sandbox forbids scripts anyway.
    res.set({
      "content-type": isImage(file.type) || file.type === "application/pdf" ? file.type : "text/plain; charset=utf-8",
      "content-disposition": `${isImage(file.type) ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox; default-src 'none'; img-src 'self'",
      "cache-control": "private, max-age=3600",
    });
    res.send(Buffer.from(file.bytes));
  });

  // MCP over Streamable HTTP, stateless: one server per request, same tools as the stdio `hive-mcp`. Tokens only.
  app.post("/mcp", json, authenticate({ cookie: false }), async (req, res) => {
    const actor = actorOf(res);
    // Headers can only narrow what the token may do: a default project, and read-only.
    const project = req.get("x-hive-project");
    const store = alerts;
    // A chat leader's scope is its thread's, not a header the machine sends (roadmap 37): the hub-wide chat has no
    // default project at all, so each tool asks which project it is for instead of guessing one.
    const scope =
      actor.chatReply === undefined
        ? null
        : ((hive.db.prepare("SELECT t.project FROM chat_messages m JOIN chat_threads t ON t.id = m.thread_id WHERE m.id = ?").get(actor.chatReply) as { project?: string } | undefined)
            ?.project ?? null);
    const server = createHiveMcpServer(
      hive,
      { ...actor, source: { ...actor.source, via: "mcp" } },
      {
        ...(scope === HUB_SCOPE ? { hubScope: true } : {}),
        ...(scope === HUB_SCOPE ? {} : scope ? { defaultProject: scope } : project && PROJECT_NAME.test(project) ? { defaultProject: project } : {}),
        ...(req.get("x-hive-readonly") === "1" ? { readOnly: true } : {}),
        // The server shows alert_list to hub admins only; the rules and the feed stay on the web.
        ...(store ? { alerts: { list: async () => (await store.list()).open } } : {}),
      },
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      hubLog.error("[xdev-hive] mcp", err);
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    }
  });
  app.all("/mcp", (_req, res) => {
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server)" }, id: null });
  });

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: { code: "not_found", message: "Unknown endpoint" } });
  });

  if (ui && "dir" in ui) {
    app.use(express.static(ui.dir, { index: false, maxAge: "1h" }));
    // `root` keeps send's dotfile check off the install path itself (e.g. an app under ~/.local).
    app.get(/^\/(?!api\/|mcp$).*/, (_req, res) => res.sendFile("index.html", { root: ui.dir }));
  } else if (ui) {
    app.use(ui.middleware);
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (err as { status?: number }).status;
    if (status === 400 || status === 413) {
      res.status(status).json({ error: { code: "bad_request", message: status === 413 ? "Body too large" : "Invalid JSON" } });
      return;
    }
    sendError(res, err);
  });

  return app;
}
