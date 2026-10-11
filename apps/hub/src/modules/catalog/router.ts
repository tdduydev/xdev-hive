import { implement } from "@orpc/server";
import { contract } from "@xdev-hive/contracts";
import type { RequestContext } from "../platform/index.ts";
import { type OrgDeps, orgMiddlewares } from "../tenancy/index.ts";
import { enqueueMergeAs, queueForUser, removeMergeAs } from "./merge-queue.ts";
import {
  type CatalogDeps,
  createProject,
  dryRunCreate,
  getProject,
  getProvision,
  listProjects,
  retryStep,
} from "./projects.ts";
import { updateProjectSettings } from "./settings.ts";

export function catalogRouter(deps: CatalogDeps & OrgDeps) {
  const { authed, inOrg, orgMember } = orgMiddlewares(deps);
  const os = implement(contract.projects).$context<RequestContext>().use(authed);
  return {
    // Chạy thử gọi ra GitHub/GitLab nên không giữ transaction (orgMember); tạo thật chỉ ghi database, job gửi
    // trong cùng transaction.
    create: os.create.use(orgMember).handler(({ context: { pool, user, orgId }, input }) => {
      const actor = { userId: user.id, orgId };
      return input.dryRun ? dryRunCreate(pool, deps, actor, input) : createProject(pool, deps, actor, input);
    }),
    list: os.list.use(inOrg).handler(({ context: { tx, user }, input }) => listProjects(tx, user.id, input.systemId)),
    get: os.get.use(inOrg).handler(({ context: { tx, user }, input }) => getProject(tx, user.id, input.id)),
    provision: os.provision
      .use(inOrg)
      .handler(({ context: { tx, user }, input }) => getProvision(tx, deps, user.id, input.id)),
    retryStep: os.retryStep
      .use(inOrg)
      .handler(({ context: { tx, user, orgId }, input }) =>
        retryStep(tx, deps, { userId: user.id, orgId }, input.id, input.stepId),
      ),
    mergeQueue: os.mergeQueue
      .use(inOrg)
      .handler(({ context: { tx, user }, input }) => queueForUser(tx, user.id, input.id)),
    enqueueMerge: os.enqueueMerge
      .use(inOrg)
      .handler(({ context: { tx, user }, input }) =>
        enqueueMergeAs(tx, deps, user.id, { projectId: input.id, prNumber: input.prNumber }),
      ),
    removeMerge: os.removeMerge
      .use(inOrg)
      .handler(({ context: { tx, user }, input }) =>
        removeMergeAs(tx, deps, user.id, { projectId: input.id, entryId: input.entryId }),
      ),
    updateSettings: os.updateSettings
      .use(inOrg)
      .handler(({ context: { tx, user }, input }) => updateProjectSettings(tx, user.id, input.key, input.settings)),
  };
}
