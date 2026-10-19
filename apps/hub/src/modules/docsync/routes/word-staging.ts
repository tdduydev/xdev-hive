import { type DocSyncRouteDeps, docSyncApi, notImplemented } from "./common.ts";

/** Duyệt đề xuất nguồn Word theo lô file đã chọn (P2, plan.md mục 9). */
export function wordStagingRoutes(deps: DocSyncRouteDeps) {
  const api = docSyncApi(deps).wordImports;
  return {
    approve: api.approve.handler(() => notImplemented()),
  };
}
