import { z } from "zod";
import { id, orgErrors, orgRoute } from "./common.ts";
import { teamRole } from "./tenancy.ts";

// Bảng điều khiển CI/CD và triển khai (specs/020). Hub cài ở module `delivery`; mọi khoá riêng, token chỉ ghi, không
// bao giờ có trong phản hồi (FR-032).

// ---- Lỗi -----------------------------------------------------------------------------------------------------------

type DeliveryErrorStatus = "BAD_REQUEST" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT";

/**
 * Mã lỗi nghiệp vụ (đi trong `data.code`) và lỗi oRPC tương ứng. Lỗi token Jenkins không dùng UNAUTHORIZED: web coi
 * UNAUTHORIZED là phiên Hive hết hạn và đăng xuất. Hệ ngoài không trả lời cũng là CONFLICT vì hub chỉ có bốn loại lỗi.
 */
export const DELIVERY_ERRORS = {
  JENKINS_NO_TOKEN: {
    status: "FORBIDDEN",
    message: "Bạn chưa có token Jenkins cho kết nối này. Thêm token Jenkins của bạn ở Cài đặt cá nhân.",
  },
  JENKINS_UNAUTHORIZED: {
    status: "FORBIDDEN",
    message: "Jenkins không nhận user hoặc token. Cập nhật token Jenkins ở Cài đặt cá nhân.",
  },
  JENKINS_FORBIDDEN: {
    status: "FORBIDDEN",
    message: "Tài khoản Jenkins của bạn không có quyền làm việc này trên job.",
  },
  JENKINS_NOT_FOUND: { status: "NOT_FOUND", message: "Không tìm thấy job hoặc build trên Jenkins." },
  JENKINS_UNAVAILABLE: { status: "CONFLICT", message: "Jenkins không trả lời. Thử lại sau." },
  SSH_UNREACHABLE: {
    status: "CONFLICT",
    message: "Hub không kết nối được máy chủ. Kiểm tra địa chỉ, cổng và tường lửa giữa hub và máy chủ.",
  },
  SSH_AUTH_FAILED: {
    status: "CONFLICT",
    message: "Máy chủ không nhận khoá SSH của hub. Kiểm tra khoá công khai trong authorized_keys và user.",
  },
  SSH_HOSTKEY_CHANGED: {
    status: "CONFLICT",
    message: "Host key của máy chủ đã đổi. Hub dừng, không chạy lệnh nào. Quản trị kiểm và xác nhận lại dấu vân tay.",
  },
  DEPLOY_IN_PROGRESS: { status: "CONFLICT", message: "Đích này đang có một lần triển khai chưa xong." },
  ENV_LOCKED: { status: "CONFLICT", message: "Môi trường đang khoá. Mở khoá trước khi triển khai." },
  SELF_APPROVAL: { status: "FORBIDDEN", message: "Người yêu cầu không tự duyệt được lần triển khai của mình." },
  APPROVAL_EXPIRED: { status: "CONFLICT", message: "Yêu cầu duyệt đã hết hạn. Tạo lại lần triển khai." },
  TARGET_VERSION_CONFLICT: {
    status: "CONFLICT",
    message: "Cấu hình đích đã được người khác sửa. Tải lại rồi sửa tiếp.",
  },
  ROLLBACK_UNAVAILABLE: { status: "CONFLICT", message: "Không quay về được ở đích này." },
} as const satisfies Record<string, { status: DeliveryErrorStatus; message: string }>;
export type DeliveryErrorCode = keyof typeof DELIVERY_ERRORS;
export const deliveryErrorCode = z.enum(Object.keys(DELIVERY_ERRORS) as [DeliveryErrorCode, ...DeliveryErrorCode[]]);

/** Người trong dữ liệu trả về; id người dùng là chuỗi của better-auth, không phải uuid. */
export const deliveryPerson = z.object({ userId: z.string(), name: z.string() });
export type DeliveryPerson = z.output<typeof deliveryPerson>;

const deliveryErrorDetail = {
  /** `DEPLOY_IN_PROGRESS`: lần đang đi, người yêu cầu, giờ bắt đầu ("Đang triển khai bởi <người> từ <giờ>"). */
  deployId: id.optional(),
  by: deliveryPerson.nullable().optional(),
  since: z.iso.datetime().optional(),
  /** `ENV_LOCKED`: lý do khoá. `ROLLBACK_UNAVAILABLE`: mã lý do ở `rollbackBlockedReason`. */
  reason: z.string().optional(),
  /** `TARGET_VERSION_CONFLICT`: phiên bản cấu hình hiện tại. */
  configVersion: z.number().int().optional(),
  /** `JENKINS_*`: kết nối gặp lỗi, để web mở đúng chỗ thêm token. */
  connectionId: id.optional(),
  /** `SSH_HOSTKEY_CHANGED`: dấu vân tay máy chủ vừa trình ra. */
  fingerprint: z.string().optional(),
};
export const deliveryErrorData = z.object({ code: z.string(), ...deliveryErrorDetail }).optional();
export type DeliveryErrorData = z.output<typeof deliveryErrorData>;

const deliveryErrors = {
  FORBIDDEN: { message: orgErrors.FORBIDDEN.message, data: deliveryErrorData },
  NOT_FOUND: { message: orgErrors.NOT_FOUND.message, data: deliveryErrorData },
  CONFLICT: { message: orgErrors.CONFLICT.message, data: deliveryErrorData },
  // Lỗi kiểm đầu vào của oRPC mang `issues` và không có `code`.
  BAD_REQUEST: {
    message: orgErrors.BAD_REQUEST.message,
    data: z.looseObject({ code: z.string().optional(), ...deliveryErrorDetail }).optional(),
  },
};

const route = (method: "GET" | "POST" | "PATCH" | "DELETE", path: `/v1/${string}`, summary: string) =>
  orgRoute(method, path, summary, "delivery").errors(deliveryErrors);

// ---- Trường dùng chung ---------------------------------------------------------------------------------------------

const name = z.string().trim().min(1, "Tên không được để trống.").max(80, "Tên dài tối đa 80 ký tự.");
const at = z.iso.datetime();
const ok = z.object({ ok: z.literal(true) });
const removed = z.object({ id });
const limit = z.coerce.number().int().min(1).max(100).default(30);
const cursor = z.string().min(1).max(500);
const sha = z.string().regex(/^[0-9a-f]{7,64}$/, "Commit SHA không hợp lệ.");
const httpsUrl = z
  .url("URL không hợp lệ.")
  .refine((u) => u.startsWith("https://"), "Chỉ nhận địa chỉ https.")
  .transform((u) => u.replace(/\/+$/, ""));
