import { implement } from "@orpc/server";
import { contract } from "@xdev-hive/contracts";
import type { RequestContext } from "../../platform/index.ts";
import { orgMiddlewares } from "../../tenancy/index.ts";
import { ciApproveDeployment, ciBuild, ciCancel, ciInput, ciPlay, ciRetry, ciStop } from "../ci/actions.ts";
import { ciDetail, ciJenkinsParams } from "../ci/detail.ts";
import { ciFeed } from "../ci/feed.ts";
import { ciLog } from "../ci/logs.ts";
import type { DeliveryRouteDeps } from "../deps.ts";

/**
 * Xem và thao tác CI. Mọi procedure gọi Jenkins, GitLab, GitHub nên dùng `orgMember` (không giữ transaction) thay cho `inOrg`
 * của `deliveryApi`: hàm nghiệp vụ tự mở transaction ngắn trước và sau khi gọi nguồn.
 */
export function ciRoutes(deps: DeliveryRouteDeps) {
  const { authed, orgMember } = orgMiddlewares(deps);
  const api = implement(contract).$context<RequestContext>().use(authed).use(orgMember).ci;
  const actor = (c: { user: { id: string }; orgId: string }) => ({ userId: c.user.id, orgId: c.orgId });
  return {
    feed: api.feed.handler(({ context, input }) => ciFeed(deps, actor(context), input)),
    detail: api.detail.handler(({ context, input }) => ciDetail(deps, actor(context), input)),
    log: api.log.handler(({ context, input }) => ciLog(deps, actor(context), input)),
    jenkinsParams: api.jenkinsParams.handler(({ context, input }) => ciJenkinsParams(deps, actor(context), input)),
    retry: api.retry.handler(({ context, input }) => ciRetry(deps, actor(context), input)),
    cancel: api.cancel.handler(({ context, input }) => ciCancel(deps, actor(context), input)),
    play: api.play.handler(({ context, input }) => ciPlay(deps, actor(context), input)),
    build: api.build.handler(({ context, input }) => ciBuild(deps, actor(context), input)),
    stop: api.stop.handler(({ context, input }) => ciStop(deps, actor(context), input)),
    input: api.input.handler(({ context, input }) => ciInput(deps, actor(context), input)),
    approveDeployment: api.approveDeployment.handler(({ context, input }) =>
      ciApproveDeployment(deps, actor(context), input),
    ),
  };
}
