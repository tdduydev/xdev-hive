import { implement, ORPCError } from "@orpc/server";
import { contract, type NotificationTestResult } from "@xdev-hive/contracts";
import { type Jobs, type MasterKey, type RequestContext, withTenant } from "../platform/index.ts";
import { type OrgDeps, orgMiddlewares } from "../tenancy/index.ts";
import {
  type ChannelRecord,
  createChannel,
  listChannels,
  loadChannelForTest,
  removeChannel,
  updateChannel,
} from "./channels.ts";
import { listInbox, markInboxRead, unreadInboxCount } from "./inbox.ts";
import { DeliveryError, type SendDeps, send } from "./send.ts";

export function inboxRouter(deps: OrgDeps & { jobs?: Jobs | undefined }) {
  const { authed, inOrg } = orgMiddlewares(deps);
  const os = implement(contract.inbox).$context<RequestContext>().use(authed);
  return {
    list: os.list.use(inOrg).handler(({ context: { tx }, input }) => listInbox(tx, input)),
    unreadCount: os.unreadCount.use(inOrg).handler(({ context: { tx } }) => unreadInboxCount(tx)),
    markRead: os.markRead.use(inOrg).handler(({ context: { tx }, input }) => markInboxRead(tx, input.ids, deps.jobs)),
    markAllRead: os.markAllRead.use(inOrg).handler(({ context: { tx } }) => markInboxRead(tx, undefined, deps.jobs)),
  };
}

export interface NotifyDeps extends OrgDeps, SendDeps {
  masterKey?: MasterKey | undefined;
}

const view = (c: ChannelRecord) => ({
  ...c,
  createdAt: c.createdAt.toISOString(),
  updatedAt: c.updatedAt.toISOString(),
});

function needKey(deps: NotifyDeps): MasterKey {
  if (!deps.masterKey) {
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: "Hub chưa cấu hình HIVE_MASTER_KEY nên chưa lưu được secret.",
    });
  }
  return deps.masterKey;
}

export function notifyRouter(deps: NotifyDeps) {
  const { authed, inOrg, orgMember } = orgMiddlewares(deps);
  const os = implement(contract.notificationChannels).$context<RequestContext>().use(authed);

  return {
    list: os.list.use(inOrg).handler(async ({ context: { tx, user } }) => (await listChannels(tx, user.id)).map(view)),
    create: os.create
      .use(inOrg)
      .handler(async ({ context: { tx, user }, input }) =>
        view(await createChannel(tx, needKey(deps), user.id, input, deps)),
      ),
    update: os.update
      .use(inOrg)
      .handler(async ({ context: { tx, user }, input }) =>
        view(await updateChannel(tx, needKey(deps), user.id, input, deps)),
      ),
    remove: os.remove.use(inOrg).handler(async ({ context: { tx, user }, input }) => {
      await removeChannel(tx, user.id, input.id);
      return { id: input.id };
    }),
    // Gọi ra Telegram/SMTP nên không giữ transaction: đọc kênh trong transaction ngắn rồi gửi.
    test: os.test
      .use(orgMember)
      .handler(async ({ context: { pool, user, orgId }, input }): Promise<NotificationTestResult> => {
        const key = needKey(deps);
        const channel = await withTenant(pool, { userId: user.id, orgId }, (tx) =>
          loadChannelForTest(tx, key, user.id, input.id),
        );
        try {
          await send(
            channel.config,
            {
              title: "Tin thử từ xDev Hive",
              body: `Kênh "${channel.name}" đã nối được. Từ giờ nhóm quản trị nhận thông báo ở đây.`,
              link: null,
            },
            deps,
          );
          return { ok: true, message: `Đã gửi tin thử tới ${channel.target}.` };
        } catch (e) {
          if (!(e instanceof DeliveryError)) throw e;
          return { ok: false, message: e.message };
        }
      }),
  };
}