/** Token chỉ ghi: nhận khi tạo hoặc thay, không bao giờ trả lại. */
const secretToken = z.string().trim().min(8, "Token quá ngắn.").max(8000, "Token quá dài.");
const caPem = z
  .string()
  .trim()
  .max(20_000, "CA quá dài.")
  .refine((v) => v.includes("-----BEGIN CERTIFICATE-----"), "CA phải ở dạng PEM (-----BEGIN CERTIFICATE-----).");
const reason = (message: string) => z.string().trim().min(1, message).max(500, "Lý do dài tối đa 500 ký tự.");

/** Kết quả nút "Kiểm" của kết nối hay token: không ném lỗi, để màn hình hiện câu báo tại chỗ. */
export const connectionTestResult = z.object({
  ok: z.boolean(),
  message: z.string(),
  /** Bản Jenkins, Argo CD, Kubernetes đọc được khi kiểm thành công. */
  version: z.string().nullable(),
  /** User Jenkins mà token đăng nhập được (`/me/api/json`). */
  user: z.string().nullable().optional(),
});
export type ConnectionTestResult = z.output<typeof connectionTestResult>;

// ---- Kết nối Jenkins (FR-001) --------------------------------------------------------------------------------------

export const jenkinsConnection = z.object({
  id,
  name: z.string(),
  url: z.string(),
  /** Token của người theo dõi chỉ dùng để đọc theo lịch; mặc định là người tạo kết nối. */
  watcher: deliveryPerson.nullable(),
  /** Người theo dõi còn token cho kết nối này; false thì phần Jenkins báo "Chưa có token để đọc Jenkins". */
  watcherHasToken: z.boolean(),
  lastPollAt: at.nullable(),
  /** Câu lỗi tiếng Việt của lần đọc theo lịch gần nhất, null khi đọc được. */
  lastError: z.string().nullable(),
  createdAt: at,
  updatedAt: at,
});
export type JenkinsConnection = z.output<typeof jenkinsConnection>;

export const ciConnectionsContract = {
  list: route("GET", "/v1/ci/connections", "Kết nối Jenkins của tổ chức").output(z.array(jenkinsConnection)),
  create: route(
    "POST",
    "/v1/ci/connections",
    "Thêm kết nối Jenkins; người tạo là người theo dõi (ci.connections.manage)",
  )
    .input(z.object({ name, url: httpsUrl }))
    .output(jenkinsConnection),
  update: route("PATCH", "/v1/ci/connections/{id}", "Sửa kết nối Jenkins (ci.connections.manage)")
    .input(z.object({ id, name: name.optional(), url: httpsUrl.optional() }))
    .output(jenkinsConnection),
  remove: route(
    "DELETE",
    "/v1/ci/connections/{id}",
    "Xoá kết nối Jenkins cùng token của mọi người (ci.connections.manage)",
  )
    .input(z.object({ id }))
    .output(removed),
  test: route("POST", "/v1/ci/connections/{id}/test", "Kiểm kết nối Jenkins bằng token của người theo dõi")
    .input(z.object({ id }))
    .output(connectionTestResult),
  setWatcher: route(
    "POST",
    "/v1/ci/connections/{id}/watcher",
    "Đổi người theo dõi; người đó phải có token (ci.connections.manage)",
  )
    .input(z.object({ id, userId: z.string().min(1) }))
    .output(jenkinsConnection),
};

// ---- Token Jenkins của chính người gọi (Q3) ------------------------------------------------------------------------

/** Một dòng mỗi kết nối Jenkins của tổ chức, kèm token của tôi nếu có. Không bao giờ có giá trị token. */
export const jenkinsTokenItem = z.object({
  connectionId: id,
  connectionName: z.string(),
  url: z.string(),
  token: z
    .object({
      jenkinsUser: z.string(),
      updatedAt: at,
      lastCheckedAt: at.nullable(),
      /** Kết quả lần kiểm cuối; null khi chưa kiểm. */
      lastCheckOk: z.boolean().nullable(),
    })
    .nullable(),
});
export type JenkinsTokenItem = z.output<typeof jenkinsTokenItem>;

export const ciTokensContract = {
  list: route("GET", "/v1/ci/tokens", "Token Jenkins của tôi theo từng kết nối (không có giá trị token)").output(
    z.array(jenkinsTokenItem),
  ),
  upsert: route("POST", "/v1/ci/tokens/{connectionId}", "Thêm hoặc thay token Jenkins của tôi cho một kết nối")
    .input(
      z.object({
        connectionId: id,
        jenkinsUser: z.string().trim().min(1, "Nhập user Jenkins.").max(200),
        token: secretToken,
      }),
    )
    .output(jenkinsTokenItem),
  test: route("POST", "/v1/ci/tokens/{connectionId}/test", "Kiểm token Jenkins của tôi (GET /me/api/json)")
    .input(z.object({ connectionId: id }))
    .output(connectionTestResult),
  remove: route("DELETE", "/v1/ci/tokens/{connectionId}", "Xoá token Jenkins của tôi cho một kết nối")
    .input(z.object({ connectionId: id }))
    .output(ok),
};

// ---- Kết nối Argo CD, Kubernetes (FR-006) --------------------------------------------------------------------------

export const infraConnectionKind = z.enum(["argocd", "kubernetes"]);
export type InfraConnectionKind = z.output<typeof infraConnectionKind>;

/** Token chung của tổ chức (plan.md "Quyết định của người viết"), chỉ ghi. CA không phải bí mật nên trả lại được. */
export const infraConnection = z.object({
  id,
  kind: infraConnectionKind,
  name: z.string(),
  url: z.string(),
  caPem: z.string().nullable(),
  createdAt: at,
  updatedAt: at,
});
export type InfraConnection = z.output<typeof infraConnection>;

export const infraConnectionCreateInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("argocd"), name, url: httpsUrl, token: secretToken }),
  /** URL API server; CA bỏ trống khi API server dùng chứng chỉ của CA công khai. Token của ServiceAccount. */
  z.object({ kind: z.literal("kubernetes"), name, url: httpsUrl, caPem: caPem.optional(), token: secretToken }),
]);
export type InfraConnectionCreateInput = z.input<typeof infraConnectionCreateInput>;

export const infraConnectionsContract = {
  list: route("GET", "/v1/infra-connections", "Kết nối Argo CD và Kubernetes của tổ chức").output(
    z.array(infraConnection),
  ),
  create: route("POST", "/v1/infra-connections", "Thêm kết nối Argo CD hoặc Kubernetes (ci.connections.manage)")
    .input(infraConnectionCreateInput)
    .output(infraConnection),
  /** Bỏ trống `token` là giữ token cũ; `caPem: null` là bỏ CA riêng. */
  update: route("PATCH", "/v1/infra-connections/{id}", "Sửa kết nối Argo CD hoặc Kubernetes (ci.connections.manage)")
    .input(
      z.object({
        id,
        name: name.optional(),
        url: httpsUrl.optional(),
        caPem: caPem.nullish(),
        token: secretToken.optional(),
      }),
    )
    .output(infraConnection),
  remove: route("DELETE", "/v1/infra-connections/{id}", "Xoá kết nối Argo CD hoặc Kubernetes (ci.connections.manage)")
    .input(z.object({ id }))
    .output(removed),
  test: route(
    "POST",
    "/v1/infra-connections/{id}/test",
    "Kiểm kết nối bằng một lệnh đọc (Argo CD: applications, Kubernetes: /version)",
  )
    .input(z.object({ id }))
    .output(connectionTestResult),
};

