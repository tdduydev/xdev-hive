import { implement } from "@orpc/server";
import { contract } from "@xdev-hive/contracts";
import { type RequestContext, withTenant } from "../platform/index.ts";
import { type OrgScopeDeps, orgScope } from "../tenancy/index.ts";
import {
  type CatalogDeps,
  createProject,
  dryRunCreate,
  getProject,
  getProvision,
  listProjects,
  retryStep,
} from "./projects.ts";

export function catalogRouter(deps: CatalogDeps & OrgScopeDeps) {
  const os = implement(contract.projects).$context<RequestContext>().use(orgScope(deps));
  return {
    create: os.create.handler(({ context: { pool, actor }, input }) =>
      input.dryRun ? dryRunCreate(pool, deps, actor, input) : createProject(pool, deps, actor, input),
    ),
    list: os.list.handler(({ context: { pool, actor }, input }) =>
      withTenant(pool, actor, (tx) => listProjects(tx, actor.userId, input.systemId)),
    ),
    get: os.get.handler(({ context: { pool, actor }, input }) =>
      withTenant(pool, actor, (tx) => getProject(tx, actor.userId, input.id)),
    ),
    provision: os.provision.handler(({ context: { pool, actor }, input }) =>
      withTenant(pool, actor, (tx) => getProvision(tx, deps, actor.userId, input.id)),
    ),
    retryStep: os.retryStep.handler(({ context: { pool, actor }, input }) =>
      withTenant(pool, actor, (tx) => retryStep(tx, deps, actor, input.id, input.stepId)),
    ),
  };
}
