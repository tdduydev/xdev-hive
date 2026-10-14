import { z } from "zod";
import { id, orgRoute } from "./common.ts";
import { type OutcomeCheck, type ProjectSettings, projectKey } from "./projects.ts";
import { checkCommandResult } from "./worker-protocol.ts";
import {
  CODE_REVIEW_RUBRIC,
  checklistItem,
  findingSeverity,
  gateKind,
  gateRunStatus,
  type ReviewGateInput,
  rejectRoute,
  reviewerCli,
  reviewGate,
  type reviewPhase,
  slaState,
  workflowInput,
} from "./workflows.ts";

/**
 * Phiên review code (specs/009-code-review-workflows): một vòng review của một PR do run code mở, ở một `headSha`, theo
 * bản chụp của quy trình `subject = 'code'` lúc mở. Commit mới trên nhánh PR đóng phiên (`superseded`) và mở vòng sau.
 */
export const codeReviewStatus = z.enum([
  "in_review",
  "changes_requested",
  "approved",
  "merged",
  "cancelled",
  "superseded",
]);
export type CodeReviewStatus = z.output<typeof codeReviewStatus>;

const sha = z.string().regex(/^[0-9a-f]{40,64}$/, "SHA commit không hợp lệ.");

export const codeReviewFinding = z.object({
  file: z.string(),
  line: z.number().int().positive().nullable(),
  severity: findingSeverity,
  message: z.string(),
});
export type CodeReviewFinding = z.output<typeof codeReviewFinding>;

/** Kết quả của một reviewer AI (một run `review`). */
export const aiReviewerResult = z.object({
  cli: reviewerCli,
  model: z.string().nullable(),
  runId: id.nullable(),
  /** `waiting_machine`: chưa có máy dùng chung có CLI này (ADR 0017); `error`: run lỗi, bị huỷ hoặc không nộp. */
  state: z.enum(["queued", "waiting_machine", "running", "done", "error"]),
  score: z.number().nullable(),
  /** Reviewer này đạt theo `passScore` và `blockOn`; null khi chưa có kết quả. */
  passed: z.boolean().nullable(),
  summary: z.string().nullable(),
  findings: z.array(codeReviewFinding),
  /** Kết quả từng mục rubric khi agent nộp `checklist` qua `review_submit`. */
  checklist: z.array(checklistItem),
  error: z.string().nullable(),
});
export type AiReviewerResult = z.output<typeof aiReviewerResult>;

export const codeReviewCi = z.object({
  state: z.enum(["success", "pending", "failure", "none"]),
  url: z.string().nullable(),
});

export const codeGateRun = z.object({
  gateId: z.string(),
  name: z.string(),
  kind: gateKind,
  phase: z.string(),
  index: z.number().int(),
  /** Checkpoint chưa tới lượt: `waiting` với `startedAt` null. */
  status: gateRunStatus,
  score: z.number().nullable(),
  checklist: z.array(checklistItem),
  approvals: z.array(z.object({ userId: z.string(), name: z.string(), at: z.iso.datetime() })),
  /** Lý do bỏ qua, lý do chờ ("Máy chưa hỗ trợ chạy lệnh kiểm…"), góp ý khi trả lại hoặc lý do quyết thay. */
  note: z.string().nullable(),
  decidedBy: z.string().nullable(),
  /** Người có `reviews.override` đã quyết thay checkpoint tự động này. */
  overridden: z.boolean(),
  dueAt: z.iso.datetime().nullable(),
  sla: slaState,
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  reviewers: z.array(aiReviewerResult),
  commands: z.array(checkCommandResult),
  ci: codeReviewCi.nullable(),
});
export type CodeGateRun = z.output<typeof codeGateRun>;