// ---- Job Jenkins gắn với dự án (FR-002) ----------------------------------------------------------------------------

/**
 * Đường dẫn job theo folder, như trên giao diện Jenkins (`his-portal/build-dev`, multibranch `org/repo/feature%2Fx`).
 * Hub đổi thành `/job/a/job/b` và mã hoá từng đoạn.
 */
export const jenkinsJobPath = z
  .string()
  .trim()
  .min(1, "Nhập đường dẫn job.")
  .max(500, "Đường dẫn job dài tối đa 500 ký tự.")
  .refine(
    (p) => p.split("/").every((s) => s !== "" && s !== "." && s !== ".."),
    "Đường dẫn job gồm các tên ngăn bởi /, không có đoạn rỗng, `.` hay `..`.",
  );

export const ciProjectJob = z.object({
  id,
  projectId: id,
  connectionId: id,
  connectionName: z.string(),
  jobPath: z.string(),
  /** Link mở job trên Jenkins. */
  url: z.string(),
  createdAt: at,
});
export type CiProjectJob = z.output<typeof ciProjectJob>;

export const ciJobsContract = {
  list: route("GET", "/v1/projects/{projectId}/ci/jobs", "Job Jenkins gắn với dự án")
    .input(z.object({ projectId: id }))
    .output(z.array(ciProjectJob)),
  add: route("POST", "/v1/projects/{projectId}/ci/jobs", "Gắn job Jenkins vào dự án (servers.manage)")
    .input(z.object({ projectId: id, connectionId: id, jobPath: jenkinsJobPath }))
    .output(ciProjectJob),
  remove: route("DELETE", "/v1/projects/{projectId}/ci/jobs/{jobId}", "Gỡ job Jenkins khỏi dự án (servers.manage)")
    .input(z.object({ projectId: id, jobId: id }))
    .output(ok),
};

// ---- CI: danh sách gộp, chi tiết, log, thao tác (FR-003, FR-005, FR-007…FR-009) -----------------------------------

/** GitHub có sẵn từ đầu để T031 (Actions) không phải đổi hợp đồng. */
export const ciSource = z.enum(["gitlab", "github", "jenkins"]);
export type CiSource = z.output<typeof ciSource>;

/**
 * Trạng thái chung của mọi nguồn; `rawStatus` giữ chữ gốc của nguồn để hiện khi cần. `waiting`: chờ người (job tay của
 * GitLab, `input` của Jenkins, deployment chờ duyệt của GitHub). `unstable`: Jenkins UNSTABLE.
 */
export const ciRunStatus = z.enum([
  "queued",
  "running",
  "waiting",
  "success",
  "failed",
  "unstable",
  "canceled",
  "skipped",
]);
export type CiRunStatus = z.output<typeof ciRunStatus>;

/**
 * Định danh một pipeline hay build, do hub ghép và tự đọc lại (`gitlab:<pipelineId>`, `jenkins:<jobId>:<build>`…).
 * Client chỉ chuyển nguyên chuỗi.
 */
export const ciRunId = z
  .string()
  .min(1)
  .max(200)
  .regex(/^(gitlab|github|jenkins):[\w.:-]+$/, "Mã lượt CI không hợp lệ.");
/** Id job GitLab/GitHub hoặc giai đoạn Jenkins trong một lượt. */
const ciStepId = z.string().min(1).max(200);

export const ciRun = z.object({
  id: ciRunId,
  source: ciSource,
  /** Job Jenkins gắn với dự án (`ciProjectJob.id`); null với GitLab, GitHub. */
  jobId: id.nullable(),
  /** "Pipeline #123", đường dẫn job Jenkins kèm số build. */
  title: z.string(),
  /** Số build Jenkins; số pipeline GitLab. */
  number: z.number().int().nullable(),
  branch: z.string().nullable(),
  sha: z.string().nullable(),
  status: ciRunStatus,
  rawStatus: z.string(),
  startedAt: at.nullable(),
  finishedAt: at.nullable(),
  durationSec: z.number().nonnegative().nullable(),
  /** Người kích hoạt theo nguồn (username GitLab, user Jenkins). */
  triggeredBy: z.string().nullable(),
  /** Link mở trên GitLab, GitHub, Jenkins. */
  url: z.string().nullable(),
});
export type CiRun = z.output<typeof ciRun>;

/**
 * Tình trạng từng nguồn của danh sách. `stale`: nguồn không trả lời, danh sách dùng dữ liệu lần cuối đọc được lúc
 * `fetchedAt`. `no_token`: chưa có token để đọc Jenkins.
 */
export const ciFeedSource = z.object({
  source: ciSource,
  /** `ciProjectJob.id` với Jenkins; null với repo của dự án. */
  jobId: id.nullable(),
  connectionId: id.nullable(),
  label: z.string(),
  state: z.enum(["ok", "stale", "no_token", "error"]),
  stale: z.boolean(),
  fetchedAt: at.nullable(),
  message: z.string().nullable(),
  /** Người gọi có token Jenkins của mình cho kết nối này (nút thao tác bật được); null với GitLab, GitHub. */
  hasMyToken: z.boolean().nullable(),
});
export type CiFeedSource = z.output<typeof ciFeedSource>;

export const ciFeedInput = z.object({
  projectId: id,
  source: ciSource.optional(),
  branch: z.string().trim().min(1).max(255).optional(),
  status: ciRunStatus.optional(),
  /** `nextCursor` của trang trước; bỏ trống là trang đầu. */
  cursor: cursor.optional(),
  limit,
});
export type CiFeedInput = z.output<typeof ciFeedInput>;

export const ciFeed = z.object({
  items: z.array(ciRun),
  nextCursor: cursor.nullable(),
  sources: z.array(ciFeedSource),
});
export type CiFeed = z.output<typeof ciFeed>;

