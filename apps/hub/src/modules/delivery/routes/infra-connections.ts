import { type DeliveryRouteDeps, deliveryApi, notImplemented } from "../deps.ts";

/** Kết nối Argo CD và Kubernetes (T009). Làm ở task sau. */
export function infraConnectionsRoutes(deps: DeliveryRouteDeps) {
  const api = deliveryApi(deps).infraConnections;
  return {
    list: api.list.handler(notImplemented),
    create: api.create.handler(notImplemented),
    update: api.update.handler(notImplemented),
    remove: api.remove.handler(notImplemented),
    test: api.test.handler(notImplemented),
  };
}
