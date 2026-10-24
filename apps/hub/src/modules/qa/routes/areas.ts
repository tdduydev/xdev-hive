import { notImplemented, type QaRouteDeps, qaApi } from "../deps.ts";

export function areasRoutes(deps: QaRouteDeps) {
  const api = qaApi(deps).areas;
  return {
    list: api.list.handler(notImplemented),
    create: api.create.handler(notImplemented),
  };
}
