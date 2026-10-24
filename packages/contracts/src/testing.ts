import { z } from "zod";
import { id, orgErrors, orgRoute } from "./common.ts";
import { credentialRef } from "./delivery-worker.ts";
import { docKey } from "./knowledge.ts";
import { projectKey } from "./projects.ts";
import { qaPriority } from "./qa.ts";

/**
 * Quản lý kiểm thử cấp dự án (specs/036, ADR 0039): thư viện TC bằng Markdown trong docs home, kết quả CI đọc qua
 * worker, đợt test tay và dashboard. Bộ đọc file khu ở test-library.ts; route ở contracts/hub-api.md của spec.
 */

// ---- Giới hạn (research D11) ---------------------------------------------------------------------------------------

/** Pipeline chờ máy quá mốc này thì `expired` (FR-022). */
export const QA_READ_WAIT_HOURS = 24;
/** "Lấy lại kết quả" đọc lại pipeline cập nhật trong khoảng này (FR-028). */
export const QA_REFETCH_DAYS = 7;
/** Số pipeline gần nhất đọc khi tạo nguồn (FR-029). */
export const QA_BACKFILL_PIPELINES = 20;
export const QA_TREND_DAYS = 90;
/** TC chập chờn: có `flaky`, hoặc đổi qua lại giữa đạt và không đạt từ `QA_FLAKY_FLIPS` lần trong cửa sổ (FR-056). */
export const QA_FLAKY_WINDOW = 10;
export const QA_FLAKY_FLIPS = 3;
export const QA_UNKNOWN_CODES_MAX = 200;
export const QA_NOTE_MAX = 500;
export const QA_LINKS_MAX = 5;
export const QA_LINK_MAX_CHARS = 2000;
export const QA_RETENTION_DAYS_DEFAULT = 365;
// Sàn để không ai hạ thời hạn xuống vài ngày rồi xoá sạch kết quả; check của `qa_settings` giữ cùng sàn.
export const QA_RETENTION_DAYS_MIN = 90;
export const QA_RETENTION_DAYS_MAX = 3650;
export const QA_TC_DIR_DEFAULT = "test-cases/";

// ---- Giá trị liệt kê -----------------------------------------------------------------------------------------------

export const testCiStatus = z.enum(["passed", "flaky", "failed", "skipped"]);
export type TestCiStatus = z.output<typeof testCiStatus>;
export const testManualStatus = z.enum(["passed", "failed", "untested", "not-applicable", "deferred", "other"]);
export type TestManualStatus = z.output<typeof testManualStatus>;
/** Trạng thái tay được tính vào trạng thái hiện tại; ba trạng thái còn lại nghĩa là chưa có kết quả (FR-052). */
export const QA_COUNTED_MANUAL_STATUSES = ["passed", "failed", "other"] as const satisfies readonly TestManualStatus[];
export const testCurrentStatus = z.enum(["passed", "flaky", "failed", "skipped", "other"]);
export type TestCurrentStatus = z.output<typeof testCurrentStatus>;
/** Thứ tự xấu dần cho FR-054; gộp cả CI và tay (data-model, quyết định 2). */
export const QA_STATUS_SEVERITY: readonly TestCurrentStatus[] = ["passed", "skipped", "flaky", "other", "failed"];
export const testCurrentSource = z.enum(["ci", "manual"]);
export type TestCurrentSource = z.output<typeof testCurrentSource>;
export const testCaseState = z.enum(["active", "retired"]);
export type TestCaseState = z.output<typeof testCaseState>;
export const testReadState = z.enum(["waiting", "reading", "done", "no-report", "error", "expired"]);
export type TestReadState = z.output<typeof testReadState>;
export const testCaseKind = z.enum(["automated", "manual", "planned"]);
export type TestCaseKind = z.output<typeof testCaseKind>;
export const testSourceMode = z.enum(["pipeline-report", "junit-artifact", "playwright-artifact"]);
export type TestSourceMode = z.output<typeof testSourceMode>;
export const testBackfillState = z.enum(["pending", "listing", "done", "error"]);
export type TestBackfillState = z.output<typeof testBackfillState>;
export const testPipelineStatus = z.enum(["success", "failed", "canceled", "skipped", "manual"]);
export type TestPipelineStatus = z.output<typeof testPipelineStatus>;
export const testRunKind = z.enum(["branch", "mr"]);
export type TestRunKind = z.output<typeof testRunKind>;
export const testRoundState = z.enum(["open", "closed"]);
export type TestRoundState = z.output<typeof testRoundState>;
/** Kết quả `docsync.ensureProjectInclude` khi bật thư viện (research D3b). */
export const testIncludeResult = z.enum(["no-home", "covered", "added"]);
export type TestIncludeResult = z.output<typeof testIncludeResult>;

// ---- Chữ giao diện -------------------------------------------------------------------------------------------------

