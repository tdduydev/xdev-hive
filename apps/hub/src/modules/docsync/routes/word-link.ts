import { confirmLink } from "../word/link.ts";
import { type DocSyncRouteDeps, docSyncApi } from "./common.ts";

/** Gắn tài liệu có sẵn với file Word (FR-028, plan.md mục 8b). */
export function wordLinkRoutes(deps: DocSyncRouteDeps) {
  const api = docSyncApi(deps).wordImports;
  return {
    confirmLink: api.confirmLink.handler(({ context, input }) =>
      confirmLink(context.tx, { kind: "user", userId: context.user.id }, input),
    ),
  };
}
