import type { CiRun, CiRunStatus } from "@xdev-hive/contracts";
import { and, asc, desc, eq, gt, inArray, isNotNull, like, lte, ne, sql } from "drizzle-orm";
import type pg from "pg";
import { loadProject, type ProjectRow } from "../../catalog/index.ts";
import { type Jobs, SecretDecryptError, type Tx, withTenant } from "../../platform/index.ts";
import type { CiPipeline, CiJob as ScmCiJob } from "../../scm/index.ts";
import { type FetchLike, type JenkinsBuild, JenkinsError } from "../clients/jenkins.ts";
import { type JenkinsAuth, jenkinsAuth } from "../connections/credentials.ts";
import { jenkinsClient, requireMasterKey } from "../connections/jenkins.ts";
import type { DeliveryDeps } from "../deps.ts";
import { type DeliveryEvent, emitDeliveryEvent } from "../notifications.ts";
import { DELIVERY_CI_POLL_QUEUE } from "../queues.ts";
import { ciJenkinsConnections, ciProjectJobs, ciRunsSeen } from "../schema.ts";
import { gitStatus, jenkinsRun, requirePool, scmTarget } from "./feed.ts";

// Hỏi Jenkins theo lịch, hỏi lại GitLab khi lỡ webhook, và báo đỏ/xanh của nhánh mặc định (FR-006, plan.md mục 4).
// Gọi Jenkins/GitLab ngoài transaction: một nguồn chậm không được giữ kết nối pool. Phần ghi `ci_runs_seen` nằm ở đây
// (không tách file) để gitlab-events.ts và webhook-refresh.ts dùng lại mà không import vòng.

/** Q4: kết nối không có build nào đang chạy thì 5 phút hỏi một lần. */
export const CI_POLL_IDLE_MS = 5 * 60_000;
/** Có build đang chạy thì hỏi dày để thấy build xong sớm. */
export const CI_POLL_BUSY_MS = 15_000;
/** Lỗi liên tiếp thì giãn dần từ chu kỳ rảnh tới trần này, để Jenkins hỏng không bị hỏi dồn. */
export const CI_POLL_BACKOFF_MAX_MS = 30 * 60_000;
/** Pipeline GitLab chưa xong thì hỏi lại sau chừng này, phòng webhook pipeline bị lỡ. */
export const GITLAB_RECHECK_MS = 5 * 60_000;
/** Lượt quét nối lại chuỗi hỏi của kết nối bị đứt (hub chết giữa chừng, job lỗi hết lượt thử). */
export const CI_POLL_SCAN_CRON = "*/5 * * * *";
const JENKINS_POLL_BUILDS = 10;
/** Pipeline chưa xong cũ hơn chừng này thì thôi hỏi lại: GitLab đã xoá hoặc nằm ngoài trang đầu. */
const GITLAB_RECHECK_WINDOW_MS = 24 * 3_600_000;
const GITLAB_RECHECK_PAGE = 100;

const TERMINAL: ReadonlySet<CiRunStatus> = new Set(["success", "failed", "unstable", "canceled", "skipped"]);
const UNFINISHED: CiRunStatus[] = ["queued", "running"];

export type CiPollJob =
  | { kind: "scan" }
  | { kind: "jenkins"; orgId: string; connectionId: string; failures?: number }
  | { kind: "gitlab"; orgId: string; projectId: string; failures?: number };

export interface CiPollDeps extends Omit<DeliveryDeps, "jobs"> {
  /** Test cố định đồng hồ để kiểm giờ hẹn chạy lại. */
  now?: (() => number) | undefined;
}

// ---- Chu kỳ và quy tắc báo ------------------------------------------------------------------------------------------

export function nextPollDelay(opts: { failures: number; building: boolean }): number {
  if (opts.failures > 0) return Math.min(CI_POLL_BACKOFF_MAX_MS, CI_POLL_IDLE_MS * 2 ** (opts.failures - 1));
  return opts.building ? CI_POLL_BUSY_MS : CI_POLL_IDLE_MS;
}

