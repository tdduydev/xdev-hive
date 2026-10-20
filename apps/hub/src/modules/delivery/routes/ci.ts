import { type DeliveryRouteDeps, deliveryApi, notImplemented } from "../deps.ts";

/** Xem và thao tác CI. Làm ở task sau. */
export function ciRoutes(deps: DeliveryRouteDeps) {
  const api = deliveryApi(deps).ci;
  return {
    feed: api.feed.handler(notImplemented),
    detail: api.detail.handler(notImplemented),
    log: api.log.handler(notImplemented),
    jenkinsParams: api.jenkinsParams.handler(notImplemented),
    retry: api.retry.handler(notImplemented),
    cancel: api.cancel.handler(notImplemented),
    play: api.play.handler(notImplemented),
    build: api.build.handler(notImplemented),
    stop: api.stop.handler(notImplemented),
    input: api.input.handler(notImplemented),
    approveDeployment: api.approveDeployment.handler(notImplemented),
  };
}
