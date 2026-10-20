import { implement, ORPCError } from "@orpc/server";
import { contract } from "@xdev-hive/contracts";
import type pg from "pg";
import type { Jobs, MasterKey, RequestContext } from "../platform/index.ts";
import type { ProviderFactory } from "../scm/index.ts";
import { type OrgDeps, orgMiddlewares } from "../tenancy/index.ts";
import type { FetchLike } from "./clients/jenkins.ts";

export interface DeliveryDeps {
  pool?: pg.Pool | undefined;
  jobs?: Jobs | undefined;
  masterKey?: MasterKey | undefined;
  providerFactory?: ProviderFactory | undefined;
  publicUrl?: string | undefined;
  /** Test thay fetch bằng máy chủ giả; mặc định là fetch toàn cục. */
  fetch?: FetchLike | undefined;
}

export type DeliveryRouteDeps = OrgDeps & DeliveryDeps;

export function deliveryApi(deps: DeliveryRouteDeps) {
  const { authed, inOrg } = orgMiddlewares(deps);
  return implement(contract).$context<RequestContext>().use(authed).use(inOrg);
}

export function notImplemented(): never {
  throw new ORPCError("NOT_IMPLEMENTED", { message: "Chức năng CI/CD và triển khai chưa được làm xong." });
}