/** Trạng thái đỏ/xanh của nhánh mặc định; `unstable`, huỷ, bỏ qua không đổi trạng thái đã báo. */
export type CiState = "failed" | "success";

/** Đỏ báo một lần cho tới khi xanh lại; xanh chỉ báo khi lần báo trước là đỏ. */
export function ciNotice(
  prev: string | null,
  next: CiState | null,
): Extract<DeliveryEvent, "ci.failed" | "ci.recovered"> | null {
  if (next === "failed") return prev === "failed" ? null : "ci.failed";
  if (next === "success") return prev === "failed" ? "ci.recovered" : null;
  return null;
}

/**
 * Build có thuộc nhánh mặc định của dự án không. Dự án chưa ghi nhánh thì là `main`. Build Jenkins không ghi nhánh (job
 * freestyle build một nhánh cố định) tính là của dự án [Suy luận].
 */
export function onDefaultBranch(branch: string | null, projectDefault: string | null): boolean {
  if (!branch) return true;
  return branch === (projectDefault || "main");
}

// ---- Đọc Jenkins --------------------------------------------------------------------------------------------------

const WATCHER_NO_TOKEN =
  "Người theo dõi kết nối chưa có token Jenkins, hub không đọc được build theo lịch. Người theo dõi thêm token ở Cài đặt cá nhân → Token Jenkins, hoặc quản trị đổi người theo dõi.";
const WATCHER_TOKEN_UNREADABLE =
  "Hub không giải mã được token Jenkins của người theo dõi (HIVE_MASTER_KEY đã đổi?). Người theo dõi nhập lại token ở Cài đặt cá nhân → Token Jenkins.";
const WATCHER_REJECTED =
  "Jenkins không nhận token của người theo dõi kết nối (token hết hạn hoặc bị thu hồi). Người theo dõi cập nhật token ở Cài đặt cá nhân → Token Jenkins, hoặc quản trị đổi người theo dõi.";
const POLL_CRASHED = "Hub gặp lỗi khi đọc build Jenkins theo lịch; sẽ thử lại sau.";

export interface JenkinsJobBuilds {
  jobId: string;
  /** Mới nhất trước, như Jenkins trả; null khi đọc job này lỗi. */
  builds: JenkinsBuild[] | null;
  error: string | null;
}

/**
 * Đọc build gần nhất của từng job bằng token người theo dõi. Lỗi riêng một job (job đã xoá, thiếu quyền job đó) ghi vào
 * job đó rồi đọc tiếp; Jenkins không nhận token hoặc không trả lời thì dừng cả lượt (`fatal`), hỏi job khác cũng vô ích.
 */
export async function readJenkinsBuilds(
  deps: { fetch?: FetchLike | undefined },
  auth: Pick<JenkinsAuth, "baseUrl" | "user" | "token">,
  jobs: ReadonlyArray<{ id: string; jobPath: string }>,
): Promise<{ results: JenkinsJobBuilds[]; fatal: string | null }> {
  const client = jenkinsClient(deps, auth);
  const results: JenkinsJobBuilds[] = [];
  for (const job of jobs) {
    try {
      results.push({ jobId: job.id, builds: await client.builds(job.jobPath, JENKINS_POLL_BUILDS), error: null });
    } catch (e) {
      if (e instanceof JenkinsError && e.code === "UNAUTHORIZED") return { results, fatal: WATCHER_REJECTED };
      if (e instanceof JenkinsError && e.code === "UNAVAILABLE") return { results, fatal: e.message };
      // Câu báo của client Jenkins không chứa token; lỗi lạ thì không đưa nguyên văn ra giao diện.
      const why = e instanceof JenkinsError ? e.message : "Không đọc được danh sách build.";
      results.push({ jobId: job.id, builds: null, error: `Job ${job.jobPath}: ${why}` });
    }
  }
  return { results, fatal: null };
}

// ---- Ghi trạng thái đã thấy và báo đỏ/xanh ---------------------------------------------------------------------------