export const TEST_CI_STATUS_LABEL: Record<TestCiStatus, string> = {
  passed: "Đạt",
  flaky: "Chập chờn",
  failed: "Không đạt",
  skipped: "Bỏ qua",
};
export const TEST_MANUAL_STATUS_LABEL: Record<TestManualStatus, string> = {
  passed: "Đạt",
  failed: "Không đạt",
  other: "Khác",
  untested: "Chưa test",
  "not-applicable": "Không test",
  deferred: "Chuyển đợt sau",
};
export const TEST_CURRENT_STATUS_LABEL: Record<TestCurrentStatus, string> = {
  ...TEST_CI_STATUS_LABEL,
  other: "Khác",
};
export const TEST_NO_RESULT_LABEL = "Chưa có kết quả";
export const TEST_CASE_STATE_LABEL: Record<TestCaseState, string> = { active: "Đang dùng", retired: "Ngừng dùng" };
export const TEST_READ_STATE_LABEL: Record<TestReadState, string> = {
  waiting: "Chờ máy",
  reading: "Đang đọc",
  done: "Đã đọc",
  "no-report": "Không có báo cáo",
  error: "Lỗi đọc",
  expired: "Hết hạn",
};
export const TEST_CASE_KIND_LABEL: Record<TestCaseKind, string> = {
  automated: "Tự động",
  manual: "Tay",
  planned: "Dự kiến tự động",
};

// ---- Mã ------------------------------------------------------------------------------------------------------------

export const TEST_AREA_CODE = /^[A-Z][A-Z0-9]{1,15}$/;
export const TEST_CASE_CODE = /^TC-[A-Z][A-Z0-9]{1,15}-[0-9]{3,5}$/;
/** Mã yêu cầu của spec Spec Kit, có thể kèm số spec (research D10). */
export const TEST_SPEC_REQUIREMENT = /^(\d{3}\/)?(FR|AC|NFR|US)-\d{3,4}(\.\d+)?$/;
// Loại trừ tiền tố của mã spec để `FR001` hay `NFR` báo "mã spec sai dạng" thay vì lọt thành mã SRS.
export const TEST_SRS_REQUIREMENT = /^(?!(FR|AC|NFR|US)(\d|$))[A-Z][A-Z0-9]{2,15}$/;

export const testAreaCode = z
  .string()
  .regex(TEST_AREA_CODE, "Mã khu gồm 2–16 chữ hoa hoặc số, bắt đầu bằng chữ, ví dụ `DANGNHAP`.");
export const testCaseCode = z
  .string()
  .regex(TEST_CASE_CODE, "Mã TC có dạng `TC-<KHU>-<SỐ>`, `<SỐ>` gồm 3–5 chữ số, ví dụ `TC-DANGNHAP-001`.");
export const isTestRequirementCode = (code: string) =>
  TEST_SPEC_REQUIREMENT.test(code) || TEST_SRS_REQUIREMENT.test(code);
export const testRequirementCode = z
  .string()
  .refine(isTestRequirementCode, "Mã yêu cầu có dạng `FR-001`, `036/AC-012.2` hoặc mã SRS như `OPD02`.");

// ---- Lỗi -----------------------------------------------------------------------------------------------------------

type QaErrorStatus = "BAD_REQUEST" | "FORBIDDEN" | "CONFLICT";

/**
 * Mã lỗi nghiệp vụ (đi trong `data.code`). Câu có `{...}` là khuôn: hub điền bằng `qaErrorMessage()` nhưng giữ mã, vì
 * web phân biệt lý do bằng mã.
 */
export const QA_ERRORS = {
  QA_LIBRARY_DISABLED: {
    status: "FORBIDDEN",
    message: "Dự án chưa bật thư viện test case. Admin dự án bật ở Cài đặt → Kiểm thử.",
  },
  QA_NOT_ASSIGNED: {
    status: "FORBIDDEN",
    message: "Bạn chưa được giao TC này trong đợt. Nhờ người quản lý đợt giao, hoặc bật cho mọi tester ghi.",
  },
  QA_RESULT_CONFLICT: {
    status: "CONFLICT",
    message: "Kết quả này vừa được người khác lưu. Xem bản mới nhất rồi lưu lại.",
  },
  QA_ROUND_CLOSED: { status: "CONFLICT", message: "Đợt đã đóng, không nhận kết quả mới. Mở lại đợt nếu cần ghi thêm." },
  QA_AREA_CODE_TAKEN: { status: "CONFLICT", message: "Mã khu `{KHU}` đã dùng ở `{đường dẫn}`. Chọn mã khu khác." },
  QA_SOURCE_LABEL_TAKEN: { status: "CONFLICT", message: "Dự án đã có nguồn tên `{nhãn}`." },
  QA_REFETCH_RUNNING: { status: "CONFLICT", message: "Đang lấy lại kết quả cho nguồn này. Chờ lần trước xong." },
  QA_NOTE_REQUIRED: { status: "BAD_REQUEST", message: "Trạng thái Khác và Không đạt cần ghi chú hoặc liên kết lỗi." },
  QA_LINK_INVALID: {
    status: "BAD_REQUEST",
    message: "Liên kết lỗi phải bắt đầu bằng http:// hoặc https://, tối đa 2.000 ký tự.",
  },
  QA_FAILED_STEP_INVALID: { status: "BAD_REQUEST", message: "Bước lỗi phải từ 1 tới {n}." },
  QA_ASSIGNEE_NOT_MEMBER: { status: "BAD_REQUEST", message: "Người sau không thuộc đội của dự án: {tên}." },
  QA_ROUND_EMPTY: { status: "BAD_REQUEST", message: "Không có TC đang dùng nào khớp điều kiện chọn." },
} as const satisfies Record<string, { status: QaErrorStatus; message: string }>;
export type QaErrorCode = keyof typeof QA_ERRORS;