export const codeReviewSummary = z.object({
  id,
  project: z.object({ id, key: z.string(), name: z.string() }),
  task: z.object({ id, key: z.string(), title: z.string() }).nullable(),
  pr: z.object({
    number: z.number().int(),
    url: z.string(),
    branch: z.string(),
    baseBranch: z.string(),
    headSha: z.string(),
  }),
  /** `id` null khi quy trình đã bị xoá; phiên vẫn chạy theo bản chụp. */
  workflow: z.object({ id: id.nullable(), name: z.string() }),
  status: codeReviewStatus,
  round: z.number().int().min(1),
  /** Checkpoint đang chờ; null khi phiên đã xong. */
  gate: z
    .object({
      id: z.string(),
      name: z.string(),
      kind: gateKind,
      phase: z.string(),
      index: z.number().int(),
      total: z.number().int(),
      dueAt: z.iso.datetime().nullable(),
      sla: slaState,
    })
    .nullable(),
  /** Chủ run code gốc (người giao việc); null khi run của đội. */
  requester: z.object({ userId: z.string(), name: z.string() }).nullable(),
  awaitingMe: z.boolean(),
  aiScore: z.number().nullable(),
  addedLines: z.number().int(),
  deletedLines: z.number().int(),
  changedFiles: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type CodeReviewSummary = z.output<typeof codeReviewSummary>;

export const codeReviewDetail = codeReviewSummary.extend({
  /** Run code tạo ra `headSha` của vòng này. */
  runId: id,
  /** Lý do `needs_review` của run code, hiện ở đầu phiên. */
  runReasons: z.array(z.string()),
  /** Hướng của lần trả lại gần nhất. */
  route: rejectRoute.nullable(),
  agentRevisions: z.number().int(),
  maxAgentRevisions: z.number().int(),
  /** Chế độ merge hiệu lực khi đạt (đã xét `merge` của quy trình và của dự án, `features.mergeQueue`). */
  mergeMode: z.enum(["auto", "manual"]),
  inMergeQueue: z.boolean(),
  gates: z.array(codeGateRun),
  /** Các vòng của cùng PR, mới nhất trước, gồm cả vòng này. */
  rounds: z.array(
    z.object({
      id,
      round: z.number().int(),
      headSha: z.string(),
      status: codeReviewStatus,
      runId: id,
      createdAt: z.iso.datetime(),
    }),
  ),
  /** Cấu hình của checkpoint đang chờ; null khi phiên đã xong. */
  currentGate: reviewGate.nullable(),
  /** Checkpoint người duyệt gần nhất phía trước: đích của "về checkpoint trước". */
  previousGate: z.string().nullable(),
  canDecide: z.boolean(),
  canOverride: z.boolean(),
  canEnqueue: z.boolean(),
  canRecheck: z.boolean(),
});
export type CodeReviewDetail = z.output<typeof codeReviewDetail>;

/** File của PR lấy từ nhà cung cấp Git, không lưu ở hub. */
export const prFile = z.object({
  path: z.string(),
  /** Đường dẫn cũ khi đổi tên. */
  previousPath: z.string().nullable(),
  status: z.enum(["added", "modified", "removed", "renamed"]),
  additions: z.number().int().min(0),
  deletions: z.number().int().min(0),
  /** Patch unified; null khi file nhị phân hoặc quá lớn. */
  patch: z.string().nullable(),
  /** Nhà cung cấp không trả đủ patch: web hiện link mở trên GitHub/GitLab. */
  truncated: z.boolean(),
});
export type PrFile = z.output<typeof prFile>;

export const codeReviewFiles = z.object({
  headSha: z.string(),
  files: z.array(prFile),
  /** PR có nhiều file hơn giới hạn đọc của hub (3 000). */
  truncated: z.boolean(),
});
export type CodeReviewFiles = z.output<typeof codeReviewFiles>;

export const codeReviewListInput = z.object({
  /** `mine`: chờ tôi duyệt; `all`: mọi phiên tôi thấy. */
  scope: z.enum(["mine", "all"]).default("mine"),
  status: codeReviewStatus.optional(),
  projectId: id.optional(),
  sla: z.enum(["overdue", "due-soon", "on-time"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(200).optional(),
});
export type CodeReviewListInput = z.input<typeof codeReviewListInput>;

export const codeReviewDecideInput = z
  .object({
    id,
    /** Đầu PR người duyệt đã xem; khác đầu hiện tại thì hub từ chối (FR-021). */
    headSha: sha,
    decision: z.enum(["approve", "changes"]),
    /** Nút chat gắn với lượt checkpoint đã thông báo, không quyết được lượt tiếp theo trên cùng SHA. */
    gateRunId: id.optional(),
    note: z.string().trim().max(4000).optional(),
    /** Bỏ trống là hướng mặc định của checkpoint. */
    route: rejectRoute.optional(),
  })
  .refine((d) => d.decision === "approve" || !!d.note, { message: "Ghi góp ý khi trả lại.", path: ["note"] });
export type CodeReviewDecideInput = z.input<typeof codeReviewDecideInput>;

export const codeReviewOverrideInput = z.object({
  id,
  headSha: sha,
  passed: z.boolean(),
  // `prefault` để thiếu ghi chú cũng ra đúng câu báo lỗi thay vì lỗi "bắt buộc" chung của zod.
  note: z.string().trim().min(1, "Ghi lý do khi quyết thay checkpoint tự động.").max(4000).prefault(""),
});
export type CodeReviewOverrideInput = z.input<typeof codeReviewOverrideInput>;

export const codeDryRunInput = z
  .object({ workflow: workflowInput, runId: id })
  .refine((d) => d.workflow.subject === "code", {
    message: "Chạy thử ở đây chỉ dành cho quy trình code.",
    path: ["workflow", "subject"],
  });
export type CodeDryRunInput = z.input<typeof codeDryRunInput>;

const workflowRef = z.object({ id: id.nullable(), name: z.string() });

export const codeDryRunResult = z.object({
  runId: id,
  project: z.object({ id, key: z.string(), name: z.string() }),
  pr: z.object({ number: z.number().int(), url: z.string() }).nullable(),
  /** Bản nháp khớp phạm vi của run này. */
  matched: z.boolean(),
  /** Vì sao khớp hoặc không (dự án, nhánh đích, loại task, đường dẫn). */
  reason: z.string(),
  /** Quy trình sẽ chạy cho run này khi lưu bản nháp; bản nháp chưa lưu có `id` null. */
  chosen: workflowRef.nullable(),
  /** Quy trình cũng khớp nhưng bị quy trình được chọn lấn (kém cụ thể hơn hoặc cũ hơn). */
  outranked: z.array(workflowRef),
  gates: z.array(
    z.object({
      gateId: z.string(),
      name: z.string(),
      kind: gateKind,
      phase: z.string(),
      runs: z.boolean(),
      reason: z.string(),
    }),
  ),
});
export type CodeDryRunResult = z.output<typeof codeDryRunResult>;

export const codeReviewsContract = {
  list: orgRoute("GET", "/v1/code-reviews", "Phiên review code", "code-reviews")
    .input(codeReviewListInput)
    .output(z.object({ items: z.array(codeReviewSummary), nextCursor: z.string().nullable() })),
  count: orgRoute("GET", "/v1/code-reviews/count", "Số PR đang chờ tôi duyệt", "code-reviews").output(
    z.object({ awaitingMe: z.number().int().nonnegative() }),
  ),
  get: orgRoute("GET", "/v1/code-reviews/item", "Chi tiết phiên review code", "code-reviews")
    .input(z.object({ id }))
    .output(codeReviewDetail),
  files: orgRoute("GET", "/v1/code-reviews/files", "File và patch của PR", "code-reviews")
    .input(z.object({ id }))
    .output(codeReviewFiles),
  decide: orgRoute("POST", "/v1/code-reviews/decide", "Duyệt hoặc trả lại PR ở checkpoint người duyệt", "code-reviews")
    .input(codeReviewDecideInput)
    .output(codeReviewDetail),
  override: orgRoute(
    "POST",
    "/v1/code-reviews/override",
    "Quyết thay checkpoint tự động (quyền reviews.override)",
    "code-reviews",
  )
    .input(codeReviewOverrideInput)
    .output(codeReviewDetail),
  enqueue: orgRoute("POST", "/v1/code-reviews/enqueue", "Đưa PR đã duyệt vào hàng merge", "code-reviews")
    .input(z.object({ id }))
    .output(codeReviewDetail),
  recheck: orgRoute("POST", "/v1/code-reviews/recheck", "Chạy lại checkpoint tự động hiện tại", "code-reviews")
    .input(z.object({ id }))
    .output(codeReviewDetail),
  dryRun: orgRoute("POST", "/v1/code-reviews/dry-run", "Chạy thử quy trình code trên một run", "code-reviews")
    .input(codeDryRunInput)
    .output(codeDryRunResult),
  workflowFromProject: orgRoute(
    "POST",
    "/v1/code-reviews/workflow-from-project",
    "Bản nháp quy trình code từ cấu hình dự án (chưa lưu)",
    "code-reviews",
  )
    .input(z.object({ projectKey }))
    .output(workflowInput),
};

type ReviewCheck = Extract<OutcomeCheck, { check: "review" }>;

/** Kiểm tra `review` của dự án: ở mặc định, hoặc chỉ ở vài loại task (khi đó quy trình chỉ áp cho các loại đó). */
function projectReview(settings: ProjectSettings): { check: ReviewCheck; taskTypes: string[] } | null {
  const isReview = (c: OutcomeCheck): c is ReviewCheck => c.check === "review";
  const inDefault = settings.outcome.default.find(isReview);
  if (inDefault) return { check: inDefault, taskTypes: [] };
  const byType = Object.entries(settings.outcome.byType).flatMap(([type, checks]) => {
    const c = checks.find(isReview);
    return c ? [{ type, check: c }] : [];
  });
  const first = byType[0];
  return first ? { check: first.check, taskTypes: byType.map((t) => t.type) } : null;
}

/**
 * Bản nháp quy trình code tương đương cấu hình hiện tại của dự án (FR-010): review chéo → checkpoint AI, `requireCi` →
 * checkpoint CI, `requiredApprovals` → checkpoint người duyệt. Các kiểm tra khác của chính sách kết quả vẫn chạy trước
 * phiên (D3) nên không chép sang. `teamId` để null; hub điền đội sở hữu dự án.
 */
export function outcomeToCodeWorkflow(settings: ProjectSettings, key: string): z.output<typeof workflowInput> {
  const phases: z.input<typeof reviewPhase>[] = [];
  const review = settings.features.crossReview ? projectReview(settings) : null;
  if (review) {
    const { by, minScore, when } = review.check;
    // `when` của review chéo là "đủ số dòng HOẶC đụng đường dẫn"; điều kiện checkpoint cộng dồn (VÀ). Có cả hai thì
    // bỏ điều kiện để thà review thừa còn hơn bỏ sót.
    const both = when?.minChangedLines !== undefined && when.paths !== undefined;
    const minChangedLines = !both && when?.minChangedLines ? when.minChangedLines : null;
    const paths = !both ? when?.paths : undefined;
    phases.push({
      name: "Review AI",
      gates: [
        {
          id: "ai-review",
          name: "Review AI",
          kind: "ai",
          ai: { checks: CODE_REVIEW_RUBRIC, passScore: minScore, reviewers: [{ cli: by }] },
          conditions: { minChangedLines, ...(paths ? { paths } : {}) },
          slaHours: null,
          onReject: "agent",
        },
      ],
    });
  }
  if (settings.merge.requireCi) {
    const gate: ReviewGateInput = {
      id: "ci",
      name: "CI trên commit đầu của PR",
      kind: "ext",
      ext: { check: "ci", whenNone: "fail" },
      slaHours: null,
      onReject: "agent",
    };
    phases.push({ name: "CI", gates: [gate] });
  }
  if (settings.merge.requiredApprovals > 0) {
    phases.push({
      name: "Người duyệt",
      gates: [
        {
          id: "reviewer",
          name: "Thành viên đội duyệt",
          kind: "human",
          reviewers: { users: [], roles: ["team-member"], quorum: settings.merge.requiredApprovals },
          slaHours: 24,
        },
      ],
    });
  }
  // Quy trình cần ít nhất một checkpoint; dự án không review, không CI, không cần người duyệt thì chỉ quét bí mật.
  if (!phases.length) {
    phases.push({
      name: "Kiểm tự động",
      gates: [{ id: "rules", name: "Quy tắc tự động", kind: "rule", rules: ["no-secrets"], slaHours: null }],
    });
  }
  return workflowInput.parse({
    name: `Review code ${key}`,
    preset: "custom",
    subject: "code",
    teamId: null,
    docPrefixes: [],
    code: { projects: [key], taskTypes: review?.taskTypes ?? [] },
    phases,
    enabled: true,
  });
}
