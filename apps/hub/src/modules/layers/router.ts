import { implement } from "@orpc/server";
import { layeredConfigContract } from "@xdev-hive/contracts";
import type { RequestContext } from "../platform/index.ts";
import { type OrgDeps, orgMiddlewares } from "../tenancy/index.ts";
import { publicDef, REGISTRY } from "./registry.ts";
import { effectiveConfig, orgEntries, setOrgEntry, setProjectEntry } from "./service.ts";

export function layeredConfigRouter(deps: OrgDeps) {
  const m = orgMiddlewares(deps);
  const os = implement(layeredConfigContract).$context<RequestContext>().use(m.authed).use(m.inOrg);
  return {
    registry: os.registry.handler(() => ({ settings: REGISTRY.map(publicDef) })),
    effective: os.effective.handler(({ context: { tx, user }, input }) =>
      effectiveConfig(tx, user.id, input.projectId),
    ),
    orgGet: os.orgGet.handler(async ({ context: { tx } }) => ({ entries: await orgEntries(tx) })),
    orgSet: os.orgSet.handler(({ context: { tx, user }, input }) => setOrgEntry(tx, user.id, input)),
    projectSet: os.projectSet.handler(({ context: { tx, user }, input }) => setProjectEntry(tx, user.id, input)),
  };
}
