import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { RPCHandler } from "@orpc/server/fetch";
import { Hono } from "hono";
import type pg from "pg";
import { catalogRouter } from "./modules/catalog/index.ts";
import { fleetRouter } from "./modules/fleet/index.ts";
import { type Auth, meRouter } from "./modules/identity/index.ts";
import type { HubConfig, Jobs } from "./modules/platform/index.ts";
import { defaultProviderFactory, type ProviderFactory, scmRouter } from "./modules/scm/index.ts";
import { systemRouter } from "./modules/system/index.ts";
import { tenancyRouter } from "./modules/tenancy/index.ts";
import { mapDomainErrors } from "./rpc-errors.ts";

export interface AppDeps {
  config: HubConfig;
  webDist?: string | undefined;
  /** Không có khi chạy test đơn vị không cần database. */
  auth?: Auth | undefined;
  /** Pool của role hive_app (HIVE_DATABASE_URL). Không có khi chạy test đơn vị không cần database. */
  pool?: pg.Pool | undefined;
  /** Hàng đợi pg-boss; không có thì không tạo được dự án. */
  jobs?: Jobs | undefined;
  /** Thay GitHub/GitLab thật bằng provider giả khi test. */
  providerFactory?: ProviderFactory | undefined;
}

export function createApp({ config, auth, pool, jobs, providerFactory, webDist = process.env.HIVE_WEB_DIST }: AppDeps) {
  const publicUrl = config.publicUrl ?? `http://localhost:${config.port}`;
  const shared = {
    auth,
    pool,
    masterKey: config.masterKey,
    providerFactory: providerFactory ?? defaultProviderFactory,
  };
  const router = {
    system: systemRouter(config),
    me: meRouter(auth),
    ...tenancyRouter({ auth, pool, orgCreators: config.orgCreators, publicUrl: config.publicUrl }),
    ...fleetRouter({ auth, pool, publicUrl }),
    scmConnections: scmRouter(shared),
    projects: catalogRouter({ ...shared, jobs, publicUrl }),
  };
  // RPC cho web (cùng kiểu dữ liệu TypeScript), OpenAPI cho worker Go và tích hợp ngoài. Cùng một router.
  const rpc = new RPCHandler(router, { clientInterceptors: [mapDomainErrors] });
  const openapi = new OpenAPIHandler(router, { clientInterceptors: [mapDomainErrors] });
  const app = new Hono();
  // Better Auth giữ /api/auth/*; phải đăng ký trước handler OpenAPI vì cùng tiền tố /api.
  if (auth) app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
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
      if (c.req.path.startsWith("/api/") || c.req.path.startsWith("/rpc/")) return c.notFound();
      try {
        return c.html(await readFile(resolve(root, "index.html"), "utf8"));
      } catch {
        return c.notFound();
      }
    });
  }
  return app;
}
