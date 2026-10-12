import {
  type AssistAction,
  type AssistStartInput,
  type AssistTarget,
  assistStartInput,
  type DocAssist,
} from "@xdev-hive/contracts";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { recordAudit } from "../audit/index.ts";
import { latestActiveProject, loadProject } from "../catalog/index.ts";
import { machineNames, machinesOfUser } from "../fleet/index.ts";
import { assistOutput, assistScope, draftForAgent } from "../knowledge/index.ts";
import { BadRequestError, ConflictError, type Tx } from "../platform/index.ts";
import { runEvents, runs } from "./schema.ts";
import { hubEvent, notifyRun, projectReady } from "./state.ts";

/** Nội dung dài quá thì cắt: lời nhắc đi qua stdin của CLI; agent đọc phần còn lại bằng doc_draft_get. */
const MAX_DOC_CHARS = 60_000;

const ACTIONS: Record<AssistAction, string> = {
  continue:
    "Viết tiếp tài liệu: phần còn dở, mục còn trống, hoặc ngay sau đoạn được chọn. Mỗi đoạn mới là một đề xuất " +
    "(`doc_suggest`); thêm ở cuối tài liệu thì để `before` rỗng.",
  template:
    "Kiểm tài liệu có đủ các mục mà loại tài liệu này cần (theo tài liệu cùng loại đã duyệt trong dự án, nếu có). " +
    "Mục thiếu hoặc sơ sài: đề xuất khung mục với nội dung gợi ý, hoặc bình luận nếu cần người viết quyết.",
  acceptance:
    "Soạn tiêu chí chấp nhận (Given/When/Then hoặc checklist kiểm được) cho các yêu cầu R-n chưa có tiêu chí. " +
    "Đề xuất chèn ngay dưới yêu cầu tương ứng.",
  crossref:
    "Đối chiếu với tài liệu liên quan (`doc_list`, `doc_get`) và code trong repo. Chỗ mâu thuẫn, trùng lặp hay thiếu " +
    "liên kết: bình luận neo vào đoạn đó; sửa được ngay thì đề xuất sửa.",
  translate:
    "Dịch đoạn được chọn (hoặc cả tài liệu nếu không chọn) theo yêu cầu bên dưới (mặc định sang tiếng Anh). Giữ " +
    "nguyên Markdown, mã R-n, tên riêng và khối code. Mỗi khối dịch là một đề xuất thay đúng khối gốc.",
  custom: "Làm theo yêu cầu của người viết bên dưới.",
};

export const ASSIST_LABELS: Record<AssistAction, string> = {
  continue: "Viết tiếp",
  template: "Kiểm đủ mục theo mẫu",
  acceptance: "Soạn tiêu chí chấp nhận",
  crossref: "Đối chiếu tài liệu liên quan",
  translate: "Dịch",
  custom: "Yêu cầu riêng",
};

const clip = (s: string) =>
  s.length > MAX_DOC_CHARS ? `${s.slice(0, MAX_DOC_CHARS)}\n\n[... đã cắt ${s.length - MAX_DOC_CHARS} ký tự]` : s;

/** Lời nhắc của run trợ lý tài liệu (DOC-05). */
export function docAssistPrompt(input: {
  key: string;
  title: string;
  action: AssistAction;
  prompt?: string | undefined;
  quote?: string | undefined;
  content: string;
}): string {
  return `Bạn là trợ lý soạn tài liệu trong xDev Hive. Việc cần làm: ${ASSIST_LABELS[input.action]}.

Tài liệu: ${input.title} (\`${input.key}\`), bản nháp đang soạn ở dưới.
Chỉ đọc: không sửa file, không commit. Mọi góp ý đi qua công cụ MCP của Hive để người viết nhận hoặc bỏ:
- \`doc_suggest\`: đề xuất sửa một đoạn. \`before\` chép nguyên văn đoạn gốc (đủ dài để chỉ có một chỗ), \`after\` là đoạn
  thay vào, \`reason\` một câu ngắn. Sửa nhiều chỗ thì gọi nhiều lần, mỗi lần một khối.
- \`doc_comment\`: bình luận, \`quote\` là đoạn trích được nói tới.
- \`doc_draft_get\`: đọc lại bản nháp mới nhất và các đề xuất, bình luận đang mở (tránh đề xuất trùng).
Xong thì gọi đúng một lần \`doc_assist_submit\` với \`summary\` vài câu cho người viết.

${ACTIONS[input.action]}
${input.prompt ? `\nYêu cầu của người viết: ${input.prompt}\n` : ""}${input.quote ? `\n=== ĐOẠN ĐƯỢC CHỌN ===\n${clip(input.quote)}\n` : ""}
=== BẢN NHÁP ===
${clip(input.content)}
`;
}

/** Máy của người gọi (họ đã đăng ký), để trợ lý chạy bằng gói thuê bao CLI trên chính máy đó. */
export async function assistTargets(tx: Tx, userId: string): Promise<AssistTarget[]> {
  return (await machinesOfUser(tx, userId)).map((m) => ({
    machineId: m.id,
    name: m.name,
    clis: m.clis,
    online: m.online,
    ready: m.capabilities.includes("docassist"),
  }));
}

type RunRow = typeof runs.$inferSelect;

