import { type DocSyncRouteDeps, docSyncApi, notImplemented } from "./common.ts";

export function importsRoutes(deps: DocSyncRouteDeps) {
  const api = docSyncApi(deps).docImports;
  return {
    scan: api.scan.handler(notImplemented),
    get: api.get.handler(notImplemented),
    files: api.files.handler(notImplemented),
    start: api.start.handler(notImplemented),
    cancel: api.cancel.handler(notImplemented),
    confirmSecret: api.confirmSecret.handler(notImplemented),
    list: api.list.handler(notImplemented),
  };
}
