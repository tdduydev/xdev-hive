import { z } from "zod";

// Việc CI/CD và triển khai chạy trên worker (specs/032). File riêng để không đụng `worker-protocol.ts`. Hub chỉ giữ và
// gửi TÊN tham chiếu credential; giá trị ở kho bí mật của máy (FR-060..063). Sự kiện không có kiểu nào mang thân log
// (FR-050): log đầy đủ ở đĩa của máy đã chạy.

/** Tên tham chiếu credential, duy nhất trong tổ chức (FR-061). */
export const credentialRef = z
  .string()
  .regex(/^[a-z0-9-]{1,64}$/, "Tên credential gồm chữ thường, số, gạch ngang, tối đa 64 ký tự.");
export type CredentialRef = z.output<typeof credentialRef>;

// Worker chỉ bấm job Jenkins hoặc sync Argo CD rồi theo dõi trạng thái; hệ ngoài tự triển khai (đã bỏ ssh, kubectl, kiểm tra
// sức khoẻ khỏi phạm vi).
/** Cách triển khai worker biết chạy. */
export const DELIVERY_METHODS = ["jenkins-job", "argocd"] as const;
export const deliveryMethod = z.enum(DELIVERY_METHODS);
export type DeliveryMethod = z.output<typeof deliveryMethod>;

// Loại việc không phải cách triển khai (specs/036): dùng chung hàng việc và chọn máy của 032, nhưng nằm ngoài
// `DELIVERY_METHODS` để màn môi trường deploy không chọn được.
export const DELIVERY_TASK_KINDS = ["test-report"] as const;
export const deliveryTaskKind = z.enum(DELIVERY_TASK_KINDS);
export type DeliveryTaskKind = z.output<typeof deliveryTaskKind>;

export const DELIVERY_JOB_KINDS = [...DELIVERY_METHODS, ...DELIVERY_TASK_KINDS] as const;
export const deliveryJobKind = z.enum(DELIVERY_JOB_KINDS);
export type DeliveryJobKind = z.output<typeof deliveryJobKind>;

/**
 * Khả năng worker báo ở `hello` và heartbeat (FR-010). `credentials` chỉ là danh sách tên. Linux không có kho bí mật báo
 * `methods: []` (FR-102). Trường lạ được bỏ qua để bản worker mới hơn không làm hub cũ hỏng. Worker cũ không gửi `kinds`
 * nên không được chọn cho việc `test-report`.
 */
export const deliveryCapability = z.object({
  methods: z.array(deliveryMethod).max(16).default([]),
  credentials: z.array(credentialRef).max(500).default([]),
  kinds: z.array(deliveryTaskKind).max(16).default([]),
});
export type DeliveryCapability = z.output<typeof deliveryCapability>;

/** Cách worker đọc báo cáo test của GitLab (specs/036 research D7). */
export const TEST_REPORT_MODES = ["pipeline-report", "junit-artifact", "playwright-artifact"] as const;
export const testReportMode = z.enum(TEST_REPORT_MODES);
export type TestReportMode = z.output<typeof testReportMode>;

const gitlabProjectPath = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)+$/, "Đường dẫn project GitLab có dạng nhóm/tên.")
  // `.` và `..` khớp regex nhưng proxy có thể giải mã thành đường dẫn khác sau khi escape.
  .refine((p) => !p.split("/").some((s) => s === "." || s === ".."), "Đường dẫn project GitLab có dạng nhóm/tên.");

export const testReportReadParams = z
  .object({
    op: z.literal("read"),
    projectPath: gitlabProjectPath,
    pipelineId: z.number().int().min(1),
    mode: testReportMode,
    /** Rỗng là mọi job; `*` là ký tự đại diện. Worker lọc tại máy nên tên job không rời máy. */
    jobFilter: z.array(z.string().min(1).max(100)).max(20).default([]),
    artifactPath: z
      .string()
      .min(1)
      .max(255)
      .refine(
        (p) => !p.startsWith("/") && !p.split(/[\\/]/).includes(".."),
        "Đường dẫn artifact phải tương đối và không chứa `..`.",
      )
      .optional(),
  })
  .strict()
  .refine((p) => p.mode === "pipeline-report" || p.artifactPath !== undefined, {
    message: "Cần đường dẫn artifact với mode đọc artifact.",
    path: ["artifactPath"],
  });

