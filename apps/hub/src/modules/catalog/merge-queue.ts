import type { MergeQueueCiState, MergeQueueEntry, MergeQueueState } from "@xdev-hive/contracts";
import { and, asc, desc, eq, inArray, isNotNull, notInArray, sql } from "drizzle-orm";
import type pg from "pg";
import { recordAudit } from "../audit/index.ts";
import { notify } from "../notify/index.ts";
import {
  BadRequestError,
  ConflictError,
  type Jobs,
  type MasterKey,
  NotFoundError,
  type Tx,
  withTenant,
} from "../platform/index.ts";
import {
  type GitProvider,
  isGitProviderError,
  loadConnection,
  type ProviderFactory,
  type PullRequestState,
} from "../scm/index.ts";
import { loadProject, type ProjectRow, projectFor } from "./projects.ts";
import { ACTIVE_MERGE_STATES, mergeQueueEntries } from "./schema.ts";

export const MERGE_QUEUE = "catalog-merge";

/** Payload của job merge: một job xử lý mục đầu hàng của một dự án. */
export interface MergeJob {
  orgId: string;
  projectId: string;
}

export const mergeQueue = {
  name: MERGE_QUEUE,
  // Mỗi dự án tối đa một job chờ và một job đang chạy (singletonKey = projectId): hai job cùng xử lý một hàng sẽ
  // merge hai PR song song, mất ý nghĩa của hàng.
  policy: "stately",
  retryLimit: 3,
  retryDelay: 30,
  retryBackoff: true,
  expireInSeconds: 10 * 60,
} as const;

/** Mục đầu hàng còn chờ (CI, người duyệt, cập nhật nhánh) thì hỏi lại sau chừng này giây. */
export const MERGE_RECHECK_SEC = 30;
/** Chờ lâu hơn thì coi như kẹt: failed để hàng đi tiếp. */
export const MERGE_MAX_WAIT_MS = 24 * 60 * 60 * 1000;
/** Số lần nhà cung cấp từ chối merge (PR vừa đổi) trước khi bỏ cuộc. */
export const MERGE_ATTEMPTS = 5;

export type MergeEntryRow = typeof mergeQueueEntries.$inferSelect;
type Active = (typeof ACTIVE_MERGE_STATES)[number];

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const isActive = (s: MergeQueueState): s is Active => (ACTIVE_MERGE_STATES as readonly string[]).includes(s);

export function mergeEntryView(row: MergeEntryRow, position: number | null): MergeQueueEntry {
  return {
    id: row.id,
    projectId: row.projectId,
    prNumber: row.prNumber,
    prUrl: row.prUrl,
    branch: row.branch,
    headSha: row.headSha,
    ciState: row.ciState,
    runId: row.runId,
    taskId: row.taskId,
    state: row.state,
    note: row.note,
    position: isActive(row.state) ? position : null,
    mergeSha: row.mergeSha,
    enqueuedBy: row.enqueuedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    finishedAt: iso(row.finishedAt),
  };
}

const activeIn = (projectId: string) =>
  and(eq(mergeQueueEntries.projectId, projectId), inArray(mergeQueueEntries.state, [...ACTIVE_MERGE_STATES]));
// FIFO theo created_at; id phân xử hai mục vào hàng cùng lúc.
const fifo = [asc(mergeQueueEntries.createdAt), asc(mergeQueueEntries.id)];

async function positionOf(tx: Tx, row: MergeEntryRow): Promise<number | null> {
  if (!isActive(row.state)) return null;
  // So bằng giá trị trong database: created_at có micro giây, Date của JS chỉ có mili giây.
  const [r] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(mergeQueueEntries)
    .where(
      and(
        activeIn(row.projectId),
        sql`(${mergeQueueEntries.createdAt}, ${mergeQueueEntries.id}) <= (select created_at, id from hive.merge_queue_entries where id = ${row.id})`,
      ),
    );
  return r?.n ?? null;
}

/** Mục đang hoạt động theo thứ tự hàng, rồi 20 mục đã xong gần nhất. */
export async function listQueue(tx: Tx, projectId: string): Promise<MergeQueueEntry[]> {
  const active = await tx
    .select()
    .from(mergeQueueEntries)
    .where(activeIn(projectId))
    .orderBy(...fifo);
  const done = await tx
    .select()
    .from(mergeQueueEntries)
    .where(
      and(
        eq(mergeQueueEntries.projectId, projectId),
        notInArray(mergeQueueEntries.state, [...ACTIVE_MERGE_STATES]),
        isNotNull(mergeQueueEntries.finishedAt),
      ),
    )
    .orderBy(desc(mergeQueueEntries.finishedAt))
    .limit(20);
  return [...active.map((r, i) => mergeEntryView(r, i + 1)), ...done.map((r) => mergeEntryView(r, null))];
}

