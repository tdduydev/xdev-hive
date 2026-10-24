import { notImplemented, type QaRouteDeps, qaApi } from "../deps.ts";

export function settingsRoutes(deps: QaRouteDeps) {
  const api = qaApi(deps).settings;
  return {
    get: api.get.handler(notImplemented),
    update: api.update.handler(notImplemented),
  };
}
