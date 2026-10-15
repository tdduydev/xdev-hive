import {
  type AiReviewerResult,
  aiReviewerResult,
  type CodeGateRun,
  type CodeReviewDetail,
  type CodeReviewFiles,
  type CodeReviewListInput,
  type CodeReviewStatus,
  type CodeReviewSummary,
  codeReviewListInput,
  type PrFile,
  type ReviewGate,
  reviewGate,
} from "@xdev-hive/contracts";
import { type CheckCommandResult, checkCommandResult } from "@xdev-hive/contracts/worker-protocol";
import { and, asc, desc, eq, getTableColumns, inArray, or, type SQL, sql } from "drizzle-orm";
import { findProject, listQueue, loadProject } from "../catalog/index.ts";
import { authUser } from "../identity/index.ts";
import { eligible, flatGates, type Reader, readerFor, slaOf } from "../knowledge/index.ts";
import { BadRequestError, type MasterKey, NotFoundError, type Tx } from "../platform/index.ts";
import {
  type GitProvider,
  isGitProviderError,
  loadConnection,
  type ProviderFactory,
  type PullRequestFile,
  type RepoRef,
} from "../scm/index.ts";
import { taskSummaries } from "../tasks/index.ts";
import { customPermissions } from "../tenancy/index.ts";
import { codeReviewGateRuns, codeReviews } from "./schema.ts";
import type { CodeReviewDeps, CodeReviewGateRunRow, CodeReviewRow, RunEvidence } from "./service.ts";

export type UserReader = Extract<Reader, { kind: "user" }>;

/** Giới hạn đọc file của `GitProvider.prFiles`: trả đủ mức này thì PR có thể còn file chưa đọc. */
const MAX_PR_FILES = 3000;
const FILES_TTL_MS = 10 * 60_000;
const FILES_CACHE_MAX = 200;

/** Bộ đệm diff theo `head_sha` (D10): cùng commit thì diff không đổi, nên đệm không bao giờ sai, chỉ tốn bộ nhớ. */
export interface FilesCache {
  get(key: string): CodeReviewFiles | undefined;
  set(key: string, value: CodeReviewFiles): void;
}

export function createFilesCache(ttlMs = FILES_TTL_MS, max = FILES_CACHE_MAX): FilesCache {
  const entries = new Map<string, { value: CodeReviewFiles; expires: number }>();
  return {
    get(key) {
      const hit = entries.get(key);
      if (!hit) return undefined;
      if (hit.expires > Date.now()) return hit.value;
      entries.delete(key);
      return undefined;
    },
    set(key, value) {
      // Map giữ thứ tự chèn: bỏ mục cũ nhất để một PR lớn xem nhiều lần không đẩy bộ nhớ hub lên mãi.
      entries.delete(key);
      while (entries.size >= max) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      entries.set(key, { value, expires: Date.now() + ttlMs });
    },
  };
}

export interface CodeReviewReadDeps {
  providerFactory?: ProviderFactory | undefined;
  masterKey?: MasterKey | undefined;
  runEvidence?: CodeReviewDeps["runEvidence"];
  filesCache?: FilesCache | undefined;
}

export const reviewNotFound = () => new NotFoundError("CODE_REVIEW_NOT_FOUND", "Không tìm thấy phiên review code.");

export async function userReader(tx: Tx, userId: string): Promise<UserReader> {
  return (await readerFor(tx, { kind: "user", userId })) as UserReader;
}

/**
 * Phiên người gọi xem được: thành viên (kể cả người xem) đội sở hữu dự án, quản trị tổ chức (là quản trị mọi đội), và
 * người hay đội được chỉ định duyệt trong bản chụp (vd. đội Pháp chế không thuộc đội dự án) để họ thấy việc được giao.
 */
function canSee(reader: UserReader, review: CodeReviewRow): boolean {
  if (reader.teams.has(review.teamId)) return true;
  const me = reader.principal.userId;
  return flatGates(review.phases).some(
    ({ gate }) => gate.reviewers?.users.includes(me) || gate.reviewers?.teams.some((t) => reader.teams.has(t)),
  );
}

