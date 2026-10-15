import {
  applySuggestion,
  type CommentAddInput,
  commentAddInput,
  type DocActor,
  type DocDraft,
  type DocEditorState,
  type DocSnapshot,
  type DocSnapshotDetail,
  type DocSuggestion,
  type DocThread,
  type DraftSaveInput,
  docKey,
  draftSaveInput,
  type EditorStage,
  type EditorStepState,
  mergeBlocks,
  occurrences,
  type PresenceEntry,
  type ReviewGate,
  type SubmitInput,
  type SubmitPreview,
  type SuggestionCreateInput,
  type SuggestionStatus,
  snapshotCreateInput,
  submitInput,
  suggestionCreateInput,
  suggestionDecideInput,
  threadResolveInput,
} from "@xdev-hive/contracts";
import { and, asc, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { authUser } from "../identity/index.ts";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError, type Tx } from "../platform/index.ts";
import {
  audit,
  authorColumns,
  authorize,
  iso,
  type Principal,
  type Reader,
  readerFor,
  type Scope,
  scopeView,
} from "./access.ts";
import { docScope } from "./docs.ts";
import { diffCounts, docTypeOf, flatGates, gateApplies } from "./review-rules.ts";
import { DERIVED_WORKFLOW_ID, proposeWithReview, type ReviewDeps, resolveWorkflow } from "./reviews.ts";
import {
  docComments,
  docDrafts,
  docPresence,
  docSnapshots,
  docSuggestions,
  docs,
  docThreads,
  docVersions,
  proposals,
  reviewGateRuns,
  reviewInstances,
} from "./schema.ts";

type DraftRow = typeof docDrafts.$inferSelect;
type SuggestionRow = typeof docSuggestions.$inferSelect;
type ThreadRow = typeof docThreads.$inferSelect;
type SnapshotRow = typeof docSnapshots.$inferSelect;

/** Coi là đang mở (hay đang sửa) khi có tín hiệu trong khoảng này. */
const PRESENCE_MS = 60_000;

const draftChanged = () =>
  new ConflictError("DRAFT_CHANGED", "Bản nháp vừa được người khác lưu. Tải bản mới, gộp thay đổi rồi lưu lại.");
const readOnly = () =>
  new ForbiddenError("DOC_EDIT_FORBIDDEN", "Bạn chỉ được đọc và bình luận tài liệu này (cần là thành viên đội).");

// ---- Người viết --------------------------------------------------------------------------------------------------

/** Tên người dùng theo id, một lần cho cả danh sách. */
async function namesOf(tx: Tx, ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((i): i is string => !!i))];
  if (!unique.length) return new Map();
  const rows = await tx
    .select({ id: authUser.id, name: authUser.name })
    .from(authUser)
    .where(inArray(authUser.id, unique));
  return new Map(rows.map((r) => [r.id, r.name]));
}

function actor(names: Map<string, string>, userId: string | null, runId: string | null): DocActor {
  if (userId) return { userId, runId: null, name: names.get(userId) ?? userId };
  return { userId: null, runId, name: "Trợ lý AI" };
}

// ---- Bản nháp ----------------------------------------------------------------------------------------------------

interface DocContext {
  reader: Reader;
  scope: Scope;
  /** Phiên bản đã duyệt mới nhất (0 khi tài liệu chưa có) và nội dung của nó. */
  latest: { version: number; title: string | null; content: string };
  draft: DraftRow | null;
}

async function approvedAt(tx: Tx, key: string, version: number): Promise<string> {
  if (version <= 0) return "";
  const [row] = await tx
    .select({ content: docVersions.content })
    .from(docVersions)
    .innerJoin(docs, eq(docs.id, docVersions.docId))
    .where(and(eq(docs.key, key), eq(docVersions.version, version)));
  return row?.content ?? "";
}

/**
 * Tài liệu theo key cho trình soạn: kiểm người gọi đọc được (tài liệu chưa có thì theo phạm vi suy từ key), kèm bản
 * đã duyệt mới nhất và bản nháp. `lock` khoá dòng nháp tới hết transaction cho thao tác ghi.
 */
async function docContext(tx: Tx, principal: Principal, key: string, lock = false): Promise<DocContext> {
  const reader = await readerFor(tx, principal);
  const scope = await docScope(tx, reader, key);
  const [doc] = await tx.select().from(docs).where(eq(docs.key, key));
  const version = doc?.currentVersion ?? 0;
  const q = tx.select().from(docDrafts).where(eq(docDrafts.key, key));
  const [draft] = lock ? await q.for("update") : await q;
  return {
    reader,
    scope,
    latest: { version, title: doc?.title ?? null, content: await approvedAt(tx, key, version) },
    draft: draft ?? null,
  };
}

