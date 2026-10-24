import { notImplemented, type QaRouteDeps, qaApi } from "../deps.ts";

export function projectSettingsRoutes(deps: QaRouteDeps) {
  const api = qaApi(deps).projectSettings;
  return {
    get: api.get.handler(notImplemented),
    update: api.update.handler(notImplemented),
  };
}
