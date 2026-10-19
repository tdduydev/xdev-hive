import { type DocSyncRouteDeps, docSyncApi, notImplemented } from "./common.ts";

/** Xem và chỉnh lượt nhập Word (plan.md mục 5), lịch sử nhập của tài liệu (US5). */
export function wordImportsRoutes(deps: DocSyncRouteDeps) {
  const api = docSyncApi(deps).wordImports;
  return {
    get: api.get.handler(() => notImplemented()),
    list: api.list.handler(() => notImplemented()),
    file: api.file.handler(() => notImplemented()),
    update: api.update.handler(() => notImplemented()),
    cancel: api.cancel.handler(() => notImplemented()),
    ofDoc: api.ofDoc.handler(() => notImplemented()),
  };
}
