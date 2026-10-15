import { implement } from "@orpc/server";
import { contract } from "@xdev-hive/contracts";
import type { RequestContext } from "../platform/index.ts";
import { withTenant } from "../platform/index.ts";
import { type OrgDeps, orgMiddlewares } from "../tenancy/index.ts";
import { disableRemote, listDevices, revokeDevice } from "./devices.ts";
import { pairComplete, pairOptions, type RemoteDeps } from "./pairing.ts";
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
import { remoteTicket } from "./ws.ts";

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

export interface RemoteRouterDeps extends OrgDeps {
  remote: RemoteDeps;
}

/**
 * Phiên trên máy cá nhân (specs/010 US1, US2). Mở phiên và đẩy thông báo thêm ở T051, T071.
 * Ghi phiên luôn bật: `HIVE_REMOTE_TERMINAL` chỉ chặn phần từ xa.
 */
export function remoteRouter(deps: RemoteRouterDeps) {
  const { authed, inOrg, orgMember } = orgMiddlewares(deps);
  const os = implement(contract.remote).$context<RequestContext>().use(authed);
  return {
    machines: os.machines.use(inOrg).handler(({ context: { tx, user } }) => remoteMachines(tx, user.id)),
    list: os.list.use(inOrg).handler(({ context: { tx, user }, input }) => listRemoteSessions(tx, user.id, input)),
    get: os.get.use(inOrg).handler(({ context: { tx, user }, input }) => getRemoteSession(tx, user.id, input.id)),
    chunks: os.chunks.use(inOrg).handler(({ context: { tx, user }, input }) => remoteSessionChunks(tx, user.id, input)),
    ticket: os.ticket
      .use(inOrg)
      .handler(({ context: { tx, user, orgId }, input }) => remoteTicket(tx, user.id, orgId, input.id, deps.remote)),
    setVisibility: os.setVisibility
      .use(inOrg)
      .handler(({ context: { tx, user }, input }) => setRemoteVisibility(tx, user.id, input.id, input.visibility)),
    disableRemote: os.disableRemote
      .use(inOrg)
      .handler(({ context: { tx, user }, input }) => disableRemote(tx, user.id, input.machineId)),
    pairOptions: os.pairOptions
      .use(inOrg)
      .handler(({ context: { tx, user }, input }) => pairOptions(tx, user, input, deps.remote)),
    // orgMember: chờ chủ máy bấm Cho phép tới cả phút, không giữ transaction trong lúc đó.
    pairComplete: os.pairComplete
      .use(orgMember)
      .handler(({ context: { pool, user, orgId }, input }) => pairComplete(pool, orgId, user, input, deps.remote)),
    devices: os.devices
      .use(inOrg)
      .handler(({ context: { tx, user }, input }) => listDevices(tx, user.id, input.machineId)),
    revokeDevice: os.revokeDevice
      .use(inOrg)
      .handler(({ context: { tx, user }, input }) => revokeDevice(tx, user.id, input.machineId, input.deviceId)),
  };
}
