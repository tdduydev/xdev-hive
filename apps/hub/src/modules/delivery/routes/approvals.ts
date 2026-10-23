import { approveDeploy, pendingApprovals, rejectDeploy } from "../approvals.ts";
import { type DeliveryRouteDeps, deliveryApi, notImplemented } from "../deps.ts";

/** Duyệt lần triển khai; nằm dưới `deploys.approvals` trong hợp đồng. So sánh commit (FR-026) chưa làm. */
export function approvalsRoutes(deps: DeliveryRouteDeps) {
  const api = deliveryApi(deps).deploys.approvals;
  return {
    pending: api.pending.handler(({ context, input }) => pendingApprovals(context.tx, context.user.id, input.systemId)),
    approve: api.approve.handler(({ context, input }) => approveDeploy(context.tx, deps, context.user.id, input)),
    reject: api.reject.handler(({ context, input }) => rejectDeploy(context.tx, deps, context.user.id, input)),
    compare: api.compare.handler(notImplemented),
  };
}