function assistView(
  run: RunRow,
  prompt: { action: AssistAction; prompt: string | null },
  machine: string | null,
  summary: string | null,
  out: { suggestions: number; comments: number } | undefined,
): DocAssist {
  return {
    runId: run.id,
    action: prompt.action,
    cli: run.cli,
    machine,
    state: run.state,
    prompt: prompt.prompt,
    summary,
    suggestions: out?.suggestions ?? 0,
    comments: out?.comments ?? 0,
    createdAt: run.createdAt.toISOString(),
  };
}

export async function listAssists(tx: Tx, userId: string, key: string): Promise<DocAssist[]> {
  // Đọc được tài liệu mới xem được lượt AI trên nó (assistScope kiểm cả quyền sửa: chỉ người soạn mới nhờ AI).
  await draftForAgent(tx, { kind: "user", userId }, key);
  const rows = await tx
    .select({ run: runs, data: runEvents.data })
    .from(runEvents)
    .innerJoin(runs, eq(runs.id, runEvents.runId))
    .where(and(eq(runEvents.type, "docassist_prompt"), sql`${runEvents.data}->>'key' = ${key}`))
    .orderBy(desc(runs.createdAt))
    .limit(30);
  const ids = rows.map((r) => r.run.id);
  const summaries = new Map<string, string>();
  if (ids.length) {
    const evs = await tx
      .select({ runId: runEvents.runId, data: runEvents.data })
      .from(runEvents)
      .where(and(inArray(runEvents.runId, ids), eq(runEvents.type, "docassist_result")))
      .orderBy(runEvents.id);
    for (const e of evs) if (typeof e.data.summary === "string") summaries.set(e.runId, e.data.summary);
  }
  const out = await assistOutput(tx, ids);
  const names = await machineNames(tx, [
    ...new Set(rows.map((r) => r.run.pinnedMachineId).filter((m): m is string => !!m)),
  ]);
  return rows.map((r) =>
    assistView(
      r.run,
      { action: r.data.action as AssistAction, prompt: typeof r.data.request === "string" ? r.data.request : null },
      r.run.pinnedMachineId ? (names.get(r.run.pinnedMachineId) ?? null) : null,
      summaries.get(r.run.id) ?? null,
      out.get(r.run.id),
    ),
  );
}

/**
 * Tạo run docassist ghim vào máy của người gọi. Run cần một dự án (repo để agent đọc code): dự án của tài liệu, không
 * thì dự án hoạt động gần nhất của đội sở hữu máy. Engine giao run sau khi commit.
 */
export async function createAssistRun(
  tx: Tx,
  userId: string,
  raw: AssistStartInput,
): Promise<{ assist: DocAssist; orgId: string }> {
  const input = assistStartInput.parse(raw);
  const scope = await assistScope(tx, { kind: "user", userId }, input.key);
  const ready = (await machinesOfUser(tx, userId)).filter((m) => m.online && m.capabilities.includes("docassist"));
  const machine = input.machineId ? ready.find((m) => m.id === input.machineId) : ready[0];
  if (!machine)
    throw new ConflictError(
      "ASSIST_NO_MACHINE",
      input.machineId
        ? "Máy đã chọn không online hoặc chưa cập nhật app để chạy trợ lý tài liệu."
        : "Chưa có máy nào của bạn online và đủ mới để chạy trợ lý tài liệu. Mở app xDev Hive trên máy của bạn.",
    );
  if (!machine.clis.includes(input.cli))
    throw new BadRequestError("ASSIST_CLI_MISSING", `Máy ${machine.name} chưa cài ${input.cli}.`);
  if (scope.teamId && scope.teamId !== machine.teamId)
    throw new ConflictError("ASSIST_TEAM_MISMATCH", "Máy của bạn thuộc đội khác với đội sở hữu tài liệu.");
  const project = scope.projectId
    ? await loadProject(tx, scope.projectId)
    : await latestActiveProject(tx, machine.teamId);
  if (!projectReady(project))
    throw new ConflictError("ASSIST_NO_PROJECT", "Đội chưa có dự án nào có repo để trợ lý đọc code.");
  const doc = await draftForAgent(tx, { kind: "user", userId }, input.key);
  const [row] = await tx
    .insert(runs)
    .values({
      orgId: sql`hive.ctx_org()`,
      teamId: project.teamId,
      taskId: null,
      projectId: project.id,
      kind: "docassist",
      cli: input.cli,
      model: null,
      branch: `docassist/${input.key}`,
      pinnedMachineId: machine.id,
      policySnapshot: [],
      createdBy: userId,
    })
    .returning();
  if (!row) throw new Error("Không tạo được run trợ lý tài liệu.");
  await hubEvent(tx, row, "state", { from: null, to: "queued", by: "doc-editor" });
  await hubEvent(tx, row, "docassist_prompt", {
    key: input.key,
    action: input.action,
    prompt: docAssistPrompt({ ...doc, ...input }),
    request: input.prompt ?? null,
  });
  await notifyRun(tx, row.id);
  await recordAudit(tx, {
    action: "docassist.run.start",
    actorUserId: userId,
    targetType: "run",
    targetId: row.id,
    data: { key: input.key, action: input.action, machineId: machine.id },
  });
  return {
    assist: assistView(row, { action: input.action, prompt: input.prompt ?? null }, machine.name, null, undefined),
    orgId: row.orgId,
  };
}
