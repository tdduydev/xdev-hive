import { implement } from "@orpc/server";
import {
  contract,
  type SdlcItemDetail,
  type SdlcPhase,
  type SdlcStep,
  type SdlcStepAction,
  sdlcItemRef,
} from "@xdev-hive/contracts";
import {
  SDLC_ARTIFACT_LIMITS,
  SDLC_MAX_REPOS,
  SDLC_REPOS_DIR,
  type SdlcJobSpec,
  type SdlcReportArtifacts,
  sdlcJobRepo,
} from "@xdev-hive/contracts/worker-protocol";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { recordAudit } from "../audit/index.ts";
import { loadProject, type ProjectRow } from "../catalog/index.ts";
import {
  type AuthorFixRequest,
  draftForAgent,
  editorState,
  getDoc,
  type Principal,
  saveDraft,
  saveRunDraft,
  submitDraft,
} from "../knowledge/index.ts";
import { notify } from "../notify/index.ts";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  type RequestContext,
  type Tx,
} from "../platform/index.ts";
import { loadConnection } from "../scm/index.ts";
import { type OrgDeps, orgMiddlewares } from "../tenancy/index.ts";
import { activeItemProjects, itemForUser, itemViewers, requireProjectWrite } from "./access.ts";
import { assertCanConverge, findingsOf, SDLC_CONVERGE_ACTOR, settleConverge, startConverge } from "./converge.ts";
import { itemDetail } from "./items.ts";
import {
  lockItem,
  onBaseline,
  SDLC_SYSTEM_ACTOR,
  type SdlcDeps,
  type SdlcItemRow,
  type SdlcStepStart,
  scheduleAdvance,
  workflowFor,
} from "./phases.ts";
import {
  buildStepPrompt,
  type PromptContextDoc,
  type PromptContract,
  type PromptOutput,
  type PromptProject,
  SEED_DIR,
} from "./prompt.ts";
import { qaCases } from "./qa.ts";
import { qaFingerprint } from "./qa-gate.ts";
import { RELEASE_ACTIONS, releaseBrief } from "./release.ts";
import { repoDigest } from "./repo-digest.ts";
import { sdlcArtifacts, sdlcItemPhases, sdlcQuestions, sdlcSteps } from "./schema.ts";

/*
 * Bước agent của giai đoạn (plan.md "Agent chạy từng bước"): dựng prompt, seed, collect rồi nhờ `runs` tạo run `sdlc`;
 * run xong thì đưa file agent ghi vào bản nháp của tài liệu, câu hỏi mở thì giai đoạn chờ trả lời.
 */

type ArtifactRow = typeof sdlcArtifacts.$inferSelect;
type StepRow = typeof sdlcSteps.$inferSelect;

/** Bước ghi file theo `collect`; các bước khác chỉ đọc tài liệu và báo bằng `sdlc_report`. */
const WRITING_ACTIONS: readonly SdlcStepAction[] = ["draft", "release-notes", "retro", "archive", "test-run"];
export const writesFiles = (action: string) => (WRITING_ACTIONS as readonly string[]).includes(action);

/** Tác nhân của bước agent sửa theo góp ý (đếm lượt sửa theo `maxAgentRevisions`). */
export const SDLC_REVISE_ACTOR = "system:sdlc-revise";

const MAX_SEEDS = 100;
const clipSeed = (text: string) =>
  text.length > SDLC_ARTIFACT_LIMITS.fileChars ? text.slice(0, SDLC_ARTIFACT_LIMITS.fileChars) : text;

/** `startSdlcRun` dựng từ `createSdlcRun` của `runs`: main.ts, engine và route cùng một cách tạo run cho bước. */
export function withStepRuns(deps: SdlcDeps): SdlcDeps {
  if (deps.startSdlcRun || !deps.createSdlcRun) return deps;
  const out: SdlcDeps = { ...deps };
  out.startSdlcRun = (tx, input) => startStep(tx, input, out);
  return out;
}

/**
 * Đường dẫn trong worktree (repo của run, thường là dự án chính; converge chạy trên repo từng dự án); tài liệu của repo
 * khác nằm dưới thư mục seed của hub.
 */