/** Điền khuôn `{tên}` của `QA_ERRORS`; khoá thiếu thì giữ nguyên khuôn để lỗi lộ ra ở test thay vì in chuỗi rỗng. */
export const qaErrorMessage = (code: QaErrorCode, values: Record<string, string | number> = {}) =>
  QA_ERRORS[code].message.replace(/\{([^}]+)\}/g, (all, key: string) => (key in values ? String(values[key]) : all));

// ---- Trường dùng chung ---------------------------------------------------------------------------------------------

const cursor = z.string().max(2000).optional();
// GET gửi số dạng chuỗi trong query; coerce để REST và RPC cùng nhận.
const limit = z.coerce.number().int().min(1).max(100).default(20);
const page = { cursor, limit };
const nextCursor = z.string().nullable();
const count = z.int().min(0);
/** Tỉ lệ 0–1; null khi mẫu số bằng 0. */
const rate = z.number().min(0).max(1).nullable();
const at = z.iso.datetime();
const date = z.iso.date("Ngày có dạng YYYY-MM-DD.");
const userRef = z.object({ id, name: z.string() });

/** Đường dẫn tương đối trong repo: không bắt đầu bằng `/`, không `..`, không `\` hay `:`. */
const isRelativePath = (p: string) =>
  !p.startsWith("/") && !/[\\:\n\r]/.test(p) && !p.split("/").some((part) => part === "..");

export const testTcDir = z
  .string()
  .trim()
  .min(2, "Thư mục TC không được để trống.")
  .max(200, "Thư mục TC dài tối đa 200 ký tự.")
  .refine(
    (p) => p.endsWith("/") && !p.includes("//") && isRelativePath(p),
    "Thư mục TC là đường dẫn tương đối, kết thúc bằng `/`, không chứa `..`, ví dụ `test-cases/`.",
  );

const repoPath = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)+$/, "Đường dẫn repo GitLab có dạng `nhom/du-an`.");
const globList = z.array(z.string().trim().min(1).max(100)).max(20, "Tối đa 20 mẫu.");
const artifactPath = z
  .string()
  .trim()
  .min(1)
  .max(255, "Đường dẫn artifact dài tối đa 255 ký tự.")
  .refine(isRelativePath, "Đường dẫn artifact là đường dẫn tương đối, không chứa `..`.");
const branchName = z.string().trim().min(1).max(255);

export const testLink = z
  .string()
  .max(QA_LINK_MAX_CHARS, QA_ERRORS.QA_LINK_INVALID.message)
  .regex(/^https?:\/\/\S+$/i, QA_ERRORS.QA_LINK_INVALID.message);

// ---- Cài đặt -------------------------------------------------------------------------------------------------------

export const testSettingsInput = z.object({
  retentionDays: z
    .number()
    .int()
    .min(QA_RETENTION_DAYS_MIN, `Thời hạn giữ tối thiểu ${QA_RETENTION_DAYS_MIN} ngày.`)
    .max(QA_RETENTION_DAYS_MAX, `Thời hạn giữ tối đa ${QA_RETENTION_DAYS_MAX} ngày.`),
});
export const testSettings = testSettingsInput.extend({
  /** Null khi tổ chức chưa đổi, đang dùng mặc định. */
  updatedAt: at.nullable(),
});
export type TestSettings = z.output<typeof testSettings>;

export const testProjectSettings = z.object({
  enabled: z.boolean(),
  tcDir: z.string(),
  includeResult: testIncludeResult.nullable(),
});
export type TestProjectSettings = z.output<typeof testProjectSettings>;
export const testProjectSettingsInput = z.object({
  projectKey,
  enabled: z.boolean().optional(),
  tcDir: testTcDir.optional(),
});
export type TestProjectSettingsInput = z.output<typeof testProjectSettingsInput>;

// ---- Thư viện ------------------------------------------------------------------------------------------------------

export const testParseError = z.object({ line: z.int().min(1), message: z.string() });
export type TestParseError = z.output<typeof testParseError>;