async function canEdit(tx: Tx, ctx: DocContext): Promise<boolean> {
  if (ctx.reader.kind === "run") return false;
  try {
    await authorize(tx, ctx.reader, ctx.scope, "propose");
    return true;
  } catch (e) {
    if (e instanceof ForbiddenError) return false;
    throw e;
  }
}

async function requireEdit(tx: Tx, ctx: DocContext): Promise<void> {
  if (!(await canEdit(tx, ctx))) throw readOnly();
}

/** Nội dung đang soạn: bản nháp nếu có, không thì bản đã duyệt mới nhất. */
const draftContent = (ctx: DocContext) => ctx.draft?.content ?? ctx.latest.content;

async function draftView(tx: Tx, key: string, ctx: DocContext, edit: boolean): Promise<DocDraft> {
  const d = ctx.draft;
  const names = await namesOf(tx, [d?.updatedByUserId]);
  return {
    key,
    title: d?.title ?? ctx.latest.title ?? docTypeOf(key),
    content: draftContent(ctx),
    scope: scopeView(ctx.scope),
    baseVersion: d?.baseVersion ?? ctx.latest.version,
    latestVersion: ctx.latest.version,
    revision: d?.revision ?? 0,
    updatedAt: d ? iso(d.updatedAt) : null,
    updatedBy: d ? actor(names, d.updatedByUserId, d.updatedByRunId) : null,
    canEdit: edit,
  };
}

/**
 * Ghi bản nháp với khoá lạc quan theo `revision`: 0 là chưa có bản nháp (tạo mới từ bản đã duyệt), khác 0 phải đúng
 * revision đang lưu. Không kiểm quyền.
 */
async function writeDraft(
  tx: Tx,
  principal: Principal,
  key: string,
  ctx: DocContext,
  change: { title?: string | undefined; content: string; baseVersion?: number; revision: number },
): Promise<DraftRow> {
  const by = authorColumns(principal);
  if (!ctx.draft) {
    if (change.revision !== 0) throw draftChanged();
    const [row] = await tx
      .insert(docDrafts)
      .values({
        orgId: sql`hive.ctx_org()`,
        teamId: ctx.scope.teamId,
        projectId: ctx.scope.projectId,
        key,
        title: change.title ?? ctx.latest.title ?? docTypeOf(key),
        content: change.content,
        baseVersion: change.baseVersion ?? ctx.latest.version,
        updatedByUserId: by.authorUserId,
        updatedByRunId: by.authorRunId,
      })
      // Hai người cùng lưu bản nháp đầu tiên: người sau nhận xung đột như mọi lần lưu lệch revision.
      .onConflictDoNothing()
      .returning();
    if (!row) throw draftChanged();
    return row;
  }
  if (change.revision !== ctx.draft.revision) throw draftChanged();
  const [row] = await tx
    .update(docDrafts)
    .set({
      ...(change.title ? { title: change.title } : {}),
      content: change.content,
      ...(change.baseVersion !== undefined ? { baseVersion: change.baseVersion } : {}),
      revision: sql`${docDrafts.revision} + 1`,
      updatedByUserId: by.authorUserId,
      updatedByRunId: by.authorRunId,
      updatedAt: new Date(),
    })
    .where(and(eq(docDrafts.id, ctx.draft.id), eq(docDrafts.revision, change.revision)))
    .returning();
  if (!row) throw draftChanged();
  return row;
}

async function touchPresence(tx: Tx, principal: Principal, key: string, edited: boolean): Promise<void> {
  if (principal.kind !== "user") return;
  const now = new Date();
  await tx
    .insert(docPresence)
    .values({ orgId: sql`hive.ctx_org()`, key, userId: principal.userId, seenAt: now, editedAt: edited ? now : null })
    .onConflictDoUpdate({
      target: [docPresence.orgId, docPresence.key, docPresence.userId],
      set: { seenAt: now, ...(edited ? { editedAt: now } : {}) },
    });
}

export async function saveDraft(tx: Tx, principal: Principal, raw: DraftSaveInput): Promise<DocDraft> {
  const input = draftSaveInput.parse(raw);
  const ctx = await docContext(tx, principal, input.key, true);
  await requireEdit(tx, ctx);
  const row = await writeDraft(tx, principal, input.key, ctx, input);
  await touchPresence(tx, principal, input.key, true);
  return draftView(tx, input.key, { ...ctx, draft: row }, true);
}

