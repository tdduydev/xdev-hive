import { notImplemented, type QaRouteDeps, qaApi } from "../deps.ts";

export function casesRoutes(deps: QaRouteDeps) {
  const api = qaApi(deps).cases;
  return {
    list: api.list.handler(notImplemented),
    get: api.get.handler(notImplemented),
    history: api.history.handler(notImplemented),
  };
}
