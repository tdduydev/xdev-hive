import type { CiFeed, CiFeedInput, CiFeedSource, CiRun, CiRunStatus, CiSource } from "@xdev-hive/contracts";
import { and, eq, inArray } from "drizzle-orm";
import type pg from "pg";
import { loadProject, type ProjectRow } from "../../catalog/index.ts";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  type MasterKey,
  NotFoundError,
  type Tx,
  withTenant,
} from "../../platform/index.ts";
import {
  type CiStatus,
  type GitProvider,
  GitProviderError,
  loadConnection,
  type ProviderFactory,
  type RepoRef,
} from "../../scm/index.ts";
import { effectivePermissions } from "../../tenancy/index.ts";
import { type FetchLike, type JenkinsBuild, JenkinsError } from "../clients/jenkins.ts";
import { type JenkinsAuth, jenkinsAuth } from "../connections/credentials.ts";
import { jenkinsClient, requireMasterKey } from "../connections/jenkins.ts";
import { ciJenkinsConnections, ciJenkinsUserTokens, ciProjectJobs } from "../schema.ts";

// Danh sách gộp pipeline GitLab và build Jenkins của dự án (US1, FR-003, FR-005, plan.md mục 2–4). Đọc thẳng từ nguồn,
// không lưu. Gọi hệ ngoài sau khi đã trả kết nối database: một nguồn chậm 15 giây không được giữ kết nối pool.
// Phần "dùng chung" ở đầu file được detail.ts, logs.ts, actions.ts dùng lại.

// ---- Dùng chung ----------------------------------------------------------------------------------------------------

export interface CiDeps {
  pool?: pg.Pool | undefined;
  masterKey?: MasterKey | undefined;
  providerFactory?: ProviderFactory | undefined;
  fetch?: FetchLike | undefined;
  /** Test đổi đồng hồ để thử đệm 10 giây. */
  now?: (() => number) | undefined;
}

export interface CiActor {
  userId: string;
  orgId: string;
}

export function requirePool(deps: CiDeps): pg.Pool {
  if (!deps.pool) throw new Error("Hub chưa cấu hình HIVE_DATABASE_URL.");
  return deps.pool;
}

const projectNotFound = () => new NotFoundError("NOT_FOUND", "Không tìm thấy dự án.");

/**
 * Dự án và quyền CI trên đội sở hữu. Thiếu `ci.view` thì báo như không có dự án; có xem mà thiếu `ci.operate` thì nói
 * rõ thiếu quyền gì.
 */
export async function ciProject(
  tx: Tx,
  userId: string,
  projectId: string,
  permission: "ci.view" | "ci.operate",
): Promise<ProjectRow> {
  const project = await loadProject(tx, projectId);
  if (!project) throw projectNotFound();
  const granted = await effectivePermissions(tx, userId, project.teamId);
  if (!granted.has("ci.view")) throw projectNotFound();
  if (permission === "ci.operate" && !granted.has("ci.operate"))
    throw new ForbiddenError(
      "CI_OPERATE_REQUIRED",
      "Bạn chỉ có quyền xem CI của dự án này. Chạy lại, huỷ, build cần quyền ci.operate (thành viên đội sở hữu dự án).",
    );
  return project;
}

export interface ScmTarget {
  provider: GitProvider;
  ref: RepoRef;
  source: CiSource;
  connectionName: string;
}

/** Provider của repo dự án với token kết nối Git của dự án (FR-035). */
export async function scmTarget(tx: Tx, deps: CiDeps, project: ProjectRow): Promise<ScmTarget> {
  if (!deps.providerFactory) throw new Error("Hub chưa cấu hình providerFactory.");
  const conn = await loadConnection(tx, requireMasterKey(deps), project.scmConnectionId);
  if (!conn) throw new ConflictError("SCM_CONNECTION_MISSING", "Kết nối Git của dự án không còn.");
  return {
    provider: deps.providerFactory(conn),
    ref: { owner: project.repoOwner, name: project.repoName },
    source: project.scmKind,
    connectionName: conn.name,
  };
}

const SOURCE_NAME: Record<CiSource, string> = { gitlab: "GitLab", github: "GitHub", jenkins: "Jenkins" };

