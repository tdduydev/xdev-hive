import { type DeliveryRouteDeps, deliveryApi } from "../deps.ts";
import { getTarget, listTargets, removeTarget, upsertTarget } from "../targets.ts";

/** Đích triển khai = dự án × môi trường (FR-013, FR-014). */
export function targetsRoutes(deps: DeliveryRouteDeps) {
  const api = deliveryApi(deps).deployTargets;
  return {
    list: api.list.handler(({ context, input }) => listTargets(context.tx, context.user.id, input)),
    get: api.get.handler(({ context, input }) => getTarget(context.tx, context.user.id, input.id)),
    upsert: api.upsert.handler(({ context, input }) => upsertTarget(context.tx, deps, context.user.id, input)),
    remove: api.remove.handler(({ context, input }) => removeTarget(context.tx, context.user.id, input.id)),
  };
}
