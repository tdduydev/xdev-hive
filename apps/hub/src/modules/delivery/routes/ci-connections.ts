import { type DeliveryRouteDeps, deliveryApi, notImplemented } from "../deps.ts";

/** Kết nối Jenkins của tổ chức (T009). Làm ở task sau. */
export function ciConnectionsRoutes(deps: DeliveryRouteDeps) {
  const api = deliveryApi(deps).ciConnections;
  return {
    list: api.list.handler(notImplemented),
    create: api.create.handler(notImplemented),
    update: api.update.handler(notImplemented),
    remove: api.remove.handler(notImplemented),
    test: api.test.handler(notImplemented),
    setWatcher: api.setWatcher.handler(notImplemented),
  };
}