export const testArea = z.object({
  id,
  code: z.string(),
  name: z.string(),
  /** Giữ key cũ khi tài liệu đã bị xoá, để màn lỗi vẫn chỉ được file. */
  docKey: z.string().nullable(),
  activeCases: count,
  parsedVersion: z.int().nullable(),
  parseErrors: z.array(testParseError),
  errorsVersion: z.int().nullable(),
  archived: z.boolean(),
});
export type TestArea = z.output<typeof testArea>;
export const testAreaCreateInput = z.object({
  projectKey,
  code: testAreaCode,
  name: z.string().trim().min(1, "Tên khu không được để trống.").max(120, "Tên khu dài tối đa 120 ký tự."),
});

export const testStep = z.object({ n: z.int().min(1), action: z.string(), expected: z.string() });
export type TestStep = z.output<typeof testStep>;
/** Các trường của FR-002; cũng là `content` của `qa_case_versions`. */
export const testCaseContent = z.object({
  name: z.string(),
  priority: qaPriority,
  kind: testCaseKind,
  requirements: z.array(z.string()),
  labels: z.array(z.string()),
  script: z.string().nullable(),
  testData: z.string().nullable(),
  preconditions: z.string().nullable(),
  note: z.string().nullable(),
  steps: z.array(testStep),
});
export type TestCaseContent = z.output<typeof testCaseContent>;

export const testCaseRow = z.object({
  id,
  code: z.string(),
  name: z.string(),
  areaCode: z.string(),
  priority: qaPriority,
  kind: testCaseKind,
  requirements: z.array(z.string()),
  labels: z.array(z.string()),
  state: testCaseState,
  version: z.int().min(1),
  /** Null là "Chưa có kết quả" (FR-051). */
  currentStatus: testCurrentStatus.nullable(),
  currentSource: testCurrentSource.nullable(),
});
export type TestCaseRow = z.output<typeof testCaseRow>;

export const testCaseListInput = z.object({
  projectKey,
  q: z.string().trim().max(200).optional(),
  area: testAreaCode.optional(),
  label: z.string().trim().min(1).max(40).optional(),
  priority: qaPriority.optional(),
  kind: testCaseKind.optional(),
  requirement: z.string().trim().min(1).max(40).optional(),
  /** `none` lọc TC chưa có kết quả. */
  currentStatus: z.union([testCurrentStatus, z.literal("none")]).optional(),
  state: testCaseState.default("active"),
  ...page,
});
export type TestCaseListInput = z.output<typeof testCaseListInput>;

const ciResult = z.object({
  status: testCiStatus,
  at,
  runId: id,
  sourceLabel: z.string(),
  pipelineId: z.int(),
  ref: z.string(),
  sha: z.string(),
  pipelineUrl: z.string().nullable(),
  jobUrl: z.string().nullable(),
});
const manualResult = z.object({
  status: testManualStatus,
  at,
  roundId: id,
  roundName: z.string(),
  roundCaseId: id,
  recordedBy: userRef.nullable(),
});

export const testCaseDetail = testCaseRow.extend({
  ...testCaseContent.shape,
  docKey: z.string().nullable(),
  /** Dòng tiêu đề `###` để editor mở đúng chỗ. */
  line: z.int().min(1),
  versions: z.array(
    z.object({ version: z.int().min(1), docVersion: z.int(), createdAt: at, content: testCaseContent }),
  ),
  // Hai nguồn hiện riêng cạnh trạng thái hiện tại (FR-052).
  latestCi: ciResult.nullable(),
  latestManual: manualResult.nullable(),
});
export type TestCaseDetail = z.output<typeof testCaseDetail>;

export const testCaseHistoryItem = z.discriminatedUnion("source", [
  ciResult.extend({ source: z.literal("ci"), kind: testRunKind, retries: count, durationMs: count }),
  manualResult.extend({
    source: z.literal("manual"),
    failedStep: z.int().nullable(),
    note: z.string().nullable(),
    noteDeleted: z.boolean(),
    links: z.array(z.string()),
  }),
]);
export type TestCaseHistoryItem = z.output<typeof testCaseHistoryItem>;

// ---- Nguồn kết quả CI ----------------------------------------------------------------------------------------------

export const testCiRun = z.object({
  id,
  pipelineId: z.int(),
  readState: testReadState,
  waitReason: z.string().nullable(),
  readErrorCode: z.string().nullable(),
  pipelineStatus: testPipelineStatus.nullable(),
  ref: z.string(),
  sha: z.string(),
  kind: testRunKind,
  isReference: z.boolean(),
  startedAt: at.nullable(),
  finishedAt: at.nullable(),
  passed: count,
  flaky: count,
  failed: count,
  skipped: count,
  unmapped: count,
  ambiguous: count,
  unknownCodes: z.array(z.string()).max(QA_UNKNOWN_CODES_MAX),
  retiredCodes: count,
  truncated: z.boolean(),
  pipelineUrl: z.string().nullable(),
});
export type TestCiRun = z.output<typeof testCiRun>;

