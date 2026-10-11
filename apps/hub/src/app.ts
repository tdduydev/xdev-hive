import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { RPCHandler } from "@orpc/server/fetch";
import { Hono } from "hono";
import type pg from "pg";
import { catalogRouter, findWebhookTarget } from "./modules/catalog/index.ts";
import { costsRouter } from "./modules/cost/index.ts";
import { fleetRouter } from "./modules/fleet/index.ts";
import { type Auth, mcpMode, meRouter } from "./modules/identity/index.ts";
import { type Embedder, registerMcpTools as knowledgeMcpTools, knowledgeRouter } from "./modules/knowledge/index.ts";
import { createMcpEndpoint, McpToolRegistry, type RunTokenVerifier } from "./modules/mcp/index.ts";
import { notifyRouter } from "./modules/notify/index.ts";
import type { HubConfig, Jobs } from "./modules/platform/index.ts";
import {
  RunNotifier,
  type RunsEngine,
  runStreamHandler,
  registerMcpTools as runsMcpTools,
  runsRouter,
} from "./modules/runs/index.ts";
import { defaultProviderFactory, handleGitWebhook, type ProviderFactory, scmRouter } from "./modules/scm/index.ts";
import { DesktopReleaseCache, findDesktopUpdate, systemRouter } from "./modules/system/index.ts";
import { tasksRouter } from "./modules/tasks/index.ts";
import { registerMcpTools as tenancyMcpTools, tenancyRouter } from "./modules/tenancy/index.ts";
import { mapDomainErrors } from "./rpc-errors.ts";

export interface AppDeps {
  config: HubConfig;
  webDist?: string | undefined;
  /** Không có khi chạy test đơn vị không cần database. */
  auth?: Auth | undefined;
  /** Pool của role hive_app (HIVE_DATABASE_URL). Không có khi chạy test đơn vị không cần database. */
  pool?: pg.Pool | undefined;
  /** Kiểm run token cho /mcp; bỏ trống thì lấy từ lõi giao run, không có cả hai thì cổng chỉ nhận token OAuth. */
  runTokens?: RunTokenVerifier | undefined;
  /** Hàng đợi pg-boss; không có thì không tạo được dự án. */
  jobs?: Jobs | undefined;
  /** Thay GitHub/GitLab thật bằng provider giả khi test. */
  providerFactory?: ProviderFactory | undefined;
  /** Tạo embedding cho memory; không có thì chỉ tìm theo từ. */
  embedder?: Embedder | undefined;
  /** Lõi giao run; không có thì xem được run nhưng không giao hay huỷ được (thiếu HIVE_AUTH_SECRET). */
  runs?: RunsEngine | undefined;
  /** Kết nối LISTEN cho SSE của run; bỏ trống thì tự tạo từ pool. */
  runNotifier?: RunNotifier | undefined;
}