function worktreePathOf(repoProjectId: string, a: ArtifactRow, keys: ReadonlyMap<string, string>): string {
  return a.projectId === repoProjectId
    ? a.repoPath
    : `${SEED_DIR}/${keys.get(a.projectId) ?? a.projectId}/${a.repoPath}`;
}

const readerFor = (item: SdlcItemRow): Principal => ({ kind: "user", userId: item.ownerUserId });

/** Nội dung baseline hoặc bản nháp, đọc bằng quyền chủ hạng mục như `onBaseline`; không đọc được thì bỏ. */
async function contentOf(tx: Tx, item: SdlcItemRow, a: ArtifactRow, prefer: "baseline" | "draft") {
  const reader = readerFor(item);
  try {
    if (prefer === "baseline" && a.baselineVersion !== null) {
      const doc = await getDoc(tx, reader, { key: a.docKey, version: a.baselineVersion });
      return { content: doc.content, state: "baseline" as const, version: a.baselineVersion };
    }
    const draft = await draftForAgent(tx, reader, a.docKey);
    return { content: draft.content, state: "draft" as const, version: draft.baseVersion || null };
  } catch (e) {
    if (e instanceof ForbiddenError || e instanceof NotFoundError) return null;
    throw e;
  }
}

async function digestsOf(tx: Tx, projects: ProjectRow[], deps: SdlcDeps): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  for (const p of projects) {
    out.set(p.id, null);
    if (!deps.providerFactory || !deps.masterKey) continue;
    try {
      const conn = await loadConnection(tx, deps.masterKey, p.scmConnectionId);
      if (!conn) continue;
      const digest = await repoDigest({
        provider: deps.providerFactory(conn),
        repo: { owner: p.repoOwner, name: p.repoName },
        projectKey: p.key,
        branch: p.defaultBranch ?? "main",
      });
      out.set(p.id, digest);
    } catch {
      // Repo tham gia không đọc được (mất kết nối, thiếu quyền): agent vẫn soạn được, prompt ghi là chưa có tóm tắt.
    }
  }
  return out;
}

export interface StepPlan {
  prompt: string;
  job: SdlcJobSpec;
}

