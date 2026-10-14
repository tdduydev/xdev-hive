import { type ChatAction, chatAction } from "@xdev-hive/contracts";
import { RUN_STATUS_GROUPS } from "@xdev-hive/contracts/run-states";
import { eq, sql } from "drizzle-orm";
import { recordAudit } from "../audit/index.ts";
import { listProjects } from "../catalog/index.ts";
import { machineQuotas } from "../fleet/index.ts";
import { listApprovals, rejectApproval } from "../leader/index.ts";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  type Tx,
  withTenant,
} from "../platform/index.ts";
import { getRun, listRuns, runs, searchRuns } from "../runs/index.ts";
import { taskByKeyForUser } from "../tasks/index.ts";
import { requireOrgRole } from "../tenancy/index.ts";
import { performAction } from "./actions.ts";
import type { OutMessage } from "./adapters.ts";
import { loadSettings, type ResolvedBot } from "./bots.ts";
import type { ChatDeps } from "./deps.ts";
import { describeAction, runStateLabel, taskStatusLabel, untilLabel } from "./describe.ts";
import { sendToLeader } from "./leader-bridge.ts";
import { codeOwner, findLink, type LinkRow, redeemLinkCode, removeMyLink } from "./links.ts";
import { ACTION_TTL_MS, storeSent, toOutMessage } from "./outbox.ts";
import { linkAttemptLimiter, messageLimiter } from "./rate-limit.ts";
import { forChat } from "./sanitize.ts";
import { chatLinks, chatOutbox } from "./schema.ts";
import type { Ctx, HandlerResult, InboundAction, InboundMessage, Reply } from "./types.ts";

type Handler = (c: Ctx, tx: Tx, args: string) => Promise<HandlerResult>;

const isDomainError = (e: unknown): e is Error =>
  e instanceof ForbiddenError ||
  e instanceof NotFoundError ||
  e instanceof ConflictError ||
  e instanceof BadRequestError;

const web = (c: Ctx) => c.deps.publicUrl.replace(/\/+$/, "");
const one = (text: string): HandlerResult => ({ replies: [{ text }] });
const prefixOf = (c: Ctx) => (c.bot.kind === "slack" ? "/hive " : "/");

// ---- Phân tích tin ---------------------------------------------------------------------------------------------

const COMMANDS = new Set([
  "start",
  "help",
  "link",
  "unlink",
  "pending",
  "approve",
  "reject",
  "runs",
  "run",
  "task",
  "cancel",
  "quota",
  "project",
  "new",
]);

