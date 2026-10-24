import { implement, ORPCError } from "@orpc/server";
import { contract } from "@xdev-hive/contracts";
import type { Jobs, RequestContext } from "../platform/index.ts";
import { type OrgDeps, orgMiddlewares } from "../tenancy/index.ts";

export interface QaDeps {
  jobs?: Jobs | undefined;
}

export type QaRouteDeps = OrgDeps & QaDeps;

export function qaApi(deps: QaRouteDeps) {
  const { authed, inOrg } = orgMiddlewares(deps);
  return implement(contract).$context<RequestContext>().use(authed).use(inOrg).testing;
}

/** Route đã có trong hợp đồng nhưng story chưa làm: web và worker nhận lỗi rõ thay vì 404. */
export function notImplemented(): never {
  throw new ORPCError("NOT_IMPLEMENTED", { message: "Chức năng chưa có." });
}