/** Lỗi của GitLab/GitHub thành lỗi nghiệp vụ nói rõ thiếu gì, ở đâu (US2 scenario 4). */
export function scmDomainError(e: unknown, target: ScmTarget, what: string): unknown {
  if (!(e instanceof GitProviderError)) return e;
  const host = SOURCE_NAME[target.source];
  const repo = `${target.ref.owner}/${target.ref.name}`;
  switch (e.code) {
    case "unauthorized":
      return new ForbiddenError(
        "CI_SOURCE_UNAUTHORIZED",
        `${host} không nhận token của kết nối Git "${target.connectionName}". Quản trị tổ chức cập nhật token ở Cài đặt → Kết nối Git.`,
      );
    case "forbidden": {
      const scopes = e.missingScopes.length ? ` (thiếu scope ${e.missingScopes.join(", ")})` : "";
      return new ForbiddenError(
        "CI_SOURCE_FORBIDDEN",
        `Token của kết nối Git "${target.connectionName}" không có quyền ${what} trên ${host} ${repo}${scopes}. Cần tài khoản có vai trò Developer trở lên trong repo và token có scope api.`,
      );
    }
    case "not_found":
      return new NotFoundError("CI_NOT_FOUND", `Không tìm thấy pipeline hoặc job trên ${host} ${repo}.`);
    case "unsupported":
      return new BadRequestError("CI_UNSUPPORTED", e.message);
    case "rate_limited":
    case "unavailable":
      return new ConflictError("CI_SOURCE_UNAVAILABLE", `${host} không trả lời. Thử lại sau.`);
    default:
      return new ConflictError("CI_WRONG_STATE", e.message);
  }
}

export interface ProjectJob {
  id: string;
  connectionId: string;
  connectionName: string;
  watcherUserId: string | null;
  jobPath: string;
}

export async function projectJobs(tx: Tx, projectId: string, jobId?: string): Promise<ProjectJob[]> {
  return tx
    .select({
      id: ciProjectJobs.id,
      connectionId: ciProjectJobs.connectionId,
      connectionName: ciJenkinsConnections.name,
      watcherUserId: ciJenkinsConnections.watcherUserId,
      jobPath: ciProjectJobs.jobPath,
    })
    .from(ciProjectJobs)
    .innerJoin(ciJenkinsConnections, eq(ciJenkinsConnections.id, ciProjectJobs.connectionId))
    .where(
      jobId
        ? and(eq(ciProjectJobs.projectId, projectId), eq(ciProjectJobs.id, jobId))
        : eq(ciProjectJobs.projectId, projectId),
    )
    .orderBy(ciJenkinsConnections.name, ciProjectJobs.jobPath);
}

export async function projectJob(tx: Tx, projectId: string, jobId: string): Promise<ProjectJob> {
  const [job] = await projectJobs(tx, projectId, jobId);
  if (!job) throw new NotFoundError("NOT_FOUND", "Không tìm thấy job Jenkins của dự án.");
  return job;
}

/** Người có token cho từng kết nối, để chọn token đọc mà chưa phải giải mã. */
async function tokenOwners(tx: Tx, connectionIds: string[]): Promise<Set<string>> {
  if (connectionIds.length === 0) return new Set();
  const rows = await tx
    .select({ connectionId: ciJenkinsUserTokens.connectionId, userId: ciJenkinsUserTokens.userId })
    .from(ciJenkinsUserTokens)
    .where(inArray(ciJenkinsUserTokens.connectionId, connectionIds));
  return new Set(rows.map((r) => `${r.connectionId}:${r.userId}`));
}

/** Đọc bằng token của người xem nếu có, không thì người theo dõi (plan.md mục 2). */
function readerOf(job: ProjectJob, owners: Set<string>, userId: string): string | null {
  if (owners.has(`${job.connectionId}:${userId}`)) return userId;
  if (job.watcherUserId && owners.has(`${job.connectionId}:${job.watcherUserId}`)) return job.watcherUserId;
  return null;
}

/**
 * Dấu dùng token khi chỉ đọc gom theo ngày, dự án và người xem: tab CI/CD tự tải lại liên tục, mỗi lần một dòng audit sẽ
 * làm phình bảng mà không thêm thông tin.
 */
const readGroup = (projectId: string, userId: string) =>
  `ci.view:${projectId}:${userId}:${new Date().toISOString().slice(0, 10)}`;

