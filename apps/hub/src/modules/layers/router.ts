import { implement } from "@orpc/server";
import { layeredConfigContract } from "@xdev-hive/contracts";
import type { RequestContext } from "../platform/index.ts";
import { type OrgDeps, orgMiddlewares } from "../tenancy/index.ts";
import { publicDef, REGISTRY } from "./registry.ts";
import { effectiveConfig, setOrgLock, setTeamEntry, teamEntries } from "./service.ts";

export function layeredConfigRouter(deps: OrgDeps) {
  const m = orgMiddlewares(deps);
  const os = implement(layeredConfigContract).$context<RequestContext>().use(m.authed).use(m.inOrg);
  return {
    registry: os.registry.handler(() => ({ settings: REGISTRY.map(publicDef) })),
    effective: os.effective.handler(({ context: { tx, user }, input }) =>
      effectiveConfig(tx, user.id, input.projectId),
    ),
    teamGet: os.teamGet.handler(async ({ context: { tx, user }, input }) => ({
      entries: await teamEntries(tx, user.id, input.teamId),
    })),
    teamSet: os.teamSet.handler(({ context: { tx, user }, input }) => setTeamEntry(tx, user.id, input)),
    orgLock: os.orgLock.handler(async ({ context: { tx, user }, input }) => {
      await setOrgLock(tx, user.id, input.key, input.locked);
      return input;
    }),
  };
}
