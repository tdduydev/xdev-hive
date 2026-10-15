import { implement } from "@orpc/server";
import {
  contract,
  SDLC_MAX_QUESTIONS,
  type SdlcQuestion,
  sdlcAnswerInput,
  sdlcAskInput,
  sdlcItemRef,
} from "@xdev-hive/contracts";
import { and, asc, eq, inArray, isNull, lt, or, type SQL, sql } from "drizzle-orm";
import type pg from "pg";
import type { z } from "zod";
import { recordAudit } from "../audit/index.ts";
import { loadProject } from "../catalog/index.ts";
import { authUser } from "../identity/index.ts";
import { notify } from "../notify/index.ts";
import {
  BadRequestError,
  ConflictError,
  type Jobs,
  NotFoundError,
  type RequestContext,
  type Tx,
  withTenant,
} from "../platform/index.ts";
import { type OrgDeps, orgMiddlewares } from "../tenancy/index.ts";
import { activeItemProjects, itemForUser, itemViewers, requireProjectWrite, visibleItemsWhere } from "./access.ts";
import { lockItem, type SdlcDeps, type SdlcItemRow } from "./phases.ts";
import { sdlcItemPhases, sdlcItems, sdlcQuestions, sdlcSteps } from "./schema.ts";
import { queueStep } from "./steps.ts";

/*
 * Câu hỏi của agent (D7): run không chờ người; câu hỏi nằm ở hub, người trả lời trên web/app, đủ câu trả lời thì bước
 * soạn chạy lượt mới với câu trả lời trong prompt.
 */

type QuestionRow = typeof sdlcQuestions.$inferSelect;

/** Nhắc câu hỏi chưa trả lời sau 3 ngày (FR-013), mỗi câu tối đa một lần mỗi 3 ngày. */
export const QUESTION_REMIND_MS = 3 * 24 * 3600 * 1000;
export const SDLC_QUESTIONS_QUEUE = "sdlc-questions";
export const SDLC_QUESTIONS_CRON = "17 * * * *";
/** main.ts thêm vào danh sách queue rồi gọi `registerQuestionReminders` (T070). */
export const sdlcQuestionsQueue = {
  name: SDLC_QUESTIONS_QUEUE,
  // Lượt nhắc kế tiếp sẽ quét lại; không cần thử lại nhiều.
  retryLimit: 1,
  expireInSeconds: 10 * 60,
};

const iso = (d: Date) => d.toISOString();
const isoOrNull = (d: Date | null) => (d ? d.toISOString() : null);

async function namesOf(tx: Tx, ids: (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((v): v is string => !!v))];
  if (!wanted.length) return new Map();
  const rows = await tx
    .select({ id: authUser.id, name: authUser.name })
    .from(authUser)
    .where(inArray(authUser.id, wanted));
  return new Map(rows.map((r) => [r.id, r.name]));
}

async function questionViews(
  tx: Tx,
  rows: readonly { q: QuestionRow; item: Pick<SdlcItemRow, "id" | "number" | "title" | "projectId"> }[],
): Promise<SdlcQuestion[]> {
  const names = await namesOf(
    tx,
    rows.map((r) => r.q.answeredBy),
  );
  const keys = new Map<string, string>();
  for (const id of new Set(rows.map((r) => r.item.projectId))) keys.set(id, (await loadProject(tx, id))?.key ?? "");
  return rows.map(({ q, item }) => ({
    id: q.id,
    itemId: item.id,
    item: { ref: sdlcItemRef(item.number), title: item.title, projectKey: keys.get(item.projectId) ?? "" },
    phaseId: q.phaseId,
    round: q.round,
    position: q.position,
    text: q.text,
    options: q.options,
    recommended: q.recommended,
    context: q.context,
    status: q.status,
    answer: q.answer,
    usedRecommended: q.usedRecommended,
    answeredBy: q.answeredBy ? { userId: q.answeredBy, name: names.get(q.answeredBy) ?? q.answeredBy } : null,
    answeredAt: isoOrNull(q.answeredAt),
    createdAt: iso(q.createdAt),
  }));
}

// ---- Agent hỏi -----------------------------------------------------------------------------------------------------

/**
 * `sdlc_ask`: ghi câu hỏi của bước đang chạy. Nhận tối đa `maxQuestions` của bước (≤ 5) câu đầu, báo agent số câu bị
 * bỏ (US2-2). Gọi nhiều lần trong một run thì cộng dồn tới giới hạn.
 */
