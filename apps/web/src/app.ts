import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { hostHeaderValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  HiveError,
  HTTP_STATUS,
  isMethod,
  PROJECT_NAME,
  readSourceHeader,
  toErrorPayload,
  TOKEN_ROLES,
  type Actor,
  type Me,
  type Role,
  type WebhookInput,
} from "@xdev-hive/core";
import type { SqliteHive } from "@xdev-hive/core/node";
import { createHiveMcpServer } from "@xdev-hive/mcp";
import { DEVICE_CHALLENGE, DEVICE_STATE, DeviceGrants, loopbackCallback } from "./device.ts";
import { SSO_ERRORS, type OidcClient } from "./oidc.ts";
import { ChatGrants } from "./grants.ts";
import type { TokenStore } from "./tokens.ts";
import { LoginThrottle, type UserInfo, type UserStore } from "./users.ts";
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
  webhooks?: { store: WebhookStore; dispatcher: WebhookDispatcher };
  /** Sign-in through an OpenID Connect provider (HIVE_OIDC_*). */
  oidc?: OidcClient | null;
  /** Tokens for a chat reply's MCP calls; by default kept in the hub's database. */
  chatGrants?: ChatGrants;
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
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
 * Host header allow-list from HIVE_ALLOWED_HOSTS. Loopback names are always accepted, so container health
 * checks and a proxy on the same host work: DNS rebinding sends the attacker's hostname, never these.
 * Undefined (no check) only when nothing is configured and the hub listens beyond loopback.
 */
export function allowedHostsFor(configured: string | undefined, bindHost: string): string[] | undefined {
  const list = configured?.split(",").map((h) => h.trim()).filter(Boolean) ?? [];
  if (list.length) return [...new Set([...list, ...LOOPBACK_HOSTS])];
  return ["127.0.0.1", "localhost", "::1"].includes(bindHost) ? LOOPBACK_HOSTS : undefined;
}

function sendError(res: Response, err: unknown): void {
  if (err instanceof HiveError) {
    res.status(HTTP_STATUS[err.code]).json({ error: toErrorPayload(err) });
    return;
  }
  console.error("[xdev-hive]", err);
  res.status(500).json({ error: { code: "internal", message: "Internal error" } });
}

const actorOf = (res: Response) => res.locals.actor as Actor;
const userOf = (res: Response) => res.locals.user as UserInfo | undefined;

/** Hub admins: an admin account, or an admin token of no account (the bootstrap / pre-account tokens). */
function requireHubAdmin(res: Response): void {
  const actor = actorOf(res);
  if (actor.role !== "admin" || actor.access) throw new HiveError("forbidden", "Chỉ admin của hub.", { key: "errors.hubAdminOnly" });
}