/**
 * Bản nháp do run AI SDLC soạn (specs/011 FR-014): hub chép file agent trả về vào bản nháp dưới tên run. Không có tool
 * MCP nào gọi tới đây (agent chỉ đề xuất qua `doc_suggest`); module `sdlc` gọi sau khi đã đối chiếu run với bước của
 * hạng mục. Run chỉ thấy tài liệu thuộc dự án của nó (`docScope`).
 */
export async function saveRunDraft(
  tx: Tx,
  principal: Principal & { kind: "run" },
  raw: DraftSaveInput,
): Promise<DocDraft> {
  const input = draftSaveInput.parse(raw);
  const ctx = await docContext(tx, principal, input.key, true);
  const row = await writeDraft(tx, principal, input.key, ctx, input);
  return draftView(tx, input.key, { ...ctx, draft: row }, false);
}

/** Gộp bản đã duyệt mới nhất vào bản nháp theo khối; chỗ hai bên cùng sửa thì giữ bản nháp và đếm xung đột. */
export async function rebaseDraft(
  tx: Tx,
  principal: Principal,
  raw: { key: string; revision: number },
): Promise<{ draft: DocDraft; conflicts: number }> {
  const key = docKey.parse(raw.key);
  const ctx = await docContext(tx, principal, key, true);
  await requireEdit(tx, ctx);
  if (!ctx.draft || ctx.draft.baseVersion === ctx.latest.version) {
    if ((ctx.draft?.revision ?? 0) !== raw.revision) throw draftChanged();
    return { draft: await draftView(tx, key, ctx, true), conflicts: 0 };
  }
  const base = await approvedAt(tx, key, ctx.draft.baseVersion);
  const merged = mergeBlocks(base, ctx.draft.content, ctx.latest.content);
  const row = await writeDraft(tx, principal, key, ctx, {
    content: merged.content,
    baseVersion: ctx.latest.version,
    revision: raw.revision,
  });
  await audit(
    tx,
    principal,
    "doc.draft.rebase",
    { type: "doc_draft", id: row.id },
    { key, conflicts: merged.conflicts },
  );
  return { draft: await draftView(tx, key, { ...ctx, draft: row }, true), conflicts: merged.conflicts };
}

// ---- Trạng thái trình soạn -----------------------------------------------------------------------------------------

type Submission = {
  snapshot: SnapshotRow;
  proposal: { id: string; status: string; decisionNote: string | null };
  instance: typeof reviewInstances.$inferSelect | null;
};

/** Bản chụp đã gửi duyệt kèm đề xuất và phiên duyệt của nó, mới nhất trước. */
async function submissions(tx: Tx, key: string, limit?: number): Promise<Submission[]> {
  const q = tx
    .select({ snapshot: docSnapshots, proposal: proposals, instance: reviewInstances })
    .from(docSnapshots)
    .innerJoin(proposals, eq(proposals.id, docSnapshots.proposalId))
    .leftJoin(reviewInstances, eq(reviewInstances.proposalId, proposals.id))
    .where(eq(docSnapshots.key, key))
    .orderBy(desc(docSnapshots.number));
  const rows = limit ? await q.limit(limit) : await q;
  return rows.map((r) => ({
    snapshot: r.snapshot,
    proposal: { id: r.proposal.id, status: r.proposal.status, decisionNote: r.proposal.decisionNote },
    instance: r.instance,
  }));
}

/** Trạng thái của lần gửi: theo phiên duyệt nếu có quy trình, không thì theo đề xuất (quản trị duyệt tay). */
function submissionStatus(s: Submission) {
  if (s.instance) return s.instance.status as "in_review" | "changes_requested" | "approved" | "cancelled";
  return s.proposal.status as "pending" | "approved" | "rejected";
}

function stageOf(s: Submission | undefined, draft: DraftRow | null): EditorStage {
  if (!s) return "drafting";
  const status = submissionStatus(s);
  if (status === "in_review" || status === "pending") return "in_review";
  if (status === "changes_requested" || status === "rejected") return "changes_requested";
  // Đã duyệt mà bản nháp sửa tiếp sau đó: đang soạn bản kế.
  if (status === "approved") return draft && draft.updatedAt > s.snapshot.createdAt ? "drafting" : "approved";
  return "drafting";
}

async function stepStates(tx: Tx, inst: typeof reviewInstances.$inferSelect | null, count: number) {
  const states: EditorStepState[] = Array.from({ length: count }, () => "todo");
  if (!inst) return states;
  const runs = await tx
    .select({ gateIndex: reviewGateRuns.gateIndex, status: reviewGateRuns.status })
    .from(reviewGateRuns)
    .where(eq(reviewGateRuns.instanceId, inst.id))
    .orderBy(asc(reviewGateRuns.startedAt));
  // Lần chạy sau cùng của mỗi gate quyết định trạng thái (gate có thể chạy lại khi bị trả về).
  const last = new Map(runs.map((r) => [r.gateIndex, r.status]));
  for (let i = 0; i < count; i++) {
    const s = last.get(i);
    if (inst.status === "approved") states[i] = s === "skipped" ? "skipped" : "done";
    else if (i < inst.gateIndex) states[i] = s === "skipped" ? "skipped" : s === "failed" ? "failed" : "done";
    else if (i === inst.gateIndex)
      states[i] = inst.status === "in_review" ? "current" : inst.status === "changes_requested" ? "failed" : "todo";
  }
  return states;
}

