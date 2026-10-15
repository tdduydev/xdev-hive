import { implement } from "@orpc/server";
import {
  contract,
  findRequirements,
  type SdlcCoverage,
  type SdlcTrace,
  type SdlcTraceRow,
  type TaskStatus,
} from "@xdev-hive/contracts";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { RequestContext, Tx } from "../platform/index.ts";
import { loadTask } from "../tasks/index.ts";
import { type OrgDeps, orgMiddlewares } from "../tenancy/index.ts";
import { itemForUser } from "./access.ts";
import { itemProjectRefs, requirementSources } from "./breakdown.ts";
import { sdlcItemTasks, sdlcTraceLinks } from "./schema.ts";

/*
 * Truy vết requirement → task → run → PR → commit → test/CI (FR-034, plan.md "Luồng" bước 7). Liên kết ghi dần theo sự
 * kiện (bản tách, run kết luận, PR merge, CI); ma trận và độ phủ tính lại mỗi lần đọc từ liên kết và trạng thái task để
 * không lệch khi task đổi trạng thái ngoài AI SDLC.
 */

export type TraceKind = "task" | "run" | "pr" | "commit" | "test" | "ci" | "finding";
type CiState = "success" | "failure" | "pending" | "none";

export interface TraceLinkInput {
  orgId: string;
  itemId: string;
  requirementIds: readonly string[];
  kind: TraceKind;
  ref: string;
  projectId: string;
  taskId: string;
  runId?: string | null;
  data?: Record<string, unknown>;
}

/** Ghi lại liên kết đã có thì cập nhật `data` (vd. CI từ `pending` thành `success`), không tạo dòng trùng. */
export async function linkTrace(tx: Tx, input: TraceLinkInput): Promise<void> {
  const reqs = [...new Set(input.requirementIds)];
  if (!reqs.length || !input.ref) return;
  await tx
    .insert(sdlcTraceLinks)
    .values(
      reqs.map((requirementId) => ({
        orgId: input.orgId,
        itemId: input.itemId,
        requirementId,
        kind: input.kind,
        ref: input.ref,
        projectId: input.projectId,
        taskId: input.taskId,
        runId: input.runId ?? null,
        data: input.data ?? {},
      })),
    )
    .onConflictDoUpdate({
      target: [sdlcTraceLinks.itemId, sdlcTraceLinks.requirementId, sdlcTraceLinks.kind, sdlcTraceLinks.ref],
      set: { data: sql`excluded.data`, runId: sql`coalesce(excluded.run_id, ${sdlcTraceLinks.runId})` },
    });
}

/** Task còn trong bản tách của hạng mục (task bị bỏ không ghi truy vết mới). */
export async function itemTaskOf(tx: Tx, taskId: string) {
  const [link] = await tx
    .select()
    .from(sdlcItemTasks)
    .where(and(eq(sdlcItemTasks.taskId, taskId), eq(sdlcItemTasks.removed, false)));
  return link ?? null;
}

/** Evidence trong `task_update` của run (mọi lần chạy lại): requirement agent nói đã làm, test đã chạy. */
async function evidenceOf(tx: Tx, runId: string): Promise<{ requirements: string[]; tests: string[] }> {
  // sdlc không import runs (runs gọi sdlc khi kết luận run); đọc sự kiện bằng SQL.
  const { rows } = await tx.execute<{ data: { evidence?: { requirements?: unknown; tests?: unknown } } }>(
    sql`select data from hive.run_events where run_id = ${runId} and type = 'agent_report' order by id`,
  );
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);
  return {
    requirements: [...new Set(rows.flatMap((r) => strings(r.data.evidence?.requirements)))],
    tests: [...new Set(rows.flatMap((r) => strings(r.data.evidence?.tests)))],
  };
}

export interface SettledRun {
  id: string;
  taskId: string | null;
  projectId: string;
  state: string;
  prUrl: string | null;
}

/**
 * `runs` gọi trong transaction kết luận run code (D17): liên kết `run`, `pr`, và `test` từ evidence. Test gắn vào
 * requirement agent nêu trong evidence nếu thuộc task, không nêu thì gắn mọi requirement của task.
 */
export async function traceSettledRun(tx: Tx, run: SettledRun): Promise<void> {
  if (!run.taskId) return;
  const link = await itemTaskOf(tx, run.taskId);
  if (!link) return;
  const base = {
    orgId: link.orgId,
    itemId: link.itemId,
    projectId: link.projectId,
    taskId: link.taskId,
    runId: run.id,
  };
  await linkTrace(tx, {
    ...base,
    requirementIds: link.requirementIds,
    kind: "run",
    ref: run.id,
    data: { state: run.state },
  });
  if (run.prUrl) await linkTrace(tx, { ...base, requirementIds: link.requirementIds, kind: "pr", ref: run.prUrl });
  const evidence = await evidenceOf(tx, run.id);
  if (!evidence.tests.length) return;
  const named = evidence.requirements.filter((r) => link.requirementIds.includes(r));
  for (const test of evidence.tests)
    await linkTrace(tx, {
      ...base,
      requirementIds: named.length ? named : link.requirementIds,
      kind: "test",
      ref: test.slice(0, 500),
    });
}