export interface SeenRun {
  projectId: string;
  source: "gitlab" | "github" | "jenkins";
  externalId: string;
  /** Tiền tố `external_id` của cùng một dòng build (một job Jenkins, một dự án GitLab): đỏ/xanh tính trong dòng này. */
  streamPrefix: string;
  status: CiRunStatus;
  branch: string | null;
  finishedAt: Date | null;
  defaultBranch: boolean;
  title: string;
  url: string | null;
  sha: string | null;
}

export interface RecordOptions {
  project: Pick<ProjectRow, "key" | "systemId">;
  publicUrl?: string | undefined;
  jobs?: Jobs | undefined;
  /** Lần đầu thấy một job: chỉ ghi nhận trạng thái, không báo về build cũ. */
  silent?: boolean | undefined;
  now: number;
}

export interface RecordResult {
  /** Dòng `ci_runs_seen` đổi. Cùng trạng thái gửi lại (webhook lặp, hỏi lại) thì false. */
  changed: boolean;
  /** Lần này mới thấy build/pipeline xong. */
  finished: boolean;
  notice: "ci.failed" | "ci.recovered" | null;
}

const stateOf = (run: SeenRun): CiState | null =>
  run.defaultBranch && (run.status === "failed" || run.status === "success") ? run.status : null;

/**
 * Ghi trạng thái một lần chạy và báo khi nhánh mặc định chuyển đỏ hoặc xanh lại. Trạng thái trước lấy từ lần chạy đã
 * xong gần nhất (theo giờ xong) trong cùng dòng build, nên webhook tới trễ hay lặp không đổi kết quả.
 */
