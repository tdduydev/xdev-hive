import { implement, ORPCError } from "@orpc/server";
import { type ChatBotTestResult, contract } from "@xdev-hive/contracts";
import { type MasterKey, type RequestContext, withTenant } from "../platform/index.ts";
import { type OrgDeps, orgMiddlewares } from "../tenancy/index.ts";
import { type ChatApiDeps, ChatSendError, probeBot } from "./adapters.ts";
import {
  availableBots,
  botView,
  createBot,
  getSettings,
  listBots,
  loadBotForProbe,
  removeBot,
  saveBotTarget,
  updateBot,
  updateSettings,
  webhookUrls,
} from "./bots.ts";
import { createLinkCode, listMyLinks, removeMyLink, updateMyLinkEvents } from "./links.ts";

export interface ChatRouterDeps extends OrgDeps, ChatApiDeps {
  masterKey?: MasterKey | undefined;
  publicUrl: string;
}

function needKey(deps: ChatRouterDeps): MasterKey {
  if (!deps.masterKey) {
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: "Hub chưa cấu hình HIVE_MASTER_KEY nên chưa lưu được secret.",
    });
  }
  return deps.masterKey;
}

export function chatRouter(deps: ChatRouterDeps) {
  const { authed, inOrg, orgMember } = orgMiddlewares(deps);
  const os = implement(contract.chat).$context<RequestContext>().use(authed);
  const view = botView(deps.publicUrl);

  return {
    bots: {
      list: os.bots.list
        .use(inOrg)
        .handler(async ({ context: { tx, user } }) => (await listBots(tx, user.id)).map(view)),
      create: os.bots.create
        .use(inOrg)
        .handler(async ({ context: { tx, user }, input }) => view(await createBot(tx, needKey(deps), user.id, input))),
      update: os.bots.update
        .use(inOrg)
        .handler(async ({ context: { tx, user }, input }) => view(await updateBot(tx, needKey(deps), user.id, input))),
      remove: os.bots.remove.use(inOrg).handler(async ({ context: { tx, user }, input }) => {
        await removeBot(tx, user.id, input.id);
        return { id: input.id };
      }),
      // Gọi ra Telegram/Slack nên không giữ transaction: đọc bot trong transaction ngắn, gọi mạng, rồi ghi tên bot.
      test: os.bots.test
        .use(orgMember)
        .handler(async ({ context: { pool, user, orgId }, input }): Promise<ChatBotTestResult> => {
          const key = needKey(deps);
          const bot = await withTenant(pool, { userId: user.id, orgId }, (tx) =>
            loadBotForProbe(tx, key, user.id, input.id),
          );
          try {
            const url = webhookUrls(deps.publicUrl, bot)[0]?.url ?? null;
            const probed = await probeBot(bot.config, bot.kind === "telegram" ? url : null, deps);
            await withTenant(pool, { userId: user.id, orgId }, (tx) =>
              saveBotTarget(tx, user.id, bot.id, probed.target),
            );
            return { ok: true, message: probed.message };
          } catch (e) {
            if (!(e instanceof ChatSendError)) throw e;
            return { ok: false, message: e.message };
          }
        }),
    },
    settings: {
      get: os.settings.get.use(inOrg).handler(({ context: { tx, user } }) => getSettings(tx, user.id)),
      update: os.settings.update
        .use(inOrg)
        .handler(({ context: { tx, user }, input }) => updateSettings(tx, user.id, input)),
    },
    links: {
      available: os.links.available
        .use(inOrg)
        .handler(async ({ context: { tx, user } }) =>
          (await availableBots(tx, user.id)).map(({ id, kind, name, target }) => ({ id, kind, name, target })),
        ),
      list: os.links.list.use(inOrg).handler(({ context: { tx, user } }) => listMyLinks(tx, user.id)),
      createCode: os.links.createCode
        .use(inOrg)
        .handler(({ context: { tx, user }, input }) => createLinkCode(tx, user.id, input.botId)),
      update: os.links.update
        .use(inOrg)
        .handler(({ context: { tx, user }, input }) => updateMyLinkEvents(tx, user.id, input.id, input.events)),
      remove: os.links.remove.use(inOrg).handler(async ({ context: { tx, user }, input }) => {
        await removeMyLink(tx, user.id, input.id, "web");
        return { id: input.id };
      }),
    },
  };
}