/** Prompt, seed và collect của một bước; tách khỏi `startStep` để test và trang "xem trước" dùng lại. */
export async function planStep(
  tx: Tx,
  input: Pick<SdlcStepStart, "item" | "phase" | "step" | "instructions"> & {
    /** Repo của run; bỏ trống là dự án chính. */
    projectId?: string | undefined;
  },
  deps: SdlcDeps,
): Promise<StepPlan> {
  const { item, phase, step } = input;
  const repo = input.projectId ?? item.projectId;
  const members = await activeItemProjects(tx, item.id);
  const projects: ProjectRow[] = [];
  for (const m of members) {
    const p = await loadProject(tx, m.projectId);
    if (p) projects.push(p);
  }
  const keys = new Map(projects.map((p) => [p.id, p.key]));
  const artifacts = await tx
    .select()
    .from(sdlcArtifacts)
    .where(eq(sdlcArtifacts.itemId, item.id))
    .orderBy(asc(sdlcArtifacts.phaseId), asc(sdlcArtifacts.artifactId), asc(sdlcArtifacts.instance));
  const order = new Map(item.mode.phases.map((p, i) => [p.id, i]));
  const phaseIndex = order.get(phase.id) ?? 0;
  const defOf = (a: ArtifactRow) =>
    item.mode.phases.find((p) => p.id === a.phaseId)?.artifacts.find((d) => d.id === a.artifactId);
  const nameOf = (a: ArtifactRow) => {
    const name = defOf(a)?.name ?? a.artifactId;
    return a.scope === "project" ? `${name} (${keys.get(a.projectId) ?? a.instance})` : name;
  };
  const seed: SdlcJobSpec["seed"] = [];
  const addSeed = (path: string, content: string) => {
    if (seed.length < MAX_SEEDS && !seed.some((s) => s.path === path)) seed.push({ path, content: clipSeed(content) });
  };

  const writing = writesFiles(step.action);
  const outputRows = writing
    ? artifacts.filter((a) => a.phaseId === phase.id && a.scope !== "contract" && step.artifacts.includes(a.artifactId))
    : [];
  const outputs: PromptOutput[] = [];
  const collect: SdlcJobSpec["collect"] = [];
  for (const a of outputRows) {
    const path = worktreePathOf(repo, a, keys);
    outputs.push({
      name: nameOf(a),
      path,
      sections: defOf(a)?.sections ?? [],
      projectKey: a.projectId === repo ? null : (keys.get(a.projectId) ?? null),
    });
    collect.push({ artifactId: a.id, path });
    // Bản nháp hiện có (khuôn lúc tạo, hoặc bản người đã sửa) để agent sửa tiếp thay vì viết lại từ đầu.
    const current = await contentOf(tx, item, a, "draft");
    if (current?.content.trim()) addSeed(path, current.content);
  }

  // Bước soạn đọc baseline của giai đoạn trước; bước đọc chéo (analyze, converge) đọc tài liệu nó khai ở mọi giai đoạn.
  const contextRows = artifacts.filter((a) => {
    if (a.scope === "contract" || outputRows.includes(a)) return false;
    if (writing) return (order.get(a.phaseId) ?? 0) < phaseIndex && a.baselineVersion !== null;
    return step.artifacts.includes(a.artifactId);
  });
  const context: PromptContextDoc[] = [];
  for (const a of contextRows) {
    const found = await contentOf(tx, item, a, "baseline");
    if (!found?.content.trim()) continue;
    const path = worktreePathOf(repo, a, keys);
    addSeed(path, found.content);
    context.push({ name: nameOf(a), path, state: found.state, version: found.version });
  }

  const contracts: PromptContract[] = [];
  for (const a of artifacts.filter((r) => r.scope === "contract")) {
    const approved = a.baselineVersion !== null && a.approval !== "revoked" && a.approval !== "none";
    const found = await contentOf(tx, item, a, approved ? "baseline" : "draft");
    const path = worktreePathOf(repo, a, keys);
    if (found?.content.trim()) addSeed(path, found.content);
    contracts.push({
      name: a.instance,
      path,
      provider: keys.get(a.projectId) ?? "",
      consumers: a.consumerProjectIds.map((id) => keys.get(id) ?? id),
      approved,
    });
  }

  const elsewhere = projects.filter((p) => p.id !== repo);
  const digests = await digestsOf(tx, elsewhere, deps);
  const promptProjects: PromptProject[] = [];
  const repos: NonNullable<SdlcJobSpec["repos"]> = [];
  for (const p of projects) {
    const role = p.id === item.projectId ? "home" : "participant";
    if (p.id === repo) {
      promptProjects.push({ key: p.key, role, digestPath: null, worktree: true });
      continue;
    }
    const digest = digests.get(p.id);
    const path = digest ? `${SEED_DIR}/projects/${p.key}.md` : null;
    if (path && digest) addSeed(path, digest);
    promptProjects.push({ key: p.key, role, digestPath: path });
    // T086: chỉ repo hub đọc được qua kết nối Git của dự án đó (có tóm tắt); máy có `sdlc-multirepo` mới nhận
    // (engine bỏ trường này với máy khác), tóm tắt vẫn seed để máy không clone được vẫn có cái để đọc.
    // Kiểm từng repo: một URL lạ làm hỏng cả spec lúc engine đọc lại, run mất seed và collect.
    const entry = sdlcJobRepo.safeParse({
      projectKey: p.key,
      cloneUrl: p.repoHttpUrl,
      branch: p.defaultBranch ?? "main",
      dir: `${SDLC_REPOS_DIR}/${p.key}`,
    });
    if (digest && entry.success && repos.length < SDLC_MAX_REPOS) repos.push(entry.data);
  }

  let release: string | null = null;
  if (RELEASE_ACTIONS.includes(step.action)) {
    release = `${SEED_DIR}/release.md`;
    addSeed(release, await releaseBrief(tx, item));
  }

  const answered = await tx
    .select({ text: sdlcQuestions.text, answer: sdlcQuestions.answer })
    .from(sdlcQuestions)
    .where(
      and(eq(sdlcQuestions.itemId, item.id), eq(sdlcQuestions.phaseId, phase.id), eq(sdlcQuestions.status, "answered")),
    )
    .orderBy(asc(sdlcQuestions.round), asc(sdlcQuestions.position));

  const prompt = buildStepPrompt({
    item,
    phaseName: phase.name,
    step,
    outputs,
    context,
    answers: answered.map((q) => ({ text: q.text, answer: q.answer ?? "" })),
    feedback: input.instructions,
    projects: promptProjects,
    contracts,
    release,
  });
  return { prompt, job: { step: step.id, seed, collect, ...(repos.length ? { repos } : {}) } };
}

