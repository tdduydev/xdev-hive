import { type DocSyncRouteDeps, docSyncApi, notImplemented } from "./common.ts";

export function conflictsRoutes(deps: DocSyncRouteDeps) {
  const api = docSyncApi(deps).docConflicts;
  return {
    list: api.list.handler(notImplemented),
    get: api.get.handler(notImplemented),
    resolve: api.resolve.handler(notImplemented),
  };
}