export async function editorState(tx: Tx, principal: Principal, raw: { key: string }): Promise<DocEditorState> {
  const key = docKey.parse(raw.key);
  const ctx = await docContext(tx, principal, key);
  const edit = await canEdit(tx, ctx);
  await touchPresence(tx, principal, key, false);
  const since = new Date(Date.now() - PRESENCE_MS);
  const present = await tx
    .select()
    .from(docPresence)
    .where(and(eq(docPresence.key, key), gt(docPresence.seenAt, since)))
    .orderBy(desc(docPresence.seenAt));
  const names = await namesOf(
    tx,
    present.map((p) => p.userId),
  );
  const presence: PresenceEntry[] = present.map((p) => ({
    userId: p.userId,
    name: names.get(p.userId) ?? p.userId,
    editing: !!p.editedAt && p.editedAt > since,
    seenAt: iso(p.seenAt),
  }));

  const [last] = await submissions(tx, key, 1);
  const [{ n: submitted = 0 } = {}] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(docSnapshots)
    .where(and(eq(docSnapshots.key, key), sql`${docSnapshots.proposalId} is not null`));
  let workflow: DocEditorState["workflow"] = null;
  if (last?.instance) {
    const flat = flatGates(last.instance.phases);
    const states = await stepStates(tx, last.instance, flat.length);
    workflow = {
      id: last.instance.workflowId ?? last.instance.id,
      name: last.instance.workflowName,
      steps: flat.map((f, i) => ({
        gateId: f.gate.id,
        name: f.gate.name,
        kind: f.gate.kind,
        phase: f.phase,
        state: states[i] ?? "todo",
      })),
    };
  } else {
    const wf = await resolveWorkflow(tx, key, ctx.scope);
    if (wf)
      workflow = {
        id: wf.id ?? DERIVED_WORKFLOW_ID,
        name: wf.name,
        steps: flatGates(wf.phases).map((f) => ({
          gateId: f.gate.id,
          name: f.gate.name,
          kind: f.gate.kind,
          phase: f.phase,
          state: "todo" as const,
        })),
      };
  }
  const [{ open = 0 } = {}] = await tx
    .select({ open: sql<number>`count(*)::int` })
    .from(docThreads)
    .where(and(eq(docThreads.key, key), isNull(docThreads.resolvedAt)));
  const [{ pending = 0 } = {}] = await tx
    .select({ pending: sql<number>`count(*)::int` })
    .from(docSuggestions)
    .where(and(eq(docSuggestions.key, key), eq(docSuggestions.status, "pending")));
  return {
    draft: await draftView(tx, key, ctx, edit),
    presence,
    workflow,
    review: last
      ? {
          id: last.instance?.id ?? null,
          proposalId: last.proposal.id,
          status: submissionStatus(last),
          snapshot: last.snapshot.number,
          note: last.proposal.decisionNote ?? last.snapshot.note,
        }
      : null,
    stage: stageOf(last, ctx.draft),
    draftNumber: submitted + 1,
    openComments: open,
    pendingSuggestions: pending,
  };
}

// ---- Đề xuất sửa -------------------------------------------------------------------------------------------------

function suggestionView(s: SuggestionRow, content: string, names: Map<string, string>): DocSuggestion {
  return {
    id: s.id,
    key: s.key,
    before: s.before,
    after: s.after,
    reason: s.reason,
    author: actor(names, s.authorUserId, s.authorRunId),
    status: s.status as SuggestionStatus,
    stale: s.status === "pending" && !!s.before && occurrences(content, s.before) !== 1,
    createdAt: iso(s.createdAt),
    decidedBy: s.decidedBy ? actor(names, s.decidedBy, null) : null,
    decidedAt: s.decidedAt ? iso(s.decidedAt) : null,
  };
}