/**
 * Tạo run `sdlc` cho dòng `sdlc_steps` đã ghi. Run mang cài đặt của dự án chính (D13): chủ theo `runner`, nhãn máy theo
 * `labels`. null: hub chưa nối `runs` (test, công cụ) hoặc không tạo được run; bước giữ `queued`.
 */
export async function startStep(tx: Tx, input: SdlcStepStart, deps: SdlcDeps): Promise<{ runId: string } | null> {
  if (!deps.createSdlcRun) return null;
  if (input.step.action === "converge")
    return startConverge(tx, input, (t, i, projectId) => startProjectRun(t, i, projectId, deps));
  return startProjectRun(tx, input, input.item.projectId, deps);
}

/** Run trên repo của `projectId`, chủ và nhãn máy theo cài đặt của dự án đó trong hạng mục. */
async function startProjectRun(
  tx: Tx,
  input: SdlcStepStart,
  projectId: string,
  deps: SdlcDeps,
): Promise<{ runId: string } | null> {
  if (!deps.createSdlcRun) return null;
  const { item, phase, step } = input;
  if (step.action === "test-run") {
    const [row] = await tx.select().from(sdlcSteps).where(eq(sdlcSteps.id, input.stepRowId));
    await tx
      .update(sdlcSteps)
      .set({ result: { ...(row?.result ?? {}), qaBaseline: qaFingerprint(await qaCases(tx, item.id)) } })
      .where(eq(sdlcSteps.id, input.stepRowId));
  }
  const plan = await planStep(tx, { ...input, projectId }, deps);
  const [member] = (await activeItemProjects(tx, item.id)).filter((m) => m.projectId === projectId);
  const settings = member?.settings ?? item.settings;
  const suffix = projectId === item.projectId ? "" : ` · ${(await loadProject(tx, projectId))?.key ?? ""}`;
  const started = await deps.createSdlcRun(tx, {
    itemId: item.id,
    projectId,
    stepRowId: input.stepRowId,
    title: `${sdlcItemRef(item.number)} ${item.title} · ${phase.name} · ${step.id}${suffix}`.slice(0, 200),
    prompt: plan.prompt,
    job: plan.job,
    cli: step.cli ?? null,
    model: step.model ?? null,
    ownerUserId: settings.runner === "requester" ? (input.requestedBy ?? item.ownerUserId) : null,
    requiredLabels: [...new Set([...(settings.labels ?? []), ...(step.labels ?? [])])],
    createdBy: input.requestedBy ?? SDLC_SYSTEM_ACTOR,
  });
  if (started)
    await tx
      .update(sdlcSteps)
      .set({ runId: started.runId, status: "running" })
      .where(eq(sdlcSteps.id, input.stepRowId));
  return started;
}

/** Lượt kế của một bước trong giai đoạn: chạy lại, trả lời câu hỏi, sửa theo góp ý đều tăng lượt. */
async function nextRound(tx: Tx, itemId: string, phaseId: string, stepId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`coalesce(max(${sdlcSteps.round}), 0)::int` })
    .from(sdlcSteps)
    .where(and(eq(sdlcSteps.itemId, itemId), eq(sdlcSteps.phaseId, phaseId), eq(sdlcSteps.stepId, stepId)));
  return (row?.n ?? 0) + 1;
}