function readCookie(req: Request, name: string): string | null {
  for (const part of (req.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

function publicUser(u: UserInfo): NonNullable<Me["user"]> {
  return { id: u.id, username: u.username, displayName: u.displayName, admin: u.admin, mustChangePassword: u.mustChangePassword };
}

export function createHubApp({
  hive,
  tokens,
  users,
  allowedHosts,
  ui,
  trustProxy = false,
  throttle = new LoginThrottle(),
  webhooks,
  oidc = null,
  chatGrants = new ChatGrants(hive.db),
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

  const json = express.json({ limit: "1mb" });
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

  const tokenActor = (req: Request, res: Response, raw: string): Actor | null => {
    const label = (req.get("x-hive-agent") ?? "").replace(/[^\w.-]/g, "").slice(0, 80);
    const source = readSourceHeader(req.get("x-hive-source"));
    const who = tokens.verify(raw);
    if (!who) {
      // A chat reply's leader: the rights cut when the machine got the request (see ChatGrants).
      const grant = chatGrants.verify(raw);
      return grant ? { name: label ? `${label}@${grant.name}` : grant.name, role: grant.role, ...(grant.access ? { access: grant.access } : {}), source } : null;
    }
    const name = label ? `${label}@${who.name}` : who.name;
    if (!who.ownerId) return { name, role: who.role, source };
    const user = users.get(who.ownerId);
    if (!user || user.disabled) return null;
    res.locals.user = user;
    // An account that lost admin keeps its old admin tokens only as a member.
    const role: Role = who.role === "admin" && !user.admin ? "member" : who.role;
    return { name, role, access: users.access(user), source };
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
      res.locals.actor = { name: user.username, role: user.admin ? "admin" : "member", access: users.access(user), source: { via: "web" } } satisfies Actor;
      next();
    };
  const auth = authenticate({ cookie: true });

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
      res.locals.actor = { name: user.username, role: user.admin ? "admin" : "member", access: users.access(user), source: { via: "web" } } satisfies Actor;
      res.json({ result: me(res) });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.post("/api/logout", (req, res) => {
    const session = readCookie(req, SESSION_COOKIE);
    if (session && sameSite(req)) users.endSession(session);
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
    for (const old of tokens.list(user.id)) if (old.name === created.info.name && old.id !== created.info.id) tokens.revoke(old.id);
    hive.audit({ name: user.username, role: user.admin ? "admin" : "member" }, "tokens.create", created.info.name, `${created.info.role} · máy`, {
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
    if (!(err instanceof HiveError)) console.error("[xdev-hive] SSO", err);
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
      const { identity, linkUserId, returnTo } = await oidc.finish(state, code);
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

  app.post("/api/rpc", json, auth, async (req, res) => {
    try {
      const { method, input } = (req.body ?? {}) as { method?: unknown; input?: unknown };
      const i = (input ?? {}) as Record<string, unknown>;
      const actor = actorOf(res);
      const user = userOf(res);

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
        const allowed: Role[] = hubAdmin ? TOKEN_ROLES : ["viewer", "agent"];
        if (!allowed.includes(role)) throw new HiveError("forbidden", `Bạn chỉ tạo được token vai trò ${allowed.join(", ")}.`, { key: "errors.tokenRoleNotAllowed", vars: { roles: allowed.join(", ") } });
        if (!hubAdmin && !user) throw new HiveError("forbidden", "Token không thuộc tài khoản nào.", { key: "errors.tokenNoAccount" });
        const created = tokens.create(String(i.name ?? ""), role, user?.id ?? null);
        hive.audit(actor, "tokens.create", created.info.name, created.info.role, { key: `role.${created.info.role}` });
        res.json({ result: created });
        return;
      }
      if (method === "tokens.revoke") {
        const info = tokens.get(String(i.id ?? ""));
        if (!info) throw new HiveError("not_found", "Token not found.", { key: "errors.tokenNotFound" });
        const hubAdmin = actor.role === "admin" && !actor.access;
        if (!hubAdmin && (!user || info.ownerId !== user.id)) throw new HiveError("forbidden", "Chỉ thu hồi được token của bạn.", { key: "errors.revokeOwnOnly" });
        tokens.revoke(info.id);
        hive.audit(actor, "tokens.revoke", info.name, info.role, { key: `role.${info.role}` });
        res.json({ result: { revoked: true } });
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
          const updated = users.setGrants(id, (i.grants ?? {}) as Record<string, string>);
          const summary = Object.entries(updated.grants).map(([p, l]) => `${p}: ${l}`).join(", ");
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

      if (!isMethod(method)) throw new HiveError("bad_request", `Unknown method ${String(method)}`);
      if (method === "machines.heartbeat") {
        // Each chat request gets its MCP token here; the sender's rights stay on the hub.
        const out = await hive.call(method, input as never, actor);
        const chatRequests = out.chatRequests.map(({ sender, ...r }) => ({ ...r, ...(sender ? { grant: chatGrants.issue(r.replyId, sender, actor) } : {}) }));
        res.json({ result: { ...out, chatRequests } });
        return;
      }
      res.json({ result: await hive.call(method, input as never, actor) });
    } catch (err) {
      sendError(res, err);
    }
  });

  // MCP over Streamable HTTP, stateless: one server per request, same tools as the stdio `hive-mcp`. Tokens only.
  app.post("/mcp", json, authenticate({ cookie: false }), async (req, res) => {
    const actor = actorOf(res);
    // Headers can only narrow what the token may do: a default project, and read-only.
    const project = req.get("x-hive-project");
    const server = createHiveMcpServer(
      hive,
      { ...actor, source: { ...actor.source, via: "mcp" } },
      {
        ...(project && PROJECT_NAME.test(project) ? { defaultProject: project } : {}),
        ...(req.get("x-hive-readonly") === "1" ? { readOnly: true } : {}),
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
      console.error("[xdev-hive] mcp", err);
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
