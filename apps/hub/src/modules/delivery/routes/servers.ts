import { implement } from "@orpc/server";
import { contract } from "@xdev-hive/contracts";
import type { RequestContext } from "../../platform/index.ts";
import { orgMiddlewares } from "../../tenancy/index.ts";
import { type DeliveryRouteDeps, deliveryApi } from "../deps.ts";
import {
  confirmServerHostKey,
  confirmServerRotation,
  createServer,
  listServers,
  removeServer,
  rotateServerKey,
  testServer,
  updateServer,
} from "../servers.ts";

/**
 * Máy chủ SSH của đội (FR-010, FR-011). Procedure nối SSH (`test`, `confirmHostKey`, `confirmRotation`) dùng
 * `orgMember` (không giữ transaction) thay cho `inOrg`: hàm nghiệp vụ tự mở transaction ngắn trước và sau khi nối.
 */
export function serversRoutes(deps: DeliveryRouteDeps) {
  const api = deliveryApi(deps).servers;
  const { authed, orgMember } = orgMiddlewares(deps);
  const ssh = implement(contract).$context<RequestContext>().use(authed).use(orgMember).servers;
  const actor = (c: { user: { id: string }; orgId: string }) => ({ userId: c.user.id, orgId: c.orgId });
  return {
    list: api.list.handler(({ context, input }) => listServers(context.tx, context.user.id, input)),
    create: api.create.handler(({ context, input }) => createServer(context.tx, deps, context.user.id, input)),
    update: api.update.handler(({ context, input }) => updateServer(context.tx, context.user.id, input)),
    remove: api.remove.handler(({ context, input }) => removeServer(context.tx, context.user.id, input.id)),
    rotateKey: api.rotateKey.handler(({ context, input }) =>
      rotateServerKey(context.tx, deps, context.user.id, input.id),
    ),
    test: ssh.test.handler(({ context, input }) => testServer(deps, actor(context), input)),
    confirmHostKey: ssh.confirmHostKey.handler(({ context, input }) =>
      confirmServerHostKey(deps, actor(context), input),
    ),
    confirmRotation: ssh.confirmRotation.handler(({ context, input }) =>
      confirmServerRotation(deps, actor(context), input),
    ),
  };
}