/** Ghi dòng bước rồi tạo run; dùng cho người bấm chạy, đủ câu trả lời và sửa theo góp ý. */
export async function queueStep(
  tx: Tx,
  item: SdlcItemRow,
  phase: SdlcPhase,
  step: SdlcStep,
  opts: { createdBy: string; requestedBy: string | null; instructions: string | null },
  deps: SdlcDeps,
): Promise<{ stepRowId: string; runId: string | null }> {
  const round = await nextRound(tx, item.id, phase.id, step.id);
  const [row] = await tx
    .insert(sdlcSteps)
    .values({
      orgId: item.orgId,
      itemId: item.id,
      phaseId: phase.id,
      stepId: step.id,
      action: step.action,
      round,
      instructions: opts.instructions,
      createdBy: opts.createdBy,
    })
    .returning();
  if (!row) throw new Error("Không ghi được bước agent.");
  const started = await withStepRuns(deps).startSdlcRun?.(tx, {
    item,
    phase,
    step,
    stepRowId: row.id,
    round,
    instructions: opts.instructions,
    requestedBy: opts.requestedBy,
  });
  await tx
    .update(sdlcItemPhases)
    .set({ status: "drafting" })
    .where(
      and(
        eq(sdlcItemPhases.itemId, item.id),
        eq(sdlcItemPhases.phaseId, phase.id),
        inArray(sdlcItemPhases.status, ["pending", "awaiting_answers", "in_review"]),
      ),
    );
  await recordAudit(tx, {
    action: "sdlc.step.start",
    actorUserId: opts.requestedBy,
    targetType: "sdlc_item",
    targetId: item.id,
    data: { phaseId: phase.id, stepId: step.id, stepRowId: row.id, round, runId: started?.runId ?? null, auto: false },
  });
  return { stepRowId: row.id, runId: started?.runId ?? null };
}

const activeStep = (tx: Tx, itemId: string, phaseId: string) =>
  tx
    .select({ id: sdlcSteps.id })
    .from(sdlcSteps)
    .where(
      and(
        eq(sdlcSteps.itemId, itemId),
        eq(sdlcSteps.phaseId, phaseId),
        inArray(sdlcSteps.status, ["queued", "running"]),
      ),
    )
    .limit(1);

/** `items.step`: người chạy hoặc chạy lại một bước agent của giai đoạn đang làm, kèm chỉ dẫn thêm nếu có. */
export async function runStep(
  tx: Tx,
  userId: string,
  input: { id: string; phaseId: string; stepId: string; instructions?: string | undefined },
  deps: SdlcDeps,
): Promise<SdlcItemDetail> {
  const item = await itemForUser(tx, userId, input.id, true);
  await requireProjectWrite(
    tx,
    userId,
    (await activeItemProjects(tx, item.id)).map((m) => m.projectId),
  );
  if (item.status !== "active")
    throw new ConflictError("SDLC_ITEM_NOT_ACTIVE", "Hạng mục đang tạm dừng hoặc đã đóng, không chạy bước được.");
  const index = item.mode.phases.findIndex((p) => p.id === input.phaseId);
  const phase = item.mode.phases[index];
  const step = phase?.steps.find((s) => s.id === input.stepId);
  if (!phase || !step) throw new NotFoundError("SDLC_STEP_NOT_FOUND", "Giai đoạn hoặc bước không có trong chế độ.");
  if (index !== item.phaseIndex)
    throw new ConflictError("SDLC_PHASE_NOT_CURRENT", "Chỉ chạy được bước của giai đoạn đang làm.");
  if (step.action === "converge") assertCanConverge(item);
  if ((await activeStep(tx, item.id, phase.id)).length)
    throw new ConflictError("SDLC_STEP_RUNNING", "Giai đoạn đang có bước agent chạy; chờ xong hoặc huỷ run đó.");
  await queueStep(
    tx,
    item,
    phase,
    step,
    { createdBy: userId, requestedBy: userId, instructions: input.instructions?.trim() || null },
    deps,
  );
  return itemDetail(tx, userId, item.id);
}

// ---- Kết luận run ----------------------------------------------------------------------------------------------

export interface SdlcRunOutcome {
  runId: string;
  /** CLI thoát êm và worker không báo lỗi. */
  ok: boolean;
  artifacts: SdlcReportArtifacts | null;
  /** Lý do khi `ok` là false (lỗi worker, mất máy, huỷ). */
  error: string | null;
  cancelled?: boolean | undefined;
}

/**
 * Ghi file agent trả về vào bản nháp dưới tên run (FR-014). Tài liệu của repo khác mà run (dự án chính) không thấy thì
 * ghi dưới tên chủ hạng mục, người đã giao việc; run nào ghi vẫn nằm ở `sdlc_steps.result`. null: không ai ghi được.
 */
