import { type DocSyncRouteDeps, docSyncApi, notImplemented } from "./common.ts";

export function treeRoutes(deps: DocSyncRouteDeps) {
  const api = docSyncApi(deps).docTree;
  return {
    list: api.list.handler(notImplemented),
    move: api.move.handler(notImplemented),
  };
}