export async function listSuggestions(
  tx: Tx,
  principal: Principal,
  raw: { key: string; status?: SuggestionStatus | undefined },
): Promise<DocSuggestion[]> {
  const key = docKey.parse(raw.key);
  const ctx = await docContext(tx, principal, key);
  const rows = await tx
    .select()
    .from(docSuggestions)
    .where(and(eq(docSuggestions.key, key), raw.status ? eq(docSuggestions.status, raw.status) : undefined))
    .orderBy(asc(docSuggestions.createdAt));
  const names = await namesOf(
    tx,
    rows.flatMap((r) => [r.authorUserId, r.decidedBy]),
  );
  const content = draftContent(ctx);
  return rows.map((r) => suggestionView(r, content, names));
}

/** Đề xuất sửa một đoạn: người (thành viên đội) hoặc agent (MCP). Đoạn gốc phải có đúng một chỗ trong bản nháp. */
export async function createSuggestion(
  tx: Tx,
  principal: Principal,
  raw: SuggestionCreateInput,
): Promise<DocSuggestion> {
  const input = suggestionCreateInput.parse(raw);
  const ctx = await docContext(tx, principal, input.key);
  if (ctx.reader.kind === "user") await requireEdit(tx, ctx);
  else await authorize(tx, ctx.reader, ctx.scope, "propose");
  const content = draftContent(ctx);
  if (input.before && occurrences(content, input.before) !== 1)
    throw new BadRequestError(
      "SUGGESTION_ANCHOR",
      "Đoạn gốc phải có đúng một chỗ trong bản nháp. Chép nguyên văn đoạn cần sửa, đủ dài để không trùng chỗ khác.",
    );
  const [row] = await tx
    .insert(docSuggestions)
    .values({
      orgId: sql`hive.ctx_org()`,
      teamId: ctx.scope.teamId,
      projectId: ctx.scope.projectId,
      key: input.key,
      before: input.before,
      after: input.after,
      reason: input.reason || null,
      ...authorColumns(principal),
    })
    .returning();
  if (!row) throw new Error("Không ghi được đề xuất sửa.");
  return suggestionView(row, content, await namesOf(tx, [row.authorUserId]));
}

export async function decideSuggestion(
  tx: Tx,
  principal: Principal,
  raw: { id: string; accept: boolean },
): Promise<{ suggestion: DocSuggestion; draft: DocDraft }> {
  const input = suggestionDecideInput.parse(raw);
  const [s] = await tx.select().from(docSuggestions).where(eq(docSuggestions.id, input.id)).for("update");
  if (!s) throw new NotFoundError("SUGGESTION_NOT_FOUND", "Không tìm thấy đề xuất sửa.");
  let ctx = await docContext(tx, principal, s.key, true);
  await requireEdit(tx, ctx);
  if (s.status !== "pending") throw new ConflictError("SUGGESTION_DECIDED", "Đề xuất này đã được nhận hoặc bỏ.");
  if (input.accept) {
    const next = applySuggestion(draftContent(ctx), s.before, s.after);
    if (next === null)
      throw new ConflictError(
        "SUGGESTION_STALE",
        "Đoạn gốc của đề xuất không còn trong bản nháp; không nhận được nữa.",
      );
    const row = await writeDraft(tx, principal, s.key, ctx, { content: next, revision: ctx.draft?.revision ?? 0 });
    ctx = { ...ctx, draft: row };
    await touchPresence(tx, principal, s.key, true);
  }
  const userId = principal.kind === "user" ? principal.userId : null;
  const [row] = await tx
    .update(docSuggestions)
    .set({ status: input.accept ? "accepted" : "rejected", decidedBy: userId, decidedAt: new Date() })
    .where(eq(docSuggestions.id, s.id))
    .returning();
  if (!row) throw new Error("Không cập nhật được đề xuất sửa.");
  const names = await namesOf(tx, [row.authorUserId, row.decidedBy]);
  return { suggestion: suggestionView(row, draftContent(ctx), names), draft: await draftView(tx, s.key, ctx, true) };
}

// ---- Bình luận ---------------------------------------------------------------------------------------------------

async function threadViews(tx: Tx, threads: ThreadRow[], content: string): Promise<DocThread[]> {
  if (!threads.length) return [];
  const comments = await tx
    .select()
    .from(docComments)
    .where(
      inArray(
        docComments.threadId,
        threads.map((t) => t.id),
      ),
    )
    .orderBy(asc(docComments.createdAt));
  const names = await namesOf(tx, [...comments.map((c) => c.authorUserId), ...threads.map((t) => t.resolvedByUserId)]);
  return threads.map((t) => ({
    id: t.id,
    key: t.key,
    quote: t.quote,
    anchored: t.quote === null || content.includes(t.quote),
    comments: comments
      .filter((c) => c.threadId === t.id)
      .map((c) => ({
        id: c.id,
        author: actor(names, c.authorUserId, c.authorRunId),
        body: c.body,
        createdAt: iso(c.createdAt),
      })),
    resolvedAt: t.resolvedAt ? iso(t.resolvedAt) : null,
    resolvedBy: t.resolvedAt ? actor(names, t.resolvedByUserId, t.resolvedByRunId) : null,
  }));
}