/** Job (GitLab, GitHub) hoặc giai đoạn (Jenkins `wfapi/describe`). */
export const ciStep = z.object({
  id: ciStepId,
  kind: z.enum(["job", "stage"]),
  name: z.string(),
  /** Stage của GitLab; null với giai đoạn Jenkins. */
  group: z.string().nullable(),
  status: ciRunStatus,
  rawStatus: z.string(),
  startedAt: at.nullable(),
  durationSec: z.number().nonnegative().nullable(),
  allowFailure: z.boolean(),
  /** Job chờ tay chạy được (`play`). */
  playable: z.boolean(),
  /** Log đọc riêng được theo bước (job GitLab); giai đoạn Jenkins đọc log cả build. */
  hasLog: z.boolean(),
  url: z.string().nullable(),
});
export type CiStep = z.output<typeof ciStep>;

/** Bước `input` của Jenkins đang chờ (`wfapi/pendingInputActions`). */
export const ciPendingInput = z.object({ id: z.string(), message: z.string() });

export const ciRunDetail = z.object({
  run: ciRun,
  steps: z.array(ciStep),
  /** Rỗng khi không có bước chờ, hoặc job không có Pipeline Stage View (404). */
  pendingInputs: z.array(ciPendingInput),
});
export type CiRunDetail = z.output<typeof ciRunDetail>;

/** Log đọc trực tiếp từ nguồn, không lưu (Q12). `from`, `next` tính theo byte. */
export const ciLogChunk = z.object({
  text: z.string(),
  next: z.number().int().nonnegative(),
  /** Còn ghi thêm (đang chạy); false là đã đọc hết. */
  more: z.boolean(),
});
export type CiLogChunk = z.output<typeof ciLogChunk>;

const paramName = z.string().min(1).max(200);
const paramBase = { name: paramName, description: z.string().nullable() };

/** Tham số khai báo của job Jenkins, để sinh form Build with Parameters. Mật khẩu không trả giá trị mặc định. */
export const jenkinsParam = z.discriminatedUnion("type", [
  z.object({ type: z.literal("string"), ...paramBase, default: z.string().nullable() }),
  z.object({ type: z.literal("text"), ...paramBase, default: z.string().nullable() }),
  z.object({ type: z.literal("boolean"), ...paramBase, default: z.boolean().nullable() }),
  z.object({ type: z.literal("choice"), ...paramBase, choices: z.array(z.string()), default: z.string().nullable() }),
  z.object({ type: z.literal("password"), ...paramBase }),
  /** Kiểu plugin hub chưa biết: form hiện ô chữ, `rawType` để người dùng nhận ra. */
  z.object({ type: z.literal("other"), ...paramBase, rawType: z.string(), default: z.string().nullable() }),
]);
export type JenkinsParam = z.output<typeof jenkinsParam>;

const jenkinsParamValues = z.record(paramName, z.union([z.string().max(10_000), z.boolean()]));

const runInput = z.object({ projectId: id, runId: ciRunId });

/** Thao tác tạo ra lượt hay job mới (chạy lại job GitLab, build Jenkins) trả id mới để mở ngay. */
export const ciActionResult = z.object({ ok: z.literal(true), runId: ciRunId.nullable(), stepId: ciStepId.nullable() });
export type CiActionResult = z.output<typeof ciActionResult>;

export const ciContract = {
  feed: route("GET", "/v1/projects/{projectId}/ci/runs", "Pipeline GitLab/GitHub và build Jenkins của dự án (ci.view)")
    .input(ciFeedInput)
    .output(ciFeed),
  detail: route("GET", "/v1/projects/{projectId}/ci/runs/{runId}", "Job hoặc giai đoạn của một lượt CI (ci.view)")
    .input(runInput)
    .output(ciRunDetail),
  log: route("GET", "/v1/projects/{projectId}/ci/runs/{runId}/log", "Đọc log CI từ nguồn theo đoạn (ci.view)")
    .input(
      runInput.extend({
        /** Job GitLab/GitHub; bỏ trống với Jenkins (log cả build). */
        stepId: ciStepId.optional(),
        from: z.coerce.number().int().min(0).default(0),
      }),
    )
    .output(ciLogChunk),
  jenkinsParams: route(
    "GET",
    "/v1/projects/{projectId}/ci/jobs/{jobId}/params",
    "Tham số khai báo của job Jenkins (ci.view)",
  )
    .input(z.object({ projectId: id, jobId: id }))
    .output(z.object({ parameters: z.array(jenkinsParam) })),
  retry: route(
    "POST",
    "/v1/projects/{projectId}/ci/runs/{runId}/retry",
    "Chạy lại pipeline, job hoặc build (ci.operate)",
  )
    .input(runInput.extend({ stepId: ciStepId.optional() }))
    .output(ciActionResult),
  cancel: route(
    "POST",
    "/v1/projects/{projectId}/ci/runs/{runId}/cancel",
    "Huỷ pipeline hoặc job GitLab/GitHub (ci.operate)",
  )
    .input(runInput.extend({ stepId: ciStepId.optional() }))
    .output(ciActionResult),
  play: route("POST", "/v1/projects/{projectId}/ci/runs/{runId}/play", "Chạy job chờ tay của GitLab (ci.operate)")
    .input(runInput.extend({ stepId: ciStepId }))
    .output(ciActionResult),
  build: route(
    "POST",
    "/v1/projects/{projectId}/ci/jobs/{jobId}/build",
    "Build job Jenkins (có tham số) bằng token của tôi (ci.operate)",
  )
    .input(z.object({ projectId: id, jobId: id, params: jenkinsParamValues.default({}) }))
    .output(ciActionResult),
  stop: route(
    "POST",
    "/v1/projects/{projectId}/ci/runs/{runId}/stop",
    "Dừng build Jenkins bằng token của tôi (ci.operate)",
  )
    .input(runInput)
    .output(ciActionResult),
  input: route(
    "POST",
    "/v1/projects/{projectId}/ci/runs/{runId}/input",
    "Tiếp tục hoặc dừng ở bước input của Jenkins (ci.operate)",
  )
    .input(runInput.extend({ inputId: z.string().min(1).max(200), action: z.enum(["proceed", "abort"]) }))
    .output(ciActionResult),
  /** GitHub Actions (T031): duyệt deployment chờ duyệt của workflow run. */
  approveDeployment: route(
    "POST",
    "/v1/projects/{projectId}/ci/runs/{runId}/deployments",
    "Duyệt hoặc từ chối deployment chờ duyệt của GitHub (ci.operate)",
  )
    .input(
      runInput.extend({
        environments: z.array(z.string().min(1).max(200)).min(1, "Chọn ít nhất một environment.").max(20),
        decision: z.enum(["approve", "reject"]),
        comment: z.string().trim().max(1000).optional(),
      }),
    )
    .output(ciActionResult),
};

// ---- Máy chủ (FR-010, FR-011) --------------------------------------------------------------------------------------

/** SHA256 của host key, đúng dạng `ssh-keygen -lf` in ra (`SHA256:` + base64 bỏ `=`). */
export const hostKeyFingerprint = z
  .string()
  .regex(/^SHA256:[A-Za-z0-9+/]{43}$/, "Dấu vân tay phải có dạng SHA256:… như ssh-keygen -lf in ra.");

