import { leaderAction } from "@xdev-hive/contracts";
import { and, eq, inArray, sql } from "drizzle-orm";
import { approvals, provideLeaderObserver } from "../leader/index.ts";
import { provideNotifyFanout } from "../notify/index.ts";
import type { Jobs, Tx } from "../platform/index.ts";
import { describeAction } from "./describe.ts";
import { enqueueOutbox } from "./outbox.ts";
import { chatBots, chatLinks } from "./schema.ts";

export interface ChatHookDeps {
  jobs?: Jobs | undefined;
  publicUrl: string;
}

/**
 * Nối chat vào hai nơi mà module khác không import được (đảo phụ thuộc): thông báo của notify, và câu trả lời hay đề
 * xuất của leader. Gọi một lần lúc hub khởi động; truyền `undefined` để gỡ (test).
 */
export function installChatHooks(deps: ChatHookDeps | undefined): void {
  if (!deps) {
    provideNotifyFanout(undefined);
    provideLeaderObserver(undefined);
    return;
  }
  const web = deps.publicUrl.replace(/\/+$/, "");

  provideNotifyFanout(async (tx, input, opts) => {
    if (input.recipients.length === 0) return;
    const links = await tx
      .select({ id: chatLinks.id })
      .from(chatLinks)
      .innerJoin(chatBots, and(eq(chatBots.id, chatLinks.botId), eq(chatBots.orgId, chatLinks.orgId)))
      .where(
        and(
          eq(chatLinks.orgId, input.orgId),
          inArray(chatLinks.userId, input.recipients),
          eq(chatBots.enabled, true),
          sql`${chatLinks.events} @> array[${input.event}]::text[]`,
        ),
      );
    for (const link of links) {
      await enqueueOutbox(tx, opts.jobs ?? deps.jobs, input.orgId, link, {
        kind: "notification",
        event: input.event,
        dedupeKey: `${input.event}:${input.eventKey}`,
        title: input.title,
        body: input.body,
        url: input.link,
        actions: input.actions,
      });
    }
  });

  provideLeaderObserver(async (tx, event) => {
    const links = await tx
      .select({ id: chatLinks.id, orgId: chatLinks.orgId })
      .from(chatLinks)
      .innerJoin(chatBots, and(eq(chatBots.id, chatLinks.botId), eq(chatBots.orgId, chatLinks.orgId)))
      .where(and(eq(chatLinks.threadId, event.threadId), eq(chatBots.enabled, true)));
    if (links.length === 0) return;
    let body = event.content;
    let actions: Array<{ kind: "approval.approve" | "approval.reject"; approvalId: string }> = [];
    if (event.kind === "proposal" && event.approvalId) {
      const [approval] = await tx.select().from(approvals).where(eq(approvals.id, event.approvalId));
      const parsed = approval ? leaderAction.safeParse(approval.action) : null;
      if (parsed?.success) body = `${event.content}\n\nĐề xuất: ${describeAction(parsed.data)}`;
      actions = [
        { kind: "approval.approve", approvalId: event.approvalId },
        { kind: "approval.reject", approvalId: event.approvalId },
      ];
    }
    for (const link of links) {
      await enqueueOutbox(tx, deps.jobs, link.orgId, link, {
        kind: "leader",
        title: event.kind === "proposal" ? "Leader đề xuất" : "Leader",
        body,
        url: `${web}/leader`,
        actions,
      });
    }
  });
}