export async function askQuestions(
  tx: Tx,
  runId: string,
  raw: z.input<typeof sdlcAskInput>,
): Promise<{ ids: string[]; dropped: number; limit: number }> {
  const input = sdlcAskInput.parse(raw);
  const [step] = await tx.select().from(sdlcSteps).where(eq(sdlcSteps.runId, runId)).for("update");
  if (!step || (step.status !== "running" && step.status !== "queued"))
    throw new ConflictError("SDLC_STEP_NOT_RUNNING", "Run không còn phục vụ bước agent nào; câu hỏi không được ghi.");
  const item = await lockItem(tx, step.itemId);
  if (!item) throw new NotFoundError("SDLC_ITEM_NOT_FOUND", "Không tìm thấy hạng mục.");
  const def = item.mode.phases.find((p) => p.id === step.phaseId)?.steps.find((s) => s.id === step.stepId);
  const limit = Math.min(def?.maxQuestions ?? SDLC_MAX_QUESTIONS, SDLC_MAX_QUESTIONS);
  const asked = await tx
    .select({ position: sdlcQuestions.position })
    .from(sdlcQuestions)
    .where(eq(sdlcQuestions.runId, runId));
  const room = Math.max(0, limit - asked.length);
  const kept = input.questions.slice(0, room);
  const ids: string[] = [];
  for (const [i, q] of kept.entries()) {
    const [row] = await tx
      .insert(sdlcQuestions)
      .values({
        orgId: item.orgId,
        itemId: item.id,
        phaseId: step.phaseId,
        stepId: step.id,
        runId,
        round: step.round,
        position: asked.length + i + 1,
        text: q.text,
        options: q.options,
        recommended: q.recommended ?? null,
        context: q.context ?? null,
      })
      .returning({ id: sdlcQuestions.id });
    if (row) ids.push(row.id);
  }
  return { ids, dropped: input.questions.length - kept.length, limit };
}

// ---- Danh sách -----------------------------------------------------------------------------------------------------

export interface QuestionListInput {
  scope: "mine" | "all";
  projectId?: string | undefined;
  itemId?: string | undefined;
  openOnly: boolean;
  limit: number;
  cursor?: string | undefined;
}

const mineWhere = (userId: string) => or(eq(sdlcItems.ownerUserId, userId), eq(sdlcItems.createdBy, userId)) as SQL;
const projectWhere = (projectId: string) =>
  or(
    eq(sdlcItems.projectId, projectId),
    sql`exists (select 1 from hive.sdlc_item_projects p where p.item_id = ${sdlcItems.id} and p.project_id = ${projectId} and p.removed_at is null)`,
  ) as SQL;

/**
 * Con trỏ là id câu cuối trang; database tự lấy (`createdAt`, `position`, id) của câu đó để so, vì `createdAt` có
 * micro giây mà Date của JS chỉ giữ mili giây. Câu của cùng một lượt hỏi có cùng `createdAt` (một transaction) nên xếp
 * tiếp theo thứ tự agent hỏi; câu mới hỏi thêm không làm lệch trang đang xem.
 */
function parseCursor(cursor: string | undefined): string | null {
  if (!cursor) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cursor))
    throw new BadRequestError("BAD_CURSOR", "Con trỏ trang không hợp lệ.");
  return cursor;
}

/** Câu hỏi người đọc thấy (D22: qua `visibleItemsWhere`); `mine` là hạng mục mình là chủ hoặc người tạo. */
export async function listQuestions(
  tx: Tx,
  userId: string,
  input: QuestionListInput,
): Promise<{ items: SdlcQuestion[]; nextCursor: string | null }> {
  const after = parseCursor(input.cursor);
  const where = [
    await visibleItemsWhere(tx, userId),
    ...(input.scope === "mine" ? [mineWhere(userId)] : []),
    ...(input.projectId ? [projectWhere(input.projectId)] : []),
    ...(input.itemId ? [eq(sdlcItems.id, input.itemId)] : []),
    ...(input.openOnly ? [eq(sdlcQuestions.status, "open"), inArray(sdlcItems.status, ["active", "paused"])] : []),
    ...(after
      ? [
          sql`(${sdlcQuestions.createdAt}, ${sdlcQuestions.position}, ${sdlcQuestions.id}) > (select q.created_at, q.position, q.id from hive.sdlc_questions q where q.id = ${after}::uuid)`,
        ]
      : []),
  ];
  const rows = await tx
    .select({ q: sdlcQuestions, item: sdlcItems })
    .from(sdlcQuestions)
    .innerJoin(sdlcItems, eq(sdlcItems.id, sdlcQuestions.itemId))
    .where(and(...where))
    .orderBy(asc(sdlcQuestions.createdAt), asc(sdlcQuestions.position), asc(sdlcQuestions.id))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const last = page.at(-1);
  return {
    items: await questionViews(tx, page),
    nextCursor: rows.length > input.limit && last ? last.q.id : null,
  };
}