export async function listThreads(tx: Tx, principal: Principal, raw: { key: string }): Promise<DocThread[]> {
  const key = docKey.parse(raw.key);
  const ctx = await docContext(tx, principal, key);
  const threads = await tx.select().from(docThreads).where(eq(docThreads.key, key)).orderBy(asc(docThreads.createdAt));
  return threadViews(tx, threads, draftContent(ctx));
}

/** Ai đọc được tài liệu cũng bình luận được: người duyệt ngoài đội vẫn góp ý trên bản nháp. */
export async function addComment(tx: Tx, principal: Principal, raw: CommentAddInput): Promise<DocThread> {
  const input = commentAddInput.parse(raw);
  const ctx = await docContext(tx, principal, input.key);
  let thread: ThreadRow | undefined;
  if (input.threadId) {
    [thread] = await tx
      .select()
      .from(docThreads)
      .where(and(eq(docThreads.id, input.threadId), eq(docThreads.key, input.key)));
    if (!thread) throw new NotFoundError("THREAD_NOT_FOUND", "Không tìm thấy luồng bình luận.");
    await tx.update(docThreads).set({ updatedAt: new Date() }).where(eq(docThreads.id, thread.id));
  } else {
    [thread] = await tx
      .insert(docThreads)
      .values({
        orgId: sql`hive.ctx_org()`,
        teamId: ctx.scope.teamId,
        projectId: ctx.scope.projectId,
        key: input.key,
        quote: input.quote ?? null,
      })
      .returning();
    if (!thread) throw new Error("Không tạo được luồng bình luận.");
  }
  await tx
    .insert(docComments)
    .values({ orgId: sql`hive.ctx_org()`, threadId: thread.id, body: input.body, ...authorColumns(principal) });
  const [view] = await threadViews(tx, [thread], draftContent(ctx));
  if (!view) throw new Error("Không đọc lại được luồng bình luận.");
  return view;
}

export async function resolveThread(
  tx: Tx,
  principal: Principal,
  raw: { id: string; resolved: boolean },
): Promise<DocThread> {
  const input = threadResolveInput.parse(raw);
  const [t] = await tx.select().from(docThreads).where(eq(docThreads.id, input.id));
  if (!t) throw new NotFoundError("THREAD_NOT_FOUND", "Không tìm thấy luồng bình luận.");
  const ctx = await docContext(tx, principal, t.key);
  const by = authorColumns(principal);
  const [row] = await tx
    .update(docThreads)
    .set(
      input.resolved
        ? { resolvedAt: new Date(), resolvedByUserId: by.authorUserId, resolvedByRunId: by.authorRunId }
        : { resolvedAt: null, resolvedByUserId: null, resolvedByRunId: null },
    )
    .where(eq(docThreads.id, t.id))
    .returning();
  if (!row) throw new Error("Không cập nhật được luồng bình luận.");
  const [view] = await threadViews(tx, [row], draftContent(ctx));
  if (!view) throw new Error("Không đọc lại được luồng bình luận.");
  return view;
}

// ---- Bản chụp và gửi duyệt ---------------------------------------------------------------------------------------

function snapshotView(s: SnapshotRow, sub: Submission | undefined, names: Map<string, string>): DocSnapshot {
  return {
    id: s.id,
    key: s.key,
    number: s.number,
    name: s.name,
    title: s.title,
    baseVersion: s.baseVersion,
    author: actor(names, s.authorUserId, s.authorRunId),
    createdAt: iso(s.createdAt),
    chars: s.content.length,
    submission: sub
      ? {
          proposalId: sub.proposal.id,
          reviewId: sub.instance?.id ?? null,
          status: submissionStatus(sub),
          note: sub.proposal.decisionNote ?? s.note,
        }
      : null,
  };
}

export async function listSnapshots(tx: Tx, principal: Principal, raw: { key: string }): Promise<DocSnapshot[]> {
  const key = docKey.parse(raw.key);
  await docContext(tx, principal, key);
  const rows = await tx.select().from(docSnapshots).where(eq(docSnapshots.key, key)).orderBy(desc(docSnapshots.number));
  const subs = new Map((await submissions(tx, key)).map((s) => [s.snapshot.id, s]));
  const names = await namesOf(
    tx,
    rows.map((r) => r.authorUserId),
  );
  return rows.map((r) => snapshotView(r, subs.get(r.id), names));
}