async function writeArtifact(
  tx: Tx,
  item: SdlcItemRow,
  runId: string,
  row: ArtifactRow,
  content: string,
): Promise<number | null> {
  const owner = readerFor(item);
  try {
    const { draft } = await editorState(tx, owner, { key: row.docKey });
    const input = { key: row.docKey, content, revision: draft.revision };
    if (row.projectId === item.projectId) {
      try {
        return (await saveRunDraft(tx, { kind: "run", runId, projectId: item.projectId }, input)).revision;
      } catch (e) {
        if (!(e instanceof ForbiddenError)) throw e;
      }
    }
    return (await saveDraft(tx, owner, input)).revision;
  } catch (e) {
    if (e instanceof ForbiddenError) return null;
    throw e;
  }
}

async function notifyQuestions(tx: Tx, item: SdlcItemRow, count: number, deps: SdlcDeps): Promise<void> {
  const home = await loadProject(tx, item.projectId);
  const recipientIds = await itemViewers(tx, item, [item.ownerUserId]);
  if (!recipientIds.length) return;
  const ref = sdlcItemRef(item.number);
  await notify(
    tx,
    {
      orgId: item.orgId,
      event: "sdlc.question",
      title: `Agent hỏi ${count} câu ở hạng mục ${ref}`,
      body: `${item.title}: trả lời để agent soạn tiếp.`,
      recipientIds,
      eventKey: `sdlc.question:${item.id}:${Date.now()}`,
      link: deps.publicUrl && home ? `${deps.publicUrl.replace(/\/+$/, "")}/sdlc/${home.key}/${ref}` : null,
    },
    { jobs: deps.jobs },
  );
}

async function failStep(tx: Tx, item: SdlcItemRow | null, row: StepRow, error: string, cancelled = false) {
  await tx
    .update(sdlcSteps)
    .set({ status: cancelled ? "cancelled" : "failed", error, finishedAt: sql`now()` })
    .where(eq(sdlcSteps.id, row.id));
  await recordAudit(tx, {
    action: "sdlc.step.finish",
    actorUserId: null,
    targetType: "sdlc_item",
    targetId: row.itemId,
    data: {
      stepRowId: row.id,
      stepId: row.stepId,
      runId: row.runId,
      status: cancelled ? "cancelled" : "failed",
      error,
    },
  });
  return { succeeded: false, message: error, itemId: item?.id ?? row.itemId };
}

/**
 * `runs.verify` của run `sdlc` gọi trong transaction kết luận run (plan.md "Luồng" bước 3): file → bản nháp, câu hỏi mở
 * → `awaiting_answers`, không câu hỏi và `autoSubmit` → gửi duyệt. null: run không thuộc bước nào (đã bị bỏ).
 */