/** Badge "Câu hỏi chờ tôi". */
export async function countQuestions(tx: Tx, userId: string): Promise<{ open: number }> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(sdlcQuestions)
    .innerJoin(sdlcItems, eq(sdlcItems.id, sdlcQuestions.itemId))
    .where(
      and(
        await visibleItemsWhere(tx, userId),
        mineWhere(userId),
        eq(sdlcQuestions.status, "open"),
        inArray(sdlcItems.status, ["active", "paused"]),
      ),
    );
  return { open: row?.n ?? 0 };
}

// ---- Trả lời -------------------------------------------------------------------------------------------------------

/**
 * Trả lời (hoặc "Dùng đề xuất") một lần nhiều câu của một hạng mục. Câu cuối của giai đoạn được trả lời thì bước đã hỏi
 * chạy lượt mới (bước `auto`) hoặc giai đoạn về soạn để người bấm chạy lại.
 */
export async function answerQuestions(
  tx: Tx,
  userId: string,
  raw: z.input<typeof sdlcAnswerInput>,
  deps: SdlcDeps = {},
): Promise<SdlcQuestion[]> {
  const input = sdlcAnswerInput.parse(raw);
  const item = await itemForUser(tx, userId, input.itemId, true);
  await requireProjectWrite(
    tx,
    userId,
    (await activeItemProjects(tx, item.id)).map((m) => m.projectId),
  );
  if (item.status === "done" || item.status === "cancelled")
    throw new ConflictError("SDLC_ITEM_CLOSED", "Hạng mục đã đóng, không trả lời được nữa.");
  const ids = input.answers.map((a) => a.id);
  const rows = await tx
    .select()
    .from(sdlcQuestions)
    .where(and(eq(sdlcQuestions.itemId, item.id), inArray(sdlcQuestions.id, ids)))
    .for("update");
  const touchedPhases = new Set<string>();
  for (const a of input.answers) {
    const q = rows.find((r) => r.id === a.id);
    if (!q) throw new NotFoundError("SDLC_QUESTION_NOT_FOUND", "Không tìm thấy câu hỏi trong hạng mục này.");
    if (q.status !== "open")
      throw new ConflictError("SDLC_QUESTION_CLOSED", `Câu hỏi “${q.text.slice(0, 80)}” đã được trả lời.`);
    if (a.useRecommended && !q.recommended)
      throw new BadRequestError("SDLC_NO_RECOMMENDATION", `Câu hỏi “${q.text.slice(0, 80)}” không có đề xuất để dùng.`);
    await tx
      .update(sdlcQuestions)
      .set({
        answer: a.useRecommended ? q.recommended : (a.answer ?? null),
        usedRecommended: !!a.useRecommended,
        answeredBy: userId,
        answeredAt: sql`now()`,
        status: "answered",
      })
      .where(eq(sdlcQuestions.id, q.id));
    touchedPhases.add(q.phaseId);
  }
  await recordAudit(tx, {
    action: "sdlc.question.answer",
    targetType: "sdlc_item",
    targetId: item.id,
    data: { questions: ids, recommended: input.answers.filter((a) => a.useRecommended).map((a) => a.id) },
  });
  for (const phaseId of touchedPhases) await redraftWhenAnswered(tx, item, phaseId, userId, deps);

  const updated = await tx
    .select()
    .from(sdlcQuestions)
    .where(inArray(sdlcQuestions.id, ids))
    .orderBy(asc(sdlcQuestions.round), asc(sdlcQuestions.position));
  return questionViews(
    tx,
    updated.map((q) => ({ q, item })),
  );
}

/** Đủ câu trả lời của giai đoạn đang chờ: chạy lại bước đã hỏi với câu trả lời (vòng 2), như clarify của Spec Kit. */
async function redraftWhenAnswered(
  tx: Tx,
  item: SdlcItemRow,
  phaseId: string,
  userId: string,
  deps: SdlcDeps,
): Promise<void> {
  const [open] = await tx
    .select({ id: sdlcQuestions.id })
    .from(sdlcQuestions)
    .where(and(eq(sdlcQuestions.itemId, item.id), eq(sdlcQuestions.phaseId, phaseId), eq(sdlcQuestions.status, "open")))
    .limit(1);
  if (open) return;
  const [phaseRow] = await tx
    .select()
    .from(sdlcItemPhases)
    .where(and(eq(sdlcItemPhases.itemId, item.id), eq(sdlcItemPhases.phaseId, phaseId)));
  if (phaseRow?.status !== "awaiting_answers") return;
  const phase = item.mode.phases.find((p) => p.id === phaseId);
  // Bước đã hỏi: câu hỏi mới nhất của giai đoạn trỏ về dòng bước của run đó.
  const [last] = await tx
    .select({ stepRowId: sdlcQuestions.stepId })
    .from(sdlcQuestions)
    .where(and(eq(sdlcQuestions.itemId, item.id), eq(sdlcQuestions.phaseId, phaseId)))
    .orderBy(sql`${sdlcQuestions.createdAt} desc`)
    .limit(1);
  const [asked] = last?.stepRowId ? await tx.select().from(sdlcSteps).where(eq(sdlcSteps.id, last.stepRowId)) : [];
  const step = phase?.steps.find((s) => s.id === asked?.stepId);
  if (!phase || !step?.auto || item.status !== "active") {
    await tx.update(sdlcItemPhases).set({ status: "drafting" }).where(eq(sdlcItemPhases.id, phaseRow.id));
    return;
  }
  await queueStep(
    tx,
    item,
    phase,
    step,
    { createdBy: userId, requestedBy: userId, instructions: asked?.instructions ?? null },
    deps,
  );
}

