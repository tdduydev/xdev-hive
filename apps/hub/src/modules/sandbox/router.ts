import { implement } from "@orpc/server";
import { sandboxContract } from "@xdev-hive/contracts";
import type { RequestContext } from "../platform/index.ts";
import { type OrgDeps, orgMiddlewares } from "../tenancy/index.ts";
import {
  addAllowlist,
  getEffectiveAllowlist,
  getImage,
  getOrgSettings,
  listAllowlist,
  removeAllowlist,
  setImage,
  updateOrgSettings,
} from "./service.ts";

export function sandboxRouter(deps: OrgDeps) {
  const { authed, inOrg } = orgMiddlewares(deps);
  const os = implement(sandboxContract).$context<RequestContext>().use(authed).use(inOrg);
  return {
    listAllowlist: os.listAllowlist.handler(({ context: { tx, user }, input }) =>
      listAllowlist(tx, user.id, input.projectId),
    ),
    addAllowlist: os.addAllowlist.handler(({ context: { tx, user }, input }) => addAllowlist(tx, user.id, input)),
    removeAllowlist: os.removeAllowlist.handler(({ context: { tx, user }, input }) =>
      removeAllowlist(tx, user.id, input),
    ),
    getOrgSettings: os.getOrgSettings.handler(({ context: { tx, user } }) => getOrgSettings(tx, user.id)),
    updateOrgSettings: os.updateOrgSettings.handler(({ context: { tx, user }, input }) =>
      updateOrgSettings(tx, user.id, input),
    ),
    effectiveAllowlist: os.effectiveAllowlist.handler(({ context: { tx, user }, input }) =>
      getEffectiveAllowlist(tx, user.id, input.projectId),
    ),
    getImage: os.getImage.handler(({ context: { tx, user }, input }) => getImage(tx, user.id, input.projectId)),
    setImage: os.setImage.handler(({ context: { tx, user }, input }) => setImage(tx, user.id, input)),
  };
}
