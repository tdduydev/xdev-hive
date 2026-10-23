import { type DeliveryRouteDeps, deliveryApi } from "../deps.ts";
import {
  createEnvironment,
  listEnvironments,
  lockEnvironment,
  reorderEnvironments,
  unlockEnvironment,
  updateEnvironment,
} from "../environments.ts";
import { listRunnerCandidates, setEnvironmentRunner } from "../runners.ts";

/** Môi trường của hệ thống (FR-012), khoá và mở khoá (FR-026). */
export function environmentsRoutes(deps: DeliveryRouteDeps) {
  const api = deliveryApi(deps).environments;
  return {
    list: api.list.handler(({ context, input }) => listEnvironments(context.tx, context.user.id, input.systemId)),
    create: api.create.handler(({ context, input }) => createEnvironment(context.tx, context.user.id, input)),
    update: api.update.handler(({ context, input }) => updateEnvironment(context.tx, context.user.id, input)),
    reorder: api.reorder.handler(({ context, input }) => reorderEnvironments(context.tx, context.user.id, input)),
    lock: api.lock.handler(({ context, input }) => lockEnvironment(context.tx, context.user.id, input)),
    unlock: api.unlock.handler(({ context, input }) => unlockEnvironment(context.tx, context.user.id, input)),
    setRunner: api.setRunner.handler(({ context, input }) => setEnvironmentRunner(context.tx, context.user.id, input)),
    runnerCandidates: api.runnerCandidates.handler(({ context, input }) =>
      listRunnerCandidates(context.tx, context.user.id, input.id),
    ),
  };
}
