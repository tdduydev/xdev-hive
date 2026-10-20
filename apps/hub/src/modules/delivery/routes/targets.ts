import { type DeliveryRouteDeps, deliveryApi, notImplemented } from "../deps.ts";

/** Đích triển khai. Làm ở task sau. */
export function targetsRoutes(deps: DeliveryRouteDeps) {
  const api = deliveryApi(deps).deployTargets;
  return {
    list: api.list.handler(notImplemented),
    get: api.get.handler(notImplemented),
    upsert: api.upsert.handler(notImplemented),
    remove: api.remove.handler(notImplemented),
  };
}