// ---- Nhắc hạn ------------------------------------------------------------------------------------------------------

export interface QuestionReminderDeps {
  pool: pg.Pool;
  jobs?: Jobs | undefined;
  publicUrl?: string | undefined;
}

/**
 * Nhắc chủ hạng mục câu hỏi chờ quá 3 ngày (cron mỗi giờ). `hive.sdlc_active_orgs()` (SECURITY DEFINER) chỉ trả id tổ
 * chức có hạng mục đang chạy; phần còn lại chạy trong tổ chức đó. Trả số hạng mục đã nhắc.
 */
export async function remindOpenQuestions(deps: QuestionReminderDeps, now = new Date()): Promise<number> {
  const orgs = await withTenant(deps.pool, {}, async (tx) => {
    const { rows } = await tx.execute<{ org_id: string }>(sql`select org_id from hive.sdlc_active_orgs()`);
    return rows.map((r) => r.org_id);
  });
  const due = new Date(now.getTime() - QUESTION_REMIND_MS);
  let reminded = 0;
  for (const orgId of orgs) {
    reminded += await withTenant(deps.pool, { orgId }, async (tx) => {
      const rows = await tx
        .select({ q: sdlcQuestions, item: sdlcItems })
        .from(sdlcQuestions)
        .innerJoin(sdlcItems, eq(sdlcItems.id, sdlcQuestions.itemId))
        .where(
          and(
            eq(sdlcQuestions.status, "open"),
            eq(sdlcItems.status, "active"),
            lt(sdlcQuestions.createdAt, due),
            or(isNull(sdlcQuestions.remindedAt), lt(sdlcQuestions.remindedAt, due)),
          ),
        );
      const byItem = new Map<string, { item: SdlcItemRow; ids: string[] }>();
      for (const { q, item } of rows) {
        const entry = byItem.get(item.id) ?? { item, ids: [] };
        entry.ids.push(q.id);
        byItem.set(item.id, entry);
      }
      for (const { item, ids } of byItem.values()) {
        const home = await loadProject(tx, item.projectId);
        const ref = sdlcItemRef(item.number);
        const recipientIds = await itemViewers(tx, item, [item.ownerUserId, item.createdBy]);
        if (recipientIds.length)
          await notify(
            tx,
            {
              orgId,
              event: "sdlc.question",
              title: `${ids.length} câu hỏi của hạng mục ${ref} chờ quá 3 ngày`,
              body: `${item.title}: agent chưa soạn tiếp được tới khi có câu trả lời.`,
              eventKey: `sdlc.question.remind:${item.id}:${now.toISOString().slice(0, 10)}`,
              recipientIds,
              link: deps.publicUrl && home ? `${deps.publicUrl.replace(/\/+$/, "")}/sdlc/${home.key}/${ref}` : null,
            },
            { jobs: deps.jobs },
          );
        // Đánh dấu kể cả khi không có người nhận để không quét lại mỗi giờ.
        await tx.update(sdlcQuestions).set({ remindedAt: now }).where(inArray(sdlcQuestions.id, ids));
      }
      return byItem.size;
    });
  }
  return reminded;
}

export async function registerQuestionReminders(jobs: Jobs, deps: QuestionReminderDeps): Promise<void> {
  const full = { ...deps, jobs };
  await jobs.work(SDLC_QUESTIONS_QUEUE, async () => void (await remindOpenQuestions(full)));
  await jobs.schedule(SDLC_QUESTIONS_QUEUE, SDLC_QUESTIONS_CRON);
}

/** Route `questions.*`; T070 gộp vào router của module. */
export function questionRoutes(deps: OrgDeps & SdlcDeps) {
  const { authed, inOrg } = orgMiddlewares(deps);
  const os = implement(contract.sdlc.questions).$context<RequestContext>().use(authed).use(inOrg);
  return {
    questions: {
      list: os.list.handler(({ context: { tx, user }, input }) => listQuestions(tx, user.id, input)),
      count: os.count.handler(({ context: { tx, user } }) => countQuestions(tx, user.id)),
      answer: os.answer.handler(({ context: { tx, user }, input }) => answerQuestions(tx, user.id, input, deps)),
    },
  };
}