// ---- Ma trận, độ phủ --------------------------------------------------------------------------------------------------

export interface TraceTaskInput {
  taskId: string;
  key: string;
  projectId: string;
  projectKey: string;
  status: TaskStatus;
  requirementIds: readonly string[];
}

export interface TraceLinkRow {
  requirementId: string;
  kind: string;
  ref: string;
  taskId: string | null;
  runId: string | null;
  data: Record<string, unknown>;
}

export interface TraceInput {
  itemId: string;
  /** Requirement của tài liệu nguồn theo thứ tự xuất hiện; requirement chỉ có trong task được thêm vào cuối. */
  requirements: readonly { id: string; text: string }[];
  tasks: readonly TraceTaskInput[];
  /** Liên kết theo thứ tự tạo: liên kết sau thay liên kết trước cùng loại (run mới nhất, CI mới nhất). */
  links: readonly TraceLinkRow[];
  /** Thứ tự dự án trong `byProject` (dự án chính trước). */
  projects: readonly { id: string; key: string }[];
  projectId?: string | undefined;
}

const percent = (n: number, of: number) => (of ? Math.round((n / of) * 1000) / 10 : 0);
const FINDING_STATUSES = new Set(["met", "partial", "missing", "contradicts"]);

/**
 * Ma trận truy vết và độ phủ ba mức (SC-006), hàm thuần. `planned`: có task; `done`: mọi task chứa requirement `done`;
 * `verified`: đã xong và mọi task có test hoặc CI xanh, hoặc lần converge gần nhất kết luận `met`. Theo dự án: mẫu số là
 * mọi requirement của hạng mục (như màn bản tách), tử số chỉ xét task của dự án đó.
 */
export function buildTrace(input: TraceInput): Omit<SdlcTrace, "csv"> {
  const tasks = input.projectId ? input.tasks.filter((t) => t.projectId === input.projectId) : input.tasks;
  const reqs = [...input.requirements];
  const known = new Set(reqs.map((r) => r.id));
  for (const t of input.tasks)
    for (const id of t.requirementIds)
      if (!known.has(id)) {
        known.add(id);
        reqs.push({ id, text: "" });
      }

  const linksOf = new Map<string, TraceLinkRow[]>();
  for (const l of input.links) {
    const k = `${l.requirementId}\u0000${l.taskId ?? ""}`;
    linksOf.set(k, [...(linksOf.get(k) ?? []), l]);
  }
  const last = (ls: readonly TraceLinkRow[], kind: string) => ls.filter((l) => l.kind === kind).at(-1) ?? null;

  type Cell = SdlcTraceRow["tasks"][number] & { projectId: string };
  const rows: (Omit<SdlcTraceRow, "tasks"> & { cells: Cell[] })[] = reqs.map((r) => {
    const cells: Cell[] = tasks
      .filter((t) => t.requirementIds.includes(r.id))
      .map((t) => {
        const ls = linksOf.get(`${r.id}\u0000${t.taskId}`) ?? [];
        const run = last(ls, "run");
        const ci = last(ls, "ci")?.data.state;
        return {
          taskId: t.taskId,
          key: t.key,
          projectId: t.projectId,
          projectKey: t.projectKey,
          status: t.status,
          runId: run?.runId ?? run?.ref ?? null,
          prUrl: last(ls, "pr")?.ref ?? null,
          mergeSha: last(ls, "commit")?.ref ?? null,
          tests: [...new Set(ls.filter((l) => l.kind === "test").map((l) => l.ref))],
          ci: ci === "success" || ci === "failure" || ci === "pending" ? ci : "none",
        };
      });
    const findings = input.links
      .filter((l) => l.requirementId === r.id && l.kind === "finding" && FINDING_STATUSES.has(String(l.data.status)))
      .map((l) => ({
        status: l.data.status as SdlcTraceRow["findings"][number]["status"],
        evidence: typeof l.data.evidence === "string" ? l.data.evidence : "",
        round: typeof l.data.round === "number" ? l.data.round : 0,
      }))
      .sort((a, b) => a.round - b.round);
    return { requirementId: r.id, text: r.text, findings, cells, ...levels(cells, findings.at(-1)?.status) };
  });

  const coverageOf = (pick: (cells: Cell[]) => Cell[]): SdlcCoverage => {
    const lv = rows.map((r) => levels(pick(r.cells), r.findings.at(-1)?.status));
    return {
      requirements: rows.length,
      planned: percent(lv.filter((l) => l.planned).length, rows.length),
      done: percent(lv.filter((l) => l.done).length, rows.length),
      verified: percent(lv.filter((l) => l.verified).length, rows.length),
    };
  };
  const projects = input.projects.filter((p) => !input.projectId || p.id === input.projectId);
  return {
    itemId: input.itemId,
    rows: rows.map(({ cells, ...r }) => ({ ...r, tasks: cells.map(({ projectId: _, ...c }) => c) })),
    total: coverageOf((cells) => cells),
    byProject: projects.map((p) => ({
      projectKey: p.key,
      coverage: coverageOf((cells) => cells.filter((c) => c.projectId === p.id)),
    })),
  };
}

