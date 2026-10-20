import { type DeliveryRouteDeps, deliveryApi, notImplemented } from "../deps.ts";

/** Job Jenkins gắn với dự án. Làm ở task sau. */
export function ciJobsRoutes(deps: DeliveryRouteDeps) {
  const api = deliveryApi(deps).ciJobs;
  return {
    list: api.list.handler(notImplemented),
    add: api.add.handler(notImplemented),
    remove: api.remove.handler(notImplemented),
  };
}