const ciSourceFields = {
  label: z.string().trim().min(1, "Tên nguồn không được để trống.").max(80, "Tên nguồn dài tối đa 80 ký tự."),
  repoPath,
  branchFilter: globList.default([]),
  jobFilter: globList.default([]),
  mode: testSourceMode,
  artifactPath: artifactPath.nullable().optional(),
  referenceBranch: branchName.optional(),
  credential: credentialRef,
};
const ARTIFACT_PATH_REQUIRED = "Mode đọc artifact cần đường dẫn artifact.";
const needsArtifactPath = (mode: TestSourceMode | undefined) =>
  mode === "junit-artifact" || mode === "playwright-artifact";

export const testCiSourceCreateInput = z
  .object({ projectKey, ...ciSourceFields })
  .refine((s) => !needsArtifactPath(s.mode) || !!s.artifactPath, {
    message: ARTIFACT_PATH_REQUIRED,
    path: ["artifactPath"],
  });
export type TestCiSourceCreateInput = z.output<typeof testCiSourceCreateInput>;
// Sửa từng phần: hub ghép với bản đang lưu rồi mới kiểm `artifactPath` theo mode.
export const testCiSourceUpdateInput = z.object({
  sourceId: id,
  label: ciSourceFields.label.optional(),
  repoPath: repoPath.optional(),
  branchFilter: globList.optional(),
  jobFilter: globList.optional(),
  mode: testSourceMode.optional(),
  artifactPath: artifactPath.nullable().optional(),
  referenceBranch: branchName.optional(),
  credential: credentialRef.optional(),
});
export type TestCiSourceUpdateInput = z.output<typeof testCiSourceUpdateInput>;

export const testCiSource = z.object({
  id,
  label: z.string(),
  repoPath: z.string(),
  repoWebUrl: z.string(),
  branchFilter: z.array(z.string()),
  jobFilter: z.array(z.string()),
  mode: testSourceMode,
  artifactPath: z.string().nullable(),
  referenceBranch: z.string(),
  credential: z.string(),
  backfillState: testBackfillState,
  refetchRequestedAt: at.nullable(),
  lastRun: testCiRun.nullable(),
  createdAt: at,
});
export type TestCiSource = z.output<typeof testCiSource>;

// ---- Đợt test tay --------------------------------------------------------------------------------------------------

const roundName = z.string().trim().min(1, "Tên đợt không được để trống.").max(120, "Tên đợt dài tối đa 120 ký tự.");
const roundFields = {
  name: roundName,
  environment: z.string().trim().max(80, "Môi trường dài tối đa 80 ký tự."),
  build: z.string().trim().max(80, "Bản phần mềm dài tối đa 80 ký tự."),
  startDate: date,
  plannedEndDate: date,
};
const datesInOrder = (r: { startDate: string; plannedEndDate: string }) => r.plannedEndDate >= r.startDate;
const DATES_IN_ORDER = { message: "Ngày dự kiến kết thúc không được trước ngày bắt đầu.", path: ["plannedEndDate"] };

/** TC thoả bất kỳ điều kiện nào thì vào đợt (FR-030). */
export const testRoundSelect = z.object({
  areas: z.array(testAreaCode).max(200).optional(),
  labels: z.array(z.string().trim().min(1).max(40)).max(50).optional(),
  priorities: z.array(qaPriority).max(3).optional(),
  kinds: z.array(testCaseKind).max(3).optional(),
  caseIds: z.array(id).max(5000).optional(),
});
export type TestRoundSelect = z.output<typeof testRoundSelect>;

export const testRoundCreateInput = z
  .object({ projectKey, ...roundFields, openRecording: z.boolean().default(false), select: testRoundSelect })
  .refine(datesInOrder, DATES_IN_ORDER);
export type TestRoundCreateInput = z.output<typeof testRoundCreateInput>;

/** Trạng thái chuyển sang đợt sau mặc định (FR-038). */
export const QA_NEXT_ROUND_STATUSES = [
  "failed",
  "untested",
  "deferred",
  "other",
] as const satisfies readonly TestManualStatus[];
export const testRoundCreateNextInput = z
  .object({
    fromRoundId: id,
    ...roundFields,
    statuses: z
      .array(testManualStatus)
      .min(1)
      .max(6)
      .default([...QA_NEXT_ROUND_STATUSES]),
  })
  .refine(datesInOrder, DATES_IN_ORDER);
export type TestRoundCreateNextInput = z.output<typeof testRoundCreateNextInput>;

export const testRoundProgress = z.object(
  Object.fromEntries(testManualStatus.options.map((s) => [s, count])) as Record<TestManualStatus, typeof count>,
);
export type TestRoundProgress = z.output<typeof testRoundProgress>;

export const testRound = z.object({
  id,
  name: z.string(),
  environment: z.string(),
  build: z.string(),
  startDate: z.string(),
  plannedEndDate: z.string(),
  state: testRoundState,
  openRecording: z.boolean(),
  previousRoundId: id.nullable(),
  reopenReason: z.string().nullable(),
  createdBy: userRef.nullable(),
  createdAt: at,
  closedAt: at.nullable(),
  total: count,
  progress: testRoundProgress,
});
export type TestRound = z.output<typeof testRound>;