export interface EnqueueMergeInput {
  projectId: string;
  prNumber: number;
  prUrl?: string | null | undefined;
  branch?: string | null | undefined;
  runId?: string | null | undefined;
  taskId?: string | null | undefined;
  /** Người đưa vào hàng; run tự vào hàng thì là người tạo run. */
  by: string;
}

/**
 * Đưa PR vào hàng merge của dự án, trong transaction của người gọi (API hoặc verifying của run). PR đã có mục đang
 * hoạt động thì trả lại mục đó. Job xử lý hàng gửi cùng transaction, nên mục chỉ được xử lý khi đã commit.
 */
export async function enqueueMerge(
  tx: Tx,
  input: EnqueueMergeInput,
  opts: { jobs?: Jobs | undefined } = {},
): Promise<MergeQueueEntry> {
  const project = await loadProject(tx, input.projectId);
  if (!project) throw new NotFoundError("PROJECT_NOT_FOUND", "Không tìm thấy dự án trong tổ chức.");
  if (!project.settings.features.mergeQueue) {
    throw new BadRequestError("MERGE_QUEUE_DISABLED", "Dự án chưa bật merge queue.");
  }
  const existing = async () => {
    const [row] = await tx
      .select()
      .from(mergeQueueEntries)
      .where(and(activeIn(project.id), eq(mergeQueueEntries.prNumber, input.prNumber)));
    return row;
  };
  const before = await existing();
  if (before) return mergeEntryView(before, await positionOf(tx, before));
  const [row] = await tx
    .insert(mergeQueueEntries)
    .values({
      orgId: project.orgId,
      projectId: project.id,
      prNumber: input.prNumber,
      prUrl: input.prUrl ?? null,
      branch: input.branch ?? null,
      runId: input.runId ?? null,
      taskId: input.taskId ?? null,
      enqueuedBy: input.by,
    })
    // Hai lần vào hàng cùng PR chạy song song: index duy nhất từng phần chặn bên sau, bên đó trả mục của bên trước.
    .onConflictDoNothing()
    .returning();
  if (!row) {
    const raced = await existing();
    if (!raced) throw new Error("Không đưa được PR vào hàng merge.");
    return mergeEntryView(raced, await positionOf(tx, raced));
  }
  const jobId = await opts.jobs?.enqueue<MergeJob>(
    MERGE_QUEUE,
    { orgId: project.orgId, projectId: project.id },
    { tx, singletonKey: project.id },
  );
  await recordAudit(tx, {
    action: "merge_queue.enqueue",
    targetType: "project",
    targetId: project.id,
    data: { entryId: row.id, prNumber: row.prNumber, runId: row.runId, taskId: row.taskId, jobId: jobId ?? null },
  });
  return mergeEntryView(row, await positionOf(tx, row));
}

/** Bỏ PR khỏi hàng. Mục đang merge thì không bỏ được: lời gọi merge đã gửi đi, kết quả chưa biết. */
export async function removeEntry(
  tx: Tx,
  input: { projectId: string; entryId: string },
  opts: { jobs?: Jobs | undefined } = {},
): Promise<MergeQueueEntry> {
  const [row] = await tx
    .select()
    .from(mergeQueueEntries)
    .where(and(eq(mergeQueueEntries.id, input.entryId), eq(mergeQueueEntries.projectId, input.projectId)))
    .for("update");
  if (!row) throw new NotFoundError("MERGE_ENTRY_NOT_FOUND", "Không tìm thấy mục này trong hàng merge.");
  if (row.state === "merging") {
    throw new ConflictError("MERGE_IN_PROGRESS", "PR đang được merge, không bỏ khỏi hàng được.");
  }
  if (!isActive(row.state)) throw new ConflictError("MERGE_ENTRY_FINISHED", "Mục này đã xong, không còn trong hàng.");
  const [updated] = await tx
    .update(mergeQueueEntries)
    .set({ state: "removed", finishedAt: sql`now()`, updatedAt: sql`now()` })
    .where(eq(mergeQueueEntries.id, row.id))
    .returning();
  // Mục bị bỏ có thể là mục đầu hàng đang chờ: xử lý mục kế ngay thay vì đợi lần hỏi lại.
  await opts.jobs?.enqueue<MergeJob>(
    MERGE_QUEUE,
    { orgId: row.orgId, projectId: row.projectId },
    { tx, singletonKey: row.projectId },
  );
  await recordAudit(tx, {
    action: "merge_queue.remove",
    targetType: "project",
    targetId: row.projectId,
    data: { entryId: row.id, prNumber: row.prNumber, previousState: row.state },
  });
  return mergeEntryView(updated ?? row, null);
}

