import { type DeliveryRouteDeps, deliveryApi, notImplemented } from "../deps.ts";

/** Môi trường của hệ thống. Làm ở task sau. */
export function environmentsRoutes(deps: DeliveryRouteDeps) {
  const api = deliveryApi(deps).environments;
  return {
    list: api.list.handler(notImplemented),
    create: api.create.handler(notImplemented),
    update: api.update.handler(notImplemented),
    reorder: api.reorder.handler(notImplemented),
    lock: api.lock.handler(notImplemented),
    unlock: api.unlock.handler(notImplemented),
  };
}