export function createApp({
  config,
  auth,
  pool,
  runTokens,
  jobs,
  providerFactory,
  embedder,
  runs,
  runNotifier,
  webDist = process.env.HIVE_WEB_DIST,
}: AppDeps) {
  const publicUrl = config.publicUrl ?? `http://localhost:${config.port}`;
  const shared = {
    auth,
    pool,
    masterKey: config.masterKey,
    providerFactory: providerFactory ?? defaultProviderFactory,
  };
  // Một cache cho cả route Hono (Tauri) và handler oRPC: manifest chỉ đọc một lần mỗi 5 phút.
  const desktopReleases = new DesktopReleaseCache(config.desktopReleases);
  const router = {
    system: systemRouter(config, desktopReleases),
    me: meRouter(auth),
    ...tenancyRouter({ auth, pool, orgCreators: config.orgCreators, publicUrl: config.publicUrl }),
    ...fleetRouter({ auth, pool, publicUrl }),
    scmConnections: scmRouter(shared),
    notificationChannels: notifyRouter({ ...shared, allowPrivate: config.notifyAllowPrivate }),
    projects: catalogRouter({ ...shared, jobs, publicUrl }),
    ...knowledgeRouter({ auth, pool, jobs, embedder }),
    tasks: tasksRouter({ auth, pool, cancelRuns: runs?.cancelRunsOfTask, plans: runs?.planActions }),
    runs: runsRouter({ auth, pool, engine: runs }),
    costs: costsRouter({ auth, pool }),
  };
  // RPC cho web (cùng kiểu dữ liệu TypeScript), OpenAPI cho worker Go và tích hợp ngoài. Cùng một router.
  const rpc = new RPCHandler(router, { clientInterceptors: [mapDomainErrors] });
  const openapi = new OpenAPIHandler(router, { clientInterceptors: [mapDomainErrors] });
  const app = new Hono();
  // Better Auth giữ /api/auth/*; phải đăng ký trước handler OpenAPI vì cùng tiền tố /api.
  if (auth) app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
  // SSE nằm ngoài oRPC (luồng dài, Last-Event-ID); cũng phải đứng trước handler OpenAPI.
  const notifier = runNotifier ?? (pool ? new RunNotifier(pool) : undefined);
  app.get("/api/v1/runs/:id/stream", runStreamHandler({ auth, pool, notifier }));
  // Webhook đọc thân request dạng byte để kiểm HMAC, nên đi thẳng qua Hono, không qua oRPC.
  const hooks = {
    pool,
    jobs,
    resolveTarget: pool ? (id: string) => findWebhookTarget(pool, config.masterKey, id) : undefined,
  };
  app.post("/hooks/git/:projectId", (c) => handleGitWebhook(hooks, c.req.param("projectId"), c.req.raw));
  // tauri-plugin-updater đòi 204 khi không có bản mới; handler oRPC cùng đường dẫn (để có trong OpenAPI) trả 200 với
  // null, nên route này phải đứng trước handler /api.
  app.get("/api/v1/desktop/updates/:os/:arch/:currentVersion", async (c) => {
    const result = await findDesktopUpdate(
      desktopReleases,
      c.req.param("os"),
      c.req.param("arch"),
      c.req.param("currentVersion"),
    );
    if (result.kind === "bad-request") return c.json({ message: "Tham số phiên bản hoặc nền tảng không hợp lệ." }, 400);
    if (result.kind === "none") return c.body(null, 204);
    return c.json(result.update, 200);
  });
  const mode = auth && pool ? mcpMode(String(auth.options.baseURL), config.mcpAllowHttp ?? false) : "off";
  if (auth && pool && mode !== "off") {
    // Metadata OAuth (RFC 9728, RFC 8414) nằm ở /.well-known theo chuẩn, ngoài basePath của Better Auth; plugin mcp
    // tự trả các đường này khi request đi qua handler của Better Auth. Chế độ chỉ-run-token không có plugin mcp.
    if (mode === "full") {
      app.on(["GET", "HEAD"], "/.well-known/*", async (c) => {
        const res = await auth.handler(c.req.raw);
        return res.status === 404 ? c.notFound() : res;
      });
    }
    const registry = new McpToolRegistry();
    tenancyMcpTools(registry);
    runsMcpTools(registry);
    knowledgeMcpTools(registry, { embedder, jobs });
    const mcp = createMcpEndpoint({
      auth,
      pool,
      registry,
      version: config.version,
      runTokens: runTokens ?? runs?.mcpRunTokens,
      runTokensOnly: mode === "run",
    });
    // Đăng ký trước handler /api và SPA để /mcp không rơi vào index.html.
    app.all("/mcp", (c) => mcp(c.req.raw));
  }
  app.use("/rpc/*", async (c, next) => {
    const { matched, response } = await rpc.handle(c.req.raw, {
      prefix: "/rpc",
      context: { headers: c.req.raw.headers },
    });
    if (matched) return c.newResponse(response.body, response);
    await next();
  });
  app.use("/api/*", async (c, next) => {
    const { matched, response } = await openapi.handle(c.req.raw, {
      prefix: "/api",
      context: { headers: c.req.raw.headers },
    });
    if (matched) return c.newResponse(response.body, response);
    await next();
  });
  if (webDist) {
    const root = resolve(webDist);
    const types: Record<string, string> = {
      ".css": "text/css; charset=utf-8",
      ".html": "text/html; charset=utf-8",
      ".ico": "image/x-icon",
      ".js": "text/javascript; charset=utf-8",
      ".json": "application/json",
      ".png": "image/png",
      ".svg": "image/svg+xml",
      ".woff2": "font/woff2",
    };
    app.get("*", async (c) => {
      let pathname: string;
      try {
        pathname = decodeURIComponent(new URL(c.req.url).pathname);
      } catch {
        // Mã hoá % hỏng thì coi như đường dẫn không tồn tại, không để lỗi thành 500.
        return c.notFound();
      }
      const requested = resolve(root, `.${pathname}`);
      const safe = requested === root || requested.startsWith(`${root}${sep}`);
      if (safe) {
        try {
          const body = await readFile(requested);
          // File trong /assets/ có hash trong tên nên cache lâu được; index.html thì không.
          const cache = pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache";
          return c.body(body, 200, {
            "Content-Type": types[extname(requested)] ?? "application/octet-stream",
            "Cache-Control": cache,
          });
        } catch {
          /* Đường dẫn SPA không phải file; trả entry point để client router xử lý. */
        }
      }
      if (["/api/", "/rpc/", "/mcp", "/.well-known/"].some((p) => c.req.path.startsWith(p))) return c.notFound();
      try {
        return c.html(await readFile(resolve(root, "index.html"), "utf8"));
      } catch {
        return c.notFound();
      }
    });
  }
  return app;
}
