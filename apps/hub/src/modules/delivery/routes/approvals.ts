import { implement } from "@orpc/server";
import { contract } from "@xdev-hive/contracts";
import type { RequestContext } from "../../platform/index.ts";
import { orgMiddlewares } from "../../tenancy/index.ts";
import { approveDeploy, pendingApprovals, rejectDeploy } from "../approvals.ts";
import { compareDeploy } from "../compare.ts";
import { type DeliveryRouteDeps, deliveryApi } from "../deps.ts";

/** Duyệt lần triển khai; so sánh gọi nguồn Git ngoài transaction như các lệnh đọc CI. */
export function approvalsRoutes(deps: DeliveryRouteDeps) {
  const api = deliveryApi(deps).deploys.approvals;
  const { authed, orgMember } = orgMiddlewares(deps);
  const compareApi = implement(contract).$context<RequestContext>().use(authed).use(orgMember).deploys.approvals;
  return {
    pending: api.pending.handler(({ context, input }) => pendingApprovals(context.tx, context.user.id, input.systemId)),
    approve: api.approve.handler(({ context, input }) => approveDeploy(context.tx, deps, context.user.id, input)),
    reject: api.reject.handler(({ context, input }) => rejectDeploy(context.tx, deps, context.user.id, input)),
    compare: compareApi.compare.handler(({ context, input }) =>
      compareDeploy(deps, { userId: context.user.id, orgId: context.orgId }, input.id),
    ),
  };
}
