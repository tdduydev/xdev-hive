import { commitWordImport } from "../word/commit.ts";
import { type DocSyncRouteDeps, docSyncApi } from "./common.ts";

/** Tạo tài liệu từ lượt nhập Word (plan.md mục 6). */
export function wordCommitRoutes(deps: DocSyncRouteDeps) {
  const api = docSyncApi(deps).wordImports;
  return {
    commit: api.commit.handler(({ context, input }) =>
      commitWordImport(context.tx, deps, { kind: "user", userId: context.user.id }, input),
    ),
  };
}
