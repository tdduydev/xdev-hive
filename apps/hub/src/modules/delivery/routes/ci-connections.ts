import {
  createJenkinsConnection,
  listJenkinsConnections,
  removeJenkinsConnection,
  setJenkinsWatcher,
  testJenkinsConnection,
  updateJenkinsConnection,
} from "../connections/jenkins.ts";
import { type DeliveryRouteDeps, deliveryApi } from "../deps.ts";

/** Kết nối Jenkins của tổ chức (FR-001). */
export function ciConnectionsRoutes(deps: DeliveryRouteDeps) {
  const api = deliveryApi(deps).ciConnections;
  return {
    list: api.list.handler(({ context }) => listJenkinsConnections(context.tx)),
    create: api.create.handler(({ context, input }) => createJenkinsConnection(context.tx, context.user.id, input)),
    update: api.update.handler(({ context, input }) => updateJenkinsConnection(context.tx, context.user.id, input)),
    remove: api.remove.handler(({ context, input }) => removeJenkinsConnection(context.tx, context.user.id, input.id)),
    test: api.test.handler(({ context, input }) => testJenkinsConnection(context.tx, deps, context.user.id, input.id)),
    setWatcher: api.setWatcher.handler(({ context, input }) => setJenkinsWatcher(context.tx, context.user.id, input)),
  };
}
