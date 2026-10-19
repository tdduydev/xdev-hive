import { type DocSyncRouteDeps, docSyncApi, notImplemented } from "./common.ts";

/** Tạo tài liệu từ lượt nhập Word (plan.md mục 6). */
export function wordCommitRoutes(deps: DocSyncRouteDeps) {
  const api = docSyncApi(deps).wordImports;
  return {
    commit: api.commit.handler(() => notImplemented()),
  };
}