export async function recordCiRun(tx: Tx, orgId: string, run: SeenRun, opts: RecordOptions): Promise<RecordResult> {
  // Hai webhook của cùng dự án xử lý song song không được cùng thấy "chưa báo đỏ".
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`ci_runs_seen:${orgId}:${run.source}:${run.streamPrefix}`}, 0))`,
  );
  const [row] = await tx
    .select()
    .from(ciRunsSeen)
    .where(and(eq(ciRunsSeen.source, run.source), eq(ciRunsSeen.externalId, run.externalId)));
  if (row && row.status === run.status) return { changed: false, finished: false, notice: null };

  if (!TERMINAL.has(run.status)) {
    // Chạy lại sau khi đã xong: giữ giờ xong và trạng thái đã báo cũ để lần xong sau so với đúng nó.
    if (row)
      await tx
        .update(ciRunsSeen)
        .set({ status: run.status, branch: run.branch, updatedAt: sql`clock_timestamp()` })
        .where(eq(ciRunsSeen.id, row.id));
    else
      await tx.insert(ciRunsSeen).values({
        orgId,
        projectId: run.projectId,
        source: run.source,
        externalId: run.externalId,
        status: run.status,
        branch: run.branch,
      });
    return { changed: true, finished: false, notice: null };
  }

  const finishedAt = run.finishedAt ?? new Date(opts.now);
  const state = stateOf(run);
  let notice: RecordResult["notice"] = null;
  if (state && !opts.silent) {
    const stream = and(
      eq(ciRunsSeen.source, run.source),
      like(ciRunsSeen.externalId, `${run.streamPrefix}%`),
      isNotNull(ciRunsSeen.notifiedState),
    );
    // Đã có lần chạy xong sau lần này và đã tính đỏ/xanh: lần này tới trễ, không đổi trạng thái của nhánh.
    const [newer] = await tx
      .select({ id: ciRunsSeen.id })
      .from(ciRunsSeen)
      .where(and(stream, gt(ciRunsSeen.finishedAt, finishedAt), row ? ne(ciRunsSeen.id, row.id) : undefined))
      .limit(1);
    if (!newer) {
      const [prev] = await tx
        .select({ state: ciRunsSeen.notifiedState })
        .from(ciRunsSeen)
        .where(and(stream, lte(ciRunsSeen.finishedAt, finishedAt)))
        .orderBy(desc(ciRunsSeen.finishedAt), desc(ciRunsSeen.updatedAt))
        .limit(1);
      notice = ciNotice(prev?.state ?? null, state);
    }
  }

  const values = {
    status: run.status,
    branch: run.branch,
    finishedAt,
    notifiedState: state ?? row?.notifiedState ?? null,
  };
  if (row)
    await tx
      .update(ciRunsSeen)
      .set({ ...values, updatedAt: sql`clock_timestamp()` })
      .where(eq(ciRunsSeen.id, row.id));
  else
    await tx
      .insert(ciRunsSeen)
      .values({ orgId, projectId: run.projectId, source: run.source, externalId: run.externalId, ...values });

  if (notice) await emitCiNotice(tx, orgId, run, notice, finishedAt, opts);
  return { changed: true, finished: true, notice };
}

async function emitCiNotice(
  tx: Tx,
  orgId: string,
  run: SeenRun,
  event: "ci.failed" | "ci.recovered",
  finishedAt: Date,
  opts: RecordOptions,
): Promise<void> {
  const branch = run.branch ?? "mặc định";
  const key = opts.project.key;
  const commit = run.sha ? ` (commit ${run.sha.slice(0, 8)})` : "";
  const what =
    event === "ci.failed"
      ? `${run.title} lỗi trên nhánh ${branch}${commit}.`
      : `${run.title} chạy xanh${commit}, nhánh ${branch} hết lỗi.`;
  await emitDeliveryEvent(
    tx,
    {
      orgId,
      event,
      title: event === "ci.failed" ? `CI lỗi: ${key} nhánh ${branch}` : `CI xanh lại: ${key} nhánh ${branch}`,
      body: run.url ? `${what}\n${run.url}` : what,
      systemId: opts.project.systemId,
      eventKey: `ci:${run.source}:${run.externalId}:${event}:${finishedAt.toISOString()}`,
      link: opts.publicUrl ? `${opts.publicUrl.replace(/\/+$/, "")}/projects/${encodeURIComponent(key)}/cicd` : run.url,
    },
    opts.jobs,
  );
}

/** Pipeline GitLab/GitHub của dự án: dòng build là cả dự án. */
export function recordGitPipeline(
  tx: Tx,
  orgId: string,
  project: ProjectRow,
  pipeline: CiPipeline,
  opts: Omit<RecordOptions, "project">,
): Promise<RecordResult> {
  const status = gitStatus(pipeline.status);
  const branch = pipeline.ref || null;
  const done = pipeline.finishedAt ?? pipeline.updatedAt;
  return recordCiRun(
    tx,
    orgId,
    {
      projectId: project.id,
      source: project.scmKind,
      externalId: `${project.id}:${pipeline.id}`,
      streamPrefix: `${project.id}:`,
      status,
      branch,
      finishedAt: TERMINAL.has(status) && done ? new Date(done) : null,
      defaultBranch: onDefaultBranch(branch, project.defaultBranch),
      title: `Pipeline #${pipeline.id}`,
      url: pipeline.url,
      sha: pipeline.sha || null,
    },
    { ...opts, project },
  );
}

/** Job chạy (lại) nghĩa là pipeline của nó đang chạy, kể cả khi trước đó đã xong. */
export function markGitPipelineActive(
  tx: Tx,
  orgId: string,
  project: ProjectRow,
  job: ScmCiJob,
  opts: Omit<RecordOptions, "project">,
): Promise<RecordResult> {
  return recordCiRun(
    tx,
    orgId,
    {
      projectId: project.id,
      source: project.scmKind,
      externalId: `${project.id}:${job.pipelineId}`,
      streamPrefix: `${project.id}:`,
      status: "running",
      branch: job.ref || null,
      finishedAt: null,
      defaultBranch: onDefaultBranch(job.ref || null, project.defaultBranch),
      title: `Pipeline #${job.pipelineId}`,
      url: null,
      sha: job.sha || null,
    },
    { ...opts, project },
  );
}

