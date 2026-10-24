import { notImplemented, type QaRouteDeps, qaApi } from "../deps.ts";

export function dashboardRoutes(deps: QaRouteDeps) {
  const api = qaApi(deps).dashboard;
  return {
    overview: api.overview.handler(notImplemented),
    areas: api.areas.handler(notImplemented),
    requirements: api.requirements.handler(notImplemented),
    trend: api.trend.handler(notImplemented),
    flaky: api.flaky.handler(notImplemented),
  };
}
