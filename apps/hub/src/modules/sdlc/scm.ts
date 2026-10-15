import { sql } from "drizzle-orm";
import type pg from "pg";
import { loadProject } from "../catalog/index.ts";
import { type Jobs, type Tx, withTenant } from "../platform/index.ts";
import { loadConnection, onScmEvent, type PullRequestEvent, type ScmEventContext } from "../scm/index.ts";
import { findTaskByKey, loadTask } from "../tasks/index.ts";
import { approvePhase, lockItem, SDLC_QUEUE, type SdlcDeps, type SdlcJob } from "./phases.ts";
import { itemTaskOf, linkTrace } from "./trace.ts";
import { autoWave } from "./waves.ts";

/*
 * PR của task hạng mục merge (plan.md "Luồng" bước 7), từ repo của bất kỳ dự án tham gia: liên kết `commit`, xếp job
 * đọc CI, chạy đợt kế, và khi mọi task của mọi dự án xong thì giai đoạn `implementation` đạt. Handler của `runs` đặt task
 * `done` trên cùng sự kiện; thứ tự hai handler không cố định nên ở đây coi task của PR là đã xong.
 */

const BRANCH_PREFIX = "ai/";
/** CI thường chạy xong vài phút sau merge; hỏi lại tối đa chừng ấy lần, mỗi lần cách nhau `CI_RETRY_MS`. */
const CI_MAX_POLLS = 10;
const CI_RETRY_MS = 3 * 60_000;

export type SdlcCiJob = Extract<SdlcJob, { kind: "trace-ci" }>;

/** Task của PR: theo run đã mở PR (link PR hoặc số PR), không có thì theo nhánh `ai/<task key>` như `runs`. */
async function taskOfPullRequest(tx: Tx, projectId: string, pr: PullRequestEvent["pullRequest"]) {
  // sdlc không import runs; đọc run bằng SQL.
  const { rows } = await tx.execute<{ task_id: string | null }>(
    sql`select task_id from hive.runs
        where project_id = ${projectId} and kind = 'code' and task_id is not null
          and (pr_url = ${pr.url ?? ""} or pr_url like ${`%/pull/${pr.number}`}
               or pr_url like ${`%/merge_requests/${pr.number}`})
        order by (pr_url = ${pr.url ?? ""}) desc, created_at desc limit 1`,
  );
  const taskId = rows[0]?.task_id;
  if (taskId) return loadTask(tx, taskId);
  if (!pr.head.startsWith(BRANCH_PREFIX)) return null;
  return findTaskByKey(tx, projectId, pr.head.slice(BRANCH_PREFIX.length));
}

export async function onSdlcMerged(e: PullRequestEvent, ctx: ScmEventContext, deps: SdlcDeps): Promise<void> {
  const { tx } = ctx;
  const task = await taskOfPullRequest(tx, ctx.projectId, e.pullRequest);
  if (!task || task.status === "cancelled") return;
  const link = await itemTaskOf(tx, task.id);
  if (!link) return;
  const base = { orgId: link.orgId, itemId: link.itemId, projectId: link.projectId, taskId: task.id };
  const pr = e.pullRequest;
  if (pr.url) await linkTrace(tx, { ...base, requirementIds: link.requirementIds, kind: "pr", ref: pr.url });
  if (pr.headSha) {
    await linkTrace(tx, {
      ...base,
      requirementIds: link.requirementIds,
      kind: "commit",
      ref: pr.headSha,
      data: { pr: pr.number, url: pr.url, base: pr.base },
    });
    if (deps.jobs)
      await deps.jobs.enqueue(
        SDLC_QUEUE,
        {
          kind: "trace-ci",
          orgId: link.orgId,
          itemId: link.itemId,
          taskId: task.id,
          sha: pr.headSha,
          poll: 0,
        } satisfies SdlcCiJob,
        { tx },
      );
  }
  const merged = new Set([task.id]);
  const afterCommit = await autoWave(tx, link.itemId, deps, merged);
  if (afterCommit.length)
    ctx.afterCommit(() => {
      for (const fn of afterCommit) fn();
    });
  await finishImplementation(tx, link.itemId, deps, merged);
}

/** Mọi task còn trong bản tách của mọi dự án `done` (task huỷ không tính) → giai đoạn `implementation` đạt. */
export async function finishImplementation(
  tx: Tx,
  itemId: string,
  deps: SdlcDeps,
  assumeDone: ReadonlySet<string> = new Set(),
): Promise<boolean> {
  const item = await lockItem(tx, itemId);
  const phase = item?.mode.phases.find((p) => p.kind === "implementation");
  if (!item || !phase || item.status === "cancelled" || item.status === "done") return false;
  const { rows } = await tx.execute<{ id: string; status: string }>(
    sql`select t.id, t.status from hive.sdlc_item_tasks it join hive.tasks t on t.id = it.task_id
        where it.item_id = ${itemId} and not it.removed`,
  );
  const status = (r: { id: string; status: string }) => (assumeDone.has(r.id) ? "done" : r.status);
  if (!rows.some((r) => status(r) === "done") || rows.some((r) => !["done", "cancelled"].includes(status(r))))
    return false;
  await approvePhase(tx, itemId, phase.id, deps);
  return true;
}

export interface SdlcScmDeps extends SdlcDeps {
  pool: pg.Pool;
}

/**
 * Job `trace-ci`: hỏi trạng thái CI của commit merge ngoài transaction (gọi GitHub/GitLab), ghi liên kết `ci`. CI còn
 * chạy thì hẹn hỏi lại; quá số lần thì để `pending`.
 */
export async function traceCi(deps: SdlcScmDeps, job: SdlcCiJob): Promise<void> {
  const tenant = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(deps.pool, { orgId: job.orgId }, fn);
  const pre = await tenant(async (tx) => {
    const link = await itemTaskOf(tx, job.taskId);
    if (!link || !deps.masterKey || !deps.providerFactory) return null;
    const project = await loadProject(tx, link.projectId);
    if (!project) return null;
    const conn = await loadConnection(tx, deps.masterKey, project.scmConnectionId);
    return conn ? { link, project, provider: deps.providerFactory(conn) } : null;
  });
  if (!pre) return;
  const { link, project, provider } = pre;
  const state = await provider.checksFor({ owner: project.repoOwner, name: project.repoName }, job.sha);
  await tenant(async (tx) => {
    await linkTrace(tx, {
      orgId: link.orgId,
      itemId: link.itemId,
      projectId: link.projectId,
      taskId: link.taskId,
      requirementIds: link.requirementIds,
      kind: "ci",
      ref: job.sha,
      data: { state },
    });
    if (state === "pending" && job.poll + 1 < CI_MAX_POLLS && deps.jobs)
      await deps.jobs.enqueue(SDLC_QUEUE, { ...job, poll: job.poll + 1 } satisfies SdlcCiJob, {
        tx,
        startAfter: new Date(Date.now() + CI_RETRY_MS),
      });
  });
}

/** Đăng ký handler `pull_request.merged` của `sdlc`; trả hàm huỷ đăng ký (test). */
export function registerSdlcScmHandlers(deps: SdlcDeps & { jobs?: Jobs | undefined }): () => void {
  return onScmEvent("pull_request.merged", (e, ctx) => onSdlcMerged(e, ctx, deps));
}
