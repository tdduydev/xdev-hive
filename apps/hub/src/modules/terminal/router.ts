import { implement } from "@orpc/server";
import { contract } from "@xdev-hive/contracts";
import type { RequestContext } from "../platform/index.ts";
import { withTenant } from "../platform/index.ts";
import { type OrgDeps, orgMiddlewares } from "../tenancy/index.ts";
import {
  getRemoteSession,
  listRemoteSessions,
  remoteMachines,
  remoteSessionChunks,
  setRemoteVisibility,
} from "./queries.ts";
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

/**
 * Phiên trên máy cá nhân (specs/010 US1). Chỉ đọc bản ghi và đổi "Cho đội xem"; vé xem trực tiếp, mở phiên, ghép, thiết
 * bị và đẩy thông báo thêm ở T021, T030, T051, T071. Ghi phiên luôn bật: `HIVE_REMOTE_TERMINAL` chỉ chặn phần từ xa.
 */
export function remoteRouter(deps: OrgDeps) {
  const { authed, inOrg } = orgMiddlewares(deps);
  const os = implement(contract.remote).$context<RequestContext>().use(authed);
  return {
    machines: os.machines.use(inOrg).handler(({ context: { tx, user } }) => remoteMachines(tx, user.id)),
    list: os.list.use(inOrg).handler(({ context: { tx, user }, input }) => listRemoteSessions(tx, user.id, input)),
    get: os.get.use(inOrg).handler(({ context: { tx, user }, input }) => getRemoteSession(tx, user.id, input.id)),
    chunks: os.chunks.use(inOrg).handler(({ context: { tx, user }, input }) => remoteSessionChunks(tx, user.id, input)),
    setVisibility: os.setVisibility
      .use(inOrg)
      .handler(({ context: { tx, user }, input }) => setRemoteVisibility(tx, user.id, input.id, input.visibility)),
  };
}
