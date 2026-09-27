import path from "node:path";
import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { hostHeaderValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { HiveError, HTTP_STATUS, isMethod, ROLE_RANK, type Actor, type Role } from "@xdev-hive/core";
import type { SqliteHive } from "@xdev-hive/core/node";
import { createHiveMcpServer } from "@xdev-hive/mcp";
import type { TokenStore } from "./tokens.ts";

export interface HubAppOptions {
  hive: SqliteHive;
  tokens: TokenStore;
  /** Hostnames accepted in the Host header (DNS-rebinding protection). */
  allowedHosts?: string[];
  /** Built client (production) or a dev middleware such as Vite. */
  ui?: { dir: string } | { middleware: RequestHandler };
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

function sendError(res: Response, err: unknown): void {
  if (err instanceof HiveError) {
    res.status(HTTP_STATUS[err.code]).json({ error: { code: err.code, message: err.message } });
    return;
  }
  console.error("[xdev-hive]", err);
  res.status(500).json({ error: { code: "internal", message: "Internal error" } });
}

const actorOf = (res: Response) => res.locals.actor as Actor;

function requireRole(res: Response, role: Role): void {
  if (ROLE_RANK[actorOf(res).role] < ROLE_RANK[role]) throw new HiveError("forbidden", `Requires role "${role}".`);
}

export function createHubApp({ hive, tokens, allowedHosts, ui }: HubAppOptions): express.Express {
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

  const auth: RequestHandler = (req, res, next) => {
    const match = /^Bearer\s+(\S+)$/i.exec(req.get("authorization") ?? "");
    const who = match ? tokens.verify(match[1]!) : null;
    if (!who) {
      res.status(401).json({ error: { code: "unauthorized", message: "Missing or invalid token." } });
      return;
    }
    const label = (req.get("x-hive-agent") ?? "").replace(/[^\w.-]/g, "").slice(0, 80);
    res.locals.actor = { name: label ? `${label}@${who.name}` : who.name, role: who.role } satisfies Actor;
    next();
  };

  app.get("/api/health", (_req, res) => {
    res.json({ result: { ok: true } });
  });

  app.get("/api/me", auth, (_req, res) => {
    res.json({ result: { ...actorOf(res), mode: "hub" } });
  });

  app.post("/api/rpc", json, auth, async (req, res) => {
    try {
      const { method, input } = (req.body ?? {}) as { method?: unknown; input?: unknown };
      if (method === "tokens.list") {
        requireRole(res, "admin");
        res.json({ result: tokens.list() });
        return;
      }
      if (method === "tokens.create") {
        requireRole(res, "admin");
        const { name, role } = (input ?? {}) as { name?: string; role?: Role };
        res.json({ result: tokens.create(String(name ?? ""), role ?? "agent") });
        return;
      }
      if (method === "tokens.revoke") {
        requireRole(res, "admin");
        tokens.revoke(String((input as { id?: string } | undefined)?.id ?? ""));
        res.json({ result: { revoked: true } });
        return;
      }
      if (!isMethod(method)) throw new HiveError("bad_request", `Unknown method ${String(method)}`);
      res.json({ result: await hive.call(method, input as never, actorOf(res)) });
    } catch (err) {
      sendError(res, err);
    }
  });

  // MCP over Streamable HTTP, stateless: one server per request, same tools as the stdio `hive-mcp`.
  app.post("/mcp", json, auth, async (req, res) => {
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
    app.get(/^\/(?!api\/|mcp$).*/, (_req, res) => res.sendFile(path.join(ui.dir, "index.html")));
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
