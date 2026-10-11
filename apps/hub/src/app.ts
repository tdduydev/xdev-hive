import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { RPCHandler } from "@orpc/server/fetch";
import { Hono } from "hono";
import type { HubConfig } from "./modules/platform/index.ts";
import { systemRouter } from "./modules/system/index.ts";

export function createApp(config: HubConfig) {
  const router = { system: systemRouter(config) };
  // RPC cho web (cùng kiểu dữ liệu TypeScript), OpenAPI cho worker Go và tích hợp ngoài. Cùng một router.
  const rpc = new RPCHandler(router);
  const openapi = new OpenAPIHandler(router);

  const app = new Hono();
  app.use("/rpc/*", async (c, next) => {
    const { matched, response } = await rpc.handle(c.req.raw, { prefix: "/rpc", context: {} });
    if (matched) return c.newResponse(response.body, response);
    await next();
  });
  app.use("/api/*", async (c, next) => {
    const { matched, response } = await openapi.handle(c.req.raw, { prefix: "/api", context: {} });
    if (matched) return c.newResponse(response.body, response);
    await next();
  });
  return app;
}
