import { implement } from "@orpc/server";
import { contract } from "@xdev-hive/contracts";
import { desc, eq } from "drizzle-orm";
import type { RequestContext } from "../platform/index.ts";
import { ConflictError, NotFoundError, withTenant } from "../platform/index.ts";
import type { RunsEngine } from "../runs/index.ts";
import { type OrgDeps, orgMiddlewares } from "../tenancy/index.ts";
import { cardFacts, cardOf } from "./cards.ts";
import { chatMessages, chatThreads } from "./schema.ts";
import {
  approveApproval,
  createThread,
  listApprovals,
  messageView,
  rejectApproval,
  sendLeaderMessage,
  threadView,
} from "./service.ts";

export interface LeaderRouterDeps extends OrgDeps {
  runs?: RunsEngine | undefined;
  approvalTtlSec?: number | undefined;
}

export function leaderRouter(deps: LeaderRouterDeps) {
  const { authed, inOrg, orgMember } = orgMiddlewares(deps);
  const os = implement(contract.leader).$context<RequestContext>().use(authed);
  return {
    threads: {
      create: os.threads.create
        .use(inOrg)
        .handler(async ({ context: { tx, user }, input }) => threadView(await createThread(tx, user.id, input))),
      list: os.threads.list
        .use(inOrg)
        .handler(async ({ context: { tx } }) =>
          (await tx.select().from(chatThreads).orderBy(desc(chatThreads.updatedAt))).map(threadView),
        ),
      get: os.threads.get.use(inOrg).handler(async ({ context: { tx, user }, input }) => {
        const [row] = await tx.select().from(chatThreads).where(eq(chatThreads.id, input.id));
        if (!row) throw new NotFoundError("LEADER_THREAD_NOT_FOUND", "Không tìm thấy cuộc trò chuyện.");
        const messages = await tx
          .select()
          .from(chatMessages)
          .where(eq(chatMessages.threadId, row.id))
          .orderBy(chatMessages.createdAt);
        const facts = await cardFacts(tx, user.id, messages);
        return {
          thread: threadView(row),
          messages: messages.map((m) => ({ ...messageView(m, cardOf(m, facts)), pageErrors: m.pageErrors })),
        };
      }),
      send: os.threads.send.use(inOrg).handler(async ({ context: { pool, user, orgId }, input }) => {
        const runsEngine = deps.runs;
        if (!runsEngine) throw new ConflictError("RUNS_DISABLED", "Hub chưa cấu hình giao leader run.");
        const { response, afterCommit } = await withTenant(pool, { userId: user.id, orgId }, (tx) =>
          sendLeaderMessage(runsEngine, tx, user.id, {
            threadId: input.id,
            content: input.content,
            ...(input.cli ? { cli: input.cli } : {}),
          }),
        );
        afterCommit();
        return response;
      }),
    },
    approvals: {
      list: os.approvals.list
        .use(inOrg)
        .handler(({ context: { tx }, input }) => listApprovals(tx, input.status, input.threadId)),
      approve: os.approvals.approve.use(orgMember).handler(async ({ context: { pool, user, orgId }, input }) => {
        const { response, afterCommit } = await withTenant(pool, { userId: user.id, orgId }, (tx) =>
          approveApproval(deps.runs, tx, user.id, input.id, input.tier),
        );
        afterCommit?.();
        return response;
      }),
      reject: os.approvals.reject
        .use(inOrg)
        .handler(({ context: { tx, user }, input }) => rejectApproval(tx, user.id, input.id, input.reason)),
    },
  };
}
