import {
  listMyJenkinsTokens,
  removeMyJenkinsToken,
  testMyJenkinsToken,
  upsertMyJenkinsToken,
} from "../connections/jenkins.ts";
import { type DeliveryRouteDeps, deliveryApi } from "../deps.ts";

/** Token Jenkins của chính người gọi (Q3): không route nào đọc hay sửa token của người khác. */
export function ciTokensRoutes(deps: DeliveryRouteDeps) {
  const api = deliveryApi(deps).ciTokens;
  return {
    list: api.list.handler(({ context }) => listMyJenkinsTokens(context.tx, context.user.id)),
    upsert: api.upsert.handler(({ context, input }) => upsertMyJenkinsToken(context.tx, deps, context.user.id, input)),
    test: api.test.handler(({ context, input }) =>
      testMyJenkinsToken(context.tx, deps, context.user.id, input.connectionId),
    ),
    remove: api.remove.handler(({ context, input }) =>
      removeMyJenkinsToken(context.tx, context.user.id, input.connectionId),
    ),
  };
}