const host = z
  .string()
  .trim()
  .min(1, "Nhập địa chỉ máy chủ.")
  .max(253)
  .regex(/^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])$/, "Địa chỉ là tên miền, IPv4 hoặc [IPv6].");
const sshUser = z
  .string()
  .trim()
  .min(1, "Nhập user SSH.")
  .max(64)
  .regex(/^[a-z_][a-z0-9_.-]*\$?$/i, "User SSH chỉ gồm chữ, số, `_`, `.`, `-`.");
const labels = z
  .array(z.string().trim().min(1).max(40))
  .max(20, "Tối đa 20 nhãn.")
  .transform((list) => [...new Set(list)]);

/** Khoá đang chờ đổi (US3 bước 4): khoá cũ vẫn dùng tới khi khoá mới kiểm thành công. */
export const pendingServerKey = z.object({ publicKey: z.string(), installCommand: z.string(), createdAt: at });

export const deployServer = z.object({
  id,
  teamId: id,
  name: z.string(),
  host: z.string(),
  port: z.number().int(),
  user: z.string(),
  labels: z.array(z.string()),
  /** Khoá công khai ed25519 dạng OpenSSH do hub sinh. Không có route nào trả khoá riêng. */
  publicKey: z.string(),
  /** Lệnh cài khoá công khai vào `~/.ssh/authorized_keys` của user. */
  installCommand: z.string(),
  /** Dấu vân tay host key đã xác nhận; rỗng khi chưa kiểm lần nào. */
  hostKeyFingerprints: z.array(z.string()),
  pendingKey: pendingServerKey.nullable(),
  lastTest: z.object({ at, ok: z.boolean(), message: z.string() }).nullable(),
  createdAt: at,
  updatedAt: at,
});
export type DeployServer = z.output<typeof deployServer>;

export const serverTestResult = z.discriminatedUnion("result", [
  z.object({
    result: z.literal("ok"),
    fingerprint: hostKeyFingerprint,
    /** Khoá đã dùng: `pending` khi kiểm khoá mới lúc đổi khoá. */
    key: z.enum(["current", "pending"]),
    os: z.string().nullable(),
    docker: z.string().nullable(),
    compose: z.string().nullable(),
    diskFreeBytes: z.number().int().nonnegative().nullable(),
  }),
  /** Lần đầu kiểm: hub chưa chạy lệnh nào, chờ quản trị xác nhận một trong các dấu vân tay máy chủ trình ra. */
  z.object({ result: z.literal("hostkey_unconfirmed"), fingerprints: z.array(hostKeyFingerprint).min(1) }),
  /** `network`: không mở được kết nối; `auth`: máy chủ không nhận khoá; `hostkey_changed`: dừng trước mọi lệnh. */
  z.object({
    result: z.literal("error"),
    kind: z.enum(["network", "auth", "hostkey_changed"]),
    message: z.string(),
    fingerprint: hostKeyFingerprint.optional(),
  }),
]);
export type ServerTestResult = z.output<typeof serverTestResult>;

export const serverCreateInput = z.object({
  teamId: id,
  name,
  host,
  port: z.number().int().min(1).max(65535).default(22),
  user: sshUser,
  labels: labels.default([]),
});
export type ServerCreateInput = z.input<typeof serverCreateInput>;

export const serversContract = {
  list: route("GET", "/v1/servers", "Máy chủ của đội (servers.manage hoặc ci.view)")
    .input(z.object({ teamId: id.optional() }))
    .output(z.array(deployServer)),
  create: route("POST", "/v1/servers", "Khai báo máy chủ; hub sinh khoá ed25519 và trả lệnh cài (servers.manage)")
    .input(serverCreateInput)
    .output(deployServer),
  /** Đổi địa chỉ hay cổng thì hub xoá dấu vân tay đã xác nhận, phải kiểm và xác nhận lại. */
  update: route("PATCH", "/v1/servers/{id}", "Sửa máy chủ (servers.manage)")
    .input(
      z.object({
        id,
        name: name.optional(),
        host: host.optional(),
        port: z.number().int().min(1).max(65535).optional(),
        user: sshUser.optional(),
        labels: labels.optional(),
      }),
    )
    .output(deployServer),
  remove: route("DELETE", "/v1/servers/{id}", "Xoá máy chủ và khoá của nó (servers.manage)")
    .input(z.object({ id }))
    .output(removed),
  test: route("POST", "/v1/servers/{id}/test", "Kiểm kết nối SSH từ hub (servers.manage)")
    .input(z.object({ id }))
    .output(serverTestResult),
  confirmHostKey: route("POST", "/v1/servers/{id}/host-key", "Xác nhận dấu vân tay host key (servers.manage)")
    .input(z.object({ id, fingerprint: hostKeyFingerprint }))
    .output(deployServer),
  rotateKey: route(
    "POST",
    "/v1/servers/{id}/rotate-key",
    "Sinh khoá mới; khoá cũ dùng tới khi xác nhận (servers.manage)",
  )
    .input(z.object({ id }))
    .output(deployServer),
  confirmRotation: route(
    "POST",
    "/v1/servers/{id}/rotate-key/confirm",
    "Kiểm khoá mới rồi thay khoá cũ (servers.manage)",
  )
    .input(z.object({ id }))
    .output(deployServer),
};

// ---- Môi trường (FR-012, FR-026, FR-027) ---------------------------------------------------------------------------

export const environmentName = z
  .string()
  .trim()
  .min(1, "Nhập tên môi trường.")
  .max(40, "Tên môi trường dài tối đa 40 ký tự.")
  .regex(/^[a-z0-9][a-z0-9-]*$/, "Tên môi trường chỉ gồm chữ thường, số và `-` (vd. dev, staging, prod).");

const roleList = z
  .array(teamRole)
  .max(teamRole.options.length)
  .transform((list) => [...new Set(list)]);

/**
 * Chính sách của môi trường, kiểm sau quyền chung `deploy.run`/`deploy.approve`. Vai trò rỗng là không giới hạn thêm.
 * `approvals` 0 là không cần duyệt (Q7: dev 0, prod ≥ 1).
 */
export const environmentPolicy = z.object({
  deployRoles: roleList.default([]),
  approveRoles: roleList.default([]),
  approvals: z.number().int().min(0).max(5).default(0),
  approvalTtlHours: z.number().int().min(1).max(168).default(24),
});
export type EnvironmentPolicy = z.output<typeof environmentPolicy>;

export const environmentLock = z.object({ by: deliveryPerson.nullable(), at, reason: z.string() });