/** Như `canSee`, ở database cho danh sách. */
function visibleWhere(reader: UserReader): SQL {
  const teams = [...reader.teams.keys()];
  const named = sql`jsonb_path_query_array(${codeReviews.phases}, '$[*].gates[*].reviewers.users[*]') ? ${reader.principal.userId}`;
  if (!teams.length) return named;
  const list = sql`array[${sql.join(
    teams.map((t) => sql`${t}`),
    sql`, `,
  )}]::text[]`;
  return or(
    inArray(codeReviews.teamId, teams),
    named,
    sql`jsonb_path_query_array(${codeReviews.phases}, '$[*].gates[*].reviewers.teams[*]') ?| ${list}`,
  ) as SQL;
}

/** Không thấy thì báo như không tồn tại để không lộ PR của đội khác. */
export async function visibleReview(tx: Tx, reader: UserReader, id: string, lock = false): Promise<CodeReviewRow> {
  const q = tx.select().from(codeReviews).where(eq(codeReviews.id, id));
  const [row] = lock ? await q.for("update") : await q;
  if (!row || !canSee(reader, row)) throw reviewNotFound();
  return row;
}

export const isOrgAdmin = (reader: UserReader) => reader.orgRole === "owner" || reader.orgRole === "admin";

/**
 * Được quyết ở checkpoint người duyệt đang chờ (FR-020): người đủ điều kiện chưa duyệt lượt này, không phải người giao
 * việc trừ khi checkpoint cho (Q2). Quản trị tổ chức luôn quyết được.
 */
export function canDecideAt(
  reader: UserReader,
  review: Pick<CodeReviewRow, "status" | "teamId" | "projectId" | "requesterUserId">,
  gate: ReviewGate | undefined,
  run: Pick<CodeReviewGateRunRow, "status" | "approvals"> | null,
): boolean {
  if (review.status !== "in_review" || gate?.kind !== "human" || run?.status !== "waiting") return false;
  const me = reader.principal.userId;
  if (run.approvals.some((a) => a.userId === me)) return false;
  if (isOrgAdmin(reader)) return true;
  if (me === review.requesterUserId && !gate.reviewers?.allowRequester) return false;
  return eligible(reader, gate, { teamId: review.teamId, projectId: review.projectId });
}

/**
 * Checkpoint tự động hiện tại còn quyết thay hoặc chạy lại được (FR-022): đang chờ, hoặc vừa không đạt mà phiên còn
 * dừng ở đó.
 */
export function autoGateOpen(
  review: Pick<CodeReviewRow, "status">,
  gate: ReviewGate | undefined,
  run: Pick<CodeReviewGateRunRow, "status"> | null,
): boolean {
  if (!gate || gate.kind === "human" || !run) return false;
  return (
    (review.status === "in_review" && run.status === "waiting") ||
    (review.status === "changes_requested" && run.status === "failed")
  );
}

/** Quyền theo đội của dự án: vai trò đội như hub vẫn kiểm (`allowWith`), cộng vai trò tự tạo. */
export async function teamPermissions(
  tx: Tx,
  reader: UserReader,
  teamId: string,
): Promise<{ override: boolean; enqueue: boolean }> {
  const role = reader.teams.get(teamId);
  const custom = await customPermissions(tx, reader.principal.userId, teamId);
  return {
    override: role === "admin" || custom.has("reviews.override"),
    enqueue: role === "admin" || role === "member" || custom.has("merge.enqueue"),
  };
}

// ---- Danh sách ---------------------------------------------------------------------------------------------------

/** Checkpoint hiện tại trong bản chụp, tính ở database để lọc "chờ tôi" không phải đọc cả bản chụp mọi phiên. */
const currentGateJson = sql`(jsonb_path_query_array(${codeReviews.phases}, '$[*].gates[*]') -> ${codeReviews.gateIndex})`;

