import { implement } from "@orpc/server";
import {
  contract,
  SDLC_PHASE_KINDS,
  type SdlcCoverage,
  type SdlcMetrics,
  type SdlcPhaseKind,
  type TaskStatus,
} from "@xdev-hive/contracts";
import { and, asc, eq, gte, inArray, isNotNull, lt, ne, type SQL, type SQLWrapper, sql } from "drizzle-orm";
import { loadProject } from "../catalog/index.ts";
import { AI_AUTO_ACTOR, flatGates } from "../knowledge/index.ts";
import { BadRequestError, type RequestContext, type Tx } from "../platform/index.ts";
import { customPermissions, type OrgDeps, orgMiddlewares, teamRolesOf } from "../tenancy/index.ts";
import { projectItemsWhere, type SdlcItemRow, visibleItemsWhere } from "./access.ts";
import { requirementSources } from "./breakdown.ts";
import {
  sdlcArtifacts,
  sdlcAutoApprovals,
  sdlcItemPhases,
  sdlcItems,
  sdlcItemTasks,
  sdlcQuestions,
  sdlcSteps,
  sdlcTraceLinks,
} from "./schema.ts";
import { buildTrace, requirementTexts, type TraceTaskInput } from "./trace.ts";

/*
 * Chỉ số AI SDLC (FR-037, US12). Tập hạng mục là hạng mục người gọi đọc được, tạo trong [from, to), lọc theo chế độ và
 * dự án (gồm hạng mục chỉ có dự án đó tham gia). Số liệu tính lại mỗi lần đọc từ bảng gốc, không có bảng tổng hợp riêng,
 * để không lệch khi phiên duyệt hay task đổi trạng thái ngoài AI SDLC.
 */

type Duration = SdlcMetrics["gateWaitHours"];

