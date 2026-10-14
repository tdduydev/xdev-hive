import { implement } from "@orpc/server";
import { contract } from "@xdev-hive/contracts";
import type { RequestContext } from "../platform/index.ts";
import { withTenant } from "../platform/index.ts";
import { type OrgDeps, orgMiddlewares } from "../tenancy/index.ts";
import {
  closeSession,
  getSession,
  listSessions,
  openSession,
  sessionActivity,
  sessionChunks,
  sessionTicket,
  setVisibility,
  type TerminalDeps,
  terminalOptions,
} from "./service.ts";

export interface TerminalRouterDeps extends OrgDeps {
  terminal: TerminalDeps;
}

export function terminalRouter(deps: TerminalRouterDeps) {
  const { authed, inOrg, orgMember } = orgMiddlewares(deps);
  const os = implement(contract.terminal).$context<RequestContext>().use(authed);
  return {
    options: os.options
      .use(inOrg)
      .handler(({ context: { tx, user }, input }) => terminalOptions(tx, user.id, input.projectId, deps.terminal)),
    // Gửi term_open sau khi commit: worker chỉ nhận phiên đã có trong DB (gói output tới trước dòng phiên thì bị bỏ).
    open: os.open.use(orgMember).handler(async ({ context: { pool, user, orgId }, input }) => {
      const { session, afterCommit } = await withTenant(pool, { userId: user.id, orgId }, (tx) =>
        openSession(tx, user, orgId, input, deps.terminal),
      );
      afterCommit();
      return session;
    }),
    list: os.list.use(inOrg).handler(({ context: { tx, user }, input }) => listSessions(tx, user.id, input.projectId)),
    get: os.get.use(inOrg).handler(({ context: { tx, user }, input }) => getSession(tx, user.id, input.id)),
    close: os.close.use(orgMember).handler(async ({ context: { pool, user, orgId }, input }) => {
      const { session, afterCommit } = await withTenant(pool, { userId: user.id, orgId }, (tx) =>
        closeSession(tx, user.id, input.id),
      );
      afterCommit();
      return session;
    }),
    setVisibility: os.setVisibility
      .use(inOrg)
      .handler(({ context: { tx, user }, input }) => setVisibility(tx, user.id, input.id, input.visibility)),
    ticket: os.ticket
      .use(inOrg)
      .handler(({ context: { tx, user, orgId }, input }) => sessionTicket(tx, user.id, orgId, input.id)),
    chunks: os.chunks.use(inOrg).handler(({ context: { tx, user }, input }) => sessionChunks(tx, user.id, input)),
    activity: os.activity
      .use(inOrg)
      .handler(({ context: { tx, user }, input }) => sessionActivity(tx, user.id, input.id)),
  };
}