/** Token đọc Jenkins cho một job: của người xem, không có thì của người theo dõi. */
export async function jenkinsReadAuth(
  tx: Tx,
  deps: CiDeps,
  userId: string,
  projectId: string,
  job: ProjectJob,
): Promise<JenkinsAuth> {
  const owners = await tokenOwners(tx, [job.connectionId]);
  const reader = readerOf(job, owners, userId);
  if (!reader) throw new ForbiddenError("JENKINS_NO_TOKEN", NO_READ_TOKEN);
  return jenkinsAuth(tx, requireMasterKey(deps), {
    connectionId: job.connectionId,
    userId: reader === userId ? userId : "watcher",
    reason: "ci.view",
    group: readGroup(projectId, userId),
  });
}

const NO_READ_TOKEN =
  "Chưa có token để đọc Jenkins. Thêm token Jenkins của bạn ở Cài đặt cá nhân, hoặc nhờ quản trị đặt người theo dõi có token.";

// ---- Định danh lượt CI ---------------------------------------------------------------------------------------------

export type ParsedRunId =
  | { source: "gitlab" | "github"; pipelineId: string }
  | { source: "jenkins"; jobId: string; build: number };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const jenkinsRunId = (jobId: string, build: number) => `jenkins:${jobId}:${build}`;

export function parseRunId(runId: string): ParsedRunId {
  const [source, ...rest] = runId.split(":");
  if ((source === "gitlab" || source === "github") && rest.length === 1 && /^\d+$/.test(rest[0] ?? ""))
    return { source, pipelineId: rest[0] as string };
  if (source === "jenkins" && rest.length === 2) {
    const [jobId, build] = rest as [string, string];
    if (UUID.test(jobId) && /^\d+$/.test(build)) return { source, jobId, build: Number(build) };
  }
  throw new BadRequestError("CI_RUN_ID_INVALID", "Mã lượt CI không hợp lệ.");
}

/** Lượt CI phải thuộc nguồn của dự án: không cho đọc pipeline của repo khác qua dự án này. */
export function expectScmSource(project: ProjectRow, run: ParsedRunId): void {
  if (run.source !== "jenkins" && run.source !== project.scmKind)
    throw new NotFoundError("CI_NOT_FOUND", "Dự án không có lượt CI này.");
}

// ---- Trạng thái ------------------------------------------------------------------------------------------------

const GIT_STATUS: Record<CiStatus, CiRunStatus> = {
  created: "queued",
  waiting_for_resource: "queued",
  preparing: "queued",
  pending: "queued",
  scheduled: "queued",
  running: "running",
  canceling: "running",
  success: "success",
  failed: "failed",
  canceled: "canceled",
  skipped: "skipped",
  manual: "waiting",
};

export const gitStatus = (s: CiStatus): CiRunStatus => GIT_STATUS[s] ?? "queued";

const JENKINS_RESULT: Record<string, CiRunStatus> = {
  SUCCESS: "success",
  FAILURE: "failed",
  UNSTABLE: "unstable",
  ABORTED: "canceled",
  NOT_BUILT: "skipped",
};

/** Trạng thái giai đoạn của Pipeline Stage View (`wfapi/describe`). */
const JENKINS_STAGE: Record<string, CiRunStatus> = {
  ...JENKINS_RESULT,
  FAILED: "failed",
  IN_PROGRESS: "running",
  PAUSED_PENDING_INPUT: "waiting",
  NOT_EXECUTED: "skipped",
  QUEUED: "queued",
};

export const jenkinsStageStatus = (s: string): CiRunStatus => JENKINS_STAGE[s] ?? "queued";

const iso = (ms: number) => (ms > 0 ? new Date(ms).toISOString() : null);