const round = (n: number, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits;
const ratio = (n: number, of: number) => (of ? round(n / of, 3) : null);
const mean = (values: readonly number[]) =>
  values.length ? round(values.reduce((s, v) => s + v, 0) / values.length) : null;

/** p50, p90 nội suy tuyến tính như `percentile_cont` của Postgres. */
export function quantiles(values: readonly number[]): Duration {
  if (!values.length) return { p50: null, p90: null, count: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => {
    const pos = (sorted.length - 1) * q;
    const lo = sorted[Math.floor(pos)] ?? 0;
    const hi = sorted[Math.ceil(pos)] ?? lo;
    return round(lo + (hi - lo) * (pos - Math.floor(pos)));
  };
  return { p50: at(0.5), p90: at(0.9), count: sorted.length };
}

/** Gộp độ phủ của nhiều hạng mục, mỗi requirement một phiếu: hạng mục nhiều requirement nặng hơn. */
export function mergeCoverage(list: readonly SdlcCoverage[]): SdlcCoverage | null {
  if (!list.length) return null;
  const total = list.reduce((s, c) => s + c.requirements, 0);
  const pct = (pick: (c: SdlcCoverage) => number) =>
    total ? round(list.reduce((s, c) => s + pick(c) * c.requirements, 0) / total, 1) : 0;
  return {
    requirements: total,
    planned: pct((c) => c.planned),
    done: pct((c) => c.done),
    verified: pct((c) => c.verified),
  };
}

export interface MetricsData {
  items: readonly { modeRef: string; convergeRound: number }[];
  /** Giai đoạn đã duyệt, số giờ từ lúc bắt đầu tới lúc duyệt. */
  phases: readonly { kind: string; hours: number }[];
  questions: number;
  /** Trạng thái cuối của mỗi phiên duyệt tài liệu. */
  reviews: readonly { status: string }[];
  /** Lượt chạy cổng người của phiên duyệt; `hours` null khi chưa xong. */
  humanGates: readonly {
    modeRef: string;
    projectKey: string | null;
    status: string;
    auto: boolean;
    hours: number | null;
  }[];
  autoApprovals: readonly { modeRef: string; projectKey: string | null; revoked: boolean }[];
  coverage: readonly SdlcCoverage[];
  /** Số vòng review code của mỗi PR. */
  prRounds: readonly number[];
  /** null: người gọi không được xem chi phí của hạng mục nào. */
  cost: { usd: number; items: number } | null;
}

/** Hàm thuần: từ dữ liệu đã lọc ra các chỉ số của hợp đồng `sdlc.metrics`. */
export function aggregateMetrics(d: MetricsData): Omit<SdlcMetrics, "from" | "to"> {
  const byKind = new Map<string, number[]>();
  for (const p of d.phases) byKind.set(p.kind, [...(byKind.get(p.kind) ?? []), p.hours]);

  // Chờ cổng là thời gian người duyệt giữ hạng mục; lượt tự duyệt không chờ ai nên không tính vào.
  const waits = d.humanGates.filter((g) => !g.auto && g.hours !== null).map((g) => g.hours ?? 0);
  const decided = d.reviews.filter((r) => r.status === "approved" || r.status === "changes_requested");
  const converged = d.items.filter((i) => i.convergeRound > 0).map((i) => i.convergeRound);

  const groups = new Map<
    string,
    { modeRef: string; projectKey: string | null; passed: number; auto: number; approvals: number; revoked: number }
  >();
  const group = (modeRef: string, projectKey: string | null) => {
    const key = `${modeRef}\u0000${projectKey ?? ""}`;
    let g = groups.get(key);
    if (!g) {
      g = { modeRef, projectKey, passed: 0, auto: 0, approvals: 0, revoked: 0 };
      groups.set(key, g);
    }
    return g;
  };
  for (const r of d.humanGates.filter((r) => r.status === "passed")) {
    const g = group(r.modeRef, r.projectKey);
    g.passed++;
    if (r.auto) g.auto++;
  }
  for (const a of d.autoApprovals) {
    const g = group(a.modeRef, a.projectKey);
    g.approvals++;
    if (a.revoked) g.revoked++;
  }

  return {
    items: d.items.length,
    leadTimeHours: SDLC_PHASE_KINDS.map((kind: SdlcPhaseKind) => ({
      kind,
      duration: quantiles(byKind.get(kind) ?? []),
    })),
    gateWaitHours: quantiles(waits),
    returnRate: ratio(decided.filter((r) => r.status === "changes_requested").length, decided.length),
    questionsPerItem: d.items.length ? round(d.questions / d.items.length) : null,
    coverage: mergeCoverage(d.coverage),
    convergeRounds: mean(converged),
    codeReviewRoundsPerPr: mean(d.prRounds),
    costUsdPerItem: d.cost?.items ? round(d.cost.usd / d.cost.items, 4) : null,
    autoApproval: [...groups.values()]
      .sort((a, b) => a.modeRef.localeCompare(b.modeRef) || (a.projectKey ?? "").localeCompare(b.projectKey ?? ""))
      .map((g) => ({
        modeRef: g.modeRef,
        projectKey: g.projectKey,
        autoRate: ratio(g.auto, g.passed),
        revokeRate: ratio(g.revoked, g.approvals),
      })),
  };
}

// ---- Đọc dữ liệu -----------------------------------------------------------------------------------------------------

export interface MetricsInput {
  projectId?: string | undefined;
  modeRef?: string | undefined;
  from: string;
  to: string;
}

const EMPTY: MetricsData = {
  items: [],
  phases: [],
  questions: 0,
  reviews: [],
  humanGates: [],
  autoApprovals: [],
  coverage: [],
  prRounds: [],
  cost: null,
};

/** Chi phí là thông tin quản trị (như costs.summary): chỉ tính hạng mục của đội người gọi quản trị hoặc có costs.read. */
async function costTeams(tx: Tx, userId: string, teamIds: readonly string[]): Promise<Set<string>> {
  const roles = await teamRolesOf(tx, userId, [...teamIds]);
  const out = new Set<string>();
  for (const teamId of new Set(teamIds))
    if (roles.get(teamId) === "admin" || (await customPermissions(tx, userId, teamId)).has("costs.read"))
      out.add(teamId);
  return out;
}

export async function sdlcMetrics(tx: Tx, userId: string, input: MetricsInput): Promise<SdlcMetrics> {
  const from = new Date(input.from);
  const to = new Date(input.to);
  if (!(from < to))
    throw new BadRequestError(
      "SDLC_METRICS_RANGE",
      "Khoảng thời gian không hợp lệ: ngày bắt đầu phải trước ngày kết thúc.",
    );
  const where: SQL[] = [
    await visibleItemsWhere(tx, userId),
    gte(sdlcItems.createdAt, from),
    lt(sdlcItems.createdAt, to),
  ];
  if (input.projectId) where.push(projectItemsWhere(input.projectId));
  if (input.modeRef) where.push(eq(sdlcItems.modeRef, input.modeRef));
  const items = await tx
    .select()
    .from(sdlcItems)
    .where(and(...where));
  const range = { from: from.toISOString(), to: to.toISOString() };
  if (!items.length) return { ...range, ...aggregateMetrics(EMPTY) };
  const data = await loadMetricsData(tx, userId, items, input.projectId);
  return { ...range, ...aggregateMetrics(data) };
}

async function loadMetricsData(
  tx: Tx,
  userId: string,
  items: readonly SdlcItemRow[],
  projectId: string | undefined,
): Promise<MetricsData> {
  const ids = items.map((i) => i.id);
  const modeOf = new Map(items.map((i) => [i.id, i.modeRef]));
  const inProject = (col: SQLWrapper) => (projectId ? sql`and ${col} = ${projectId}` : sql``);

  const phases = await tx
    .select({
      kind: sdlcItemPhases.kind,
      hours: sql<number>`extract(epoch from ${sdlcItemPhases.approvedAt} - ${sdlcItemPhases.startedAt})::float / 3600`,
    })
    .from(sdlcItemPhases)
    .where(
      and(
        inArray(sdlcItemPhases.itemId, ids),
        eq(sdlcItemPhases.status, "approved"),
        isNotNull(sdlcItemPhases.startedAt),
        isNotNull(sdlcItemPhases.approvedAt),
      ),
    );

  const [questions] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(sdlcQuestions)
    .where(and(inArray(sdlcQuestions.itemId, ids), ne(sdlcQuestions.status, "withdrawn")));

  // Phiên duyệt thuộc knowledge; sdlc chỉ đọc bằng SQL theo `doc_key` của tài liệu, như autoapprove.ts.
  const { rows: reviews } = await tx.execute<{
    id: string;
    status: string;
    phases: Parameters<typeof flatGates>[0];
    itemId: string;
    projectId: string;
  }>(
    sql`select ri.id, ri.status, ri.phases, ${sdlcArtifacts.itemId} as "itemId", ${sdlcArtifacts.projectId} as "projectId"
        from hive.review_instances ri join ${sdlcArtifacts} on ${sdlcArtifacts.docKey} = ri.doc_key
        where ${inArray(sdlcArtifacts.itemId, ids)} ${inProject(sdlcArtifacts.projectId)}`,
  );

  const keys = new Map<string, string | null>();
  const keyOf = async (id: string) => {
    if (!keys.has(id)) keys.set(id, (await loadProject(tx, id))?.key ?? null);
    return keys.get(id) ?? null;
  };

  const humanGates: MetricsData["humanGates"][number][] = [];
  if (reviews.length) {
    const gateRuns = await tx.execute<{
      instanceId: string;
      gateIndex: number;
      status: string;
      decidedBy: string | null;
      hours: number | null;
    }>(
      sql`select instance_id as "instanceId", gate_index as "gateIndex", status, decided_by as "decidedBy",
            extract(epoch from finished_at - started_at)::float / 3600 as hours
          from hive.review_gate_runs where instance_id in ${reviews.map((r) => r.id)}`,
    );
    const reviewOf = new Map(reviews.map((r) => [r.id, { ...r, gates: flatGates(r.phases) }]));
    for (const g of gateRuns.rows) {
      const r = reviewOf.get(g.instanceId);
      if (r?.gates[g.gateIndex]?.gate.kind !== "human") continue;
      humanGates.push({
        modeRef: modeOf.get(r.itemId) ?? "",
        projectKey: await keyOf(r.projectId),
        status: g.status,
        auto: g.decidedBy === AI_AUTO_ACTOR,
        hours: g.hours,
      });
    }
  }

  const approvals = await tx
    .select({
      itemId: sdlcAutoApprovals.itemId,
      projectId: sdlcArtifacts.projectId,
      revoked: sql<boolean>`${sdlcAutoApprovals.revokedAt} is not null`,
    })
    .from(sdlcAutoApprovals)
    .innerJoin(sdlcArtifacts, eq(sdlcArtifacts.id, sdlcAutoApprovals.artifactId))
    .where(and(inArray(sdlcAutoApprovals.itemId, ids), projectId ? eq(sdlcArtifacts.projectId, projectId) : undefined));
  const autoApprovals: MetricsData["autoApprovals"][number][] = [];
  for (const a of approvals)
    autoApprovals.push({
      modeRef: modeOf.get(a.itemId) ?? "",
      projectKey: await keyOf(a.projectId),
      revoked: a.revoked,
    });

  const itemTasks = sql`select ${sdlcItemTasks.taskId} from ${sdlcItemTasks} where ${inArray(sdlcItemTasks.itemId, ids)}`;
  const { rows: prRounds } = await tx.execute<{ rounds: number }>(
    sql`select max(round)::int as rounds from hive.code_reviews
        where task_id in (${itemTasks}) ${inProject(sql`project_id`)}
        group by project_id, pr_number`,
  );

  return {
    items,
    phases,
    questions: questions?.n ?? 0,
    reviews,
    humanGates,
    autoApprovals,
    coverage: await coverageOf(tx, userId, items, projectId),
    prRounds: prRounds.map((r) => r.rounds),
    cost: await costOf(tx, userId, items, projectId),
  };
}

/** Độ phủ của từng hạng mục đã có bản tách, tính như ma trận truy vết (`buildTrace`). */
async function coverageOf(
  tx: Tx,
  userId: string,
  items: readonly SdlcItemRow[],
  projectId: string | undefined,
): Promise<SdlcCoverage[]> {
  const withBreakdown = items.filter((i) => i.mode.decomposition);
  if (!withBreakdown.length) return [];
  const links = await tx
    .select({
      itemId: sdlcItemTasks.itemId,
      taskId: sdlcItemTasks.taskId,
      projectId: sdlcItemTasks.projectId,
      requirementIds: sdlcItemTasks.requirementIds,
    })
    .from(sdlcItemTasks)
    .where(
      and(
        inArray(
          sdlcItemTasks.itemId,
          withBreakdown.map((i) => i.id),
        ),
        eq(sdlcItemTasks.removed, false),
      ),
    );
  if (!links.length) return [];
  // sdlc không import tasks để đọc hàng loạt; một truy vấn cho mọi task thay vì loadTask từng cái.
  const { rows: statuses } = await tx.execute<{ id: string; status: TaskStatus }>(
    sql`select id, status from hive.tasks where id in ${links.map((l) => l.taskId)}`,
  );
  const statusOf = new Map(statuses.map((t) => [t.id, t.status]));
  const tasksOf = new Map<string, TraceTaskInput[]>();
  for (const l of links) {
    const status = statusOf.get(l.taskId);
    if (!status || status === "cancelled") continue;
    const task = {
      taskId: l.taskId,
      key: "",
      projectId: l.projectId,
      projectKey: "",
      status,
      requirementIds: l.requirementIds,
    };
    tasksOf.set(l.itemId, [...(tasksOf.get(l.itemId) ?? []), task]);
  }
  const traced = withBreakdown.filter((i) => tasksOf.has(i.id));
  if (!traced.length) return [];
  const traceLinks = await tx
    .select()
    .from(sdlcTraceLinks)
    .where(
      and(
        inArray(
          sdlcTraceLinks.itemId,
          traced.map((i) => i.id),
        ),
        inArray(sdlcTraceLinks.kind, ["run", "pr", "commit", "test", "ci", "finding"]),
      ),
    )
    .orderBy(asc(sdlcTraceLinks.createdAt), asc(sdlcTraceLinks.id));
  const out: SdlcCoverage[] = [];
  for (const item of traced) {
    const d = item.mode.decomposition;
    if (!d) continue;
    const requirements = requirementTexts(
      await requirementSources(tx, { kind: "user", userId }, item, d),
      d.requirementId,
    );
    const trace = buildTrace({
      itemId: item.id,
      requirements,
      tasks: tasksOf.get(item.id) ?? [],
      links: traceLinks.filter((l) => l.itemId === item.id),
      projects: [],
      projectId,
    });
    out.push(trace.total);
  }
  return out;
}

/** Chi phí run của hạng mục: run code của task, run các bước soạn và run AI chấm tài liệu. */
async function costOf(
  tx: Tx,
  userId: string,
  items: readonly SdlcItemRow[],
  projectId: string | undefined,
): Promise<MetricsData["cost"]> {
  const allowed = await costTeams(
    tx,
    userId,
    items.map((i) => i.teamId),
  );
  const ids = items.filter((i) => allowed.has(i.teamId)).map((i) => i.id);
  if (!ids.length) return null;
  const [row] = (
    await tx.execute<{ usd: number }>(
      sql`select coalesce(sum(r.cost_usd), 0)::float as usd from hive.runs r
          where (r.task_id in (select ${sdlcItemTasks.taskId} from ${sdlcItemTasks} where ${inArray(sdlcItemTasks.itemId, ids)})
            or r.id in (select ${sdlcSteps.runId} from ${sdlcSteps} where ${inArray(sdlcSteps.itemId, ids)} and ${sdlcSteps.runId} is not null)
            or r.id in (select g.run_id from hive.review_gate_runs g
                          join hive.review_instances ri on ri.id = g.instance_id
                          join ${sdlcArtifacts} on ${sdlcArtifacts.docKey} = ri.doc_key
                        where ${inArray(sdlcArtifacts.itemId, ids)} and g.run_id is not null))
          ${projectId ? sql`and r.project_id = ${projectId}` : sql``}`,
    )
  ).rows;
  return { usd: row?.usd ?? 0, items: ids.length };
}

export function metricsRoute(deps: OrgDeps) {
  const { authed, inOrg } = orgMiddlewares(deps);
  const os = implement(contract.sdlc).$context<RequestContext>().use(authed).use(inOrg);
  return os.metrics.handler(({ context: { tx, user }, input }) => sdlcMetrics(tx, user.id, input));
}
