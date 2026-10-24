import { OpenAPIHandler } from "@orpc/openapi/fetch";
import type { HubConfig } from "../platform/index.ts";
import { type JobsHeartbeat, jobsHeartbeat } from "./jobs-health.ts";
import { systemRouter } from "./router.ts";

/**
 * HTTP của tiến trình chỉ có vai trò `jobs`: không mở API, cổng worker hay web, chỉ health để healthcheck của compose gọi.
 */
export function jobsOnlyFetch(config: HubConfig, heartbeat: JobsHeartbeat = jobsHeartbeat) {
  const handler = new OpenAPIHandler({ system: systemRouter(config, undefined, undefined, heartbeat) });
  return async (request: Request): Promise<Response> => {
    const { matched, response } = await handler.handle(request, {
      prefix: "/api",
      context: { headers: request.headers },
    });
    return matched ? response : new Response("Not Found", { status: 404 });
  };
}
