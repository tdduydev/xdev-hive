import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { RPCHandler } from "@orpc/server/fetch";
import { Hono } from "hono";
import type pg from "pg";
import { catalogRouter } from "./modules/catalog/index.ts";
import { type Auth, meRouter } from "./modules/identity/index.ts";
import type { HubConfig, Jobs } from "./modules/platform/index.ts";
import { defaultProviderFactory, type ProviderFactory, scmRouter } from "./modules/scm/index.ts";
import { systemRouter } from "./modules/system/index.ts";
import { mapDomainErrors } from "./rpc-errors.ts";

export interface AppDeps {
  config: HubConfig;
  /** Không có khi chạy test đơn vị không cần database. */
  auth?: Auth | undefined;
  /** Pool của role hive_app (HIVE_DATABASE_URL). Không có khi chạy test đơn vị không cần database. */
  pool?: pg.Pool | undefined;
  /** Hàng đợi pg-boss; không có thì không tạo được dự án. */
  jobs?: Jobs | undefined;
  /** Thay GitHub/GitLab thật bằng provider giả khi test. */
  providerFactory?: ProviderFactory | undefined;
}

export function createApp({ config, auth, pool, jobs, providerFactory }: AppDeps) {
  const shared = {
    auth,
    pool,
    masterKey: config.masterKey,
    providerFactory: providerFactory ?? defaultProviderFactory,
  };
  const router = {
    system: systemRouter(config),
    me: meRouter(auth),
    scmConnections: scmRouter(shared),
    projects: catalogRouter({ ...shared, jobs, publicUrl: config.publicUrl ?? `http://localhost:${config.port}` }),
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
  return app;
}
