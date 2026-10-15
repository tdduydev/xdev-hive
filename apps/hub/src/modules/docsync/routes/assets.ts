import { listDocAssets, resolveDocLinks } from "../assets.ts";
import { type DocSyncRouteDeps, docSyncApi } from "./common.ts";

export function assetsRoutes(deps: DocSyncRouteDeps) {
  const api = docSyncApi(deps).docAssets;
  return {
    resolve: api.resolve.handler(({ context, input }) =>
      resolveDocLinks(context.tx, { kind: "user", userId: context.user.id }, input),
    ),
    list: api.list.handler(({ context, input }) =>
      listDocAssets(context.tx, { kind: "user", userId: context.user.id }, input),
    ),
  };
}
