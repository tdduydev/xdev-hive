import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { RPCHandler } from "@orpc/server/fetch";
import { Hono } from "hono";
import type pg from "pg";
import { type Auth, meRouter } from "./modules/identity/index.ts";
import type { HubConfig } from "./modules/platform/index.ts";
import { systemRouter } from "./modules/system/index.ts";
import { tenancyRouter } from "./modules/tenancy/index.ts";
import { mapDomainErrors } from "./rpc-errors.ts";

export interface AppDeps {
  config: HubConfig;
  /** Không có khi chạy test đơn vị không cần database. */
  auth?: Auth | undefined;
  /** Pool của role hive_app (HIVE_DATABASE_URL). Không có khi chạy test đơn vị không cần database. */
  pool?: pg.Pool | undefined;
}

export function createApp({ config, auth, pool }: AppDeps) {
  const router = {
    system: systemRouter(config),
    me: meRouter(auth),
    ...tenancyRouter({ auth, pool, orgCreators: config.orgCreators }),
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