export const deployEnvironment = z.object({
  id,
  systemId: id,
  name: z.string(),
  /** Thứ tự dev → staging → prod, từ 0. */
  position: z.number().int(),
  policy: environmentPolicy,
  lock: environmentLock.nullable(),
  createdAt: at,
  updatedAt: at,
});
export type DeployEnvironment = z.output<typeof deployEnvironment>;

export const environmentsContract = {
  list: route("GET", "/v1/systems/{systemId}/environments", "Môi trường của hệ thống theo thứ tự (ci.view)")
    .input(z.object({ systemId: id }))
    .output(z.array(deployEnvironment)),
  create: route("POST", "/v1/systems/{systemId}/environments", "Tạo môi trường, xếp cuối (servers.manage)")
    .input(z.object({ systemId: id, name: environmentName, policy: environmentPolicy.prefault({}) }))
    .output(deployEnvironment),
  update: route("PATCH", "/v1/environments/{id}", "Sửa tên hoặc chính sách môi trường (servers.manage)")
    .input(z.object({ id, name: environmentName.optional(), policy: environmentPolicy.optional() }))
    .output(deployEnvironment),
  reorder: route("POST", "/v1/systems/{systemId}/environments/order", "Sắp lại thứ tự môi trường (servers.manage)")
    .input(
      z.object({
        systemId: id,
        /** Đủ mọi môi trường của hệ thống, theo thứ tự mới. */
        ids: z
          .array(id)
          .min(1)
          .max(50)
          .refine((list) => new Set(list).size === list.length, "Danh sách môi trường bị trùng."),
      }),
    )
    .output(z.array(deployEnvironment)),
  lock: route("POST", "/v1/environments/{id}/lock", "Khoá môi trường: chặn mọi lần triển khai mới (servers.manage)")
    .input(z.object({ id, reason: reason("Ghi lý do khoá môi trường.") }))
    .output(deployEnvironment),
  unlock: route("POST", "/v1/environments/{id}/unlock", "Mở khoá môi trường (servers.manage)")
    .input(z.object({ id }))
    .output(deployEnvironment),
};

// ---- Đích triển khai (FR-013, FR-014) ------------------------------------------------------------------------------

export const DEPLOY_METHODS = ["ssh-script", "jenkins-job", "gitlab-manual", "argocd", "kubectl"] as const;
export const deployMethod = z.enum(DEPLOY_METHODS);
export type DeployMethod = z.output<typeof deployMethod>;

/** Tăng khi đổi dạng cấu hình; hub đọc được bản cũ và nâng lên khi lưu lại. */
export const TARGET_CONFIG_SCHEMA_VERSION = 1;
const schemaVersion = z.literal(TARGET_CONFIG_SCHEMA_VERSION);

const script = z.string().min(1, "Nhập lệnh của bước.").max(20_000, "Lệnh của bước dài tối đa 20 000 ký tự.");
const timeoutSec = (fallback: number) => z.number().int().min(10).max(7200).default(fallback);
const scriptStep = z.object({ script, timeoutSec: timeoutSec(600) });
const absoluteDir = z
  .string()
  .trim()
  .max(500)
  .regex(/^\/[^\0]*$/, "Thư mục làm việc phải là đường dẫn tuyệt đối trên máy chủ.")
  .refine((p) => !p.split("/").includes(".."), "Thư mục làm việc không được chứa `..`.");
const composeProject = z
  .string()
  .trim()
  .min(1, "Nhập tên compose project.")
  .max(100)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "Tên compose project chỉ gồm chữ thường, số, `_`, `-`.");
const branchName = z.string().trim().min(1).max(255).nullable().default(null);

/** Đường dẫn JSON đơn giản (`version`, `status.ok`, `items[0].name`), không chạy mã. */
const jsonPath = z
  .string()
  .regex(/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[\d+\])*$/, "Đường dẫn JSON có dạng version hoặc status.ok.");

/** Health gọi từ hub (FR-018). `equals` nhận `{{commit}}`, `{{commit8}}`, `{{tag}}`. */
export const healthCheck = z.object({
  url: z.url("URL health không hợp lệ.").refine((u) => /^https?:\/\//.test(u), "URL health phải là http hoặc https."),
  expectStatus: z.number().int().min(100).max(599).default(200),
  match: z
    .object({ path: jsonPath, equals: z.string().max(500) })
    .nullable()
    .default(null),
  timeoutSec: z.number().int().min(10).max(3600).default(180),
  intervalSec: z.number().int().min(1).max(300).default(5),
});
export type HealthCheck = z.output<typeof healthCheck>;

const varName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/, "Tên biến chỉ gồm chữ, số, `_`, không bắt đầu bằng số.");
const varValue = z.string().max(10_000);
const uniqueNames = <T extends { name: string }>(list: T[]) => new Set(list.map((v) => v.name)).size === list.length;

/** Biến ghi vào: biến bí mật bỏ trống `value` khi sửa là giữ giá trị đã lưu. */
const variableInput = z.discriminatedUnion("secret", [
  z.object({ name: varName, secret: z.literal(false), value: varValue }),
  z.object({ name: varName, secret: z.literal(true), value: varValue.min(1).optional() }),
]);
/** Biến đọc ra: biến bí mật chỉ cho biết đã đặt hay chưa (FR-019). */
const variableOutput = z.discriminatedUnion("secret", [
  z.object({ name: z.string(), secret: z.literal(false), value: z.string() }),
  z.object({ name: z.string(), secret: z.literal(true), set: z.boolean() }),
]);
export type TargetVariable = z.output<typeof variableOutput>;

/** Tham số Jenkins cố định hoặc lấy từ lần triển khai (`{{commit}}`, `{{tag}}`, `{{env}}`). */
const jenkinsTargetParam = z.object({ name: paramName, value: z.string().max(10_000) });

