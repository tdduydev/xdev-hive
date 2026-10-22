import {
  createInfraConnection,
  listInfraConnections,
  removeInfraConnection,
  testInfraConnection,
  updateInfraConnection,
} from "../connections/infra.ts";
import { type DeliveryRouteDeps, deliveryApi } from "../deps.ts";

/** Kết nối Argo CD và Kubernetes (FR-006). */
export function infraConnectionsRoutes(deps: DeliveryRouteDeps) {
  const api = deliveryApi(deps).infraConnections;
  return {
    list: api.list.handler(({ context }) => listInfraConnections(context.tx)),
    create: api.create.handler(({ context, input }) => createInfraConnection(context.tx, deps, context.user.id, input)),
    update: api.update.handler(({ context, input }) => updateInfraConnection(context.tx, deps, context.user.id, input)),
    remove: api.remove.handler(({ context, input }) => removeInfraConnection(context.tx, context.user.id, input.id)),
    test: api.test.handler(({ context, input }) => testInfraConnection(context.tx, deps, context.user.id, input.id)),
  };
}
