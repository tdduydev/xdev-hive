import { type DeliveryRouteDeps, deliveryApi, notImplemented } from "../deps.ts";

/** Token Jenkins của từng người (T009). Làm ở task sau. */
export function ciTokensRoutes(deps: DeliveryRouteDeps) {
  const api = deliveryApi(deps).ciTokens;
  return {
    list: api.list.handler(notImplemented),
    upsert: api.upsert.handler(notImplemented),
    test: api.test.handler(notImplemented),
    remove: api.remove.handler(notImplemented),
  };
}
