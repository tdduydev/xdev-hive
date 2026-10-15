import { type DocSyncRouteDeps, docSyncApi, notImplemented } from "./common.ts";

export function syncRoutes(deps: DocSyncRouteDeps) {
  const api = docSyncApi(deps).docHomes;
  return {
    syncNow: api.syncNow.handler(notImplemented),
    status: api.status.handler(notImplemented),
  };
}