export const testRoundCase = z.object({
  id,
  caseId: id,
  code: z.string(),
  name: z.string(),
  areaCode: z.string(),
  caseState: testCaseState,
  /** Số bước của TC hiện tại, để web giới hạn ô "Bước lỗi". */
  stepCount: z.int().min(1),
  status: testManualStatus,
  failedStep: z.int().nullable(),
  note: z.string().nullable(),
  noteDeleted: z.boolean(),
  links: z.array(z.string()),
  assignees: z.array(userRef),
  recordedBy: userRef.nullable(),
  recordedAt: at.nullable(),
  recordedCaseVersion: z.int().nullable(),
  revision: z.int().min(0),
  /** TC đã sửa sau khi vào đợt (FR-037). */
  caseChanged: z.boolean(),
});
export type TestRoundCase = z.output<typeof testRoundCase>;

export const testRoundDetail = testRound.extend({ projectKey: z.string(), cases: z.array(testRoundCase) });
export type TestRoundDetail = z.output<typeof testRoundDetail>;

export const testRoundAssignInput = z
  .object({
    roundId: id,
    roundCaseIds: z.array(id).max(5000).optional(),
    areaCodes: z.array(testAreaCode).max(200).optional(),
    userIds: z.array(id).max(100),
    mode: z.enum(["add", "replace"]),
  })
  .refine((a) => (a.roundCaseIds?.length ?? 0) + (a.areaCodes?.length ?? 0) > 0, {
    message: "Chọn TC hoặc khu cần giao.",
    path: ["roundCaseIds"],
  });
export type TestRoundAssignInput = z.output<typeof testRoundAssignInput>;

export const testRecordInput = z
  .object({
    roundCaseId: id,
    /** `revision` client đã đọc; khác bản đang lưu thì `QA_RESULT_CONFLICT` (FR-035). */
    revision: z.int().min(0),
    status: testManualStatus,
    failedStep: z.int().min(1).nullable().optional(),
    note: z.string().trim().max(QA_NOTE_MAX, `Ghi chú dài tối đa ${QA_NOTE_MAX} ký tự.`).nullable().optional(),
    links: z.array(testLink).max(QA_LINKS_MAX, `Tối đa ${QA_LINKS_MAX} liên kết lỗi.`).default([]),
  })
  .refine((r) => !(r.status === "failed" || r.status === "other") || !!r.note || r.links.length > 0, {
    message: QA_ERRORS.QA_NOTE_REQUIRED.message,
    path: ["note"],
  });
export type TestRecordInput = z.output<typeof testRecordInput>;

export const testResultHistoryItem = z.object({
  revision: z.int().min(0),
  status: testManualStatus,
  failedStep: z.int().nullable(),
  note: z.string().nullable(),
  /** Web hiện "Ghi chú đã bị quản trị xoá". */
  noteDeleted: z.boolean(),
  links: z.array(z.string()),
  recordedBy: userRef.nullable(),
  recordedAt: at.nullable(),
  recordedCaseVersion: z.int().nullable(),
  changedBy: userRef.nullable(),
  changedAt: at,
});
export type TestResultHistoryItem = z.output<typeof testResultHistoryItem>;

export const testMyWorkItem = z.object({
  roundCaseId: id,
  roundId: id,
  roundName: z.string(),
  projectKey: z.string(),
  code: z.string(),
  name: z.string(),
  status: testManualStatus,
  revision: z.int().min(0),
  caseChanged: z.boolean(),
});
export type TestMyWorkItem = z.output<typeof testMyWorkItem>;

// ---- Dashboard -----------------------------------------------------------------------------------------------------

const statusCounts = {
  passed: count,
  flaky: count,
  failed: count,
  skipped: count,
  other: count,
  noResult: count,
};

export const testDashboardOverview = z.object({
  activeCases: count,
  byKind: z.object({ automated: count, manual: count, planned: count }),
  ...statusCounts,
  passRate: rate,
  sources: z.array(z.object({ sourceId: id, label: z.string(), lastRun: testCiRun.nullable() })),
  openRounds: z.array(testRound),
});
export type TestDashboardOverview = z.output<typeof testDashboardOverview>;

export const testDashboardArea = z.object({
  areaCode: z.string(),
  name: z.string(),
  activeCases: count,
  ...statusCounts,
  passRate: rate,
});
export type TestDashboardArea = z.output<typeof testDashboardArea>;

export const testDashboardRequirement = z.object({
  requirement: z.string(),
  cases: count,
  /** Null khi chưa TC nào có kết quả. */
  worstStatus: testCurrentStatus.nullable(),
});
export type TestDashboardRequirement = z.output<typeof testDashboardRequirement>;

