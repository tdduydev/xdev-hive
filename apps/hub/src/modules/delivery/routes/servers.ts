import { type DeliveryRouteDeps, deliveryApi, notImplemented } from "../deps.ts";

/** Máy chủ SSH của đội. Làm ở task sau. */
export function serversRoutes(deps: DeliveryRouteDeps) {
  const api = deliveryApi(deps).servers;
  return {
    list: api.list.handler(notImplemented),
    create: api.create.handler(notImplemented),
    update: api.update.handler(notImplemented),
    remove: api.remove.handler(notImplemented),
    test: api.test.handler(notImplemented),
    confirmHostKey: api.confirmHostKey.handler(notImplemented),
    rotateKey: api.rotateKey.handler(notImplemented),
    confirmRotation: api.confirmRotation.handler(notImplemented),
  };
}
