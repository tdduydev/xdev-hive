import { notImplemented, type QaRouteDeps, qaApi } from "../deps.ts";

export function sourcesRoutes(deps: QaRouteDeps) {
  const api = qaApi(deps).sources;
  return {
    list: api.list.handler(notImplemented),
    create: api.create.handler(notImplemented),
    update: api.update.handler(notImplemented),
    delete: api.delete.handler(notImplemented),
    refetch: api.refetch.handler(notImplemented),
    runs: api.runs.handler(notImplemented),
  };
}
