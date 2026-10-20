import { type DeliveryRouteDeps, deliveryApi, notImplemented } from "../deps.ts";

/** Duyệt lần triển khai; nằm dưới `deploys.approvals` trong hợp đồng. Làm ở task sau. */
export function approvalsRoutes(deps: DeliveryRouteDeps) {
  const api = deliveryApi(deps).deploys.approvals;
  return {
    pending: api.pending.handler(notImplemented),
    approve: api.approve.handler(notImplemented),
    reject: api.reject.handler(notImplemented),
    compare: api.compare.handler(notImplemented),
  };
}