// ---- Báo build Jenkins xong cho phần khác (T024) --------------------------------------------------------------------

export interface JenkinsBuildFinished {
  orgId: string;
  connectionId: string;
  projectId: string;
  /** Id dòng `ci_project_jobs`. */
  jobId: string;
  jobPath: string;
  build: JenkinsBuild;
  run: CiRun;
}

/** Chạy trong transaction ghi `ci_runs_seen`: handler ném lỗi thì cả lượt rollback và lần hỏi sau thử lại. */
export type JenkinsBuildFinishedHandler = (event: JenkinsBuildFinished, ctx: { tx: Tx }) => Promise<void>;

const buildFinishedHandlers = new Set<JenkinsBuildFinishedHandler>();

/**
 * Đăng ký nhận build Jenkins vừa xong (mỗi build một lần, trừ build có sẵn lúc hub mới thấy job). Trả hàm huỷ đăng ký.
 */
export function onJenkinsBuildFinished(handler: JenkinsBuildFinishedHandler): () => void {
  buildFinishedHandlers.add(handler);
  return () => {
    buildFinishedHandlers.delete(handler);
  };
}

// ---- Xếp job ------------------------------------------------------------------------------------------------------

/** Hẹn lần hỏi kế của một kết nối Jenkins. Đã có lần hẹn đang chờ thì giữ lần đó (stately theo id kết nối). */
export function ensureCiPoll(
  jobs: Jobs,
  target: { orgId: string; connectionId: string },
  opts: { tx?: Tx | undefined; delayMs?: number; now?: number; failures?: number } = {},
): Promise<string | null> {
  const data: CiPollJob = {
    kind: "jenkins",
    orgId: target.orgId,
    connectionId: target.connectionId,
    ...(opts.failures ? { failures: opts.failures } : {}),
  };
  return jobs.enqueue(DELIVERY_CI_POLL_QUEUE, data, {
    singletonKey: target.connectionId,
    ...(opts.tx ? { tx: opts.tx } : {}),
    ...(opts.delayMs ? { startAfter: new Date((opts.now ?? Date.now()) + opts.delayMs) } : {}),
  });
}

/** Hẹn hỏi lại GitLab sau 5 phút cho dự án còn pipeline chưa xong. */
export function queueGitlabRecheck(
  jobs: Jobs,
  target: { orgId: string; projectId: string },
  opts: { tx?: Tx | undefined; now?: number; failures?: number } = {},
): Promise<string | null> {
  const failures = opts.failures ?? 0;
  const data: CiPollJob = {
    kind: "gitlab",
    orgId: target.orgId,
    projectId: target.projectId,
    ...(failures ? { failures } : {}),
  };
  const delay = failures ? nextPollDelay({ failures, building: false }) : GITLAB_RECHECK_MS;
  return jobs.enqueue(DELIVERY_CI_POLL_QUEUE, data, {
    singletonKey: `gitlab:${target.projectId}`,
    ...(opts.tx ? { tx: opts.tx } : {}),
    startAfter: new Date((opts.now ?? Date.now()) + delay),
  });
}

/**
 * Tổ chức có Jenkins hoặc dự án GitLab cần theo dõi. Job không có tổ chức trong context nên cần hàm SECURITY DEFINER
 * `hive.delivery_active_orgs()`; chưa có migration thì trả rỗng và chuỗi hỏi chỉ bắt đầu từ `ensureCiPoll`.
 */
export async function deliveryActiveOrgs(pool: pg.Pool): Promise<string[]> {
  return withTenant(pool, {}, async (tx) => {
    const { rows: probe } = await tx.execute<{ ok: boolean }>(
      sql`select to_regprocedure('hive.delivery_active_orgs()') is not null as ok`,
    );
    if (!probe[0]?.ok) return [];
    const { rows } = await tx.execute<{ org_id: string }>(sql`select org_id from hive.delivery_active_orgs()`);
    return rows.map((r) => r.org_id);
  });
}