function levels(
  cells: readonly { status: string; tests: readonly string[]; ci: CiState }[],
  finding: string | undefined,
): { planned: boolean; done: boolean; verified: boolean } {
  const planned = cells.length > 0;
  const done = planned && cells.every((c) => c.status === "done");
  const proven = cells.every((c) => c.tests.length > 0 || c.ci === "success");
  return { planned, done, verified: done && (proven || finding === "met") };
}

/** Câu chữ của requirement: dòng đầu tiên nêu mã, bỏ dấu đầu dòng Markdown. */
export function requirementTexts(sources: readonly string[], pattern: string): { id: string; text: string }[] {
  const out = new Map<string, string>();
  for (const content of sources)
    for (const line of content.split("\n"))
      for (const id of findRequirements(line, pattern) ?? [])
        if (!out.has(id))
          out.set(
            id,
            line
              .replace(/^\s*(?:[-*+>|#]+|\d+[.)])\s*/, "")
              .replace(/\s*\|\s*$/, "")
              .trim()
              .slice(0, 500),
          );
  return [...out].map(([id, text]) => ({ id, text }));
}

// Excel, Sheets chạy ô bắt đầu bằng = + - @ như công thức; thêm nháy đơn để mở file từ hub không chạy lệnh.
const csvCell = (v: string) => {
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};

const yes = (b: boolean) => (b ? "có" : "không");

/** CSV một dòng mỗi (requirement, task), có cột dự án; requirement chưa có task vẫn có một dòng. */
export function traceCsv(trace: Pick<SdlcTrace, "rows">): string {
  const header = [
    "requirement",
    "nội dung",
    "dự án",
    "task",
    "trạng thái",
    "run",
    "PR",
    "commit",
    "test",
    "CI",
    "kế hoạch",
    "đã làm",
    "đã kiểm",
  ];
  const lines = [header];
  for (const r of trace.rows) {
    const tail = [yes(r.planned), yes(r.done), yes(r.verified)];
    if (!r.tasks.length) lines.push([r.requirementId, r.text, "", "", "", "", "", "", "", "", ...tail]);
    for (const t of r.tasks)
      lines.push([
        r.requirementId,
        r.text,
        t.projectKey,
        t.key,
        t.status,
        t.runId ?? "",
        t.prUrl ?? "",
        t.mergeSha ?? "",
        t.tests.join("; "),
        t.ci,
        ...tail,
      ]);
  }
  return `${lines.map((l) => l.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

/** `trace`: ma trận của hạng mục cho người đọc được hạng mục; `projectId` lọc task và độ phủ theo dự án. */
export async function getTrace(
  tx: Tx,
  userId: string,
  input: { id: string; projectId?: string | undefined; format?: "json" | "csv" | undefined },
): Promise<SdlcTrace> {
  const item = await itemForUser(tx, userId, input.id);
  const d = item.mode.decomposition;
  const requirements = d
    ? requirementTexts(await requirementSources(tx, { kind: "user", userId }, item, d), d.requirementId)
    : [];
  const projects = await itemProjectRefs(tx, item.id);
  const keyOf = new Map(projects.map((p) => [p.id, p.key]));
  const itemTasks = await tx
    .select()
    .from(sdlcItemTasks)
    .where(and(eq(sdlcItemTasks.itemId, item.id), eq(sdlcItemTasks.removed, false)))
    .orderBy(asc(sdlcItemTasks.wave), asc(sdlcItemTasks.sliceKey));
  const tasks: TraceTaskInput[] = [];
  for (const l of itemTasks) {
    const task = await loadTask(tx, l.taskId);
    if (!task || task.status === "cancelled") continue;
    tasks.push({
      taskId: task.id,
      key: task.key,
      projectId: l.projectId,
      projectKey: keyOf.get(l.projectId) ?? "",
      status: task.status,
      requirementIds: l.requirementIds,
    });
  }
  const links = tasks.length
    ? await tx
        .select()
        .from(sdlcTraceLinks)
        .where(
          and(
            eq(sdlcTraceLinks.itemId, item.id),
            inArray(sdlcTraceLinks.kind, ["run", "pr", "commit", "test", "ci", "finding"]),
          ),
        )
        .orderBy(asc(sdlcTraceLinks.createdAt), asc(sdlcTraceLinks.id))
    : [];
  const trace = buildTrace({ itemId: item.id, requirements, tasks, links, projects, projectId: input.projectId });
  return { ...trace, csv: input.format === "csv" ? traceCsv(trace) : null };
}

export function traceRoute(deps: OrgDeps) {
  const { authed, inOrg } = orgMiddlewares(deps);
  const os = implement(contract.sdlc).$context<RequestContext>().use(authed).use(inOrg);
  return os.trace.handler(({ context: { tx, user }, input }) => getTrace(tx, user.id, input));
}
