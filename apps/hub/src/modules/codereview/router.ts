import { implement } from "@orpc/server";
import { contract } from "@xdev-hive/contracts";
import type { RequestContext } from "../platform/index.ts";
import { type OrgDeps, orgMiddlewares } from "../tenancy/index.ts";
import { type CodeRunPort, dryRunCodeWorkflow, workflowFromProject } from "./dry-run.ts";

/** `runs` do module `runs` cài vào (nó import codereview nên không import ngược được). */
export function codeReviewsRouter(deps: OrgDeps & { runs: CodeRunPort }) {
  const { authed, inOrg } = orgMiddlewares(deps);
  const os = implement(contract.codeReviews).$context<RequestContext>().use(authed).use(inOrg);
  return {
    codeReviews: {
      dryRun: os.dryRun.handler(({ context: { tx, user }, input }) =>
        dryRunCodeWorkflow(tx, user.id, input, deps.runs),
      ),
      workflowFromProject: os.workflowFromProject.handler(({ context: { tx, user }, input }) =>
        workflowFromProject(tx, user.id, input.projectKey),
      ),
    },
  };
}
