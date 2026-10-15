import { type DocSyncRouteDeps, docSyncApi, notImplemented } from "./common.ts";

export function assetsRoutes(deps: DocSyncRouteDeps) {
  const api = docSyncApi(deps).docAssets;
  return {
    resolve: api.resolve.handler(notImplemented),
    list: api.list.handler(notImplemented),
  };
}