export const testReportListParams = z
  .object({
    op: z.literal("list"),
    projectPath: gitlabProjectPath,
    ref: z.string().min(1).max(255).optional(),
    updatedAfter: z.string().datetime().optional(),
    limit: z.number().int().min(1).max(500),
  })
  .strict();

export const testReportParams = z.discriminatedUnion("op", [testReportReadParams, testReportListParams]);
export type TestReportParams = z.output<typeof testReportParams>;

/** Mã lỗi ở `finished` của việc `test-report`; hub đổi thành `read_state` của lần chạy CI. */
export const TEST_REPORT_ERROR_CODES = [
  "no_report",
  "report_too_large",
  "report_invalid",
  "gitlab_auth",
  "gitlab_not_found",
  "gitlab_unreachable",
  "unsupported",
  "runner_offline",
] as const;
export const testReportErrorCode = z.enum(TEST_REPORT_ERROR_CODES);
export type TestReportErrorCode = z.output<typeof testReportErrorCode>;

/** Việc hub giao cho worker. `target` và `params` không bao giờ chứa giá trị bí mật; chỉ tên tham chiếu. */
export const deliveryJobSpec = z
  .object({
    jobId: z.string().uuid(),
    kind: deliveryJobKind,
    deployId: z.string().uuid().nullable().default(null),
    /** Phiên bản cấu hình đích đã khoá lúc giao (FR-021). */
    configVersion: z.number().int().nonnegative(),
    target: z.record(z.string(), z.unknown()),
    credential: credentialRef.nullable().default(null),
    params: z.record(z.string(), z.unknown()).default({}),
    timeoutSeconds: z.number().int().min(1).max(86_400).default(1800),
  })
  .superRefine((spec, ctx) => {
    // `params` của Jenkins và Argo CD vẫn tự do; chỉ `test-report` có dạng chốt vì worker gọi API GitLab theo nó.
    if (spec.kind !== "test-report") return;
    const parsed = testReportParams.safeParse(spec.params);
    if (!parsed.success) {
      ctx.addIssue({ code: "custom", path: ["params"], message: parsed.error.issues[0]?.message ?? "Tham số sai." });
    }
    if (spec.deployId !== null) {
      ctx.addIssue({ code: "custom", path: ["deployId"], message: "Việc đọc kết quả test không gắn lần triển khai." });
    }
  });
export type DeliveryJobSpec = z.output<typeof deliveryJobSpec>;

export const deliveryStepState = z.enum(["running", "succeeded", "failed", "skipped"]);
export type DeliveryStepState = z.output<typeof deliveryStepState>;

export const deliveryFinalState = z.enum(["succeeded", "failed", "canceled"]);
export type DeliveryFinalState = z.output<typeof deliveryFinalState>;

/** Thông điệp lỗi một dòng, đã che; cắt ở 200 ký tự (không gửi stderr). */
export const deliveryErrorMessage = z.string().max(200);

const eventBase = {
  jobId: z.string().uuid(),
  /** Tăng dần theo việc; hub bỏ sự kiện trùng theo `(jobId, seq)`. */
  seq: z.number().int().nonnegative(),
  at: z.string().datetime(),
};

export const deliveryEvent = z.discriminatedUnion("type", [
  z.object({ ...eventBase, type: z.literal("started"), workerId: z.string().min(1).max(128) }),
  z.object({
    ...eventBase,
    type: z.literal("step"),
    name: z.string().min(1).max(120),
    state: deliveryStepState,
    exitCode: z.number().int().optional(),
  }),
  z.object({
    ...eventBase,
    type: z.literal("external"),
    /** Tham chiếu build, ứng dụng hay workload ở hệ ngoài. */
    ref: z.string().min(1).max(500),
    /** Đường dẫn mở ở nguồn (FR-054). */
    url: z.string().url().optional(),
  }),
  z.object({
    ...eventBase,
    type: z.literal("finished"),
    state: deliveryFinalState,
    error: z.object({ code: z.string().min(1).max(64), message: deliveryErrorMessage }).optional(),
  }),
]);
export type DeliveryEvent = z.output<typeof deliveryEvent>;

