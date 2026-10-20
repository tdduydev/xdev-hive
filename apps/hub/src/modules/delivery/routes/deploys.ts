import { type DeliveryRouteDeps, deliveryApi, notImplemented } from "../deps.ts";

/** Lần triển khai. Làm ở task sau. */
export function deploysRoutes(deps: DeliveryRouteDeps) {
  const api = deliveryApi(deps).deploys;
  return {
    create: api.create.handler(notImplemented),
    get: api.get.handler(notImplemented),
    list: api.list.handler(notImplemented),
    board: api.board.handler(notImplemented),
    cancel: api.cancel.handler(notImplemented),
    rollback: api.rollback.handler(notImplemented),
    rollbackInfo: api.rollbackInfo.handler(notImplemented),
  };
}