export function parseCommand(text: string): { command: string; args: string } | null {
  const m = /^\/([A-Za-z]+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (m?.[1]) return { command: m[1].toLowerCase(), args: (m[2] ?? "").trim() };
  // Slack chặn tin DM bắt đầu bằng "/" (coi là slash command), nên người dùng gõ "link MÃ" không có dấu gạch.
  const bare = /^link\s+(\S+)$/i.exec(text.trim());
  if (bare?.[1]) return { command: "link", args: bare[1] };
  return null;
}

// ---- Chạy lệnh dưới danh người đã liên kết ---------------------------------------------------------------------

async function recordDenied(c: Ctx, name: string, code: string, kind: "chat.command" | "chat.action") {
  try {
    await withTenant(c.deps.pool, { userId: c.link.userId, orgId: c.bot.orgId }, (tx) =>
      recordAudit(tx, {
        action: kind,
        targetType: "chat_link",
        targetId: c.link.id,
        data: { channel: c.bot.kind, name, ok: false, code },
      }),
    );
  } catch (e) {
    console.warn("Không ghi được audit cho lệnh chat bị từ chối:", e instanceof Error ? e.message : e);
  }
}

/**
 * Chạy `fn` trong transaction của người dùng đã liên kết: kiểm họ còn là thành viên tổ chức, chạy hàm hub như web, ghi
 * audit trong cùng transaction. Lỗi nghiệp vụ (không quyền, không thấy, trạng thái sai) thành câu trả lời và được audit
 * riêng, vì transaction đã rollback.
 */
async function execute(
  c: Ctx,
  name: string,
  kind: "chat.command" | "chat.action",
  fn: (tx: Tx) => Promise<HandlerResult>,
  extra: Record<string, unknown> = {},
): Promise<{ replies: Reply[]; ok: boolean }> {
  let result: HandlerResult;
  try {
    result = await withTenant(c.deps.pool, { userId: c.link.userId, orgId: c.bot.orgId }, async (tx) => {
      await requireOrgRole(tx, c.link.userId, "member");
      const out = await fn(tx);
      await recordAudit(tx, {
        action: kind,
        targetType: "chat_link",
        targetId: c.link.id,
        data: { channel: c.bot.kind, name, ok: true, ...extra },
      });
      return out;
    });
  } catch (e) {
    if (!isDomainError(e)) throw e;
    await recordDenied(c, name, (e as { code?: string }).code ?? e.name, kind);
    return { replies: [{ text: `⚠️ ${e.message}` }], ok: false };
  }
  result.after?.();
  return { replies: result.replies, ok: true };
}

// ---- Lệnh ------------------------------------------------------------------------------------------------------

const helpText = (c: Ctx) => {
  const p = prefixOf(c);
  return [
    "Lệnh của Hive (không tốn token):",
    `${p}pending – đề xuất của Leader đang chờ duyệt`,
    `${p}approve ID · ${p}reject ID [lý do] – duyệt hoặc từ chối đề xuất`,
    `${p}runs – run gần đây của bạn · ${p}run ID · ${p}cancel ID`,
    `${p}task MÃ – trạng thái task (vd. PAY-12)`,
    `${p}quota – quota tài khoản CLI trên máy của bạn`,
    `${p}project [MÃ] – chọn dự án cho Leader · ${p}new – cuộc trò chuyện Leader mới`,
    `${p}unlink – tách tài khoản chat khỏi Hive`,
    "",
    "Tin nhắn thường trong chat riêng được chuyển cho Leader của dự án đang chọn (có giới hạn lượt mỗi ngày).",
  ].join("\n");
};

/** Tìm id đầy đủ theo 4 ký tự đầu trở lên; mơ hồ hay không thấy thì báo lỗi. */
function pickByPrefix(ids: string[], prefix: string, what: string): string {
  const hits = ids.filter((id) => id.startsWith(prefix.toLowerCase()));
  if (hits.length === 1 && hits[0]) return hits[0];
  if (hits.length > 1)
    throw new BadRequestError("CHAT_AMBIGUOUS_ID", `Có nhiều ${what} bắt đầu bằng “${prefix}”, gõ dài hơn.`);
  throw new NotFoundError("CHAT_ID_NOT_FOUND", `Không thấy ${what} “${prefix}”.`);
}

const validPrefix = (raw: string) => (/^[0-9a-f-]{4,36}$/i.test(raw) ? raw : null);

async function runIdByPrefix(tx: Tx, raw: string): Promise<string> {
  const prefix = validPrefix(raw);
  if (!prefix) throw new BadRequestError("CHAT_BAD_ID", "Mã run là 4–36 ký tự đầu của id (xem /runs).");
  const rows = await tx
    .select({ id: runs.id })
    .from(runs)
    .where(sql`${runs.id}::text like ${`${prefix.toLowerCase()}%`}`)
    .limit(3);
  return pickByPrefix(
    rows.map((r) => r.id),
    prefix,
    "run",
  );
}

const pending: Handler = async (c, tx) => {
  const list = (await listApprovals(tx, "pending")).slice(0, 5);
  if (list.length === 0) return one("Không có đề xuất nào đang chờ duyệt.");
  return {
    replies: list.map((a) => ({
      title: `Đề xuất ${a.id.slice(0, 8)}`,
      text: describeAction(a.action),
      actions: [
        { kind: "approval.approve", approvalId: a.id },
        { kind: "approval.reject", approvalId: a.id },
      ] satisfies ChatAction[],
      url: `${web(c)}/leader`,
    })),
  };
};

async function decide(
  c: Ctx,
  tx: Tx,
  args: string,
  kind: "approval.approve" | "approval.reject",
): Promise<HandlerResult> {
  const [idArg, ...rest] = args.split(/\s+/);
  const prefix = idArg ? validPrefix(idArg) : null;
  if (!prefix)
    return one(
      `Cách dùng: ${prefixOf(c)}${kind === "approval.approve" ? "approve" : "reject"} ID (xem ${prefixOf(c)}pending).`,
    );
  const open = (await listApprovals(tx, "pending")).map((a) => a.id);
  const approvalId = pickByPrefix(open, prefix, "đề xuất đang chờ");
  if (kind === "approval.reject" && rest.length > 0) {
    await rejectApproval(tx, c.link.userId, approvalId, rest.join(" ").slice(0, 2000));
    return one("Đã từ chối đề xuất.");
  }
  const done = await performAction(c.deps, tx, c.link.userId, { kind, approvalId });
  return { replies: [{ text: done.text }], after: done.after };
}

const runsList: Handler = async (c, tx) => {
  const { items } = await searchRuns(tx, c.link.userId, { mine: true, limit: 8 });
  if (items.length === 0) return one("Bạn chưa có run nào.");
  const active = new Set<string>(RUN_STATUS_GROUPS.active);
  const lines = items.map(
    (r) => `${active.has(r.state) ? "▶" : "•"} ${r.id.slice(0, 8)} ${r.taskKey} – ${runStateLabel(r.state)}`,
  );
  return { replies: [{ title: "Run gần đây của bạn", text: lines.join("\n"), url: `${web(c)}/runs` }] };
};

const runInfo: Handler = async (c, tx, args) => {
  if (!args) return one(`Cách dùng: ${prefixOf(c)}run ID (xem ${prefixOf(c)}runs).`);
  const run = await getRun(tx, c.link.userId, await runIdByPrefix(tx, args.split(/\s+/)[0] ?? ""));
  const lines = [
    `Trạng thái: ${runStateLabel(run.state)}`,
    `Loại: ${run.kind}${run.cli ? ` · ${run.cli}` : ""}${run.machineName ? ` · máy ${run.machineName}` : ""}`,
    `Nhánh: ${run.branch}`,
    ...(run.prUrl ? [`PR: ${run.prUrl}`] : []),
  ];
  const active = new Set<string>(RUN_STATUS_GROUPS.active);
  return {
    replies: [
      {
        title: `Run ${run.id.slice(0, 8)}`,
        text: lines.join("\n"),
        url: `${web(c)}/runs/${run.id}`,
        ...(active.has(run.state) && run.state !== "cancelling"
          ? { actions: [{ kind: "run.cancel", runId: run.id }] satisfies ChatAction[] }
          : {}),
      },
    ],
  };
};

const taskInfo: Handler = async (c, tx, args) => {
  const key = args.split(/\s+/)[0]?.toUpperCase();
  if (!key || !/^[A-Z0-9_-]+-\d+$/.test(key)) return one(`Cách dùng: ${prefixOf(c)}task MÃ (vd. PAY-12).`);
  const task = await taskByKeyForUser(tx, c.link.userId, key, "viewer");
  const [latest] = await listRuns(tx, c.link.userId, task.id);
  const lines = [
    task.title,
    `Trạng thái: ${taskStatusLabel(task.status)}`,
    ...(latest ? [`Run mới nhất: ${latest.id.slice(0, 8)} – ${runStateLabel(latest.state)}`] : ["Chưa có run."]),
  ];
  return { replies: [{ title: task.key, text: lines.join("\n"), url: `${web(c)}/tasks/${task.key}` }] };
};

const cancel: Handler = async (c, tx, args) => {
  if (!args) return one(`Cách dùng: ${prefixOf(c)}cancel ID (xem ${prefixOf(c)}runs).`);
  const id = await runIdByPrefix(tx, args.split(/\s+/)[0] ?? "");
  const done = await performAction(c.deps, tx, c.link.userId, { kind: "run.cancel", runId: id });
  return { replies: [{ text: done.text }], after: done.after };
};

const quota: Handler = async (c, tx) => {
  const list = await machineQuotas(tx, c.link.userId);
  if (list.length === 0) return one("Bạn chưa có máy nào đăng ký với Hive.");
  const lines = list.flatMap((m) => {
    const head = `🖥 ${m.name} (${m.online ? "đang online" : "offline"})`;
    if (!m.accounts?.length) return [head, "  Máy chưa báo quota tài khoản."];
    return [
      head,
      ...m.accounts.map((a) => {
        const reset = untilLabel(a.resetsAt);
        const state =
          a.loggedIn === false ? "chưa đăng nhập" : `phiên ${a.sessionPct ?? "?"}% · tuần ${a.weekPct ?? "?"}%`;
        return `  ${a.cli} “${a.label}”: ${state}${reset ? ` (phiên đặt lại sau ${reset})` : ""}${a.enabled ? "" : " [tắt]"}`;
      }),
    ];
  });
  return { replies: [{ title: "Quota máy của bạn", text: lines.join("\n"), url: `${web(c)}/machines` }] };
};

const project: Handler = async (c, tx, args) => {
  const all = await listProjects(tx, c.link.userId);
  const key = args.split(/\s+/)[0]?.toUpperCase();
  if (key) {
    const found = all.find((p) => p.key.toUpperCase() === key);
    if (!found) throw new NotFoundError("CHAT_PROJECT_NOT_FOUND", `Không thấy dự án “${key}” trong các đội của bạn.`);
    await tx.update(chatLinks).set({ projectId: found.id, threadId: null }).where(eq(chatLinks.id, c.link.id));
    return one(`Đã chọn dự án ${found.key} (${found.name}) cho Leader. Cuộc trò chuyện mới bắt đầu từ tin kế tiếp.`);
  }
  const current = all.find((p) => p.id === c.link.projectId);
  const list = all
    .slice(0, 15)
    .map((p) => `• ${p.key} – ${p.name}`)
    .join("\n");
  return one(
    `${current ? `Dự án hiện tại: ${current.key} (${current.name}).` : "Chưa chọn dự án cho Leader."}\n${list || "Bạn chưa thuộc dự án nào."}\nĐổi bằng ${prefixOf(c)}project MÃ.`,
  );
};

const newThread: Handler = async (c, tx) => {
  await tx.update(chatLinks).set({ threadId: null }).where(eq(chatLinks.id, c.link.id));
  return one("Đã bắt đầu cuộc trò chuyện Leader mới.");
};

const unlink: Handler = async (c, tx) => {
  await removeMyLink(tx, c.link.userId, c.link.id, "chat");
  return one("Đã tách tài khoản chat khỏi Hive. Thông báo sẽ không gửi tới đây nữa.");
};

const HANDLERS: Record<string, Handler> = {
  pending,
  approve: (c, tx, a) => decide(c, tx, a, "approval.approve"),
  reject: (c, tx, a) => decide(c, tx, a, "approval.reject"),
  runs: runsList,
  run: runInfo,
  task: taskInfo,
  cancel,
  quota,
  project,
  new: newThread,
  unlink,
};

// ---- Điểm vào --------------------------------------------------------------------------------------------------

const TOO_FAST = "Bạn gửi quá nhanh, thử lại sau một phút.";
const NOT_LINKED = (bot: ResolvedBot) =>
  `Tài khoản chat này chưa liên kết với Hive. Vào Hive → Thông báo → Chat để lấy mã, rồi gửi ${bot.kind === "slack" ? "/hive link MÃ" : "/link MÃ"}.`;

/** Biến Reply thành tin gửi đi; tin có nút được lưu vào outbox để nút nhớ hành động và chỉ người nhận bấm được. */
async function render(c: Pick<Ctx, "deps" | "bot">, link: LinkRow | null, replies: Reply[]): Promise<OutMessage[]> {
  const out: OutMessage[] = [];
  for (const r of replies) {
    const text = forChat(r.text, 1800);
    if (link && (r.actions?.length ?? 0) > 0) {
      const id = await withTenant(c.deps.pool, { orgId: c.bot.orgId }, (tx) =>
        storeSent(tx, link, {
          kind: "command",
          title: r.title,
          body: text,
          url: r.url,
          actions: r.actions,
        }),
      );
      out.push(
        toOutMessage(c.bot.kind, {
          id,
          title: r.title ?? "",
          body: text,
          url: r.url ?? null,
          actions: r.actions ?? [],
        }),
      );
    } else {
      out.push(toOutMessage(c.bot.kind, { id: "", title: r.title ?? "", body: text, url: r.url ?? null, actions: [] }));
    }
  }
  return out;
}

/** Tin nhắn từ chat tới: lệnh, mã liên kết, hoặc tin tự do cho Leader. Trả các tin cần gửi lại. */
export async function handleMessage(deps: ChatDeps, bot: ResolvedBot, m: InboundMessage): Promise<OutMessage[]> {
  const key = `${bot.id}:${m.externalUserId}`;
  if (!messageLimiter.allow(key)) return render({ deps, bot }, null, [{ text: TOO_FAST }]);

  const parsed = parseCommand(m.text);
  const known = parsed && COMMANDS.has(parsed.command) ? parsed : null;
  const { link, settings } = await withTenant(deps.pool, { orgId: bot.orgId }, async (tx) => ({
    link: await findLink(tx, bot.id, m.externalUserId),
    settings: await loadSettings(tx),
  }));

  // Nhóm: chặn trừ khi tổ chức bật, và khi bật vẫn chỉ nhận lệnh có dấu gạch, không nhận tin tự do cho Leader.
  if (m.chatType === "group") {
    if (!parsed) return [];
    if (!settings.allowGroups) {
      return render({ deps, bot }, null, [{ text: "Tổ chức chưa bật chat nhóm cho bot này. Hãy nhắn riêng cho bot." }]);
    }
    // Liên kết trong nhóm sẽ gắn "chat riêng" sai chỗ (thông báo bay vào nhóm), nên chỉ cho liên kết ở chat riêng.
    if (parsed.command === "link" || parsed.command === "start") {
      return render({ deps, bot }, null, [{ text: "Hãy liên kết trong chat riêng với bot, không phải trong nhóm." }]);
    }
  }

  if (known && (known.command === "link" || known.command === "start")) {
    return render({ deps, bot }, null, [await linkAccount(deps, bot, m, known.args)]);
  }
  if (!link) return render({ deps, bot }, null, [{ text: NOT_LINKED(bot) }]);

  const c: Ctx = { deps, bot, link, settings, chatType: m.chatType };
  if (parsed && !known) {
    return render(c, link, [{ text: `Không có lệnh “${parsed.command}”.\n\n${helpText(c)}` }]);
  }
  if (known?.command === "help") {
    const { replies } = await execute(c, "help", "chat.command", async () => one(helpText(c)));
    return render(c, link, replies);
  }
  if (known) {
    const handler = HANDLERS[known.command];
    if (!handler) return [];
    const { replies } = await execute(c, known.command, "chat.command", (tx) => handler(c, tx, known.args));
    return render(c, link, replies);
  }

  // Tin tự do: chỉ chat riêng.
  const text = m.text.trim().slice(0, 4000);
  if (!text) return [];
  const { replies } = await execute(c, "leader.message", "chat.command", (tx) => sendToLeader(c, tx, text), {
    length: text.length,
  });
  return render(c, link, replies);
}

/** `/link MÃ`: đổi mã một lần lấy liên kết. Mã sai không nói rõ lý do (hết hạn hay không có) để khỏi dò. */
async function linkAccount(deps: ChatDeps, bot: ResolvedBot, m: InboundMessage, rawCode: string): Promise<Reply> {
  const code = rawCode.split(/\s+/)[0] ?? "";
  if (!code) return { text: "Gửi kèm mã từ web: /link MÃ (Hive → Thông báo → Chat → Tạo mã)." };
  if (!linkAttemptLimiter.allow(`${bot.id}:${m.externalUserId}`)) {
    return { text: "Nhập mã sai quá nhiều lần. Đợi vài phút rồi tạo mã mới trên web." };
  }
  const bad: Reply = { text: "Mã không đúng hoặc đã hết hạn. Hãy tạo mã mới trên web." };
  const owner = await withTenant(deps.pool, { orgId: bot.orgId }, (tx) => codeOwner(tx, bot.id, code));
  if (!owner) return bad;
  try {
    const linked = await withTenant(deps.pool, { userId: owner, orgId: bot.orgId }, (tx) =>
      redeemLinkCode(tx, bot.id, code, { userId: m.externalUserId, chatId: m.chatId, label: m.label }),
    );
    return linked
      ? { text: "Đã liên kết tài khoản chat với Hive. Gõ /help để xem lệnh; chọn loại thông báo nhận trên web." }
      : bad;
  } catch (e) {
    if (isDomainError(e)) return { text: `⚠️ ${e.message}` };
    throw e;
  }
}

/** Bấm nút. Chỉ chính người nhận tin mới bấm được, và hành động lấy từ outbox chứ không từ dữ liệu nút. */
export async function handleAction(
  deps: ChatDeps,
  bot: ResolvedBot,
  a: InboundAction,
): Promise<{ messages: OutMessage[]; ok: boolean }> {
  const fail = async (text: string, c: Pick<Ctx, "deps" | "bot"> = { deps, bot }) => ({
    messages: await render(c, null, [{ text }]),
    ok: false,
  });
  if (!messageLimiter.allow(`${bot.id}:${a.externalUserId}`)) return fail(TOO_FAST);
  const m = /^o:([0-9a-f-]{36}):(\d{1,2})$/i.exec(a.data);
  if (!m?.[1] || !m[2]) return { messages: [], ok: false };
  const [outboxId, index] = [m[1], Number(m[2])];
  const loaded = await withTenant(deps.pool, { orgId: bot.orgId }, async (tx) => {
    const [row] = await tx
      .select({ actions: chatOutbox.actions, createdAt: chatOutbox.createdAt, linkId: chatOutbox.linkId })
      .from(chatOutbox)
      .where(eq(chatOutbox.id, outboxId));
    const [link] = row ? await tx.select().from(chatLinks).where(eq(chatLinks.id, row.linkId)) : [];
    return { row, link, settings: await loadSettings(tx) };
  });
  const { row, link, settings } = loaded;
  if (!row || !link || link.botId !== bot.id || link.externalUserId !== a.externalUserId) {
    return fail("Nút này không dành cho tài khoản của bạn.");
  }
  const c: Ctx = { deps, bot, link, settings, chatType: a.chatType };
  if (a.chatType === "group" && !settings.allowGroups) {
    return fail("Tổ chức chưa bật chat nhóm. Hãy dùng nút trong chat riêng với bot.", c);
  }
  const action = chatAction.safeParse((row.actions as unknown[])[index]);
  if (!action.success) return fail("Nút này không còn hiệu lực.", c);
  if (Date.now() - row.createdAt.getTime() > ACTION_TTL_MS) {
    return fail("Nút đã hết hạn, hãy mở trên web để xem lại.", c);
  }
  const { replies, ok } = await execute(
    c,
    action.data.kind,
    "chat.action",
    async (tx) => {
      const done = await performAction(deps, tx, link.userId, action.data);
      return { replies: [{ text: done.text }], after: done.after };
    },
    { outboxId },
  );
  return { messages: await render(c, null, replies), ok };
}
