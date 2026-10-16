import { eq } from "drizzle-orm";
import type pg from "pg";
import { loadProject } from "../catalog/index.ts";
import { flatGates } from "../knowledge/index.ts";
import { type Jobs, type Tx, withTenant } from "../platform/index.ts";
import { type GitProvider, loadConnection, type ProviderFactory, type RepoRef } from "../scm/index.ts";
import { registerCommentSyncWorker } from "./comment-sync.ts";
import { registerCommentReconcileWorker } from "./comment-sync-in.ts";
import { ciVerdict } from "./gates.ts";
import { codeReviews } from "./schema.ts";
import {
  advanceReview,
  CODE_REVIEW_QUEUE,
  type CodeReviewDeps,
  type CodeReviewJob,
  type CodeReviewRow,
  codeReviewQueue,
  completeAutoGate,
  currentGateRun,
} from "./service.ts";

import { REVIEW_STATUS_CONTEXT } from "./status.ts";

/** Checkpoint CI còn chờ thì hỏi lại sau chừng này; quá số lần thì coi như không đạt để người giao việc biết. */
export const CI_RECHECK_MS = 2 * 60_000;
export const CI_MAX_CHECKS = 60;

export interface CodeReviewWorkerDeps extends CodeReviewDeps {
  pool: pg.Pool;
  providerFactory: ProviderFactory;
}

/** Repo của dự án sở hữu phiên; null khi không đọc được kết nối Git (thiếu khoá chủ, kết nối đã xoá). */
async function repoFor(
  tx: Tx,
  deps: CodeReviewWorkerDeps,
  review: CodeReviewRow,
): Promise<{ provider: GitProvider; ref: RepoRef } | null> {
  const project = await loadProject(tx, review.projectId);
  if (!project || !deps.masterKey) return null;
  const conn = await loadConnection(tx, deps.masterKey, project.scmConnectionId);
  if (!conn) return null;
  return { provider: deps.providerFactory(conn), ref: { owner: project.repoOwner, name: project.repoName } };
}

async function loadReview(tx: Tx, id: string): Promise<CodeReviewRow | null> {
  const [row] = await tx.select().from(codeReviews).where(eq(codeReviews.id, id));
  return row ?? null;
}

/**
 * Đi tiếp từ checkpoint của job. Lấy danh sách file và patch của PR trước, ngoài transaction, vì quy tắc (`no-secrets`,
 * `deny-paths`) và điều kiện đường dẫn cần chúng. Lỗi nhà cung cấp thì để pg-boss thử lại; hết lượt thử thì đi tiếp
 * không có diff, quy tắc cần diff sẽ chờ người xem thay vì treo phiên.
 */
async function runAdvance(
  deps: CodeReviewWorkerDeps,
  job: Extract<CodeReviewJob, { kind: "advance" }>,
  retryCount: number,
): Promise<void> {
  const tenant = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(deps.pool, { orgId: job.orgId }, fn);
  const pre = await tenant(async (tx) => {
    const review = await loadReview(tx, job.reviewId);
    if (review?.status !== "in_review" || review.gateIndex !== job.gateIndex) return null;
    const needFiles = flatGates(review.phases)
      .slice(review.gateIndex)
      .some(({ gate }) => gate.kind === "rule" || Boolean(gate.conditions.paths?.length));
    return { review, repo: needFiles ? await repoFor(tx, deps, review) : null };
  });
  if (!pre) return;
  let files = null;
  if (pre.repo) {
    try {
      files = await pre.repo.provider.prFiles(pre.repo.ref, pre.review.prNumber);
    } catch (e) {
      if (retryCount < codeReviewQueue.retryLimit) throw e;
    }
  }
  await tenant((tx) => advanceReview(tx, job.reviewId, deps, { files, gateIndex: job.gateIndex }));
}

/** Checkpoint CI: trạng thái CI trên commit đầu của PR (FR-005), hỏi lại mỗi 2 phút, tối đa 60 lần. */
async function runCi(deps: CodeReviewWorkerDeps, job: Extract<CodeReviewJob, { kind: "ci" }>): Promise<void> {
  const tenant = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(deps.pool, { orgId: job.orgId }, fn);
  const pre = await tenant(async (tx) => {
    const review = await loadReview(tx, job.reviewId);
    if (review?.status !== "in_review" || review.gateIndex !== job.gateIndex || review.headSha !== job.headSha)
      return null;
    const gate = flatGates(review.phases)[review.gateIndex]?.gate;
    if (gate?.kind !== "ext" || (await currentGateRun(tx, review))?.status !== "waiting") return null;
    return { gate, repo: await repoFor(tx, deps, review) };
  });
  if (!pre) return;
  const finish = (passed: boolean, note: string | null, state: string) =>
    tenant((tx) =>
      completeAutoGate(
        tx,
        {
          reviewId: job.reviewId,
          gateIndex: job.gateIndex,
          headSha: job.headSha,
          kind: "ext",
          status: passed ? "passed" : "failed",
          checklist: [{ label: "CI trên commit đầu của PR", passed, note }],
          note,
          details: [{ ci: state, sha: job.headSha, checks: job.attempt + 1 }],
        },
        deps,
      ),
    );
  if (!pre.repo) return void (await finish(false, "Không đọc được repo của dự án để kiểm CI.", "none"));
  const state = await pre.repo.provider.checksFor(pre.repo.ref, job.headSha, {
    excludeContexts: [REVIEW_STATUS_CONTEXT],
  });
  const v = ciVerdict(pre.gate, state);
  if (v.status !== "waiting") return void (await finish(v.status === "passed", v.note, state));
  if (job.attempt + 1 >= CI_MAX_CHECKS) return void (await finish(false, "CI chạy quá lâu, chưa có kết quả.", state));
  await deps.jobs?.enqueue(CODE_REVIEW_QUEUE, { ...job, attempt: job.attempt + 1 } satisfies CodeReviewJob, {
    startAfter: new Date(Date.now() + CI_RECHECK_MS),
  });
}

/** Xử lý một job của queue `codereview`; tách ra để test gọi thẳng không cần pg-boss. */
export function handleCodeReviewJob(deps: CodeReviewWorkerDeps, job: CodeReviewJob, retryCount = 0): Promise<void> {
  if (job.kind === "advance") return runAdvance(deps, job, retryCount);
  return runCi(deps, job);
}

export async function registerCodeReviewWorker(jobs: Jobs, deps: CodeReviewWorkerDeps): Promise<void> {
  const full = { ...deps, jobs };
  await registerCommentSyncWorker(jobs, full);
  await registerCommentReconcileWorker(jobs, full);
  await jobs.work<CodeReviewJob>(CODE_REVIEW_QUEUE, ({ data, retryCount }) =>
    handleCodeReviewJob(full, data, retryCount),
  );
}