export const testTrendPoint = z.object({
  runId: id,
  pipelineId: z.int(),
  finishedAt: at,
  passed: count,
  flaky: count,
  failed: count,
  skipped: count,
  passRate: rate,
});
export type TestTrendPoint = z.output<typeof testTrendPoint>;

export const testFlakyCase = z.object({
  caseId: id,
  code: z.string(),
  name: z.string(),
  areaCode: z.string(),
  flakyRuns: count,
  flips: count,
  lastRun: z.object({ runId: id, pipelineId: z.int(), finishedAt: at.nullable(), status: testCiStatus }),
});
export type TestFlakyCase = z.output<typeof testFlakyCase>;

// ---- Hợp đồng ------------------------------------------------------------------------------------------------------

const qaErrorDetail = {
  /** `QA_ASSIGNEE_NOT_MEMBER`: tên người không thuộc đội. */
  names: z.array(z.string()).optional(),
  /** `QA_AREA_CODE_TAKEN`: key tài liệu đang giữ mã khu. */
  docKey: z.string().optional(),
  /** `QA_FAILED_STEP_INVALID`: số bước của TC. */
  limit: z.number().optional(),
};
export const qaErrorData = z.object({ code: z.string(), ...qaErrorDetail }).optional();
export type QaErrorData = z.output<typeof qaErrorData>;

const qaErrors = {
  FORBIDDEN: { message: orgErrors.FORBIDDEN.message, data: qaErrorData },
  NOT_FOUND: { message: orgErrors.NOT_FOUND.message, data: qaErrorData },
  CONFLICT: { message: orgErrors.CONFLICT.message, data: qaErrorData },
  // Lỗi kiểm đầu vào của oRPC mang `issues` và không có `code`; schema chặt thì oRPC coi lỗi đó là lỗi lạ.
  BAD_REQUEST: {
    message: orgErrors.BAD_REQUEST.message,
    data: z.looseObject({ code: z.string().optional(), ...qaErrorDetail }).optional(),
  },
};
// `latest` chỉ có ở route ghi kết quả: gắn vào mọi route thì openapi.json chép cả `testRoundCase` vào từng lỗi.
export const qaRecordConflictData = z
  .object({
    code: z.string(),
    ...qaErrorDetail,
    /** `QA_RESULT_CONFLICT`: bản đang lưu để web gộp với bản người dùng vừa sửa. */
    latest: testRoundCase.optional(),
  })
  .optional();
export type QaRecordConflictData = z.output<typeof qaRecordConflictData>;

const route = (method: "GET" | "POST" | "PATCH" | "DELETE", path: `/v1/testing/${string}`, summary: string) =>
  orgRoute(method, path, summary, "testing").errors(qaErrors);

const ok = z.object({ ok: z.literal(true) });
const byProject = z.object({ projectKey });
const bySource = z.object({ sourceId: id });
const byRound = z.object({ roundId: id });
const byRoundCase = z.object({ roundCaseId: id });
const list = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item), nextCursor });