export async function onSdlcRunFinished(
  tx: Tx,
  outcome: SdlcRunOutcome,
  deps: SdlcDeps = {},
): Promise<{ succeeded: boolean; message: string; itemId: string } | null> {
  const [row] = await tx.select().from(sdlcSteps).where(eq(sdlcSteps.runId, outcome.runId)).for("update");
  if (!row || (row.status !== "running" && row.status !== "queued")) return null;
  const item = await lockItem(tx, row.itemId);
  if (!item) return null;
  const fail = async (error: string, cancelled = false) => {
    const failed = await failStep(tx, item, row, error, cancelled);
    if (row.action === "converge") await afterConverge(tx, item, { ...row, status: "failed" }, deps);
    return failed;
  };
  if (!outcome.ok) return fail(outcome.error ?? "Run soạn tài liệu lỗi hoặc hết thời gian.", outcome.cancelled);
  const phase = item.mode.phases.find((p) => p.id === row.phaseId);
  const step = phase?.steps.find((s) => s.id === row.stepId);
  if (!phase || !step) return fail("Chế độ của hạng mục không còn bước này.");
  if (step.action === "converge" && !findingsOf(row.result))
    return fail("Agent không báo kết quả converge (sdlc_report loại findings); xem log của run rồi chạy vòng mới.");
  if (step.action === "test-run" && !row.result?.["test-results"])
    return fail("Chưa nhận metadata kết quả QA; hãy chạy lại và gửi sdlc_report loại test-results.");

  const rows = await tx.select().from(sdlcArtifacts).where(eq(sdlcArtifacts.itemId, item.id));
  const saved: { artifactId: string; docKey: string; revision: number; sha256: string }[] = [];
  const skipped: string[] = [];
  for (const file of outcome.artifacts ?? []) {
    const target = rows.find((a) => a.id === file.artifactId && a.phaseId === phase.id);
    if (!target) {
      skipped.push(file.path);
      continue;
    }
    const revision = await writeArtifact(tx, item, outcome.runId, target, file.content);
    if (revision === null) skipped.push(file.path);
    else saved.push({ artifactId: target.id, docKey: target.docKey, revision, sha256: file.sha256 });
  }

  const open = await tx
    .select({ id: sdlcQuestions.id })
    .from(sdlcQuestions)
    .where(and(eq(sdlcQuestions.runId, outcome.runId), eq(sdlcQuestions.status, "open")));
  if (writesFiles(step.action) && !saved.length && !open.length)
    return fail("Agent không ghi tài liệu nào và không hỏi lại; xem log của run rồi chạy lại bước.");

  const result = { ...(row.result ?? {}), artifacts: saved, ...(skipped.length ? { skipped } : {}) };
  await tx
    .update(sdlcSteps)
    .set({ status: "succeeded", result, finishedAt: sql`now()` })
    .where(eq(sdlcSteps.id, row.id));

  let message = saved.length ? `Agent đã ghi ${saved.length} tài liệu vào bản nháp.` : "Bước agent đã xong.";
  if (open.length) {
    await tx
      .update(sdlcItemPhases)
      .set({ status: "awaiting_answers" })
      .where(and(eq(sdlcItemPhases.itemId, item.id), eq(sdlcItemPhases.phaseId, phase.id)));
    await notifyQuestions(tx, item, open.length, deps);
    message = `${message} Agent hỏi ${open.length} câu, chờ người trả lời.`;
  } else if (step.autoSubmit && saved.length) {
    const submitted = await submitSaved(tx, item, saved, deps);
    if (submitted) {
      await tx
        .update(sdlcItemPhases)
        .set({ status: "in_review" })
        .where(and(eq(sdlcItemPhases.itemId, item.id), eq(sdlcItemPhases.phaseId, phase.id)));
      message = `${message} Đã gửi duyệt.`;
    }
  }
  await recordAudit(tx, {
    action: "sdlc.step.finish",
    actorUserId: null,
    targetType: "sdlc_item",
    targetId: item.id,
    data: {
      stepRowId: row.id,
      stepId: row.stepId,
      runId: outcome.runId,
      status: "succeeded",
      artifacts: saved.map((s) => s.docKey),
      questions: open.length,
    },
  });
  if (step.action === "converge")
    message = await afterConverge(tx, item, { ...row, status: "succeeded", result }, deps);
  // Bước không ghi tài liệu (cỡ, đọc chéo) có thể làm giai đoạn đạt; bước kế tự chạy cũng đi qua đây.
  if (item.status === "active" && !open.length) await scheduleAdvance(tx, item, deps);
  return { succeeded: true, message, itemId: item.id };
}

/**
 * Chốt vòng converge khi run cuối của vòng kết luận; còn yêu cầu chưa đạt thì giao bước soạn tài liệu tách việc với phát
 * hiện làm chỉ dẫn. Bước đó đang chạy thì không giao chồng, người chạy lại sau.
 */
async function afterConverge(tx: Tx, item: SdlcItemRow, row: StepRow, deps: SdlcDeps): Promise<string> {
  const settled = await settleConverge(tx, item, row, deps);
  const follow = settled.followUp;
  if (!follow || item.status !== "active") return settled.message;
  if ((await activeStep(tx, item.id, follow.phase.id)).length)
    return `${settled.message} Bước soạn tài liệu tách việc đang chạy nên chưa giao thêm.`;
  await queueStep(
    tx,
    item,
    follow.phase,
    follow.step,
    { createdBy: SDLC_CONVERGE_ACTOR, requestedBy: null, instructions: follow.instructions },
    deps,
  );
  return `${settled.message} Đã giao agent bổ sung task.`;
}

