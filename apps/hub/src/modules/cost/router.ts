import { implement } from "@orpc/server";
import { contract } from "@xdev-hive/contracts";
import type { RequestContext } from "../platform/index.ts";
import { type OrgDeps, orgMiddlewares } from "../tenancy/index.ts";
import { budgetStoppedRuns, costSummary } from "./summary.ts";

export function costsRouter(deps: OrgDeps) {
  const { authed, inOrg } = orgMiddlewares(deps);
  const os = implement(contract.costs).$context<RequestContext>().use(authed);
  return {
    summary: os.summary.use(inOrg).handler(({ context: { tx, user }, input }) => costSummary(tx, user.id, input)),
    budgetStopped: os.budgetStopped
      .use(inOrg)
      .handler(({ context: { tx, user }, input }) => budgetStoppedRuns(tx, user.id, input.projectId)),
  };
}
