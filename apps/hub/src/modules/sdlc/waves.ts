import { implement } from "@orpc/server";
import { contract, TERMINAL_RUN_STATES } from "@xdev-hive/contracts";
import { eq, sql } from "drizzle-orm";
import { recordAudit } from "../audit/index.ts";
import { loadProject } from "../catalog/index.ts";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  type RequestContext,
  type Tx,
  withTenant,
} from "../platform/index.ts";
import { dependenciesOf, loadTask, type TaskRow, taskForUser } from "../tasks/index.ts";
import { type OrgDeps, orgMiddlewares } from "../tenancy/index.ts";
import { activeItemProjects, itemForUser, type SdlcItemRow } from "./access.ts";
import { lockItem, type SdlcDeps } from "./phases.ts";
import { sdlcItemTasks } from "./schema.ts";

/*
 * Chạy đợt task của hạng mục (specs/011 plan.md "Luồng" bước 6, D24). Task sẵn sàng là task `todo` có mọi phụ thuộc
 * `done` (kể cả task của dự án khác) và không có run code đang chạy; mỗi dự án tự giới hạn `maxParallel` của mình vì
 * máy, quota và người review là của đội sở hữu dự án.
 */

const SYSTEM_ACTOR = "system:sdlc";

export interface WaveResult {
  started: { taskId: string; runId: string }[];
  skipped: { taskId: string; key: string; reason: string }[];
}

/** Người bấm "Chạy đợt", hoặc hub tự chạy khi task `done` (chỉ dự án bật `autoRunWaves`). */
export type WaveActor = { kind: "user"; userId: string } | { kind: "system" };

export interface WaveOptions {
  projectId?: string | undefined;
  /**
   * Task vừa merge trong cùng transaction: handler `pull_request.merged` của `runs` có thể chạy sau handler của `sdlc`
   * (thứ tự đăng ký do `main.ts` quyết) nên task chưa kịp `done`.
   */
  assumeDone?: ReadonlySet<string> | undefined;
}

interface Candidate {
  task: TaskRow;
  projectId: string;
  wave: number;
  sliceKey: string;
}

/** Lỗi nghiệp vụ khi tạo run (cổng chặn, ngân sách, task đã đóng, dự án chưa sẵn sàng) thành lý do bỏ qua. */
const skippable = (e: unknown): e is Error =>
  e instanceof ConflictError ||
  e instanceof ForbiddenError ||
  e instanceof NotFoundError ||
  e instanceof BadRequestError;

/**
 * Savepoint quanh mỗi lần tạo run: một task lỗi (vd. vi phạm ràng buộc khi có run khác vừa chen vào) không làm hỏng
 * transaction của cả đợt. Drizzle `transaction()` trên client đang trong transaction không lồng được.
 */
async function inSavepoint<T>(tx: Tx, fn: () => Promise<T>): Promise<T> {
  await tx.execute(sql`savepoint sdlc_wave_start`);
  try {
    const out = await fn();
    await tx.execute(sql`release savepoint sdlc_wave_start`);
    return out;
  } catch (e) {
    await tx.execute(sql`rollback to savepoint sdlc_wave_start`);
    throw e;
  }
}

/** Run code theo task: còn chạy hay không, và task đã từng có run chưa (hub tự chạy không thử lại task đã có run lỗi). */
async function codeRunsOf(tx: Tx, taskIds: readonly string[]) {
  if (!taskIds.length) return new Map<string, { active: number; any: boolean }>();
  // sdlc không import runs (runs gọi cổng của sdlc); đọc bằng SQL như breakdown.ts.
  const { rows } = await tx.execute<{ task_id: string; active: number; total: number }>(
    sql`select task_id, count(*) filter (where state not in ${[...TERMINAL_RUN_STATES]})::int as active, count(*)::int as total
        from hive.runs where task_id in ${taskIds} and kind = 'code' group by task_id`,
  );
  return new Map(rows.map((r) => [r.task_id, { active: r.active, any: r.total > 0 }]));
}

/**
 * Tạo run cho task sẵn sàng của hạng mục. Trả `afterCommit` của các run vừa tạo; người gọi chạy sau khi transaction
 * commit (đẩy gói tới máy). Hạng mục phải đang khoá `FOR UPDATE` để hai đợt chạy cùng lúc không vượt `maxParallel`.
 */