export async function getSnapshot(tx: Tx, principal: Principal, raw: { id: string }): Promise<DocSnapshotDetail> {
  const [row] = await tx.select().from(docSnapshots).where(eq(docSnapshots.id, raw.id));
  if (!row) throw new NotFoundError("SNAPSHOT_NOT_FOUND", "Không tìm thấy bản chụp.");
  await docContext(tx, principal, row.key);
  const sub = (await submissions(tx, row.key)).find((s) => s.snapshot.id === row.id);
  return { ...snapshotView(row, sub, await namesOf(tx, [row.authorUserId])), content: row.content };
}

async function insertSnapshot(
  tx: Tx,
  principal: Principal,
  key: string,
  ctx: DocContext,
  extra: { name: string; proposalId?: string; note?: string | null },
): Promise<SnapshotRow> {
  // Khoá theo tài liệu để hai bản chụp cùng lúc không lấy trùng số thứ tự.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`doc-snapshot:${key}`}, 0))`);
  const [{ n = 0 } = {}] = await tx
    .select({ n: sql<number>`coalesce(max(${docSnapshots.number}), 0)::int` })
    .from(docSnapshots)
    .where(eq(docSnapshots.key, key));
  const [row] = await tx
    .insert(docSnapshots)
    .values({
      orgId: sql`hive.ctx_org()`,
      teamId: ctx.scope.teamId,
      projectId: ctx.scope.projectId,
      key,
      number: n + 1,
      name: extra.name,
      title: ctx.draft?.title ?? ctx.latest.title ?? docTypeOf(key),
      content: draftContent(ctx),
      baseVersion: ctx.draft?.baseVersion ?? ctx.latest.version,
      proposalId: extra.proposalId ?? null,
      note: extra.note ?? null,
      ...authorColumns(principal),
    })
    .returning();
  if (!row) throw new Error("Không ghi được bản chụp.");
  return row;
}

export async function createSnapshot(
  tx: Tx,
  principal: Principal,
  raw: { key: string; name: string },
): Promise<DocSnapshot> {
  const input = snapshotCreateInput.parse(raw);
  const ctx = await docContext(tx, principal, input.key);
  await requireEdit(tx, ctx);
  const row = await insertSnapshot(tx, principal, input.key, ctx, { name: input.name });
  return snapshotView(row, undefined, await namesOf(tx, [row.authorUserId]));
}

function reviewerText(gate: ReviewGate): string {
  if (gate.kind === "ai") return "Agent AI kiểm";
  if (gate.kind === "rule") return "Quy tắc tự động";
  if (gate.kind === "ext") return "CI của repo";
  const r = gate.reviewers;
  const roles: Record<string, string> = {
    "org-admin": "Quản trị tổ chức",
    "team-admin": "Quản trị đội",
    "team-member": "Thành viên đội",
    "team-ba": "BA/PO của đội",
  };
  const parts = [
    ...(r?.roles ?? []).map((x) => roles[x] ?? x),
    ...(r?.users.length ? [`${r.users.length} người được chỉ định`] : []),
    ...(r?.teams.length ? [`${r.teams.length} đội`] : []),
  ];
  return parts.join(", ") || "Người duyệt";
}

export async function previewSubmit(tx: Tx, principal: Principal, raw: { key: string }): Promise<SubmitPreview> {
  const key = docKey.parse(raw.key);
  const ctx = await docContext(tx, principal, key);
  const content = draftContent(ctx);
  const { added, deleted } = diffCounts(ctx.latest.content, content);
  const wf = await resolveWorkflow(tx, key, ctx.scope);
  const gctx = { docType: docTypeOf(key), content, base: ctx.latest.content };
  return {
    workflow: wf ? { id: wf.id ?? DERIVED_WORKFLOW_ID, name: wf.name } : null,
    gates: wf
      ? flatGates(wf.phases).map(({ gate }) => {
          const applies = gateApplies(gate, gctx);
          return {
            gateId: gate.id,
            name: gate.name,
            kind: gate.kind,
            runs: applies.runs,
            reason: applies.reason,
            who: reviewerText(gate),
          };
        })
      : [],
    addedLines: added,
    deletedLines: deleted,
  };
}

/**
 * Chụp bản nháp và gửi thành đề xuất sửa tài liệu; tài liệu khớp quy trình thì phiên duyệt bắt đầu ngay trong cùng
 * transaction (proposeWithReview). Bản nháp phải dựa trên bản đã duyệt mới nhất để đề xuất không xung đột sẵn.
 */
