import { implement } from "@orpc/server";
import { contract } from "@xdev-hive/contracts";
import type { RequestContext } from "../platform/index.ts";
import { type OrgDeps, orgMiddlewares } from "../tenancy/index.ts";
import { type SdlcDeps, scheduleAdvance } from "./phases.ts";
import { qaViewFor, waiveQaCase } from "./qa.ts";

export function qaRoutes(deps: OrgDeps & SdlcDeps) {
  const { authed, inOrg } = orgMiddlewares(deps);
  const os = implement(contract.sdlc.qa).$context<RequestContext>().use(authed).use(inOrg);
  return {
    view: os.view.handler(({ context: { tx, user }, input }) => qaViewFor(tx, user.id, input.itemId)),
    waive: os.waive.handler(async ({ context: { tx, user }, input }) => {
      const item = await waiveQaCase(tx, user.id, input);
      await scheduleAdvance(tx, item, deps);
      return { ok: true as const };
    }),
  };
}
