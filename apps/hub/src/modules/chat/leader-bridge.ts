import { and, eq, sql } from "drizzle-orm";
import { listProjects } from "../catalog/index.ts";
import { chatThreads, createThread, sendLeaderMessage } from "../leader/index.ts";
import { ConflictError, type Tx } from "../platform/index.ts";
import { chatLinks, chatUsage } from "./schema.ts";
import { type Ctx, type HandlerResult, LimitError } from "./types.ts";

// Hạn mức tính theo ngày giờ Việt Nam, như giờ làm việc của người dùng; đổi ngày lúc nửa đêm ở Hà Nội.
const TODAY = sql`(now() at time zone 'Asia/Ho_Chi_Minh')::date`;

/** Cộng một lượt vào dòng của `userId` và trả số lượt hôm nay. `userId` rỗng là dòng tổng của tổ chức. */
async function bump(tx: Tx, userId: string): Promise<number> {
  const [row] = await tx
    .insert(chatUsage)
    .values({ orgId: sql`hive.ctx_org()`, userId, day: TODAY, count: 1 })
    .onConflictDoUpdate({
      target: [chatUsage.orgId, chatUsage.userId, chatUsage.day],
      set: { count: sql`${chatUsage.count} + 1` },
    })
    .returning({ count: chatUsage.count });
  return row?.count ?? 0;
}

/**
 * Tính một lượt tin tự do. Vượt hạn mức thì ném LimitError, làm transaction rollback nên lượt vừa cộng cũng mất: người
 * bị chặn không ăn thêm hạn mức. Trả số lượt còn lại của người dùng hôm nay.
 */
export async function consumeLeaderTurn(c: Ctx, tx: Tx): Promise<number> {
  const { userDailyLimit, orgDailyLimit } = c.settings;
  if (userDailyLimit === 0 || orgDailyLimit === 0) {
    throw new LimitError("Tổ chức chưa cho gửi tin tự do cho Leader qua chat. Hãy dùng lệnh hoặc mở web.");
  }
  const mine = await bump(tx, c.link.userId);
  if (mine > userDailyLimit) {
    throw new LimitError(
      `Bạn đã dùng hết ${userDailyLimit} lượt Leader hôm nay. Lệnh và nút vẫn dùng được; mai thử lại hoặc mở web.`,
    );
  }
  const total = await bump(tx, "");
  if (total > orgDailyLimit) {
    throw new LimitError(
      "Tổ chức đã dùng hết lượt Leader qua chat hôm nay. Lệnh và nút vẫn dùng được; mai thử lại hoặc mở web.",
    );
  }
  return userDailyLimit - mine;
}

/**
 * Tin tự do → phiên Leader của người dùng cho dự án đang chọn, y như gõ trên web (đề xuất vẫn phải có người duyệt).
 * Câu trả lời tới sau, qua hook leader (hooks.ts), nên ở đây chỉ báo đã nhận.
 */
export async function sendToLeader(c: Ctx, tx: Tx, text: string): Promise<HandlerResult> {
  const runs = c.deps.runs;
  if (!runs) throw new ConflictError("RUNS_DISABLED", "Hub chưa cấu hình giao leader run.");
  const { link, settings } = c;
  const visible = await listProjects(tx, link.userId);
  let project = visible.find((p) => p.id === link.projectId);
  if (!project) {
    if (visible.length !== 1 || !visible[0]) {
      const list = visible
        .slice(0, 10)
        .map((p) => `• ${p.key} – ${p.name}`)
        .join("\n");
      return {
        replies: [
          { text: `Chọn dự án cho Leader trước: ${c.bot.kind === "slack" ? "/hive project" : "/project"} MÃ\n${list}` },
        ],
      };
    }
    project = visible[0];
  }

  const left = await consumeLeaderTurn(c, tx);

  let threadId = link.threadId;
  if (threadId) {
    const [t] = await tx
      .select({ projectId: chatThreads.projectId })
      .from(chatThreads)
      .where(eq(chatThreads.id, threadId));
    if (t?.projectId !== project.id) threadId = null;
  }
  if (!threadId) {
    const thread = await createThread(tx, link.userId, {
      projectId: project.id,
      title: `Chat ${c.bot.kind === "slack" ? "Slack" : "Telegram"} · ${new Date().toISOString().slice(0, 10)}`,
    });
    threadId = thread.id;
  }
  if (threadId !== link.threadId || project.id !== link.projectId) {
    await tx
      .update(chatLinks)
      .set({ projectId: project.id, threadId })
      .where(and(eq(chatLinks.id, link.id)));
  }

  // Model theo cài đặt tổ chức (mặc định sonnet): model là bí danh của Claude nên đi cùng cli = claude.
  const { afterCommit } = await sendLeaderMessage(runs, tx, link.userId, {
    threadId,
    content: text,
    ...(settings.leaderModel ? { cli: "claude" as const, model: settings.leaderModel } : {}),
  });
  return {
    replies: [
      {
        text: `Đã chuyển cho Leader (${project.key}). Còn ${left} lượt hôm nay; câu trả lời sẽ tới ngay trong chat này.`,
      },
    ],
    after: afterCommit,
  };
}