// ---- Chạy job -----------------------------------------------------------------------------------------------------

export async function runCiPollJob(deps: CiPollDeps, jobs: Jobs, data: CiPollJob): Promise<void> {
  switch (data.kind) {
    case "scan":
      return scanCiPolls(deps, jobs);
    case "jenkins":
      return pollJenkinsConnection(deps, jobs, data);
    case "gitlab":
      return recheckGitlabProject(deps, jobs, data);
  }
}

/** Nối lại chuỗi hỏi của mọi kết nối và dự án còn việc; chuỗi đang chạy thì enqueue bị bỏ qua (stately). */
async function scanCiPolls(deps: CiPollDeps, jobs: Jobs): Promise<void> {
  const pool = requirePool(deps);
  const now = clock(deps)();
  for (const orgId of await deliveryActiveOrgs(pool)) {
    const found = await withTenant(pool, { orgId }, async (tx) => {
      const connections = await tx
        .selectDistinct({ id: ciJenkinsConnections.id })
        .from(ciJenkinsConnections)
        .innerJoin(ciProjectJobs, eq(ciProjectJobs.connectionId, ciJenkinsConnections.id))
        .where(isNotNull(ciJenkinsConnections.watcherUserId));
      const projects = await tx
        .selectDistinct({ id: ciRunsSeen.projectId })
        .from(ciRunsSeen)
        .where(
          and(
            ne(ciRunsSeen.source, "jenkins"),
            inArray(ciRunsSeen.status, UNFINISHED),
            gt(ciRunsSeen.updatedAt, new Date(now - GITLAB_RECHECK_WINDOW_MS)),
          ),
        );
      return { connections, projects };
    });
    for (const c of found.connections) await ensureCiPoll(jobs, { orgId, connectionId: c.id });
    for (const p of found.projects) if (p.id) await queueGitlabRecheck(jobs, { orgId, projectId: p.id }, { now });
  }
}

const clock = (deps: CiPollDeps) => deps.now ?? Date.now;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function watcherTokenError(e: unknown): string | null {
  if (e instanceof SecretDecryptError) return WATCHER_TOKEN_UNREADABLE;
  if ((e as { code?: unknown }).code === "JENKINS_NO_TOKEN") return WATCHER_NO_TOKEN;
  return null;
}

async function markConnection(tx: Tx, connectionId: string, lastError: string | null, now: number): Promise<void> {
  await tx
    .update(ciJenkinsConnections)
    .set({ lastError, lastPollAt: new Date(now) })
    .where(eq(ciJenkinsConnections.id, connectionId));
}

