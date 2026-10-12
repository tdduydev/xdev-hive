import { and, eq, isNull, lt, sql } from "drizzle-orm";
import type pg from "pg";
import { loadProject } from "../catalog/index.ts";
import { notify } from "../notify/index.ts";
import { type Jobs, type MasterKey, type Tx, withTenant } from "../platform/index.ts";
import { loadConnection, type ProviderFactory } from "../scm/index.ts";
import { notificationRecipients } from "../tenancy/index.ts";
import { flatGates } from "./review-rules.ts";
import { applyAiResult, completeWaitingGate, REVIEW_QUEUE, type ReviewDeps, type ReviewJob } from "./reviews.ts";
import { reviewGateRuns, reviewInstances } from "./schema.ts";

/** Nhắc hạn duyệt mười phút một lần (UTC). */
export const REVIEW_SLA_CRON = "*/10 * * * *";
/** Gate CI còn chờ thì hỏi lại sau chừng này; quá số lần thì coi như không đạt để người viết biết. */
const CI_RECHECK_MS = 2 * 60_000;
const CI_MAX_CHECKS = 60;

export interface ReviewJobDeps extends ReviewDeps {
  pool: pg.Pool;
  masterKey?: MasterKey | undefined;
  providerFactory: ProviderFactory;
  /**
   * Bắt đầu run agent kiểm cho gate AI (module runs truyền vào qua main.ts để knowledge không import runs). Không có
   * thì gate AI chờ tới khi hub có lõi giao run.
   */
  startDocCheck?: ((orgId: string, instanceId: string) => Promise<void>) | undefined;
}

/** Gate CI: trạng thái CI của commit đầu nhánh chính trong repo của dự án sở hữu tài liệu. */
async function checkCi(deps: ReviewJobDeps, job: Extract<ReviewJob, { kind: "ext" }>): Promise<void> {
  const tenant = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(deps.pool, { orgId: job.orgId }, fn);
  const target = await tenant(async (tx) => {
    const [inst] = await tx.select().from(reviewInstances).where(eq(reviewInstances.id, job.instanceId));
    if (inst?.status !== "in_review" || flatGates(inst.phases)[inst.gateIndex]?.gate.kind !== "ext") return null;
    if (!inst.projectId) return { inst, project: null, conn: null };
    const project = await loadProject(tx, inst.projectId);
    const conn = project && deps.masterKey ? await loadConnection(tx, deps.masterKey, project.scmConnectionId) : null;
    return { inst, project, conn };
  });
  if (!target) return;
  const finishWith = (passed: boolean, note: string) =>
    tenant((tx) =>
      completeWaitingGate(
        tx,
        job.instanceId,
        "ext",
        { passed, note, checklist: [{ label: "CI của repo xanh", passed, note }] },
        deps,
      ),
    );
  if (!target.project) return void (await finishWith(true, "Tài liệu không thuộc dự án nào: không có CI để chờ."));
  if (!target.conn || !target.project.defaultBranch)
    return void (await finishWith(false, "Không đọc được repo của dự án để kiểm CI."));
  const provider = deps.providerFactory(target.conn);
  const ref = { owner: target.project.repoOwner, name: target.project.repoName };
  const sha = await provider.branchHead(ref, target.project.defaultBranch);
  const state = sha ? await provider.checksFor(ref, sha) : "none";
  if (state === "success") return void (await finishWith(true, `CI xanh ở ${sha?.slice(0, 7)}.`));
  if (state === "failure")
    return void (await finishWith(false, `CI đỏ ở ${sha?.slice(0, 7)} của ${target.project.defaultBranch}.`));
  if (state === "none") return void (await finishWith(true, "Repo không có CI: không có gì để chờ."));
  const attempt = (job.attempt ?? 0) + 1;
  if (attempt >= CI_MAX_CHECKS) return void (await finishWith(false, "CI chạy quá lâu, chưa có kết quả."));
  await deps.jobs?.enqueue(REVIEW_QUEUE, { ...job, attempt } satisfies ReviewJob, {
    startAfter: new Date(Date.now() + CI_RECHECK_MS),
  });
}

/**
 * Nhắc gate người duyệt quá hạn: báo người được chỉ định và quản trị tổ chức một lần cho mỗi lượt chờ. Hàm
 * hive.review_overdue_orgs (SECURITY DEFINER) chỉ trả id tổ chức có gate quá hạn; phần còn lại chạy trong tổ chức đó.
 */
export async function remindOverdue(deps: ReviewJobDeps): Promise<number> {
  const orgs = await withTenant(deps.pool, {}, async (tx) => {
    const { rows } = await tx.execute<{ org_id: string }>(sql`select org_id from hive.review_overdue_orgs()`);
    return rows.map((r) => r.org_id);
  });
  let reminded = 0;
  for (const orgId of orgs) {
    reminded += await withTenant(deps.pool, { orgId }, async (tx) => {
      const due = await tx
        .select({ run: reviewGateRuns, inst: reviewInstances })
        .from(reviewGateRuns)
        .innerJoin(reviewInstances, eq(reviewInstances.id, reviewGateRuns.instanceId))
        .where(
          and(
            eq(reviewGateRuns.status, "waiting"),
            lt(reviewGateRuns.dueAt, sql`now()`),
            isNull(reviewGateRuns.overdueNotifiedAt),
            eq(reviewInstances.status, "in_review"),
          ),
        );
      for (const { run, inst } of due) {
        const gate = flatGates(inst.phases)[run.gateIndex]?.gate;
        const ids = new Set([
          ...(await notificationRecipients(tx, gate?.reviewers?.users ?? [])),
          ...(await notificationRecipients(tx)),
        ]);
        await notify(
          tx,
          {
            orgId,
            event: "review.overdue",
            title: `Quá hạn duyệt: ${inst.docTitle}`,
            body: `Checkpoint “${gate?.name ?? run.gateId}” của quy trình ${inst.workflowName} đã quá hạn (${inst.docKey}). Quản trị có thể nhắc hoặc đổi người duyệt.`,
            eventKey: `review-overdue:${run.id}`,
            recipientIds: [...ids],
            link: deps.publicUrl ? `${deps.publicUrl.replace(/\/+$/, "")}/knowledge/reviews?id=${inst.id}` : null,
          },
          { jobs: deps.jobs },
        );
        await tx.update(reviewGateRuns).set({ overdueNotifiedAt: sql`now()` }).where(eq(reviewGateRuns.id, run.id));
      }
      return due.length;
    });
  }
  return reminded;
}

export async function registerReviewWorker(jobs: Jobs, deps: ReviewJobDeps): Promise<void> {
  const full = { ...deps, jobs };
  await jobs.work<ReviewJob>(REVIEW_QUEUE, async ({ data }) => {
    if (data.kind === "ext") return checkCi(full, data);
    if (data.kind === "ai") return deps.startDocCheck?.(data.orgId, data.instanceId);
    if (data.kind === "ai-result")
      return withTenant(deps.pool, { orgId: data.orgId }, (tx) => applyAiResult(tx, data, full));
    if (data.kind === "sla") await remindOverdue(full);
  });
  await jobs.schedule(REVIEW_QUEUE, REVIEW_SLA_CRON, { kind: "sla" } satisfies ReviewJob);
}
