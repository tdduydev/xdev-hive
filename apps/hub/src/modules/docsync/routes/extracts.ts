import { type DocSyncRouteDeps, docSyncApi, notImplemented } from "./common.ts";

export function extractsRoutes(deps: DocSyncRouteDeps) {
  const api = docSyncApi(deps).docExtracts;
  return {
    list: api.list.handler(notImplemented),
    get: api.get.handler(notImplemented),
    update: api.update.handler(notImplemented),
    approve: api.approve.handler(notImplemented),
    reject: api.reject.handler(notImplemented),
    confirmSecret: api.confirmSecret.handler(notImplemented),
  };
}
