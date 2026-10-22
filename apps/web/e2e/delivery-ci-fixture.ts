import {
  type CiFeedSource,
  type CiProjectJob,
  type CiRun,
  type CiRunDetail,
  type CiStep,
  ciRun,
  ciRunDetail,
  type JenkinsParam,
} from "@xdev-hive/contracts";

// Fixture tự chứa vì fake-hub nạp các fixture này; import ngược sẽ tạo vòng phụ thuộc.
export type DeliveryCiHandler = (input: unknown) => { status: number; json: unknown };
const ok = (value: unknown) => ({ status: 200, json: { json: value } });
const fail = (code: string, status: number, message: string, data?: unknown) => ({
  status,
  json: { json: { defined: true, code, status, message, ...(data === undefined ? {} : { data }) } },
});

/** Thủ tục RPC giả của phần "ci" (specs/020). Task web của phần này thêm thủ tục vào đây; T011 chỉ giữ chỗ. */
export function deliveryCiDefaults(): Record<string, DeliveryCiHandler> {
  return {};
}

const NOW = "2026-10-15T03:00:00.000Z";
const STALE_AT = "2026-10-15T02:40:00.000Z";
export const CI_PROJECT_ID = "9a9a9a9a-0000-4000-8000-000000000021";
export const CI_CONNECTION_ID = "30303030-0000-4000-8000-0000000000c1";
export const CI_JOB_ID = "30303030-0000-4000-8000-0000000000a1";
export const CI_NEW_JOB_ID = "30303030-0000-4000-8000-0000000000a2";
export const GITLAB_RUNNING = "gitlab:101";
export const GITLAB_FAILED = "gitlab:100";
export const JENKINS_OK = `jenkins:${CI_JOB_ID}:42`;
export const JENKINS_WAITING = `jenkins:${CI_JOB_ID}:43`;
export const JENKINS_BUILT = `jenkins:${CI_JOB_ID}:44`;
export const JENKINS_JOB_PATH = "his-portal/build-dev";

const run = (r: Partial<CiRun> & Pick<CiRun, "id" | "source" | "title" | "status">): CiRun =>
  ciRun.parse({
    jobId: null,
    number: null,
    branch: "main",
    sha: "0123456789abcdef0123456789abcdef01234567",
    rawStatus: r.status,
    startedAt: NOW,
    finishedAt: null,
    durationSec: null,
    triggeredBy: "duy",
    url: `https://ci.example.com/${r.id}`,
    ...r,
  });

const RUNS: CiRun[] = [
  run({
    id: GITLAB_RUNNING,
    source: "gitlab",
    title: "Pipeline #101",
    status: "running",
    rawStatus: "running",
    branch: "feature/login",
    sha: "aaaaaaaa11111111",
  }),
  run({
    id: GITLAB_FAILED,
    source: "gitlab",
    title: "Pipeline #100",
    status: "failed",
    rawStatus: "failed",
    branch: "main",
    sha: "bbbbbbbb22222222",
    durationSec: 372,
    triggeredBy: "lan",
  }),
  run({
    id: JENKINS_OK,
    source: "jenkins",
    jobId: CI_JOB_ID,
    title: `${JENKINS_JOB_PATH} #42`,
    number: 42,
    status: "success",
    rawStatus: "SUCCESS",
    branch: "main",
    sha: "cccccccc33333333",
    durationSec: 65,
    triggeredBy: "jenkins-user",
  }),
  run({
    id: JENKINS_WAITING,
    source: "jenkins",
    jobId: CI_JOB_ID,
    title: `${JENKINS_JOB_PATH} #43`,
    number: 43,
    status: "waiting",
    rawStatus: "PAUSED_PENDING_INPUT",
    branch: null,
    sha: null,
    triggeredBy: null,
    url: null,
  }),
];

/** Trang hai của danh sách, để thử "Tải thêm". */
const RUN_PAGE_TWO = run({
  id: "gitlab:99",
  source: "gitlab",
  title: "Pipeline #99",
  status: "canceled",
  rawStatus: "canceled",
  branch: "main",
  sha: "dddddddd44444444",
  durationSec: 12,
});