function targetConfigSchema<V extends z.ZodType<{ name: string }>>(variable: V) {
  return z.discriminatedUnion("method", [
    z.object({
      method: z.literal("ssh-script"),
      schemaVersion,
      serverId: id,
      workdir: absoluteDir,
      composeProject,
      /** Nhánh lấy commit mới nhất khi người triển khai không chọn; null là nhánh mặc định của repo. */
      branch: branchName,
      steps: z.object({
        precheck: scriptStep,
        /** Null là đích không sao lưu (Q9). */
        backup: scriptStep.nullable(),
        /** `git-archive`: hub gửi tarball của commit vào `src.new.tar.gz`; `none`: bước triển khai tự kéo mã/image. */
        upload: z.object({ mode: z.enum(["git-archive", "none"]) }),
        deploy: scriptStep,
      }),
      health: healthCheck.nullable().default(null),
      variables: z.array(variable).max(100).refine(uniqueNames, "Tên biến bị trùng.").default([]),
    }),
    z.object({
      method: z.literal("jenkins-job"),
      schemaVersion,
      connectionId: id,
      jobPath: jenkinsJobPath,
      branch: branchName,
      params: z.array(jenkinsTargetParam).max(50).refine(uniqueNames, "Tên tham số bị trùng.").default([]),
      /** "Đẩy từ môi trường" (Q15, FR-034): điền `buildParam` bằng số build đang chạy ở môi trường nguồn. */
      promote: z.object({ fromEnvironmentId: id, buildParam: paramName }).nullable().default(null),
      /** Job quay về riêng; đích promote không có thì không quay về được. */
      rollbackJob: z
        .object({ jobPath: jenkinsJobPath, params: z.array(jenkinsTargetParam).max(50).default([]) })
        .nullable()
        .default(null),
      health: healthCheck.nullable().default(null),
    }),
    z.object({
      method: z.literal("gitlab-manual"),
      schemaVersion,
      /** Tên job chờ tay trong pipeline của commit được chọn. */
      jobName: z.string().trim().min(1, "Nhập tên job chờ tay.").max(255),
      branch: branchName,
      health: healthCheck.nullable().default(null),
    }),
    z.object({
      method: z.literal("argocd"),
      schemaVersion,
      connectionId: id,
      application: z
        .string()
        .trim()
        .regex(/^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/, "Tên application Argo CD không hợp lệ."),
      /** Đồng bộ tới revision (commit) của lần triển khai; false là đồng bộ theo cấu hình của application. */
      syncToRevision: z.boolean().default(false),
      branch: branchName,
      timeoutSec: timeoutSec(600),
      health: healthCheck.nullable().default(null),
    }),
    z.object({
      method: z.literal("kubectl"),
      schemaVersion,
      connectionId: id,
      namespace: z.string().regex(/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/, "Namespace không hợp lệ."),
      kind: z.enum(["Deployment", "StatefulSet"]),
      name: z.string().regex(/^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/, "Tên workload không hợp lệ."),
      container: z.string().regex(/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/, "Tên container không hợp lệ."),
      /** Vd. `harbor.example.com/his/his-portal:{{tag}}`. */
      imageTemplate: z
        .string()
        .trim()
        .max(500)
        .refine((v) => v.includes("{{tag}}"), "Mẫu image phải có {{tag}}."),
      timeoutSec: timeoutSec(600),
      health: healthCheck.nullable().default(null),
    }),
  ]);
}

/** Cấu hình gửi lên khi lưu đích. */
export const targetConfigInput = targetConfigSchema(variableInput);
export type TargetConfigInput = z.input<typeof targetConfigInput>;
/** Cấu hình đọc ra: không có giá trị biến bí mật. */
export const targetConfig = targetConfigSchema(variableOutput);
export type TargetConfig = z.output<typeof targetConfig>;

export const deployTarget = z.object({
  id,
  projectId: id,
  environmentId: id,
  method: deployMethod,
  config: targetConfig,
  /** Tăng mỗi lần sửa; gửi lại ở `expectedConfigVersion` để khoá lạc quan. */
  configVersion: z.number().int().min(1),
  updatedBy: deliveryPerson.nullable(),
  createdAt: at,
  updatedAt: at,
});
export type DeployTarget = z.output<typeof deployTarget>;

export const targetUpsertInput = z.object({
  projectId: id,
  environmentId: id,
  config: targetConfigInput,
  /** Null khi tạo mới. Khác phiên bản đang lưu thì `TARGET_VERSION_CONFLICT`. */
  expectedConfigVersion: z.number().int().min(1).nullable(),
});
export type TargetUpsertInput = z.input<typeof targetUpsertInput>;

export const targetsContract = {
  list: route("GET", "/v1/deploy-targets", "Đích triển khai theo hệ thống, dự án hoặc môi trường (ci.view)")
    .input(z.object({ systemId: id.optional(), projectId: id.optional(), environmentId: id.optional() }))
    .output(z.array(deployTarget)),
  get: route("GET", "/v1/deploy-targets/{id}", "Một đích triển khai (ci.view)")
    .input(z.object({ id }))
    .output(deployTarget),
  upsert: route("POST", "/v1/deploy-targets", "Tạo hoặc sửa đích của dự án ở một môi trường (servers.manage)")
    .input(targetUpsertInput)
    .output(deployTarget),
  remove: route("DELETE", "/v1/deploy-targets/{id}", "Xoá đích triển khai (servers.manage)")
    .input(z.object({ id }))
    .output(removed),
};

// ---- Lần triển khai (FR-015…FR-025, FR-028) ------------------------------------------------------------------------

/** Mã trạng thái tiếng Anh trong DB; giao diện dịch (plan.md mục 1). */
export const deployState = z.enum([
  "pending_approval",
  "queued",
  "running",
  "succeeded",
  "failed",
  "failed_needs_review",
  "unknown",
  "canceled",
  "rejected",
  "expired",
]);
export type DeployState = z.output<typeof deployState>;
/** Đang đi: mỗi đích chỉ một lần do Hive tạo ở các trạng thái này (FR-015). */
export const DEPLOY_ACTIVE_STATES = ["pending_approval", "queued", "running"] as const satisfies readonly DeployState[];

export const deployOrigin = z.enum(["hive", "external"]);
export type DeployOrigin = z.output<typeof deployOrigin>;

export const deployStepState = z.enum(["pending", "running", "succeeded", "failed", "skipped", "canceled"]);
export type DeployStepState = z.output<typeof deployStepState>;

/**
 * Một bước của lần triển khai. `key` ổn định theo cách (`precheck`, `backup`, `upload`, `deploy`, `health` với
 * `ssh-script`; `build`, `sync`, `rollout`… với cách khác) để web dịch.
 */
export const deployStep = z.object({
  key: z.string(),
  state: deployStepState,
  startedAt: at.nullable(),
  finishedAt: at.nullable(),
  exitCode: z.number().int().nullable(),
  message: z.string().nullable(),
});
export type DeployStep = z.output<typeof deployStep>;

/** Phiên bản của lần triển khai (Q10); trường nào cách đó không biết thì null. */
export const deployVersion = z.object({
  commit: z.string().nullable(),
  tag: z.string().nullable(),
  jenkinsBuild: z.number().int().nullable(),
  /** Image chính (kubectl, `HIVE_DEPLOYED_IMAGE=` của Jenkins). */
  image: z.string().nullable(),
  /** Mọi image đang chạy theo Argo CD (`status.summary.images`); rỗng với cách khác. */
  images: z.array(z.string()),
  /** Revision của Argo CD. */
  revision: z.string().nullable(),
});
export type DeployVersion = z.output<typeof deployVersion>;

