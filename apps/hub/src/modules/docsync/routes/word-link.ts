import { type DocSyncRouteDeps, docSyncApi, notImplemented } from "./common.ts";

/** Gắn tài liệu có sẵn với file Word (FR-028, plan.md mục 8b). */
export function wordLinkRoutes(deps: DocSyncRouteDeps) {
  const api = docSyncApi(deps).wordImports;
  return {
    confirmLink: api.confirmLink.handler(() => notImplemented()),
  };
}
