import { type DeliveryRouteDeps, deliveryApi, notImplemented } from "../deps.ts";
import { createEnvironment, listEnvironments, reorderEnvironments, updateEnvironment } from "../environments.ts";

/** Môi trường của hệ thống (FR-012). Khoá và mở khoá thuộc T027. */
export function environmentsRoutes(deps: DeliveryRouteDeps) {
  const api = deliveryApi(deps).environments;
  return {
    list: api.list.handler(({ context, input }) => listEnvironments(context.tx, context.user.id, input.systemId)),
    create: api.create.handler(({ context, input }) => createEnvironment(context.tx, context.user.id, input)),
    update: api.update.handler(({ context, input }) => updateEnvironment(context.tx, context.user.id, input)),
    reorder: api.reorder.handler(({ context, input }) => reorderEnvironments(context.tx, context.user.id, input)),
    lock: api.lock.handler(notImplemented),
    unlock: api.unlock.handler(notImplemented),
  };
}