export async function submitDraft(
  tx: Tx,
  principal: Principal,
  raw: SubmitInput,
  deps: ReviewDeps,
): Promise<{ snapshot: DocSnapshot; proposalId: string; reviewId: string | null }> {
  const input = submitInput.parse(raw);
  const ctx = await docContext(tx, principal, input.key, true);
  await requireEdit(tx, ctx);
  if ((ctx.draft?.revision ?? 0) !== input.revision) throw draftChanged();
  if (ctx.draft && ctx.draft.baseVersion !== ctx.latest.version)
    throw new ConflictError(
      "DRAFT_OUTDATED",
      `Đã có phiên bản ${ctx.latest.version} được duyệt sau khi bạn bắt đầu soạn. Gộp bản mới vào nháp rồi gửi lại.`,
    );
  const content = draftContent(ctx);
  if (!content.trim()) throw new BadRequestError("DRAFT_EMPTY", "Bản nháp đang trống.");
  if (ctx.latest.version > 0 && content === ctx.latest.content)
    throw new BadRequestError("DRAFT_UNCHANGED", "Bản nháp chưa đổi gì so với bản đã duyệt.");
  const [last] = await submissions(tx, input.key, 1);
  if (last && ["in_review", "pending"].includes(submissionStatus(last)))
    throw new ConflictError(
      "REVIEW_IN_PROGRESS",
      `Bản v${last.snapshot.number} còn đang duyệt; chờ kết quả rồi gửi tiếp.`,
    );
  const proposal = await proposeWithReview(
    tx,
    principal,
    {
      kind: "doc",
      key: input.key,
      baseVersion: ctx.latest.version,
      title: ctx.draft?.title ?? ctx.latest.title ?? undefined,
      content,
      ...(input.note ? { reason: input.note } : {}),
    },
    deps,
  );
  const [{ n: count = 0 } = {}] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(docSnapshots)
    .where(and(eq(docSnapshots.key, input.key), sql`${docSnapshots.proposalId} is not null`));
  const row = await insertSnapshot(tx, principal, input.key, ctx, {
    name: `Gửi duyệt v${count + 1}`,
    proposalId: proposal.id,
    note: input.note ?? null,
  });
  const [sub] = await submissions(tx, input.key, 1);
  await audit(
    tx,
    principal,
    "doc.draft.submit",
    { type: "doc_draft", id: row.id },
    {
      key: input.key,
      proposalId: proposal.id,
    },
  );
  return {
    snapshot: snapshotView(row, sub, await namesOf(tx, [row.authorUserId])),
    proposalId: proposal.id,
    reviewId: sub?.instance?.id ?? null,
  };
}

// ---- Cho trợ lý AI và MCP ------------------------------------------------------------------------------------------

/** Bản nháp kèm đề xuất còn chờ và luồng còn mở, để agent đọc trước khi góp ý. */
export async function draftForAgent(tx: Tx, principal: Principal, key: string) {
  const ctx = await docContext(tx, principal, docKey.parse(key));
  return {
    key,
    title: ctx.draft?.title ?? ctx.latest.title ?? docTypeOf(key),
    content: draftContent(ctx),
    baseVersion: ctx.draft?.baseVersion ?? ctx.latest.version,
    scope: ctx.scope,
    pendingSuggestions: await listSuggestions(tx, principal, { key, status: "pending" }),
    openThreads: (await listThreads(tx, principal, { key })).filter((t) => !t.resolvedAt),
  };
}

/** Quyền nhờ trợ lý AI: như sửa bản nháp. Trả phạm vi để module runs chọn dự án cho run. */
export async function assistScope(tx: Tx, principal: Principal, key: string): Promise<Scope> {
  const ctx = await docContext(tx, principal, docKey.parse(key));
  await requireEdit(tx, ctx);
  return ctx.scope;
}

/** Số đề xuất và bình luận mỗi run trợ lý đã để lại. */
export async function assistOutput(tx: Tx, runIds: string[]) {
  const out = new Map<string, { suggestions: number; comments: number }>(
    runIds.map((id) => [id, { suggestions: 0, comments: 0 }]),
  );
  if (!runIds.length) return out;
  const s = await tx
    .select({ id: docSuggestions.authorRunId, n: sql<number>`count(*)::int` })
    .from(docSuggestions)
    .where(inArray(docSuggestions.authorRunId, runIds))
    .groupBy(docSuggestions.authorRunId);
  const c = await tx
    .select({ id: docComments.authorRunId, n: sql<number>`count(*)::int` })
    .from(docComments)
    .where(inArray(docComments.authorRunId, runIds))
    .groupBy(docComments.authorRunId);
  for (const r of s) {
    const o = r.id ? out.get(r.id) : undefined;
    if (o) o.suggestions = r.n;
  }
  for (const r of c) {
    const o = r.id ? out.get(r.id) : undefined;
    if (o) o.comments = r.n;
  }
  return out;
}