/** Phiên bản chọn khi bấm Triển khai. `commit` bỏ trống `sha` là commit mới nhất của nhánh đã cấu hình. */
export const deployVersionInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("commit"), sha: sha.optional() }),
  z.object({ kind: z.literal("tag"), tag: z.string().trim().min(1).max(255) }),
  /** Tag image (kubectl, argocd). */
  z.object({ kind: z.literal("image"), tag: z.string().trim().min(1).max(128) }),
  /** Đẩy từ môi trường (Q15): lấy bản đang chạy ở môi trường nguồn. */
  z.object({ kind: z.literal("fromEnv"), environmentId: id }),
]);
export type DeployVersionInput = z.input<typeof deployVersionInput>;

export const deployApprovalDecision = z.object({
  by: deliveryPerson,
  decision: z.enum(["approve", "reject"]),
  reason: z.string().nullable(),
  at,
});
export type DeployApprovalDecision = z.output<typeof deployApprovalDecision>;

export const deploy = z.object({
  id,
  targetId: id,
  projectId: id,
  environmentId: id,
  systemId: id,
  method: deployMethod,
  origin: deployOrigin,
  state: deployState,
  version: deployVersion,
  /** Người bấm trên Hive; null với lần "ngoài Hive". */
  requestedBy: deliveryPerson.nullable(),
  /** Người kích hoạt theo Jenkins (lần "ngoài Hive"). */
  triggeredBy: z.string().nullable(),
  steps: z.array(deployStep),
  configVersion: z.number().int().nullable(),
  rollbackOf: id.nullable(),
  skipBackup: z.object({ reason: z.string() }).nullable(),
  /** Build Jenkins, job GitLab, application Argo CD của lần này. */
  external: z.object({ label: z.string(), url: z.string().nullable() }).nullable(),
  health: z.object({ ok: z.boolean(), at, status: z.number().int().nullable(), message: z.string() }).nullable(),
  approval: z
    .object({ required: z.number().int(), expiresAt: at, decisions: z.array(deployApprovalDecision) })
    .nullable(),
  createdAt: at,
  startedAt: at.nullable(),
  finishedAt: at.nullable(),
});
export type Deploy = z.output<typeof deploy>;

export const deployCreateInput = z.object({
  targetId: id,
  version: deployVersionInput,
  /** "Bỏ qua sao lưu lần này" (Q9), ghi audit. */
  skipBackup: z.object({ reason: reason("Ghi lý do bỏ qua sao lưu.") }).optional(),
});
export type DeployCreateInput = z.input<typeof deployCreateInput>;

export const deployListInput = z.object({
  systemId: id.optional(),
  projectId: id.optional(),
  environmentId: id.optional(),
  targetId: id.optional(),
  state: deployState.optional(),
  origin: deployOrigin.optional(),
  cursor: cursor.optional(),
  limit,
});
export type DeployListInput = z.output<typeof deployListInput>;

/** Ô của bảng "đang chạy" (FR-020): bản thành công gần nhất và lần đang đi nếu có. */
export const deployBoardCell = z.object({
  environmentId: id,
  targetId: id.nullable(),
  method: deployMethod.nullable(),
  current: deploy.nullable(),
  active: deploy.nullable(),
});
export const deployBoard = z.object({
  environments: z.array(deployEnvironment),
  rows: z.array(z.object({ projectId: id, projectName: z.string(), cells: z.array(deployBoardCell) })),
});
export type DeployBoard = z.output<typeof deployBoard>;

/** Lý do nút "Quay về bản trước" tắt (US7 scenario 2). */
export const rollbackBlockedReason = z.enum([
  "no_previous_success",
  "promote_without_rollback_job",
  "env_locked",
  "in_progress",
]);
export const rollbackInfo = z.object({
  available: z.boolean(),
  reason: rollbackBlockedReason.nullable(),
  /** Bản đang chạy và bản sẽ quay về. */
  from: deploy.nullable(),
  to: deploy.nullable(),
  /** Argo CD: rollback tắt autoSync của application (plan.md R9). */
  warning: z.enum(["argocd_autosync"]).nullable(),
});
export type RollbackInfo = z.output<typeof rollbackInfo>;

export const deployCompareCommit = z.object({ sha: z.string(), title: z.string(), author: z.string(), at });
/** Danh sách commit giữa bản đang chạy và bản sẽ lên (FR-026). */
export const deployCompare = z.object({
  from: deployVersion.nullable(),
  to: deployVersion,
  commits: z.array(deployCompareCommit),
  /** Nguồn cắt bớt danh sách. */
  incomplete: z.boolean(),
});
export type DeployCompare = z.output<typeof deployCompare>;

export const deployApprovalsContract = {
  pending: route("GET", "/v1/deploy-approvals", "Lần triển khai chờ tôi duyệt (deploy.approve)")
    .input(z.object({ systemId: id.optional() }))
    .output(z.array(deploy)),
  approve: route(
    "POST",
    "/v1/deploys/{id}/approve",
    "Duyệt lần triển khai; người yêu cầu không tự duyệt (deploy.approve)",
  )
    .input(z.object({ id, comment: z.string().trim().max(1000).optional() }))
    .output(deploy),
  reject: route("POST", "/v1/deploys/{id}/reject", "Từ chối lần triển khai (deploy.approve)")
    .input(z.object({ id, reason: reason("Ghi lý do từ chối.") }))
    .output(deploy),
  compare: route("GET", "/v1/deploys/{id}/compare", "Commit giữa bản đang chạy và bản sẽ lên (ci.view)")
    .input(z.object({ id }))
    .output(deployCompare),
};

export const deploysContract = {
  create: route("POST", "/v1/deploys", "Triển khai một phiên bản lên đích (deploy.run)")
    .input(deployCreateInput)
    .output(deploy),
  get: route("GET", "/v1/deploys/{id}", "Một lần triển khai, các bước (ci.view)")
    .input(z.object({ id }))
    .output(deploy),
  list: route("GET", "/v1/deploys", "Lịch sử triển khai, mới nhất trước (ci.view)")
    .input(deployListInput)
    .output(z.object({ items: z.array(deploy), nextCursor: cursor.nullable() })),
  board: route("GET", "/v1/systems/{systemId}/deploy-board", "Bảng đang chạy: dự án × môi trường (ci.view)")
    .input(z.object({ systemId: id }))
    .output(deployBoard),
  cancel: route("POST", "/v1/deploys/{id}/cancel", "Huỷ lần triển khai đang đi (deploy.run)")
    .input(z.object({ id }))
    .output(deploy),
  rollback: route(
    "POST",
    "/v1/deploy-targets/{targetId}/rollback",
    "Quay về bản thành công trước đó, qua duyệt như thường (deploy.run)",
  )
    .input(z.object({ targetId: id }))
    .output(deploy),
  rollbackInfo: route("GET", "/v1/deploy-targets/{targetId}/rollback", "Quay về được không, về bản nào (ci.view)")
    .input(z.object({ targetId: id }))
    .output(rollbackInfo),
  approvals: deployApprovalsContract,
};