export async function startWave(
  tx: Tx,
  item: SdlcItemRow,
  actor: WaveActor,
  deps: SdlcDeps,
  opts: WaveOptions = {},
): Promise<WaveResult & { afterCommit: (() => void)[] }> {
  const result: WaveResult & { afterCommit: (() => void)[] } = { started: [], skipped: [], afterCommit: [] };
  const startTaskRun = deps.startTaskRun;
  if (!startTaskRun) {
    if (actor.kind === "system") return result;
    throw new ConflictError("SDLC_WAVES_UNAVAILABLE", "Hub chưa bật chạy đợt task.");
  }
  const assumeDone = opts.assumeDone ?? new Set<string>();
  const projects = (await activeItemProjects(tx, item.id)).filter(
    (p) => !opts.projectId || p.projectId === opts.projectId,
  );
  const settingsOf = new Map(projects.map((p) => [p.projectId, p.settings]));
  const links = (await tx.select().from(sdlcItemTasks).where(eq(sdlcItemTasks.itemId, item.id))).filter(
    (l) => !l.removed && settingsOf.has(l.projectId),
  );
  const ids = links.map((l) => l.taskId);
  const depsOf = await dependenciesOf(tx, ids);
  const runsOf = await codeRunsOf(tx, ids);

  // Run đang chạy của dự án trong hạng mục chiếm chỗ song song, kể cả run người giao tay ngoài đợt.
  const busy = new Map<string, number>();
  const ready: Candidate[] = [];
  for (const l of links) {
    const runs = runsOf.get(l.taskId);
    busy.set(l.projectId, (busy.get(l.projectId) ?? 0) + (runs?.active ?? 0));
    if (assumeDone.has(l.taskId) || runs?.active) continue;
    if (actor.kind === "system" && runs?.any) continue;
    const blocked = (depsOf.get(l.taskId)?.blockedBy ?? []).some((b) => !assumeDone.has(b.id));
    if (blocked) continue;
    const task = await loadTask(tx, l.taskId);
    if (task?.status !== "todo") continue;
    ready.push({ task, projectId: l.projectId, wave: l.wave, sliceKey: l.sliceKey });
  }
  ready.sort((a, b) => a.wave - b.wave || a.sliceKey.localeCompare(b.sliceKey));

  for (const p of projects) {
    const settings = p.settings;
    const mine = ready.filter((c) => c.projectId === p.projectId);
    if (!mine.length || (actor.kind === "system" && !settings.autoRunWaves)) continue;
    const projectKey = (await loadProject(tx, p.projectId))?.key ?? "";
    const skip = (list: Candidate[], reason: string) => {
      for (const c of list) result.skipped.push({ taskId: c.task.id, key: c.task.key, reason });
    };
    if (actor.kind === "user" && !(await canAssign(tx, actor.userId, mine[0]?.task.id ?? ""))) {
      skip(mine, `Bạn không có quyền giao task ở dự án ${projectKey}.`);
      continue;
    }
    const slots = Math.max(0, settings.maxParallel - (busy.get(p.projectId) ?? 0));
    skip(mine.slice(slots), `Dự án ${projectKey} đang chạy đủ ${settings.maxParallel} run song song.`);
    for (const c of mine.slice(0, slots)) {
      const userId = actor.kind === "user" ? actor.userId : null;
      try {
        const run = await inSavepoint(tx, () =>
          startTaskRun(tx, {
            taskId: c.task.id,
            ownerUserId: settings.runner === "requester" ? (userId ?? item.ownerUserId) : null,
            requiredLabels: settings.labels,
            createdBy: userId ?? SYSTEM_ACTOR,
            actorUserId: userId,
          }),
        );
        result.started.push({ taskId: c.task.id, runId: run.runId });
        result.afterCommit.push(run.afterCommit);
      } catch (e) {
        if (!skippable(e)) throw e;
        result.skipped.push({ taskId: c.task.id, key: c.task.key, reason: e.message });
      }
    }
  }
  if (result.started.length || (actor.kind === "user" && result.skipped.length))
    await recordAudit(tx, {
      action: "sdlc.wave.run",
      ...(actor.kind === "system" ? { actorUserId: null } : {}),
      targetType: "sdlc_item",
      targetId: item.id,
      data: {
        via: actor.kind,
        projectId: opts.projectId ?? null,
        started: result.started.map((s) => s.taskId),
        skipped: result.skipped.map((s) => s.taskId),
      },
    });
  return result;
}

/** Quyền giao task ở dự án như `runs.start`: thử trên một task của dự án vì quyền tính theo đội của dự án. */
async function canAssign(tx: Tx, userId: string, taskId: string): Promise<boolean> {
  try {
    await taskForUser(tx, userId, taskId, "member", "tasks.assign");
    return true;
  } catch (e) {
    if (e instanceof ForbiddenError || e instanceof NotFoundError) return false;
    throw e;
  }
}

/** `waves.run`: người đọc được hạng mục chạy đợt; task của dự án họ không có quyền giao bị bỏ qua, báo lại. */
export async function runWave(
  tx: Tx,
  userId: string,
  input: { id: string; projectId?: string | undefined },
  deps: SdlcDeps,
): Promise<WaveResult & { afterCommit: (() => void)[] }> {
  const item = await itemForUser(tx, userId, input.id, true);
  if (item.status !== "active")
    throw new ConflictError(
      "SDLC_ITEM_NOT_ACTIVE",
      item.status === "paused" ? "Hạng mục đang tạm dừng, tiếp tục rồi mới chạy đợt." : "Hạng mục đã xong hoặc đã huỷ.",
    );
  return startWave(tx, item, { kind: "user", userId }, deps, { projectId: input.projectId });
}

/** Hub tự chạy đợt kế khi task `done`; hạng mục tạm dừng hay đã đóng thì không làm gì. */
export async function autoWave(
  tx: Tx,
  itemId: string,
  deps: SdlcDeps,
  assumeDone: ReadonlySet<string> = new Set(),
): Promise<(() => void)[]> {
  const item = await lockItem(tx, itemId);
  if (item?.status !== "active") return [];
  return (await startWave(tx, item, { kind: "system" }, deps, { assumeDone })).afterCommit;
}

/**
 * Route `waves.run`. Mở transaction riêng (như `runs.start`) để đẩy run tới máy sau khi commit: đẩy trong transaction thì
 * máy có thể nhận gói của run chưa tồn tại với nó.
 */
export function waveRoutes(deps: OrgDeps & SdlcDeps) {
  const { authed, orgMember } = orgMiddlewares(deps);
  const os = implement(contract.sdlc.waves).$context<RequestContext>().use(authed);
  return {
    run: os.run.use(orgMember).handler(async ({ context: { pool, user, orgId }, input }) => {
      const { afterCommit, ...out } = await withTenant(pool, { userId: user.id, orgId }, (tx) =>
        runWave(tx, user.id, input, deps),
      );
      for (const fn of afterCommit) fn();
      return out;
    }),
  };
}