/**
 * Gửi duyệt bản nháp agent vừa ghi (`autoSubmit`), dưới tên chủ như lúc ghi. Truyền thẳng `workflowFor`, `onBaseline`
 * của module này thay vì dựa vào hook main.ts cài, để cổng của giai đoạn luôn áp. true: có phiên duyệt được mở.
 */
async function submitSaved(
  tx: Tx,
  item: SdlcItemRow,
  saved: { docKey: string; revision: number }[],
  deps: SdlcDeps,
): Promise<boolean> {
  let reviewing = false;
  for (const s of saved) {
    try {
      const out = await submitDraft(
        tx,
        readerFor(item),
        { key: s.docKey, revision: s.revision, note: "Agent soạn (AI SDLC), tự gửi duyệt." },
        {
          jobs: deps.jobs,
          publicUrl: deps.publicUrl,
          workflowFor,
          onBaseline: (t, event) => onBaseline(t, event, deps),
        },
      );
      if (out.reviewId) reviewing = true;
    } catch (e) {
      // Chủ mất quyền, bản nháp lệch phiên bản: để người gửi tay, bước vẫn xong.
      if (e instanceof ForbiddenError || e instanceof ConflictError || e instanceof BadRequestError) continue;
      throw e;
    }
  }
  return reviewing;
}

// ---- Sửa theo góp ý ---------------------------------------------------------------------------------------------

/**
 * Hook `queueAuthorFix` của knowledge (D4): người duyệt trả tài liệu của hạng mục về agent → bước soạn chạy lại với góp
 * ý. Quá `maxAgentRevisions` lượt thì không giao agent nữa (tránh vòng sửa không dừng): giai đoạn về soạn tay và ghi
 * chú. `false`: tài liệu không thuộc hạng mục, knowledge làm như cũ.
 */
export async function queueAuthorFix(tx: Tx, request: AuthorFixRequest, deps: SdlcDeps = {}): Promise<boolean> {
  const [artifact] = await tx.select().from(sdlcArtifacts).where(eq(sdlcArtifacts.docKey, request.docKey));
  if (!artifact) return false;
  const item = await lockItem(tx, artifact.itemId);
  if (!item || item.status === "done" || item.status === "cancelled") return false;
  const phase = item.mode.phases.find((p) => p.id === artifact.phaseId);
  const step = phase?.steps.find((s) => s.action === "draft" && s.artifacts.includes(artifact.artifactId));
  if (!phase || !step) return false;
  const [used] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(sdlcSteps)
    .where(
      and(eq(sdlcSteps.itemId, item.id), eq(sdlcSteps.phaseId, phase.id), eq(sdlcSteps.createdBy, SDLC_REVISE_ACTOR)),
    );
  const phaseFilter = and(eq(sdlcItemPhases.itemId, item.id), eq(sdlcItemPhases.phaseId, phase.id));
  if ((used?.n ?? 0) >= item.mode.maxAgentRevisions || item.status !== "active") {
    const note =
      item.status !== "active"
        ? "Hạng mục đang tạm dừng: người viết sửa theo góp ý."
        : `Agent đã sửa ${used?.n ?? 0} lượt (tối đa ${item.mode.maxAgentRevisions}): người viết sửa tay theo góp ý.`;
    await tx.update(sdlcItemPhases).set({ status: "drafting", note }).where(phaseFilter);
    return true;
  }
  if ((await activeStep(tx, item.id, phase.id)).length) {
    await tx.update(sdlcItemPhases).set({ status: "drafting" }).where(phaseFilter);
    return true;
  }
  const feedback = `Người duyệt trả lại ${request.docTitle}:\n${request.note}`;
  await queueStep(
    tx,
    item,
    phase,
    step,
    { createdBy: SDLC_REVISE_ACTOR, requestedBy: null, instructions: feedback },
    deps,
  );
  return true;
}

/** Route `items.step`; T070 gộp vào router của module để file này không đụng `router.ts` chung. */
export function stepRoutes(deps: OrgDeps & SdlcDeps) {
  const { authed, inOrg } = orgMiddlewares(deps);
  const os = implement(contract.sdlc.items).$context<RequestContext>().use(authed).use(inOrg);
  return {
    step: os.step.handler(({ context: { tx, user }, input }) => runStep(tx, user.id, input, deps)),
  };
}
