import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { hostHeaderValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { HiveError, HTTP_STATUS, isMethod, toErrorPayload, TOKEN_ROLES, type Actor, type Me, type Role } from "@xdev-hive/core";
import type { SqliteHive } from "@xdev-hive/core/node";
import { createHiveMcpServer } from "@xdev-hive/mcp";
import type { TokenStore } from "./tokens.ts";
import { LoginThrottle, type UserInfo, type UserStore } from "./users.ts";

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

export function createHubApp({ hive, tokens, users, allowedHosts, ui, trustProxy = false, throttle = new LoginThrottle() }: HubAppOptions): express.Express {
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
    res.setHeader(
      "set-cookie",
      `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure(req) ? "; Secure" : ""}`,
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
    const who = tokens.verify(raw);
    if (!who) return null;
    const label = (req.get("x-hive-agent") ?? "").replace(/[^\w.-]/g, "").slice(0, 80);
    const name = label ? `${label}@${who.name}` : who.name;
    if (!who.ownerId) return { name, role: who.role };
    const user = users.get(who.ownerId);
    if (!user || user.disabled) return null;
    res.locals.user = user;
    // An account that lost admin keeps its old admin tokens only as a member.
    const role: Role = who.role === "admin" && !user.admin ? "member" : who.role;
    return { name, role, access: users.access(user) };
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
      res.locals.actor = { name: user.username, role: user.admin ? "admin" : "member", access: users.access(user) } satisfies Actor;
      next();
    };
  const auth = authenticate({ cookie: true });

  const me = (res: Response): Me => {
    const { name, role, access } = actorOf(res);
    const user = userOf(res);
    return { name, role, mode: "hub", ...(access ? { access } : {}), ...(user ? { user: publicUser(user) } : {}) };
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
      res.locals.actor = { name: user.username, role: user.admin ? "admin" : "member", access: users.access(user) } satisfies Actor;
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

  /** The desktop app signs in with username + password once and keeps a token for this machine. */
  app.post("/api/device-token", json, (req, res) => {
    try {
      const user = signIn(req);
      if (user.mustChangePassword) throw new HiveError("forbidden", "Tài khoản đang dùng mật khẩu tạm: đăng nhập hub trên trình duyệt để đổi mật khẩu trước.", {
          key: "errors.temporaryPassword",
        });
      const name = String((req.body as { name?: unknown }).name ?? "").trim();
      const created = tokens.create(name, user.admin ? "admin" : "member", user.id);
      for (const old of tokens.list(user.id)) if (old.name === created.info.name && old.id !== created.info.id) tokens.revoke(old.id);
      hive.audit({ name: user.username, role: user.admin ? "admin" : "member" }, "tokens.create", created.info.name, `${created.info.role} · máy`, {
        key: "audit.machineToken",
        vars: { role: created.info.role },
      });
      res.json({ result: { token: created.token, info: created.info, user: publicUser(user) } });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.get("/api/me", authenticate({ cookie: true, allowPasswordChange: true }), (_req, res) => {
    res.json({ result: me(res) });
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
      res.json({ result: await hive.call(method, input as never, actor) });
    } catch (err) {
      sendError(res, err);
    }
  });

  // MCP over Streamable HTTP, stateless: one server per request, same tools as the stdio `hive-mcp`. Tokens only.
  app.post("/mcp", json, authenticate({ cookie: false }), async (req, res) => {
    const server = createHiveMcpServer(hive, actorOf(res));
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