export const testingContract = {
  settings: {
    get: route("GET", "/v1/testing/settings", "Xem thời hạn giữ kết quả kiểm thử").output(testSettings),
    update: route("PATCH", "/v1/testing/settings", "Đổi thời hạn giữ kết quả kiểm thử (quản trị tổ chức)")
      .input(testSettingsInput)
      .output(testSettings),
  },
  projectSettings: {
    get: route("GET", "/v1/testing/projects/{projectKey}/settings", "Xem cài đặt kiểm thử của dự án")
      .input(byProject)
      .output(testProjectSettings),
    update: route("PATCH", "/v1/testing/projects/{projectKey}/settings", "Bật thư viện test case, đổi thư mục TC")
      .input(testProjectSettingsInput)
      .output(testProjectSettings),
  },
  areas: {
    list: route("GET", "/v1/testing/projects/{projectKey}/areas", "Danh sách khu chức năng và lỗi đọc file")
      .input(byProject)
      .output(z.object({ items: z.array(testArea) })),
    create: route("POST", "/v1/testing/projects/{projectKey}/areas", "Thêm khu chức năng từ mẫu")
      .input(testAreaCreateInput)
      .output(z.object({ area: testArea, docKey })),
  },
  cases: {
    list: route("GET", "/v1/testing/projects/{projectKey}/cases", "Lọc test case của thư viện")
      .input(testCaseListInput)
      .output(list(testCaseRow)),
    get: route("GET", "/v1/testing/projects/{projectKey}/cases/{code}", "Chi tiết test case và các phiên bản")
      .input(z.object({ projectKey, code: testCaseCode }))
      .output(testCaseDetail),
    history: route("GET", "/v1/testing/projects/{projectKey}/cases/{code}/history", "Lịch sử kết quả của test case")
      .input(z.object({ projectKey, code: testCaseCode, source: testCurrentSource, ...page }))
      .output(list(testCaseHistoryItem)),
  },
  sources: {
    list: route("GET", "/v1/testing/projects/{projectKey}/sources", "Danh sách nguồn kết quả CI")
      .input(byProject)
      .output(z.object({ items: z.array(testCiSource) })),
    create: route("POST", "/v1/testing/projects/{projectKey}/sources", "Thêm nguồn kết quả CI")
      .input(testCiSourceCreateInput)
      .output(testCiSource),
    update: route("PATCH", "/v1/testing/sources/{sourceId}", "Sửa nguồn kết quả CI")
      .input(testCiSourceUpdateInput)
      .output(testCiSource),
    delete: route("DELETE", "/v1/testing/sources/{sourceId}", "Xoá nguồn kết quả CI và các lần chạy")
      .input(bySource)
      .output(ok),
    refetch: route("POST", "/v1/testing/sources/{sourceId}/refetch", "Lấy lại kết quả CI 7 ngày gần nhất")
      .input(bySource)
      .output(testCiSource),
    runs: route("GET", "/v1/testing/sources/{sourceId}/runs", "Lịch sử lần chạy của nguồn")
      .input(z.object({ sourceId: id, ...page }))
      .output(list(testCiRun)),
  },
  rounds: {
    list: route("GET", "/v1/testing/projects/{projectKey}/rounds", "Danh sách đợt test")
      .input(z.object({ projectKey, state: testRoundState.optional(), ...page }))
      .output(list(testRound)),
    get: route("GET", "/v1/testing/rounds/{roundId}", "Chi tiết đợt test").input(byRound).output(testRoundDetail),
    create: route("POST", "/v1/testing/projects/{projectKey}/rounds", "Tạo đợt test")
      .input(testRoundCreateInput)
      .output(testRoundDetail),
    createNext: route("POST", "/v1/testing/rounds/{fromRoundId}/next", "Tạo đợt tiếp theo từ đợt cũ")
      .input(testRoundCreateNextInput)
      .output(testRoundDetail),
    assign: route("POST", "/v1/testing/rounds/{roundId}/assign", "Giao test case cho người test")
      .input(testRoundAssignInput)
      .output(testRoundDetail),
    record: route("POST", "/v1/testing/round-cases/{roundCaseId}/result", "Ghi kết quả test tay")
      .errors({ CONFLICT: { message: orgErrors.CONFLICT.message, data: qaRecordConflictData } })
      .input(testRecordInput)
      .output(testRoundCase),
    history: route("GET", "/v1/testing/round-cases/{roundCaseId}/history", "Lịch sử sửa kết quả test tay")
      .input(byRoundCase)
      .output(z.object({ items: z.array(testResultHistoryItem) })),
    close: route("POST", "/v1/testing/rounds/{roundId}/close", "Đóng đợt test").input(byRound).output(testRound),
    reopen: route("POST", "/v1/testing/rounds/{roundId}/reopen", "Mở lại đợt test")
      .input(
        z.object({
          roundId: id,
          reason: z.string().trim().min(10, "Lý do cần ít nhất 10 ký tự.").max(500, "Lý do dài tối đa 500 ký tự."),
        }),
      )
      .output(testRound),
    deleteNote: route("DELETE", "/v1/testing/round-cases/{roundCaseId}/note", "Xoá ghi chú và lịch sử ghi chú")
      .input(byRoundCase)
      .output(ok),
    export: route("POST", "/v1/testing/rounds/export", "Xuất kết quả đợt ra CSV")
      .input(z.object({ roundId: id }))
      .output(z.file()),
  },
  myWork: {
    list: route("GET", "/v1/testing/my-work", "Test case được giao cho tôi")
      .input(z.object({ projectKey: projectKey.optional(), ...page }))
      .output(list(testMyWorkItem)),
  },
  dashboard: {
    overview: route("GET", "/v1/testing/projects/{projectKey}/dashboard/overview", "Tổng quan kiểm thử của dự án")
      .input(byProject)
      .output(testDashboardOverview),
    areas: route("GET", "/v1/testing/projects/{projectKey}/dashboard/areas", "Kết quả theo khu chức năng")
      .input(byProject)
      .output(z.object({ items: z.array(testDashboardArea) })),
    requirements: route("GET", "/v1/testing/projects/{projectKey}/dashboard/requirements", "Kết quả theo mã yêu cầu")
      .input(z.object({ projectKey, ...page }))
      .output(list(testDashboardRequirement)),
    trend: route("GET", "/v1/testing/projects/{projectKey}/dashboard/trend", "Xu hướng tỉ lệ đạt trên nhánh tham chiếu")
      .input(
        z.object({
          projectKey,
          sourceId: id.optional(),
          areaCode: testAreaCode.optional(),
          days: z.coerce.number().int().min(1).max(QA_TREND_DAYS).default(QA_TREND_DAYS),
        }),
      )
      .output(z.object({ points: z.array(testTrendPoint) })),
    flaky: route("GET", "/v1/testing/projects/{projectKey}/dashboard/flaky", "Test case chập chờn")
      .input(byProject)
      .output(z.object({ items: z.array(testFlakyCase) })),
  },
};