// Kết quả của việc `test-report` (specs/036 FR-025): chỉ mã TC và số liệu. Mọi object đều `.strict()` để hub từ chối
// sự kiện mang tên test, tên file, thông báo lỗi hay trường lạ khác.

export const GITLAB_PIPELINE_FINAL_STATUSES = ["success", "failed", "canceled", "skipped", "manual"] as const;
export const gitlabPipelineFinalStatus = z.enum(GITLAB_PIPELINE_FINAL_STATUSES);

export const TEST_RESULT_STATUSES = ["passed", "failed", "skipped", "flaky"] as const;
export const testResultStatus = z.enum(TEST_RESULT_STATUSES);

/** Giới hạn của sự kiện `test-results`; số mã lạ bằng `QA_UNKNOWN_CODES_MAX` của specs/036. */
export const TEST_RESULTS_MAX_CASES = 5000;
export const TEST_RESULTS_MAX_UNKNOWN_CODES = 200;
export const TEST_RESULTS_MAX_JOBS = 100;
export const PIPELINES_EVENT_MAX_ITEMS = 100;

const libraryCaseCode = z.string().regex(/^TC-[A-Z][A-Z0-9]{1,15}-[0-9]{3,5}$/);
const count = z.number().int().nonnegative();
const gitlabId = z.number().int().min(1);

const pipelineMeta = {
  ref: z.string().min(1).max(255),
  sha: z.string().regex(/^[0-9a-f]{40}$/),
  status: gitlabPipelineFinalStatus,
  /** `source` của GitLab, ví dụ `push`, `merge_request_event`. */
  source: z.string().regex(/^[a-z_]{1,64}$/),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
};

export const testResultsEvent = z
  .object({
    ...eventBase,
    type: z.literal("test-results"),
    pipeline: z.object(pipelineMeta).strict(),
    jobIds: z.array(gitlabId).max(TEST_RESULTS_MAX_JOBS),
    totals: z.object({ total: count, passed: count, failed: count, skipped: count, flaky: count }).strict(),
    /** Số test không có mã TC. */
    unmapped: count,
    /** Số test có từ hai mã TC trở lên; không đưa vào `cases`. */
    ambiguous: count,
    /** Mã worker thấy trong báo cáo; hub so với thư viện và chỉ giữ mã lạ. */
    unknownCodes: z.array(libraryCaseCode).max(TEST_RESULTS_MAX_UNKNOWN_CODES),
    truncated: z.boolean(),
    cases: z
      .array(
        z
          .object({
            code: libraryCaseCode,
            status: testResultStatus,
            retries: z.number().int().min(0).max(20),
            durationMs: count,
            /** Job có kết quả xấu nhất của mã; vắng khi GitLab không cho biết test thuộc job nào. */
            worstJobId: gitlabId.optional(),
          })
          .strict(),
      )
      .max(TEST_RESULTS_MAX_CASES),
  })
  .strict();

export const pipelinesEvent = z
  .object({
    ...eventBase,
    type: z.literal("pipelines"),
    items: z.array(z.object({ pipelineId: gitlabId, ...pipelineMeta }).strict()).max(PIPELINES_EVENT_MAX_ITEMS),
  })
  .strict();

/**
 * Mọi sự kiện worker gửi cho một việc. `deliveryEvent` giữ riêng phần của lần triển khai: `delivery` áp nó vào tiến trình
 * deploy, còn `test-results` và `pipelines` đi tới module nhận của `test-report` (specs/036 T052).
 */
export const deliveryJobEvent = z.discriminatedUnion("type", [
  ...deliveryEvent.options,
  testResultsEvent,
  pipelinesEvent,
]);
export type DeliveryJobEvent = z.output<typeof deliveryJobEvent>;