// ---- Cho API: kiểm quyền đội rồi gọi phần nghiệp vụ ở trên ------------------------------------------------------

export async function queueForUser(tx: Tx, userId: string, projectId: string): Promise<MergeQueueEntry[]> {
  await projectFor(tx, userId, projectId, "viewer");
  return listQueue(tx, projectId);
}

// Người xem chỉ đọc; đưa vào hay bỏ khỏi hàng cần thành viên đội. Người duyệt PR vẫn do bảo vệ nhánh quyết.
export async function enqueueMergeAs(
  tx: Tx,
  opts: { jobs?: Jobs | undefined },
  userId: string,
  input: { projectId: string; prNumber: number },
): Promise<MergeQueueEntry> {
  await projectFor(tx, userId, input.projectId, "member");
  return enqueueMerge(tx, { ...input, by: userId }, opts);
}

export async function removeMergeAs(
  tx: Tx,
  opts: { jobs?: Jobs | undefined },
  userId: string,
  input: { projectId: string; entryId: string },
): Promise<MergeQueueEntry> {
  await projectFor(tx, userId, input.projectId, "member");
  return removeEntry(tx, input, opts);
}

// ---------------------------------------------------------------------------------------------------------------
// Xử lý hàng

export interface MergeDeps {
  /** Pool của hive_app. Job chạy với tenant là tổ chức trong payload, không có người dùng. */
  pool: pg.Pool;
  masterKey: MasterKey;
  providerFactory: ProviderFactory;
  publicUrl: string;
  /** Gửi thông báo merge.failed; không có thì thông báo nằm chờ deliverPending. */
  jobs?: Jobs | undefined;
  /** Đồng hồ cho test hạn chờ 24 giờ. */
  now?: (() => Date) | undefined;
}

/** `next`: mục đầu đã xong, xử lý mục kế ngay. `wait`: mục đầu đang chờ, hỏi lại sau. `idle`: hàng trống. */
export type MergeStep = "next" | "wait" | "idle";

type Decision = (
  | { state: "merged"; mergeSha: string | null; note: string | null }
  | { state: "failed"; note: string }
  | { state: "waiting" | "updating"; note: string }
  | { state: "queued"; note: string | null; attempts?: number }
  | { state: "merging" }
) & { ciState?: MergeQueueCiState };

/**
 * Xử lý một bước của mục đầu hàng (FIFO theo created_at). Gọi nhà cung cấp ngoài transaction; mỗi lần ghi trạng
 * thái là một transaction ngắn có khoá dòng, chỉ ghi khi mục còn ở đúng trạng thái đã đọc (người dùng có thể vừa bỏ
 * mục khỏi hàng).
 */