/** Lượt đang chờ của checkpoint hiện tại ở commit hiện tại, như `currentGateRun`. */
const waitingRun = (extra: SQL = sql`true`) =>
  sql`exists (select 1 from hive.code_review_gate_runs g where g.review_id = ${codeReviews.id} and g.gate_index = ${codeReviews.gateIndex} and g.head_sha = ${codeReviews.headSha} and g.status = 'waiting' and ${extra})`;

// Cùng ngưỡng với `slaOf`: sắp hạn khi còn dưới 1/4 thời gian và dưới 8 giờ.
const dueSoon = sql`g.due_at - now() < least((g.due_at - g.started_at) / 4, interval '8 hours')`;
const SLA_FILTER: Record<NonNullable<CodeReviewListInput["sla"]>, SQL> = {
  overdue: sql`g.due_at < now()`,
  "due-soon": sql`g.due_at >= now() and ${dueSoon}`,
  "on-time": sql`g.due_at >= now() and not (${dueSoon})`,
};

/** Thời điểm đủ micro giây cho con trỏ: Date của JS chỉ giữ mili giây nên so lại sẽ bỏ sót hoặc lặp dòng. */
const cursorAt = sql<string>`to_char(${codeReviews.updatedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)~([0-9a-f-]{36})$/i;

function parseCursor(cursor: string): { at: string; id: string } {
  const m = CURSOR.exec(cursor);
  if (!m?.[1] || !m[2]) throw new BadRequestError("BAD_CURSOR", "Con trỏ trang không hợp lệ.");
  return { at: m[1], id: m[2] };
}

const newestFirst = [desc(codeReviews.updatedAt), desc(codeReviews.id)];

interface Lookups {
  names: Map<string, string>;
  tasks: Map<string, { key: string; title: string }>;
  projects: Map<string, { id: string; key: string; name: string }>;
}

async function namesOf(tx: Tx, ids: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((i): i is string => !!i))];
  if (!unique.length) return new Map();
  const rows = await tx
    .select({ id: authUser.id, name: authUser.name })
    .from(authUser)
    .where(inArray(authUser.id, unique));
  return new Map(rows.map((r) => [r.id, r.name]));
}

async function lookups(tx: Tx, rows: CodeReviewRow[], userIds: (string | null)[] = []): Promise<Lookups> {
  const projects = new Map<string, { id: string; key: string; name: string }>();
  // Một trang thường chỉ có vài dự án.
  for (const id of new Set(rows.map((r) => r.projectId))) {
    const p = await findProject(tx, id);
    projects.set(id, p ? { id: p.id, key: p.key, name: p.name } : { id, key: id, name: "Dự án đã xoá" });
  }
  return {
    names: await namesOf(tx, [...rows.map((r) => r.requesterUserId), ...userIds]),
    tasks: await taskSummaries(tx, [...new Set(rows.flatMap((r) => (r.taskId ? [r.taskId] : [])))]),
    projects,
  };
}

async function gateRunsOf(tx: Tx, reviewIds: string[]): Promise<Map<string, CodeReviewGateRunRow[]>> {
  const out = new Map<string, CodeReviewGateRunRow[]>();
  if (!reviewIds.length) return out;
  const rows = await tx
    .select()
    .from(codeReviewGateRuns)
    .where(inArray(codeReviewGateRuns.reviewId, reviewIds))
    .orderBy(asc(codeReviewGateRuns.startedAt), asc(codeReviewGateRuns.gateIndex));
  for (const r of rows) out.set(r.reviewId, [...(out.get(r.reviewId) ?? []), r]);
  return out;
}

/** Lượt bắt đầu sau cùng; `runs` đã xếp theo `started_at` tăng dần. */
const latest = (runs: CodeReviewGateRunRow[]) => runs.at(-1) ?? null;

/** Lượt của checkpoint hiện tại ở commit hiện tại, như `currentGateRun` nhưng trên dữ liệu đã đọc. */
const currentRunOf = (review: CodeReviewRow, runs: CodeReviewGateRunRow[]) =>
  latest(runs.filter((r) => r.gateIndex === review.gateIndex && r.headSha === review.headSha));

/** Phiên còn dừng ở một checkpoint: đang review, hoặc bị trả lại ở đó. */
const atGate = (status: string) => status === "in_review" || status === "changes_requested";

const iso = (d: Date | null) => d?.toISOString() ?? null;

function summarize(
  reader: UserReader,
  review: CodeReviewRow,
  runs: CodeReviewGateRunRow[],
  look: Lookups,
): CodeReviewSummary {
  const flat = flatGates(review.phases);
  const cur = atGate(review.status) ? flat[review.gateIndex] : undefined;
  const run = cur ? currentRunOf(review, runs) : null;
  const ai = latest(runs.filter((r) => r.score !== null));
  const task = review.taskId ? look.tasks.get(review.taskId) : undefined;
  return {
    id: review.id,
    project: look.projects.get(review.projectId) ?? { id: review.projectId, key: review.projectId, name: "" },
    task: task && review.taskId ? { id: review.taskId, ...task } : null,
    pr: {
      number: review.prNumber,
      url: review.prUrl,
      branch: review.branch,
      baseBranch: review.baseBranch,
      headSha: review.headSha,
    },
    workflow: { id: review.workflowId, name: review.workflowName },
    status: review.status as CodeReviewStatus,
    round: review.round,
    gate: cur
      ? {
          id: cur.gate.id,
          name: cur.gate.name,
          kind: cur.gate.kind,
          phase: cur.phase,
          index: cur.index,
          total: flat.length,
          dueAt: iso(run?.dueAt ?? null),
          sla: run?.status === "waiting" ? slaOf(run.dueAt, run.startedAt) : "none",
        }
      : null,
    requester: review.requesterUserId
      ? { userId: review.requesterUserId, name: look.names.get(review.requesterUserId) ?? review.requesterUserId }
      : null,
    awaitingMe: canDecideAt(reader, review, cur?.gate, run),
    aiScore: ai?.score ?? null,
    addedLines: review.addedLines,
    deletedLines: review.deletedLines,
    changedFiles: review.changedFiles,
    createdAt: review.createdAt.toISOString(),
    updatedAt: review.updatedAt.toISOString(),
  };
}

/**
 * Phiên đang chờ người gọi quyết, mới cập nhật trước. Database lọc phiên dừng ở checkpoint người duyệt có lượt đang
 * chờ; điều kiện người duyệt (người, vai trò, đội, người giao việc, đã duyệt chưa) xét ở đây vì nằm trong bản chụp.
 */
async function awaitingIds(tx: Tx, reader: UserReader, where: SQL | undefined): Promise<{ id: string; at: string }[]> {
  const rows = await tx
    .select({
      id: codeReviews.id,
      teamId: codeReviews.teamId,
      projectId: codeReviews.projectId,
      requesterUserId: codeReviews.requesterUserId,
      at: cursorAt,
      gate: sql<unknown>`${currentGateJson}`,
      // Ghi rõ tên bảng: trong danh sách cột drizzle bỏ tên bảng, `id` sẽ trỏ vào `g.id` của truy vấn con.
      approvals: sql<
        { userId: string; at: string }[] | null
      >`(select g.approvals from hive.code_review_gate_runs g where g.review_id = hive.code_reviews.id and g.gate_index = hive.code_reviews.gate_index and g.head_sha = hive.code_reviews.head_sha and g.status = 'waiting' order by g.started_at desc limit 1)`,
    })
    .from(codeReviews)
    .where(and(where, eq(codeReviews.status, "in_review"), sql`${currentGateJson} ->> 'kind' = 'human'`, waitingRun()))
    .orderBy(...newestFirst);
  return rows.flatMap((r) => {
    // Bản chụp lưu từ phiên bản contract cũ hơn: parse lại để trường thêm sau có mặc định, như `flatGates`.
    const parsed = reviewGate.safeParse(r.gate);
    const gate = parsed.success ? parsed.data : undefined;
    const run = r.approvals ? { status: "waiting", approvals: r.approvals } : null;
    return canDecideAt(reader, { ...r, status: "in_review" }, gate, run) ? [{ id: r.id, at: r.at }] : [];
  });
}

/** Hàng "Chờ tôi duyệt" tab Code (FR-018): `mine` là PR chờ người gọi quyết, `all` là mọi phiên người gọi xem được. */
export async function listCodeReviews(
  tx: Tx,
  userId: string,
  raw: CodeReviewListInput,
): Promise<{ items: CodeReviewSummary[]; nextCursor: string | null }> {
  const input = codeReviewListInput.parse(raw);
  const reader = await userReader(tx, userId);
  const after = input.cursor ? parseCursor(input.cursor) : null;
  const where = and(
    visibleWhere(reader),
    input.status ? eq(codeReviews.status, input.status) : undefined,
    input.projectId ? eq(codeReviews.projectId, input.projectId) : undefined,
    input.sla ? waitingRun(SLA_FILTER[input.sla]) : undefined,
    after
      ? sql`(${codeReviews.updatedAt}, ${codeReviews.id}) < (${after.at}::timestamptz, ${after.id}::uuid)`
      : undefined,
  );

  let page: (CodeReviewRow & { at: string })[];
  let more: boolean;
  if (input.scope === "mine") {
    const ids = await awaitingIds(tx, reader, where);
    more = ids.length > input.limit;
    const wanted = ids.slice(0, input.limit);
    const rows = wanted.length
      ? await tx
          .select()
          .from(codeReviews)
          .where(
            inArray(
              codeReviews.id,
              wanted.map((w) => w.id),
            ),
          )
      : [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    page = wanted.flatMap((w) => {
      const r = byId.get(w.id);
      return r ? [{ ...r, at: w.at }] : [];
    });
  } else {
    const rows = await tx
      .select({ ...getTableColumns(codeReviews), at: cursorAt })
      .from(codeReviews)
      .where(where)
      .orderBy(...newestFirst)
      .limit(input.limit + 1);
    more = rows.length > input.limit;
    page = rows.slice(0, input.limit);
  }

  const runs = await gateRunsOf(
    tx,
    page.map((r) => r.id),
  );
  const look = await lookups(tx, page);
  const items = page.map((r) => summarize(reader, r, runs.get(r.id) ?? [], look));
  const last = page.at(-1);
  return { items, nextCursor: more && last ? `${last.at}~${last.id}` : null };
}

/** Số PR chờ người gọi duyệt, cho badge menu "Chờ tôi duyệt" trên web và app. */
export async function countAwaiting(tx: Tx, userId: string): Promise<{ awaitingMe: number }> {
  const reader = await userReader(tx, userId);
  return { awaitingMe: (await awaitingIds(tx, reader, visibleWhere(reader))).length };
}

// ---- Chi tiết ----------------------------------------------------------------------------------------------------

/** Kết quả từng reviewer AI trong `details` của lượt checkpoint AI; mục không đúng dạng (bản cũ) bị bỏ. */
function reviewersOf(run: CodeReviewGateRunRow | null): AiReviewerResult[] {
  return (run?.details ?? []).flatMap((d) => {
    const parsed = aiReviewerResult.safeParse(d);
    return parsed.success ? [parsed.data] : [];
  });
}

/**
 * Kết quả lệnh của checkpoint quy tắc: lấy từ `details` khi đã ghi; không có thì đọc lại `report.commands` của run code
 * ở đúng commit của phiên (vòng do push tay thì không có, FR-017).
 */
function commandsOf(
  run: CodeReviewGateRunRow | null,
  gate: ReviewGate,
  review: CodeReviewRow,
  evidence: RunEvidence | null,
): CheckCommandResult[] {
  if (!run) return [];
  const stored = run.details.flatMap((d) => {
    const parsed = checkCommandResult.safeParse(d);
    return parsed.success ? [parsed.data] : [];
  });
  if (stored.length || !gate.rules?.includes("command")) return stored;
  if (!evidence?.commands || evidence.headSha !== review.headSha) return [];
  const wanted = new Set((gate.commands ?? []).map((c) => c.run));
  return evidence.commands.filter((c) => wanted.has(c.run));
}

const CI_STATES = new Set(["success", "pending", "failure", "none"]);

function ciOf(run: CodeReviewGateRunRow | null): CodeGateRun["ci"] {
  if (!run) return null;
  const state = run.details.map((d) => d.ci).find((s): s is string => typeof s === "string" && CI_STATES.has(s));
  if (state) return { state: state as NonNullable<CodeGateRun["ci"]>["state"], url: null };
  return { state: run.status === "waiting" ? "pending" : "none", url: null };
}

/** Chế độ merge hiệu lực khi phiên đạt (FR-027), như `onApproved`. */
function mergeModeOf(
  review: CodeReviewRow,
  project: Awaited<ReturnType<typeof loadProject>>,
): CodeReviewDetail["mergeMode"] {
  const auto =
    review.options.merge === "project" ? project?.settings.merge.mode === "auto" : review.options.merge === "auto";
  return auto && project?.settings.features.mergeQueue === true ? "auto" : "manual";
}

/** Chi tiết phiên cho người gọi; `decide.ts` dùng lại sau khi ghi để trả trạng thái mới trong cùng transaction. */
export async function detailOf(
  tx: Tx,
  reader: UserReader,
  review: CodeReviewRow,
  deps: CodeReviewReadDeps,
): Promise<CodeReviewDetail> {
  const runs = (await gateRunsOf(tx, [review.id])).get(review.id) ?? [];
  const look = await lookups(
    tx,
    [review],
    runs.flatMap((r) => [r.decidedBy, ...r.approvals.map((a) => a.userId)]),
  );
  const summary = summarize(reader, review, runs, look);
  const flat = flatGates(review.phases);
  const nameOf = (id: string) => look.names.get(id) ?? id;

  const needsEvidence = flat.some(({ gate }) => gate.rules?.includes("command"));
  const evidence = needsEvidence ? ((await deps.runEvidence?.(tx, review.runId)) ?? null) : null;
  const gates: CodeGateRun[] = flat.map(({ gate, phase, index }) => {
    const r = latest(runs.filter((x) => x.gateIndex === index && x.headSha === review.headSha));
    return {
      gateId: gate.id,
      name: gate.name,
      kind: gate.kind,
      phase,
      index,
      // Checkpoint chưa tới lượt chưa có lượt chạy: hiện là chờ nhưng không có thời điểm bắt đầu.
      status: (r?.status as CodeGateRun["status"] | undefined) ?? "waiting",
      score: r?.score ?? null,
      checklist: r?.checklist ?? [],
      approvals: (r?.approvals ?? []).map((a) => ({ userId: a.userId, name: nameOf(a.userId), at: a.at })),
      note: r?.note ?? null,
      decidedBy: r?.decidedBy ? nameOf(r.decidedBy) : null,
      overridden: r?.overridden ?? false,
      dueAt: iso(r?.dueAt ?? null),
      sla: r?.status === "waiting" ? slaOf(r.dueAt, r.startedAt) : "none",
      startedAt: iso(r?.startedAt ?? null),
      finishedAt: iso(r?.finishedAt ?? null),
      reviewers: gate.kind === "ai" ? reviewersOf(r) : [],
      commands: gate.kind === "rule" ? commandsOf(r, gate, review, evidence) : [],
      ci: gate.kind === "ext" ? ciOf(r) : null,
    };
  });

  const rounds = await tx
    .select({
      id: codeReviews.id,
      round: codeReviews.round,
      headSha: codeReviews.headSha,
      status: codeReviews.status,
      runId: codeReviews.runId,
      createdAt: codeReviews.createdAt,
    })
    .from(codeReviews)
    .where(and(eq(codeReviews.projectId, review.projectId), eq(codeReviews.prNumber, review.prNumber)))
    .orderBy(desc(codeReviews.round), desc(codeReviews.createdAt));

  const project = await loadProject(tx, review.projectId);
  const inMergeQueue = (await listQueue(tx, review.projectId)).some(
    (e) => e.prNumber === review.prNumber && e.position !== null,
  );
  const cur = summary.gate ? flat[review.gateIndex] : undefined;
  const curRun = cur ? currentRunOf(review, runs) : null;
  const perms = await teamPermissions(tx, reader, review.teamId);
  const open = autoGateOpen(review, cur?.gate, curRun);
  const options = review.options as Partial<typeof review.options>;

  return {
    ...summary,
    runId: review.runId,
    runReasons: review.runReasons,
    route: (review.route as CodeReviewDetail["route"]) ?? null,
    agentRevisions: review.agentRevisions,
    maxAgentRevisions: options.maxAgentRevisions ?? 2,
    mergeMode: mergeModeOf(review, project),
    inMergeQueue,
    gates,
    rounds: rounds.map((r) => ({
      id: r.id,
      round: r.round,
      headSha: r.headSha,
      status: r.status as CodeReviewStatus,
      runId: r.runId,
      createdAt: r.createdAt.toISOString(),
    })),
    currentGate: cur?.gate ?? null,
    previousGate:
      flat
        .slice(0, review.gateIndex)
        .reverse()
        .find((f) => f.gate.kind === "human")?.gate.id ?? null,
    canDecide: summary.awaitingMe,
    canOverride: perms.override && open,
    canEnqueue:
      perms.enqueue && review.status === "approved" && !inMergeQueue && project?.settings.features.mergeQueue === true,
    canRecheck: open && (perms.override || reader.principal.userId === review.requesterUserId),
  };
}

export async function getCodeReview(
  tx: Tx,
  userId: string,
  id: string,
  deps: CodeReviewReadDeps,
): Promise<CodeReviewDetail> {
  const reader = await userReader(tx, userId);
  return detailOf(tx, reader, await visibleReview(tx, reader, id), deps);
}

// ---- Diff --------------------------------------------------------------------------------------------------------

/** Repo của dự án sở hữu phiên; null khi không đọc được kết nối Git (thiếu khoá chủ, kết nối đã xoá). */
export async function repoOf(
  tx: Tx,
  review: CodeReviewRow,
  deps: Pick<CodeReviewReadDeps, "providerFactory" | "masterKey">,
): Promise<{ provider: GitProvider; ref: RepoRef } | null> {
  if (!deps.providerFactory || !deps.masterKey) return null;
  const project = await loadProject(tx, review.projectId);
  if (!project) return null;
  const conn = await loadConnection(tx, deps.masterKey, project.scmConnectionId);
  if (!conn) return null;
  return { provider: deps.providerFactory(conn), ref: { owner: project.repoOwner, name: project.repoName } };
}

const toPrFile = (f: PullRequestFile): PrFile => ({
  path: f.path,
  previousPath: f.previousPath ?? null,
  status: f.status,
  additions: f.additions,
  deletions: f.deletions,
  patch: f.patch ?? null,
  truncated: f.truncated,
});

/** File và patch của PR lấy từ nhà cung cấp Git (D10), không lưu ở hub; đệm theo `head_sha` của phiên 10 phút. */
export async function codeReviewFiles(
  tx: Tx,
  userId: string,
  id: string,
  deps: CodeReviewReadDeps,
): Promise<CodeReviewFiles> {
  const reader = await userReader(tx, userId);
  const review = await visibleReview(tx, reader, id);
  const key = `${review.id}:${review.headSha}`;
  const hit = deps.filesCache?.get(key);
  if (hit) return hit;
  const repo = await repoOf(tx, review, deps);
  if (!repo) throw new BadRequestError("SCM_UNAVAILABLE", "Không đọc được repo của dự án để lấy diff.");
  let files: PullRequestFile[] | null;
  try {
    files = await repo.provider.prFiles(repo.ref, review.prNumber);
  } catch (e) {
    if (!isGitProviderError(e)) throw e;
    throw new BadRequestError("SCM_ERROR", `Không lấy được diff từ nhà cung cấp Git: ${e.message}`);
  }
  if (!files) throw new NotFoundError("PR_NOT_FOUND", "Không tìm thấy PR trên nhà cung cấp Git.");
  const out: CodeReviewFiles = {
    headSha: review.headSha,
    files: files.map(toPrFile),
    truncated: files.length >= MAX_PR_FILES,
  };
  deps.filesCache?.set(key, out);
  return out;
}