/** `origin/main`, `refs/remotes/origin/main` → `main`. */
function shortBranch(name: string | null): string | null {
  if (!name) return null;
  return name.replace(/^refs\/(heads|remotes\/[^/]+)\//, "").replace(/^origin\//, "");
}

export function jenkinsRun(job: ProjectJob, b: JenkinsBuild): CiRun {
  const cause = b.causes.find((c) => c.userId || c.userName);
  return {
    id: jenkinsRunId(job.id, b.number),
    source: "jenkins",
    jobId: job.id,
    title: `${job.jobPath} #${b.number}`,
    number: b.number,
    branch: shortBranch(b.commit?.branch ?? null),
    sha: b.commit?.sha ?? null,
    status: b.building ? "running" : (JENKINS_RESULT[b.result ?? ""] ?? "failed"),
    rawStatus: b.building ? "BUILDING" : (b.result ?? "UNKNOWN"),
    startedAt: iso(b.startedAt),
    finishedAt: b.building ? null : iso(b.startedAt + b.durationMs),
    durationSec: b.building ? null : Math.max(0, b.durationMs) / 1000,
    triggeredBy: cause?.userName ?? cause?.userId ?? null,
    url: b.url || null,
  };
}

export function gitRun(
  source: CiSource,
  p: {
    id: string;
    ref: string;
    sha: string | null;
    status: CiStatus;
    url: string | null;
    createdAt: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    durationSec: number | null;
    user: string | null;
  },
): CiRun {
  return {
    id: `${source}:${p.id}`,
    source,
    jobId: null,
    title: `Pipeline #${p.id}`,
    number: /^\d+$/.test(p.id) ? Number(p.id) : null,
    branch: p.ref || null,
    sha: p.sha || null,
    status: gitStatus(p.status),
    rawStatus: p.status,
    startedAt: p.startedAt ?? p.createdAt,
    finishedAt: p.finishedAt,
    durationSec: p.durationSec,
    triggeredBy: p.user,
    url: p.url,
  };
}

// ---- Đệm -----------------------------------------------------------------------------------------------------------

const FRESH_MS = 10_000;
/** Đủ cho mọi dự án đang mở của một hub; quá thì bỏ mục cũ nhất. */
const CACHE_MAX = 1_000;

interface SourceItems {
  runs: CiRun[];
  more: boolean;
}

/** Kết quả đọc gần nhất của từng nguồn: dưới 10 giây thì dùng lại, nguồn lỗi thì trả bản này kèm cờ `stale`. */
const cache = new Map<string, { at: number; value: SourceItems }>();

function remember(key: string, at: number, value: SourceItems): void {
  cache.delete(key);
  cache.set(key, { at, value });
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/** Cho test: mỗi test bắt đầu với đệm rỗng. */
export function clearCiFeedCache(): void {
  cache.clear();
}

// ---- Danh sách gộp --------------------------------------------------------------------------------------------------

/** Trang sâu nhất đọc được: mỗi trang đọc lại từ đầu mọi nguồn rồi gộp, nên phải có giới hạn. */
const MAX_DEPTH = 500;
const GIT_PER_PAGE = 100;

function pageOf(cursor: string | undefined): number {
  if (cursor === undefined) return 1;
  if (!/^\d{1,4}$/.test(cursor) || Number(cursor) < 1)
    throw new BadRequestError("CI_CURSOR_INVALID", "Vị trí trang không hợp lệ. Tải lại danh sách.");
  return Number(cursor);
}

interface SourcePlan {
  meta: Omit<CiFeedSource, "state" | "stale" | "fetchedAt" | "message">;
  key: string | null;
  /** null: chưa có token, hoặc đệm còn mới nên không gọi nguồn. */
  load: (() => Promise<SourceItems>) | null;
  /** Lỗi khi chuẩn bị (vd. kết nối Git của dự án đã xoá): báo ở nguồn này, không chặn nguồn khác. */
  failed?: unknown;
}

async function gitLoad(target: ScmTarget, branch: string | undefined, needed: number): Promise<SourceItems> {
  const perPage = Math.min(GIT_PER_PAGE, needed);
  const runs: CiRun[] = [];
  let page: number | null = 1;
  while (page !== null && runs.length < needed) {
    const res = await target.provider.listPipelines(target.ref, {
      page,
      perPage,
      ...(branch ? { branch } : {}),
    });
    runs.push(...res.items.map((p) => gitRun(target.source, p)));
    page = res.nextPage;
  }
  return { runs: runs.slice(0, needed), more: runs.length > needed || page !== null };
}

async function jenkinsLoad(deps: CiDeps, auth: JenkinsAuth, job: ProjectJob, needed: number): Promise<SourceItems> {
  const builds = await jenkinsClient(deps, auth).builds(job.jobPath, needed + 1);
  return { runs: builds.slice(0, needed).map((b) => jenkinsRun(job, b)), more: builds.length > needed };
}

function failureMessage(e: unknown): string {
  if (e instanceof JenkinsError || e instanceof GitProviderError) return e.message;
  if (e instanceof ForbiddenError || e instanceof ConflictError || e instanceof NotFoundError) return e.message;
  return "Không đọc được nguồn này. Thử lại sau.";
}

const runTime = (r: CiRun) => (r.startedAt ? Date.parse(r.startedAt) : 0);

export async function ciFeed(deps: CiDeps, actor: CiActor, input: CiFeedInput): Promise<CiFeed> {
  const page = pageOf(input.cursor);
  const end = page * input.limit;
  if (end > MAX_DEPTH)
    throw new BadRequestError(
      "CI_CURSOR_INVALID",
      "Danh sách chỉ xem được 500 lượt gần nhất. Lọc theo nhánh để xem cũ hơn.",
    );
  const now = deps.now ?? Date.now;
  const isFresh = (key: string) => {
    const hit = cache.get(key);
    return hit !== undefined && now() - hit.at < FRESH_MS;
  };

  const plans = await withTenant(requirePool(deps), actor, async (tx) => {
    const project = await ciProject(tx, actor.userId, input.projectId, "ci.view");
    const out: SourcePlan[] = [];

    if (!input.source || input.source === project.scmKind) {
      const key = `${actor.orgId}:${project.scmKind}:${project.id}:${input.branch ?? ""}:${end}`;
      let target: ScmTarget | null = null;
      let failed: unknown;
      if (!isFresh(key)) {
        try {
          target = await scmTarget(tx, deps, project);
        } catch (e) {
          failed = e;
        }
      }
      out.push({
        ...(failed === undefined ? {} : { failed }),
        meta: {
          source: project.scmKind,
          jobId: null,
          connectionId: null,
          label: `${SOURCE_NAME[project.scmKind]} ${project.repoOwner}/${project.repoName}`,
          hasMyToken: null,
        },
        key,
        load: target ? () => gitLoad(target, input.branch, end) : null,
      });
    }

    if (!input.source || input.source === "jenkins") {
      const jobs = await projectJobs(tx, project.id);
      const owners = await tokenOwners(tx, [...new Set(jobs.map((j) => j.connectionId))]);
      for (const job of jobs) {
        const meta = {
          source: "jenkins" as const,
          jobId: job.id,
          connectionId: job.connectionId,
          label: `${job.connectionName}: ${job.jobPath}`,
          hasMyToken: owners.has(`${job.connectionId}:${actor.userId}`),
        };
        const reader = readerOf(job, owners, actor.userId);
        if (!reader) {
          out.push({ meta, key: null, load: null });
          continue;
        }
        // Token người khác có thể thấy job khác nhau, nên đệm theo chủ token.
        const key = `${actor.orgId}:jenkins:${job.id}:${reader}:${end}`;
        const auth = isFresh(key) ? null : await jenkinsReadAuth(tx, deps, actor.userId, project.id, job);
        out.push({ meta, key, load: auth ? () => jenkinsLoad(deps, auth, job, end) : null });
      }
    }
    return out;
  });

  const results = await Promise.all(
    plans.map(async (plan): Promise<{ source: CiFeedSource; items: SourceItems | null }> => {
      if (plan.key === null)
        return {
          source: { ...plan.meta, state: "no_token", stale: false, fetchedAt: null, message: NO_READ_TOKEN },
          items: null,
        };
      const key = plan.key;
      if (plan.load || plan.failed !== undefined) {
        try {
          if (!plan.load) throw plan.failed;
          const items = await plan.load();
          const at = now();
          remember(key, at, items);
          return {
            source: { ...plan.meta, state: "ok", stale: false, fetchedAt: new Date(at).toISOString(), message: null },
            items,
          };
        } catch (e) {
          const last = cache.get(key);
          const message = failureMessage(e);
          if (!last)
            return { source: { ...plan.meta, state: "error", stale: false, fetchedAt: null, message }, items: null };
          return {
            source: { ...plan.meta, state: "stale", stale: true, fetchedAt: new Date(last.at).toISOString(), message },
            items: last.value,
          };
        }
      }
      const hit = cache.get(key);
      if (!hit)
        return {
          source: { ...plan.meta, state: "error", stale: false, fetchedAt: null, message: failureMessage(null) },
          items: null,
        };
      return {
        source: { ...plan.meta, state: "ok", stale: false, fetchedAt: new Date(hit.at).toISOString(), message: null },
        items: hit.value,
      };
    }),
  );

  const merged = results
    .flatMap((r) => r.items?.runs ?? [])
    .filter((r) => (!input.branch || r.branch === input.branch) && (!input.status || r.status === input.status))
    .sort((a, b) => runTime(b) - runTime(a) || b.id.localeCompare(a.id));
  const more = merged.length > end || results.some((r) => r.items?.more);
  return {
    items: merged.slice(end - input.limit, end),
    nextCursor: more && end < MAX_DEPTH ? String(page + 1) : null,
    sources: results.map((r) => r.source),
  };
}