export async function processMergeQueue(deps: MergeDeps, job: MergeJob): Promise<MergeStep> {
  const tenant = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(deps.pool, { orgId: job.orgId }, fn);
  const loaded = await tenant(async (tx) => {
    const project = await loadProject(tx, job.projectId);
    // Tắt tính năng thì hàng dừng, mục giữ nguyên để bật lại là chạy tiếp.
    if (!project?.settings.features.mergeQueue) return null;
    const [entry] = await tx
      .select()
      .from(mergeQueueEntries)
      .where(activeIn(project.id))
      .orderBy(...fifo)
      .limit(1);
    if (!entry) return null;
    return { project, entry, conn: await loadConnection(tx, deps.masterKey, project.scmConnectionId) };
  });
  if (!loaded) return "idle";
  const { project, entry, conn } = loaded;

  let ciState: MergeQueueCiState | null = null;

  const save = (from: MergeQueueState, decision: Decision, pr: PullRequestState | null) =>
    tenant((tx) => saveDecision(tx, deps, project, entry.id, from, decision, pr, ciState));

  if (!conn) return save(entry.state, { state: "failed", note: "Dự án không còn kết nối Git." }, null);
  const provider = deps.providerFactory(conn);
  const ref = { owner: project.repoOwner, name: project.repoName };

  let pr: PullRequestState | null = null;
  let decision: Decision;
  try {
    pr = await provider.getPR(ref, entry.prNumber);
    decision = await decide(provider, project, entry, pr);
  } catch (e) {
    if (!isGitProviderError(e)) throw e;
    // Hết hạn mức hay nhà cung cấp chập chờn: giữ nguyên mục, hỏi lại sau.
    if (e.retryable) return "wait";
    decision = { state: "failed", note: `Lỗi từ nhà cung cấp Git: ${e.message}` };
  }
  ciState = decision.ciState ?? null;

  if (decision.state === "waiting" || decision.state === "updating") {
    const since = entry.waitingSince?.getTime();
    const now = (deps.now?.() ?? new Date()).getTime();
    if (since !== undefined && now - since >= MERGE_MAX_WAIT_MS) {
      decision = { state: "failed", note: `Chờ quá 24 giờ: ${decision.note}` };
    }
  }
  if (decision.state !== "merging" || !pr) return save(entry.state, decision, pr);

  // Đánh dấu merging trước khi gọi merge: từ đây người dùng không bỏ mục khỏi hàng được nữa.
  const claimed = await save(entry.state, decision, pr);
  if (claimed !== "wait") return claimed;
  const method = project.settings.merge.method ?? "squash";
  try {
    const merged = await provider.mergePR(ref, pr.number, { method, sha: pr.headSha });
    return save("merging", { state: "merged", mergeSha: merged.sha, note: null }, pr);
  } catch (e) {
    if (!isGitProviderError(e)) throw e;
    if (e.code === "conflict") {
      // PR vừa đổi giữa lúc đọc và lúc merge (push thêm, nhánh chính tiến): về hàng, lần sau đọc lại PR.
      const attempts = entry.attempts + 1;
      if (attempts >= MERGE_ATTEMPTS) {
        return save(
          "merging",
          { state: "failed", note: `Nhà cung cấp từ chối merge ${attempts} lần: ${e.message}` },
          pr,
        );
      }
      return save("merging", { state: "queued", note: `Chưa merge được, sẽ thử lại: ${e.message}`, attempts }, pr);
    }
    // Không biết lời gọi đã tới chưa: về hàng, lần sau getPR sẽ cho biết PR đã merge hay chưa.
    if (e.retryable) return save("merging", { state: "queued", note: e.message }, pr);
    return save("merging", { state: "failed", note: `Lỗi từ nhà cung cấp Git: ${e.message}` }, pr);
  }
}

/** Bước tiếp của mục đầu hàng theo trạng thái PR và CI. Chỉ gọi nhà cung cấp, không ghi database. */
async function decide(
  provider: GitProvider,
  project: ProjectRow,
  entry: MergeEntryRow,
  pr: PullRequestState | null,
): Promise<Decision> {
  const ref = { owner: project.repoOwner, name: project.repoName };
  if (!pr) return { state: "failed", note: `Không tìm thấy PR #${entry.prNumber}.` };
  // Merge tay ngoài Hive cũng tính là xong. Mục đang merging thì có thể chính hàng đã merge rồi chết trước khi ghi.
  if (pr.state === "merged") {
    return { state: "merged", mergeSha: null, note: entry.state === "merging" ? null : "PR đã được merge ngoài hàng." };
  }
  if (pr.state === "closed") return { state: "failed", note: "PR đã bị đóng." };
  const base = project.defaultBranch ?? "main";
  if (pr.base !== base)
    return { state: "failed", note: `PR nhắm vào nhánh ${pr.base}, không phải nhánh chính ${base}.` };
  if (pr.draft) return { state: "waiting", note: "PR đang là bản nháp." };
  if (pr.mergeable === "unknown") return { state: "waiting", note: "Chờ nhà cung cấp Git tính trạng thái merge." };
  if (pr.mergeable === "conflict") return { state: "failed", note: "PR xung đột với nhánh chính." };
  if (pr.mergeable === "behind") {
    try {
      await provider.updatePRBranch(ref, pr.number, pr.headSha);
    } catch (e) {
      if (isGitProviderError(e, "conflict")) return { state: "failed", note: "PR xung đột với nhánh chính." };
      throw e;
    }
    return { state: "updating", note: "Đang cập nhật nhánh của PR theo nhánh chính." };
  }
  const checks = await provider.checksFor(ref, pr.headSha);
  if (checks === "pending") return { state: "waiting", note: "Chờ CI.", ciState: checks };
  if (checks === "failure") return { state: "failed", note: "CI không đạt.", ciState: checks };
  if (checks === "none" && project.settings.merge.requireCi) {
    return { state: "waiting", note: "Chờ CI: dự án bắt buộc CI xanh mà chưa có kết quả nào.", ciState: checks };
  }
  if (pr.mergeable === "blocked")
    return { state: "waiting", note: "Chờ người duyệt hoặc kiểm tra bắt buộc.", ciState: checks };
  return { state: "merging", ciState: checks };
}