async function pollJenkinsConnection(
  deps: CiPollDeps,
  jobs: Jobs,
  data: Extract<CiPollJob, { kind: "jenkins" }>,
): Promise<void> {
  const pool = requirePool(deps);
  const masterKey = requireMasterKey(deps);
  const now = clock(deps);
  const tenant = { orgId: data.orgId };
  const target = { orgId: data.orgId, connectionId: data.connectionId };
  const failures = data.failures ?? 0;

  const prep = await withTenant(pool, tenant, async (tx) => {
    const [conn] = await tx
      .select({ name: ciJenkinsConnections.name, watcherUserId: ciJenkinsConnections.watcherUserId })
      .from(ciJenkinsConnections)
      .where(eq(ciJenkinsConnections.id, data.connectionId));
    // Kết nối đã xoá, không còn người theo dõi, hoặc chưa gắn job nào: dừng chuỗi; gắn lại thì `ensureCiPoll` nối lại.
    if (!conn?.watcherUserId) return null;
    const projectJobs = await tx
      .select({ id: ciProjectJobs.id, projectId: ciProjectJobs.projectId, jobPath: ciProjectJobs.jobPath })
      .from(ciProjectJobs)
      .where(eq(ciProjectJobs.connectionId, data.connectionId))
      .orderBy(asc(ciProjectJobs.createdAt));
    if (!projectJobs.length) return null;
    try {
      const auth = await jenkinsAuth(tx, masterKey, {
        connectionId: data.connectionId,
        userId: "watcher",
        reason: "ci.poll",
        // Hỏi 15 giây một lần: mỗi ngày một dòng audit cho mỗi kết nối là đủ.
        group: `ci.poll:${data.connectionId}:${day(now())}`,
      });
      return { ok: true as const, auth, conn: { ...conn, watcherUserId: conn.watcherUserId }, projectJobs };
    } catch (e) {
      const why = watcherTokenError(e);
      if (!why) throw e;
      await markConnection(tx, data.connectionId, why, now());
      return { ok: false as const };
    }
  });
  if (!prep) return;
  if (!prep.ok) {
    await ensureCiPoll(jobs, target, {
      failures: failures + 1,
      delayMs: nextPollDelay({ failures: failures + 1, building: false }),
      now: now(),
    });
    return;
  }

  const read = await readJenkinsBuilds(deps, prep.auth, prep.projectJobs);
  const byId = new Map(prep.projectJobs.map((j) => [j.id, j]));
  const finished: JenkinsBuildFinished[] = [];

  const building = await withTenant(pool, tenant, async (tx) => {
    let anyBuilding = false;
    const errors: string[] = [];
    for (const result of read.results) {
      const job = byId.get(result.jobId);
      if (!job) continue;
      if (!result.builds) {
        if (result.error) errors.push(result.error);
        continue;
      }
      const project = await loadProject(tx, job.projectId);
      if (!project) continue;
      const prefix = `${job.id}:`;
      const [known] = await tx
        .select({ id: ciRunsSeen.id })
        .from(ciRunsSeen)
        .where(and(eq(ciRunsSeen.source, "jenkins"), like(ciRunsSeen.externalId, `${prefix}%`)))
        .limit(1);
      const projectJob = {
        id: job.id,
        connectionId: data.connectionId,
        connectionName: prep.conn.name,
        watcherUserId: prep.conn.watcherUserId,
        jobPath: job.jobPath,
      };
      // Cũ trước mới sau, để đỏ/xanh đi đúng thứ tự build.
      for (const build of [...result.builds].reverse()) {
        if (build.building) anyBuilding = true;
        const run = jenkinsRun(projectJob, build);
        const outcome = await recordCiRun(
          tx,
          data.orgId,
          {
            projectId: project.id,
            source: "jenkins",
            externalId: `${prefix}${build.number}`,
            streamPrefix: prefix,
            status: run.status,
            branch: run.branch,
            finishedAt: run.finishedAt ? new Date(run.finishedAt) : null,
            defaultBranch: onDefaultBranch(run.branch, project.defaultBranch),
            title: run.title,
            url: run.url,
            sha: run.sha,
          },
          { project, publicUrl: deps.publicUrl, jobs, silent: !known, now: now() },
        );
        if (outcome.finished && known)
          finished.push({
            orgId: data.orgId,
            connectionId: data.connectionId,
            projectId: project.id,
            jobId: job.id,
            jobPath: job.jobPath,
            build,
            run,
          });
      }
    }
    for (const event of finished) for (const handler of buildFinishedHandlers) await handler(event, { tx });
    await markConnection(tx, data.connectionId, read.fatal ?? (errors.length ? errors.join("\n") : null), now());
    return anyBuilding;
  });

  const nextFailures = read.fatal ? failures + 1 : 0;
  await ensureCiPoll(jobs, target, {
    failures: nextFailures,
    delayMs: nextPollDelay({ failures: nextFailures, building }),
    now: now(),
  });
}

