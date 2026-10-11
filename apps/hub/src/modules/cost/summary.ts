import type { CostSummary, CostSummaryInput, CostTotals } from "@xdev-hive/contracts";
import { and, eq, gte, lt, type SQL, sql } from "drizzle-orm";
import { loadProject } from "../catalog/index.ts";
import { NotFoundError, type Tx } from "../platform/index.ts";
import { runEvents, runs } from "../runs/index.ts";
import { loadTask } from "../tasks/index.ts";
import { requireTeamRole, teamRoleOf } from "../tenancy/index.ts";

const GROUP_KEY: Record<CostSummaryInput["groupBy"], SQL<string | null>> = {
  // Ngày theo UTC để kết quả không đổi theo múi giờ của tiến trình hub hay của Postgres.
  day: sql`to_char(${runs.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`,
  task: sql`${runs.taskId}::text`,
  // Run không chọn CLI thì lấy CLI của lần đề nghị job cuối (máy tự chọn theo CLI nó có). Ghi rõ tên bảng vì
  // drizzle bỏ tên bảng của cột trong truy vấn con, khiến "id" bị hiểu là cột của run_events.
  cli: sql`coalesce(${runs}.cli, (select e.data->>'cli' from ${runEvents} e where e.run_id = ${runs}.id and e.type = 'offer' order by e.id desc limit 1))`,
  machine: sql`${runs.machineId}::text`,
};

/**
 * Token, USD và số run của một dự án trong khoảng ngày [from, to] (UTC, theo ngày tạo run), nhóm theo ngày, task, CLI
 * hoặc máy. Chi phí là thông tin quản trị nên chỉ quản trị đội sở hữu dự án (hoặc quản trị tổ chức) xem được.
 */
export async function costSummary(tx: Tx, userId: string, input: CostSummaryInput): Promise<CostSummary> {
  const project = await loadProject(tx, input.projectId);
  // Không thấy dự án thì báo không tồn tại, như projects.get, để không lộ dự án của đội khác.
  if (!project || !(await teamRoleOf(tx, userId, project.teamId))) {
    throw new NotFoundError("PROJECT_NOT_FOUND", "Không tìm thấy dự án.");
  }
  await requireTeamRole(tx, userId, project.teamId, "admin");
  // Khoá nhóm tính trong truy vấn con: khoá CLI là truy vấn con theo từng run, không GROUP BY trực tiếp được.
  const scoped = tx
    .select({
      key: GROUP_KEY[input.groupBy].as("key"),
      tokensIn: runs.tokensIn,
      tokensOut: runs.tokensOut,
      cacheRead: runs.cacheRead,
      cacheWrite: runs.cacheWrite,
      costUsd: runs.costUsd,
    })
    .from(runs)
    .where(
      and(
        eq(runs.projectId, project.id),
        gte(runs.createdAt, sql`(${input.from}::date)::timestamp at time zone 'UTC'`),
        lt(runs.createdAt, sql`(${input.to}::date + 1)::timestamp at time zone 'UTC'`),
      ),
    )
    .as("r");
  const rows = await tx
    .select({
      key: scoped.key,
      runs: sql<number>`count(*)::int`,
      // sum(bigint) ra numeric, pg trả chuỗi; ép về bigint rồi đọc bằng Number (an toàn tới 2^53 token).
      tokensIn: sql<string>`coalesce(sum(${scoped.tokensIn}), 0)::bigint`,
      tokensOut: sql<string>`coalesce(sum(${scoped.tokensOut}), 0)::bigint`,
      cacheRead: sql<string>`coalesce(sum(${scoped.cacheRead}), 0)::bigint`,
      cacheWrite: sql<string>`coalesce(sum(${scoped.cacheWrite}), 0)::bigint`,
      costUsd: sql<string>`coalesce(sum(${scoped.costUsd}), 0)`,
    })
    .from(scoped)
    .groupBy(scoped.key)
    .orderBy(scoped.key);
  const groups = rows.map((r) => ({
    key: r.key,
    runs: r.runs,
    tokensIn: Number(r.tokensIn),
    tokensOut: Number(r.tokensOut),
    cacheRead: Number(r.cacheRead),
    cacheWrite: Number(r.cacheWrite),
    costUsd: Number(r.costUsd),
  }));
  const total: CostTotals = { runs: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
  for (const g of groups) {
    total.runs += g.runs;
    total.tokensIn += g.tokensIn;
    total.tokensOut += g.tokensOut;
    total.cacheRead += g.cacheRead;
    total.cacheWrite += g.cacheWrite;
    total.costUsd += g.costUsd;
  }
  // Cộng số thực của các nhóm có thể lệch ở chữ số thứ 15; numeric(14, 6) chỉ có 6 chữ số thập phân.
  total.costUsd = Math.round(total.costUsd * 1e6) / 1e6;
  return { groupBy: input.groupBy, groups, total };
}

/** Danh sách run worker kết thúc do bộ đo vượt một trần ngân sách của dự án. */
export async function budgetStoppedRuns(tx: Tx, userId: string, projectId: string) {
  const project = await loadProject(tx, projectId);
  if (!project || !(await teamRoleOf(tx, userId, project.teamId))) {
    throw new NotFoundError("PROJECT_NOT_FOUND", "Không tìm thấy dự án.");
  }
  await requireTeamRole(tx, userId, project.teamId, "admin");
  const budget = project.settings.budget;
  if (!budget) return [];
  const rows = await tx
    .select({
      id: runs.id,
      taskId: runs.taskId,
      costUsd: runs.costUsd,
      turns: runs.turns,
      stoppedAt: runEvents.createdAt,
    })
    .from(runs)
    .innerJoin(
      runEvents,
      and(eq(runEvents.runId, runs.id), eq(runEvents.attempt, runs.attempt), eq(runEvents.type, "result")),
    )
    .where(and(eq(runs.projectId, projectId), sql`${runEvents.data}->'report'->>'error' like 'Vượt ngân sách:%'`))
    .orderBy(sql`${runEvents.createdAt} desc`)
    .limit(100);
  const out = [];
  for (const row of rows) {
    const task = await loadTask(tx, row.taskId);
    if (!task) continue;
    const reasons = [];
    if (budget.perRunUsd !== undefined && row.costUsd !== null && row.costUsd > budget.perRunUsd) {
      reasons.push({ reason: "per_run_usd" as const, measured: row.costUsd, limit: budget.perRunUsd });
    }
    if (budget.perTaskUsd !== undefined) {
      const [spent] = await tx
        .select({ value: sql<string>`coalesce(sum(${runs.costUsd}), 0)` })
        .from(runs)
        .where(eq(runs.taskId, task.id));
      const measured = Number(spent?.value ?? 0);
      if (measured > budget.perTaskUsd) {
        reasons.push({ reason: "per_task_usd" as const, measured, limit: budget.perTaskUsd });
      }
    }
    if (budget.maxTurns !== undefined && row.turns !== null && row.turns > budget.maxTurns) {
      reasons.push({ reason: "max_turns" as const, measured: row.turns, limit: budget.maxTurns });
    }
    for (const reason of reasons) {
      out.push({
        runId: row.id,
        taskId: task.id,
        taskKey: task.key,
        taskTitle: task.title,
        ...reason,
        stoppedAt: row.stoppedAt.toISOString(),
      });
    }
  }
  return out;
}