const step = (s: Partial<CiStep> & Pick<CiStep, "id" | "name" | "status">): CiStep => ({
  kind: "job",
  group: null,
  rawStatus: s.status,
  startedAt: NOW,
  durationSec: 30,
  allowFailure: false,
  playable: false,
  hasLog: true,
  url: null,
  ...s,
});

const STEPS: Record<string, CiStep[]> = {
  [GITLAB_RUNNING]: [
    step({ id: "j1", name: "build", group: "build", status: "success" }),
    step({ id: "j2", name: "unit-test", group: "test", status: "running", durationSec: null }),
    step({ id: "j3", name: "deploy-dev", group: "deploy", status: "waiting", playable: true, durationSec: null }),
  ],
  [GITLAB_FAILED]: [step({ id: "j9", name: "lint", group: "test", status: "failed" })],
  [JENKINS_OK]: [
    step({ id: "s1", kind: "stage", name: "Checkout", status: "success", hasLog: false }),
    step({ id: "s2", kind: "stage", name: "Build", status: "success", hasLog: false }),
  ],
};

export const JENKINS_PARAMS: JenkinsParam[] = [
  { type: "string", name: "BRANCH", description: "Nhánh cần build", default: "main" },
  { type: "boolean", name: "DEPLOY", description: null, default: false },
  { type: "choice", name: "TARGET_ENV", description: null, choices: ["dev", "stage"], default: "dev" },
  { type: "password", name: "API_SECRET", description: null },
  { type: "text", name: "NOTES", description: null, default: "" },
];

export interface DeliveryCiOptions {
  /** `degraded`: GitLab trả dữ liệu cũ, Jenkins chưa có token của người xem. */
  sources?: "ok" | "degraded";
  /** Job Jenkins đã gắn sẵn; `false` để thử gắn mới. */
  attached?: boolean;
  /** Có kết nối Jenkins trong tổ chức. */
  connections?: boolean;
}

/**
 * Hub giả cho tab CI/CD của dự án (specs/020 T021). `state.calls` giữ thân yêu cầu để test đọc lại; log của run đang
 * chạy dài thêm một dòng mỗi lần hỏi, để test thấy việc hỏi lại.
 */