async function recheckGitlabProject(
  deps: CiPollDeps,
  jobs: Jobs,
  data: Extract<CiPollJob, { kind: "gitlab" }>,
): Promise<void> {
  const pool = requirePool(deps);
  const now = clock(deps);
  const tenant = { orgId: data.orgId };
  const prefix = `${data.projectId}:`;

  const prep = await withTenant(pool, tenant, async (tx) => {
    const pending = await tx
      .select({ externalId: ciRunsSeen.externalId })
      .from(ciRunsSeen)
      .where(
        and(
          eq(ciRunsSeen.projectId, data.projectId),
          ne(ciRunsSeen.source, "jenkins"),
          inArray(ciRunsSeen.status, UNFINISHED),
          gt(ciRunsSeen.updatedAt, new Date(now() - GITLAB_RECHECK_WINDOW_MS)),
        ),
      );
    if (!pending.length) return null;
    const project = await loadProject(tx, data.projectId);
    if (project?.scmKind !== "gitlab") return null;
    const target = await scmTarget(tx, deps, project);
    return { project, target, ids: new Set(pending.map((p) => p.externalId.slice(prefix.length))) };
  });
  if (!prep) return;

  const found: CiPipeline[] = [];
  try {
    // Pipeline chưa xong thường là mới nhất; trang đầu đủ, còn sót thì ra khỏi cửa sổ 24 giờ.
    const page = await prep.target.provider.listPipelines(prep.target.ref, { page: 1, perPage: GITLAB_RECHECK_PAGE });
    for (const p of page.items) if (prep.ids.has(p.id)) found.push(p);
  } catch (e) {
    const failures = (data.failures ?? 0) + 1;
    console.warn(
      `delivery-ci-poll: không hỏi lại được pipeline của dự án ${prep.project.key}:`,
      e instanceof Error ? e.message : String(e),
    );
    await queueGitlabRecheck(jobs, tenantTarget(data), { failures, now: now() });
    return;
  }

  const open = await withTenant(pool, tenant, async (tx) => {
    let stillOpen = false;
    for (const p of found) {
      await recordGitPipeline(tx, data.orgId, prep.project, p, { publicUrl: deps.publicUrl, jobs, now: now() });
      if (UNFINISHED.includes(gitStatus(p.status))) stillOpen = true;
    }
    return stillOpen;
  });
  if (open) await queueGitlabRecheck(jobs, tenantTarget(data), { now: now() });
}

const tenantTarget = (data: { orgId: string; projectId: string }) => ({
  orgId: data.orgId,
  projectId: data.projectId,
});

// ---- Đăng ký worker -----------------------------------------------------------------------------------------------

/** Lỗi ngoài dự tính: ghi lỗi chung cho kết nối và hẹn lại theo lùi dần, để chuỗi hỏi không đứt. */
async function recoverCiPoll(deps: CiPollDeps, jobs: Jobs, data: CiPollJob, e: unknown): Promise<void> {
  // Câu lỗi từ database và client không chứa token; vẫn không in data job ngoài id.
  console.error(`delivery-ci-poll (${data.kind}):`, e instanceof Error ? e.message : String(e));
  if (data.kind === "scan") throw e;
  const failures = (data.failures ?? 0) + 1;
  const now = clock(deps)();
  if (data.kind === "jenkins") {
    try {
      await withTenant(requirePool(deps), { orgId: data.orgId }, (tx) =>
        markConnection(tx, data.connectionId, POLL_CRASHED, now),
      );
    } catch {
      // Ghi lỗi chỉ để người dùng thấy; hẹn lại mới là việc chính.
    }
    await ensureCiPoll(jobs, data, { failures, delayMs: nextPollDelay({ failures, building: false }), now });
    return;
  }
  await queueGitlabRecheck(jobs, tenantTarget(data), { failures, now });
}

export async function registerCiPoll(jobs: Jobs, deps: DeliveryDeps): Promise<void> {
  if (!deps.pool || !deps.masterKey) return;
  await jobs.work<CiPollJob>(DELIVERY_CI_POLL_QUEUE, async (job) => {
    try {
      await runCiPollJob(deps, jobs, job.data);
    } catch (e) {
      await recoverCiPoll(deps, jobs, job.data, e);
    }
  });
  await jobs.schedule(DELIVERY_CI_POLL_QUEUE, CI_POLL_SCAN_CRON, { kind: "scan" } satisfies CiPollJob);
}
