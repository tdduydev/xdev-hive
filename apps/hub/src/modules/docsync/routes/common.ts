import { implement, ORPCError } from "@orpc/server";
import { contract } from "@xdev-hive/contracts";
import type { RequestContext } from "../../platform/index.ts";
import { type OrgDeps, orgMiddlewares } from "../../tenancy/index.ts";
import type { DocSyncDeps } from "./deps.ts";

export type DocSyncRouteDeps = OrgDeps & DocSyncDeps;

export function docSyncApi(deps: DocSyncRouteDeps) {
  const { authed, inOrg } = orgMiddlewares(deps);
  return implement(contract).$context<RequestContext>().use(authed).use(inOrg);
}

export function notImplemented(): never {
  throw new ORPCError("NOT_IMPLEMENTED", { message: "Chức năng đồng bộ tài liệu chưa được triển khai." });
}