export function deliveryCiFixture(options: DeliveryCiOptions = {}) {
  const degraded = options.sources === "degraded";
  const jobs: CiProjectJob[] =
    options.attached === false
      ? []
      : [
          {
            id: CI_JOB_ID,
            projectId: CI_PROJECT_ID,
            connectionId: CI_CONNECTION_ID,
            connectionName: "Jenkins công ty",
            jobPath: JENKINS_JOB_PATH,
            url: "https://jenkins.example.com/job/his-portal/job/build-dev/",
            createdAt: NOW,
          },
        ];
  const state = {
    jobs,
    calls: [] as { path: string; input: unknown }[],
    logPolls: 0,
    retried: false,
  };
  const record = (path: string, input: unknown) => state.calls.push({ path, input });

  const sources = (): CiFeedSource[] => [
    {
      source: "gitlab",
      jobId: null,
      connectionId: null,
      label: "GitLab của dự án",
      state: degraded ? "stale" : "ok",
      stale: degraded,
      fetchedAt: degraded ? STALE_AT : NOW,
      message: degraded ? "GitLab không trả lời." : null,
      hasMyToken: null,
    },
    ...state.jobs.map(
      (j): CiFeedSource => ({
        source: "jenkins",
        jobId: j.id,
        connectionId: j.connectionId,
        label: `Jenkins ${j.jobPath}`,
        state: degraded ? "no_token" : "ok",
        stale: false,
        fetchedAt: degraded ? null : NOW,
        message: null,
        hasMyToken: !degraded,
      }),
    ),
  ];

  const known = (id: string): CiRun | undefined =>
    [...RUNS, RUN_PAGE_TWO].find((r) => r.id === id) ??
    (id === JENKINS_BUILT
      ? run({
          id,
          source: "jenkins",
          jobId: CI_JOB_ID,
          title: `${JENKINS_JOB_PATH} #44`,
          number: 44,
          status: "queued",
          rawStatus: "QUEUED",
          branch: null,
          sha: null,
        })
      : undefined);

  const rpc: Record<string, DeliveryCiHandler> = {
    "ci/feed": (input) => {
      record("ci/feed", input);
      const q = input as { source?: string; status?: string; branch?: string; cursor?: string };
      const all = q.cursor ? [RUN_PAGE_TWO] : RUNS;
      const items = all.filter(
        (r) =>
          (!q.source || r.source === q.source) &&
          (!q.status || r.status === q.status) &&
          (!q.branch || r.branch === q.branch),
      );
      const more = !q.cursor && !q.source && !q.status && !q.branch;
      return ok({ items, nextCursor: more ? "page-2" : null, sources: sources() });
    },
    "ci/detail": (input) => {
      record("ci/detail", input);
      const { runId } = input as { runId: string };
      const found = known(runId);
      if (!found) return fail("NOT_FOUND", 404, "Không tìm thấy lần chạy.");
      const detail: CiRunDetail = ciRunDetail.parse({
        run: found,
        steps: STEPS[runId] ?? [],
        pendingInputs: runId === JENKINS_WAITING ? [{ id: "in1", message: "Duyệt đẩy lên stage?" }] : [],
      });
      return ok(detail);
    },
    "ci/log": (input) => {
      record("ci/log", input);
      const { runId, stepId, from } = input as { runId: string; stepId?: string; from: number };
      const active = runId === GITLAB_RUNNING;
      if (active) state.logPolls += 1;
      const lines = stepId
        ? [`[${stepId}] bước chạy`, "kết thúc bước"]
        : active
          ? Array.from({ length: state.logPolls }, (_, i) => `poll ${i + 1}: đang biên dịch`)
          : ["Started by user duy", "ERROR: build lỗi ở bước lint", "Finished: FAILURE"];
      const full = `${lines.join("\n")}\n`;
      return ok({ text: full.slice(from), next: full.length, more: active && !stepId });
    },
    "ci/jenkinsParams": (input) => {
      record("ci/jenkinsParams", input);
      return ok({ parameters: JENKINS_PARAMS });
    },
    "ci/retry": (input) => {
      record("ci/retry", input);
      state.retried = true;
      return ok({ ok: true, runId: null, stepId: null });
    },
    "ci/cancel": (input) => {
      record("ci/cancel", input);
      return ok({ ok: true, runId: null, stepId: null });
    },
    "ci/play": (input) => {
      record("ci/play", input);
      return ok({ ok: true, runId: null, stepId: (input as { stepId: string }).stepId });
    },
    "ci/stop": (input) => {
      record("ci/stop", input);
      return ok({ ok: true, runId: null, stepId: null });
    },
    "ci/input": (input) => {
      record("ci/input", input);
      return ok({ ok: true, runId: null, stepId: null });
    },
    "ci/build": (input) => {
      record("ci/build", input);
      return ok({ ok: true, runId: JENKINS_BUILT, stepId: null });
    },
    "ciJobs/list": () => ok(state.jobs),
    "ciJobs/add": (input) => {
      record("ciJobs/add", input);
      const { connectionId, jobPath } = input as { connectionId: string; jobPath: string };
      if (jobPath.includes("//")) return fail("BAD_REQUEST", 400, "Đường dẫn job không hợp lệ.");
      const job: CiProjectJob = {
        id: CI_NEW_JOB_ID,
        projectId: CI_PROJECT_ID,
        connectionId,
        connectionName: "Jenkins công ty",
        jobPath,
        url: `https://jenkins.example.com/job/${jobPath}/`,
        createdAt: NOW,
      };
      state.jobs.push(job);
      return ok(job);
    },
    "ciJobs/remove": (input) => {
      record("ciJobs/remove", input);
      const { jobId } = input as { jobId: string };
      state.jobs = state.jobs.filter((j) => j.id !== jobId);
      return ok({ ok: true });
    },
    "ciConnections/list": () =>
      ok(
        options.connections === false
          ? []
          : [
              {
                id: CI_CONNECTION_ID,
                name: "Jenkins công ty",
                url: "https://jenkins.example.com",
                watcher: null,
                watcherHasToken: true,
                lastPollAt: NOW,
                lastError: null,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
      ),
  };

  return { rpc, state };
}