/** Ghi bước vừa quyết. Trả `wait` khi mục còn trong hàng, `next` khi đã xong hoặc không còn ở trạng thái đã đọc. */
async function saveDecision(
  tx: Tx,
  deps: MergeDeps,
  project: ProjectRow,
  entryId: string,
  from: MergeQueueState,
  decision: Decision,
  pr: PullRequestState | null,
  ciState: MergeQueueCiState | null,
): Promise<MergeStep> {
  const [row] = await tx.select().from(mergeQueueEntries).where(eq(mergeQueueEntries.id, entryId)).for("update");
  if (row?.state !== from) return "next";
  const done = decision.state === "merged" || decision.state === "failed";
  const waiting = decision.state === "waiting" || decision.state === "updating";
  const [saved] = await tx
    .update(mergeQueueEntries)
    .set({
      state: decision.state,
      // Xoá kết quả cũ khi lần xử lý này chưa kiểm tra CI (ví dụ PR đã đổi head và đang cập nhật nhánh).
      ciState,
      note: "note" in decision ? decision.note : null,
      ...(pr ? { prUrl: pr.url, branch: pr.head, headSha: pr.headSha } : {}),
      ...(decision.state === "merged" ? { mergeSha: decision.mergeSha } : {}),
      ...(decision.state === "queued" && decision.attempts !== undefined ? { attempts: decision.attempts } : {}),
      // Giữ mốc chờ đầu tiên: đổi qua lại giữa chờ CI và cập nhật nhánh vẫn tính chung một lần chờ.
      waitingSince: waiting ? (row.waitingSince ?? sql`now()`) : decision.state === "queued" ? null : row.waitingSince,
      finishedAt: done ? sql`now()` : null,
      updatedAt: sql`now()`,
    })
    .where(eq(mergeQueueEntries.id, entryId))
    .returning();
  if (!saved) return "next";
  if (decision.state === "merged") {
    await recordAudit(tx, {
      action: "merge_queue.merged",
      actorUserId: null,
      targetType: "project",
      targetId: project.id,
      data: { entryId, prNumber: saved.prNumber, mergeSha: saved.mergeSha, note: saved.note },
    });
  }
  if (decision.state === "failed") {
    await recordAudit(tx, {
      action: "merge_queue.failed",
      actorUserId: null,
      targetType: "project",
      targetId: project.id,
      data: { entryId, prNumber: saved.prNumber, previousState: from, note: decision.note },
    });
    await notify(
      tx,
      {
        orgId: saved.orgId,
        event: "merge.failed",
        title: `Không merge được PR #${saved.prNumber} của ${project.key}`,
        body: [saved.branch ? `Nhánh ${saved.branch}` : "", decision.note, "PR đã ra khỏi hàng merge."]
          .filter(Boolean)
          .join("\n"),
        link: saved.prUrl,
      },
      { jobs: deps.jobs },
    );
  }
  return done ? "next" : "wait";
}

/** Đăng ký xử lý hàng merge ở tiến trình có vai trò `jobs`. Mỗi job một bước, rồi tự xếp job kế. */
export async function registerMergeWorker(jobs: Jobs, deps: MergeDeps, opts: { pollingIntervalSeconds?: number } = {}) {
  await jobs.work<MergeJob>(
    MERGE_QUEUE,
    async (job) => {
      const step = await processMergeQueue(deps, job.data);
      if (step === "idle") return;
      await jobs.enqueue<MergeJob>(MERGE_QUEUE, job.data, {
        singletonKey: job.data.projectId,
        startAfter: step === "wait" ? new Date(Date.now() + MERGE_RECHECK_SEC * 1000) : undefined,
      });
    },
    opts,
  );
}
