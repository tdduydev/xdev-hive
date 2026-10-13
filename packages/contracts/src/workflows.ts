import { z } from "zod";
import { orgRoute } from "./common.ts";
import { projectKey } from "./projects.ts";
import { checkCommand } from "./worker-protocol.ts";

/**
 * Quy trình duyệt (specs/004-review-workflows, specs/009-code-review-workflows, Workflows.dc.html). Một quy trình gồm
 * các giai đoạn, mỗi giai đoạn có các checkpoint (gate): AI tự kiểm, người duyệt, quy tắc tự động, cổng CI. Quy trình
 * áp cho một loại đối tượng (`subject`), chọn khi tạo và không đổi sau: đề xuất sửa tài liệu (`doc`, qua hết thì hub
 * lưu phiên bản) hoặc PR do run code mở (`code`, qua hết thì PR vào hàng merge).
 */
export const workflowSubject = z.enum(["doc", "code"]);
export type WorkflowSubject = z.output<typeof workflowSubject>;
export const DOC_PRESET_IDS = ["aidlc", "speckit", "bmad"] as const;
export const CODE_PRESET_IDS = ["code-basic", "code-strict", "code-fast"] as const;
export const workflowPreset = z.enum([...DOC_PRESET_IDS, "custom", ...CODE_PRESET_IDS]);
export type WorkflowPreset = z.output<typeof workflowPreset>;
export type CodeWorkflowPreset = (typeof CODE_PRESET_IDS)[number];
export const gateKind = z.enum(["ai", "human", "rule", "ext"]);
export type GateKind = z.output<typeof gateKind>;
/** `team-ba`: vai trò BA/PO của đội (specs/011 FR-061), được chọn làm người duyệt tài liệu. */
export const reviewerRole = z.enum(["org-admin", "team-admin", "team-member", "team-ba"]);
export type ReviewerRole = z.output<typeof reviewerRole>;
/**
 * Quy tắc theo loại: `sections`, `requirements` chỉ cho tài liệu; `command`… chỉ cho code; hai cái giữa dùng chung.
 * `no-open-questions`, `breakdown`, `coverage` là của tài liệu hạng mục AI SDLC (specs/011 FR-017).
 */
export const DOC_RULE_CHECKS = [
  "sections",
  "requirements",
  "no-secrets",
  "max-diff",
  "no-open-questions",
  "breakdown",
  "coverage",
] as const;
export const CODE_RULE_CHECKS = [
  "command",
  "max-files",
  "deny-paths",
  "max-diff",
  "no-secrets",
  "agent-report",
] as const;
export const ruleCheck = z.enum([
  "sections",
  "requirements",
  "no-secrets",
  "max-diff",
  "command",
  "max-files",
  "deny-paths",
  "agent-report",
  "no-open-questions",
  "breakdown",
  "coverage",
]);
export type RuleCheck = z.output<typeof ruleCheck>;
export const rejectRoute = z.enum(["author", "agent", "previous"]);
export type RejectRoute = z.output<typeof rejectRoute>;
export const passAction = z.enum(["next", "task", "baseline"]);

const shortText = (max: number) => z.string().trim().min(1).max(max);
/** Glob đường dẫn hoặc nhánh theo `matchGlob` (glob.ts). */
const glob = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[^\\]+$/, "Glob dùng dấu / thay cho dấu \\.");
const taskType = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, "Loại task gồm chữ thường, số và gạch ngang.");
/** CLI làm reviewer AI cho code. Antigravity chưa có chế độ review chỉ đọc nên không nằm ở đây. */
export const reviewerCli = z.enum(["claude", "codex", "gemini"]);
export type ReviewerCli = z.output<typeof reviewerCli>;
export const findingSeverity = z.enum(["critical", "major", "minor", "info"]);
export type FindingSeverity = z.output<typeof findingSeverity>;

export const gateConditions = z.object({
  /** Loại tài liệu: đoạn cuối của key (`prd`, `design`…) bằng hoặc bắt đầu bằng `<loại>-`. Rỗng là mọi loại. */
  docTypes: z.array(shortText(40)).max(20).default([]),
  /** Chỉ chạy khi nội dung mới có một trong các từ khoá (không phân biệt hoa thường). */
  keywords: z.array(shortText(60)).max(20).default([]),
  /** Chỉ chạy khi số dòng thêm và xoá so với baseline từ ngưỡng này trở lên. */
  minChangedLines: z.number().int().min(1).max(100_000).nullable().default(null),
  /** Bỏ qua khi thay đổi chỉ là khoảng trắng, dấu câu, định dạng Markdown. */
  skipFormattingOnly: z.boolean().default(false),
  // Hai điều kiện dưới chỉ cho quy trình code; để optional (không default) để quy trình tài liệu đã lưu parse ra y cũ.
  /** Chỉ chạy khi diff đụng một trong các glob này. */
  paths: z.array(glob).max(50).optional(),
  /** Chỉ chạy với task thuộc một trong các loại này. */
  taskTypes: z.array(taskType).max(20).optional(),
});
export type GateConditions = z.output<typeof gateConditions>;

export const reviewGate = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "Mã checkpoint gồm chữ thường, số và -."),
  name: shortText(120),
  kind: gateKind,
  /** Gate người duyệt: người cụ thể và/hoặc vai trò; `quorum` 0 là mọi người được chỉ định phải duyệt. */
  reviewers: z
    .object({
      users: z.array(z.string().min(1).max(200)).max(50).default([]),
      roles: z.array(reviewerRole).max(3).default([]),
      /** Đội (vd. Pháp chế): thành viên và quản trị của đội được duyệt. */
      teams: z.array(z.uuid()).max(20).default([]),
      quorum: z.number().int().min(0).max(50).default(1),
      /** Quy trình code: chủ run code (người giao việc) cũng được quyết. Tắt theo nguyên tắc bốn mắt (Q2). */
      allowRequester: z.boolean().optional(),
      /**
       * Đội mà `roles` được tính trong đó thay cho đội của tài liệu. Chỉ hub điền khi dựng cổng theo đội của hạng mục
       * AI SDLC (specs/011 D21); quy trình và chế độ người sửa không được đặt.
       */
      teamScope: z.uuid().optional(),
    })
    .optional(),
  /** Gate quy tắc. */
  rules: z.array(ruleCheck).max(8).optional(),
  /** Tiêu đề mục bắt buộc cho quy tắc `sections`. */
  sections: z.array(shortText(120)).max(30).optional(),
  maxDiffLines: z.number().int().min(1).max(100_000).optional(),
  /** Quy tắc `command`: worker chạy trong worktree của run code sau khi agent xong. */
  commands: z.array(checkCommand).min(1).max(5).optional(),
  /** Quy tắc `max-files`. */
  maxFiles: z.number().int().min(1).max(10_000).optional(),
  /** Quy tắc `deny-paths`: diff không được đụng các glob này. */
  denyPaths: z.array(glob).min(1).max(50).optional(),
  /** Gate AI: agent đọc tài liệu (hoặc diff của PR) và chấm theo danh sách kiểm (rubric). */
  ai: z
    .object({
      checks: z.array(shortText(300)).min(1).max(20),
      passScore: z.number().min(0).max(10),
      /** Model agent dùng khi kiểm; bỏ trống là model review của dự án. Chính sách agent của tổ chức vẫn áp. */
      model: z.string().trim().min(1).max(200).optional(),
      // Các trường dưới chỉ cho quy trình code; optional để quy trình tài liệu đã lưu không đổi. Hub tự điền mặc định.
      /** Mỗi reviewer là một run review chạy song song. */
      reviewers: z
        .array(z.object({ cli: reviewerCli, model: z.string().trim().min(1).max(200).optional() }))
        .min(1)
        .max(3)
        .optional(),
      /** `all` (mặc định): mọi reviewer đạt `passScore`; `avg`: điểm trung bình đạt. */
      aggregate: z.enum(["all", "avg"]).optional(),
      /** Có phát hiện từ mức này trở lên thì không đạt dù đủ điểm; null hoặc bỏ trống là không chặn. */
      blockOn: z.enum(["critical", "major"]).nullable().optional(),
      /** `team` (mặc định): run của đội trên máy dùng chung; `requester`: chủ là chủ run code gốc. */
      runner: z.enum(["team", "requester"]).optional(),
    })
    .optional(),
  /**
   * Gate CI: tài liệu xét nhánh chính của repo dự án, code xét commit đầu của PR. `whenNone` (chỉ code, mặc định
   * `pass`): kết quả khi repo không có CI.
   */
  ext: z.object({ check: z.literal("ci"), whenNone: z.enum(["pass", "fail"]).optional() }).optional(),
  conditions: gateConditions.default({ docTypes: [], keywords: [], minChangedLines: null, skipFormattingOnly: false }),
  slaHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 30)
    .nullable()
    .default(null),
  onReject: rejectRoute.default("author"),
  /** Khi đạt: sang gate kế, hoặc tạo việc cho agent của bước sau rồi sang gate kế, hoặc chốt luôn. */
  onPass: passAction.default("next"),
  /** Tiêu đề việc tạo cho bước sau khi `onPass` là `task`; `{title}` là tiêu đề tài liệu. */
  nextTaskTitle: shortText(200).optional(),
});
export type ReviewGate = z.output<typeof reviewGate>;
export type ReviewGateInput = z.input<typeof reviewGate>;

export const reviewPhase = z.object({
  name: shortText(80),
  description: z.string().trim().max(300).optional(),
  /** Tài liệu đầu ra của giai đoạn, chỉ để hiện. */
  outputs: z.array(shortText(80)).max(10).default([]),
  gates: z.array(reviewGate).min(1).max(20),
});
export type ReviewPhase = z.output<typeof reviewPhase>;

/** Tiền tố key tài liệu mà quy trình áp, ví dụ `project/payment-api/prd` hay `org/`. */
const docPrefix = z
  .string()
  .trim()
  .min(3)
  .max(200)
  .regex(
    /^(?:org|team\/[a-z0-9-]+|project\/[a-z0-9-]+)(?:\/[a-z0-9._/-]*)?$/,
    "Tiền tố có dạng org/…, team/<đội>/…, project/<dự án>/….",
  );

/**
 * Phạm vi kích hoạt của quy trình code (FR-002). Danh sách rỗng là không lọc theo tiêu chí đó; `baseBranches` rỗng là
 * nhánh mặc định của dự án.
 */
export const codeScope = z.object({
  projects: z.array(projectKey).max(50).default([]),
  baseBranches: z.array(glob).max(20).default([]),
  taskTypes: z.array(taskType).max(20).default([]),
  paths: z.array(glob).max(50).default([]),
});
export type CodeScope = z.output<typeof codeScope>;

/** Việc sau khi đạt và vòng sửa (FR-025…FR-027). Phiên chụp lại các giá trị này lúc mở. */
export const codeOptions = z.object({
  /** `project`: theo `merge.mode` của dự án; `auto`: vào hàng merge; `manual`: chờ người bấm. */
  merge: z.enum(["project", "auto", "manual"]).default("project"),
  maxAgentRevisions: z.number().int().min(0).max(5).default(2),
  dismissStaleApprovals: z.boolean().default(false),
});
export type CodeOptions = z.output<typeof codeOptions>;

/** Cột `review_workflows.code`: phạm vi và tuỳ chọn gộp một khối; null với quy trình tài liệu. */
export const codeWorkflow = z.object({ ...codeScope.shape, ...codeOptions.shape });
export type CodeWorkflow = z.output<typeof codeWorkflow>;
export type CodeWorkflowInput = z.input<typeof codeWorkflow>;

const DOC_ONLY_RULES = new Set<RuleCheck>(
  DOC_RULE_CHECKS.filter((r) => !(CODE_RULE_CHECKS as readonly string[]).includes(r)),
);
const CODE_ONLY_RULES = new Set<RuleCheck>(
  CODE_RULE_CHECKS.filter((r) => !(DOC_RULE_CHECKS as readonly string[]).includes(r)),
);
const isCodePreset = (p: WorkflowPreset) => (CODE_PRESET_IDS as readonly string[]).includes(p);

type Issue = (message: string, path: (string | number)[]) => void;

/** Checkpoint dùng đúng loại quy tắc và trường của quy trình (FR-004). */
function checkGateSubject(subject: WorkflowSubject, g: ReviewGate, path: (string | number)[], issue: Issue) {
  if (subject === "doc") {
    if (g.rules?.some((r) => CODE_ONLY_RULES.has(r))) issue("Quy tắc này chỉ dùng cho code.", [...path, "rules"]);
    if (g.ai?.reviewers || g.commands || g.maxFiles || g.denyPaths || g.conditions.paths || g.conditions.taskTypes)
      issue(`Checkpoint “${g.name}” có cấu hình chỉ dùng cho code.`, path);
    return;
  }
  if (g.rules?.some((r) => DOC_ONLY_RULES.has(r))) issue("Quy tắc này chỉ dùng cho tài liệu.", [...path, "rules"]);
  if (g.conditions.docTypes.length || g.conditions.keywords.length || g.conditions.skipFormattingOnly)
    issue("Điều kiện loại tài liệu, từ khoá, định dạng chỉ dùng cho tài liệu.", [...path, "conditions"]);
  if (g.onPass !== "next") issue("Checkpoint của quy trình code chỉ sang checkpoint kế khi đạt.", [...path, "onPass"]);
  if (g.kind === "ai" && g.ai && !g.ai.reviewers)
    issue(`Checkpoint “${g.name}” cần 1–3 reviewer AI.`, [...path, "ai", "reviewers"]);
  if (g.kind === "ai" && g.ai?.model) issue("Chọn model theo từng reviewer.", [...path, "ai", "model"]);
  if (g.rules?.includes("command") && !g.commands)
    issue(`Checkpoint “${g.name}” cần lệnh kiểm.`, [...path, "commands"]);
  if (g.rules?.includes("max-files") && !g.maxFiles)
    issue(`Checkpoint “${g.name}” cần số file tối đa.`, [...path, "maxFiles"]);
  if (g.rules?.includes("deny-paths") && !g.denyPaths)
    issue(`Checkpoint “${g.name}” cần đường dẫn cấm.`, [...path, "denyPaths"]);
}

export const workflowInput = z
  .object({
    id: z.uuid().optional(),
    name: shortText(120),
    preset: workflowPreset,
    /** Loại đối tượng; cố định sau khi tạo. Client cũ không gửi là tài liệu. */
    subject: workflowSubject.default("doc"),
    /** Đội sở hữu quy trình; null là quy trình của tổ chức. */
    teamId: z.uuid().nullable(),
    /** Ít nhất một với tài liệu, rỗng với code. */
    docPrefixes: z.array(docPrefix).max(20),
    /** Bắt buộc với code, null với tài liệu. */
    code: codeWorkflow.nullable().default(null),
    phases: z.array(reviewPhase).min(1).max(10),
    enabled: z.boolean(),
  })
  .superRefine((w, ctx) => {
    const issue: Issue = (message, path) => ctx.addIssue({ code: "custom", message, path });
    const ids = w.phases.flatMap((p) => p.gates.map((g) => g.id));
    if (new Set(ids).size !== ids.length) issue("Mã checkpoint trùng nhau.", ["phases"]);
    if (w.subject === "doc") {
      if (!w.docPrefixes.length) issue("Cần ít nhất một tiền tố tài liệu.", ["docPrefixes"]);
      if (w.code) issue("Quy trình tài liệu không có phạm vi code.", ["code"]);
      if (isCodePreset(w.preset)) issue("Khung mẫu này dành cho quy trình code.", ["preset"]);
    } else {
      if (!w.code) issue("Quy trình code cần phạm vi kích hoạt.", ["code"]);
      if (w.docPrefixes.length) issue("Quy trình code không dùng tiền tố tài liệu.", ["docPrefixes"]);
      if (w.preset !== "custom" && !isCodePreset(w.preset)) issue("Khung mẫu này dành cho tài liệu.", ["preset"]);
    }
    for (const [pi, p] of w.phases.entries()) {
      for (const [gi, g] of p.gates.entries()) {
        const path = ["phases", pi, "gates", gi];
        if (
          g.kind === "human" &&
          !(g.reviewers && (g.reviewers.users.length || g.reviewers.roles.length || g.reviewers.teams.length))
        )
          issue(`Checkpoint “${g.name}” cần người duyệt.`, path);
        if (g.kind === "rule" && !g.rules?.length) issue(`Checkpoint “${g.name}” cần ít nhất một quy tắc.`, path);
        if (g.kind === "ai" && !g.ai) issue(`Checkpoint “${g.name}” cần danh sách AI kiểm.`, path);
        if (g.reviewers?.teamScope) issue("Đội của người duyệt do hub điền, không đặt trong quy trình.", path);
        checkGateSubject(w.subject, g, path, issue);
      }
    }
  });
export type WorkflowInput = z.input<typeof workflowInput>;

export const reviewWorkflow = z.object({
  id: z.uuid(),
  name: z.string(),
  preset: workflowPreset,
  // Mặc định để hub chưa có cột `subject` (trước migration của spec 009) vẫn trả đúng hợp đồng.
  subject: workflowSubject.default("doc"),
  teamId: z.uuid().nullable(),
  docPrefixes: z.array(z.string()),
  code: codeWorkflow.nullable().default(null),
  phases: z.array(reviewPhase),
  enabled: z.boolean(),
  updatedAt: z.iso.datetime(),
  updatedBy: z.string().nullable(),
  /** Số phiên duyệt đang chạy theo quy trình này. */
  inFlight: z.number().int(),
});
export type ReviewWorkflow = z.output<typeof reviewWorkflow>;

// ---- Phiên duyệt ----------------------------------------------------------------------------------------------

export const reviewStatus = z.enum(["in_review", "changes_requested", "approved", "cancelled"]);
export type ReviewStatus = z.output<typeof reviewStatus>;
export const gateRunStatus = z.enum(["waiting", "passed", "failed", "skipped"]);
export const slaState = z.enum(["overdue", "due-soon", "on-time", "none"]);
export type SlaState = z.output<typeof slaState>;

export const checklistItem = z.object({ label: z.string(), passed: z.boolean(), note: z.string().nullable() });
export type ChecklistItem = z.output<typeof checklistItem>;

export const gateRun = z.object({
  gateId: z.string(),
  name: z.string(),
  kind: gateKind,
  phase: z.string(),
  status: gateRunStatus,
  score: z.number().nullable(),
  checklist: z.array(checklistItem),
  /** Người đã duyệt ở gate này (gate cần nhiều người). */
  approvals: z.array(z.object({ userId: z.string(), name: z.string(), at: z.iso.datetime() })),
  note: z.string().nullable(),
  decidedBy: z.string().nullable(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  /** Run agent của gate AI. */
  runId: z.uuid().nullable(),
  /** Checkpoint người do hub tự duyệt (specs/011 D25): điểm review AI, ngưỡng hiệu lực, dòng tự duyệt để thu hồi. */
  auto: z.object({ score: z.number(), threshold: z.number(), approvalId: z.uuid() }).optional(),
});
export type GateRun = z.output<typeof gateRun>;

export const reviewSummary = z.object({
  id: z.uuid(),
  proposalId: z.uuid(),
  docKey: z.string(),
  docTitle: z.string(),
  docType: z.string(),
  workflowId: z.uuid(),
  workflowName: z.string(),
  status: reviewStatus,
  /** Gate đang chờ; null khi đã xong. */
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
  author: z.object({ userId: z.string().nullable(), runId: z.uuid().nullable(), name: z.string() }),
  /** Người gọi đang được chờ duyệt ở gate hiện tại. */
  awaitingMe: z.boolean(),
  aiScore: z.number().nullable(),
  addedLines: z.number().int(),
  deletedLines: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ReviewSummary = z.output<typeof reviewSummary>;

export const requirementTrace = z.object({
  id: z.string(),
  text: z.string(),
  /** Tiêu chí chấp nhận tìm thấy cho yêu cầu này. */
  acceptance: z.array(z.string()),
  /** Task của dự án có nhắc tới mã yêu cầu. */
  tasks: z.array(z.object({ key: z.string(), title: z.string(), status: z.string() })),
});
export type RequirementTrace = z.output<typeof requirementTrace>;

export const reviewDetail = reviewSummary.extend({
  baseVersion: z.number().int(),
  baseContent: z.string(),
  content: z.string(),
  reason: z.string().nullable(),
  gates: z.array(gateRun),
  trace: z.array(requirementTrace),
  /** Người gọi được quyết ở gate hiện tại. */
  canDecide: z.boolean(),
  /** Gate trước gate hiện tại có người duyệt: đích của "về checkpoint trước". */
  previousGate: z.string().nullable(),
  /** Cấu hình của gate đang chờ (người duyệt, số người cần, hướng trả lại mặc định); null khi phiên đã xong. */
  currentGate: reviewGate.nullable(),
});
export type ReviewDetail = z.output<typeof reviewDetail>;

export const reviewListInput = z.object({
  /** `mine`: chờ tôi duyệt; `all`: mọi phiên tôi thấy. */
  scope: z.enum(["mine", "all"]).default("mine"),
  status: reviewStatus.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(200).optional(),
});

export const reviewDecideInput = z
  .object({
    id: z.uuid(),
    decision: z.enum(["approve", "changes"]),
    note: z.string().trim().max(4000).optional(),
    route: rejectRoute.optional(),
  })
  .refine((d) => d.decision === "approve" || !!d.note, {
    message: "Ghi góp ý khi trả lại.",
    path: ["note"],
  });
export type ReviewDecideInput = z.input<typeof reviewDecideInput>;

export const dryRunInput = z.object({ workflow: workflowInput, docKey: z.string().min(1).max(200) });
export const dryRunResult = z.object({
  docKey: z.string(),
  docType: z.string(),
  matched: z.boolean(),
  gates: z.array(
    z.object({
      gateId: z.string(),
      name: z.string(),
      kind: gateKind,
      runs: z.boolean(),
      reason: z.string(),
      checklist: z.array(checklistItem),
    }),
  ),
});
export type DryRunResult = z.output<typeof dryRunResult>;

export const workflowListInput = z.object({ subject: workflowSubject.optional() }).optional();

export const workflowsContract = {
  list: orgRoute("GET", "/v1/review-workflows", "Quy trình duyệt tài liệu và code", "reviews")
    .input(workflowListInput)
    .output(z.array(reviewWorkflow)),
  save: orgRoute("POST", "/v1/review-workflows", "Tạo hoặc sửa quy trình duyệt", "reviews")
    .input(workflowInput)
    .output(reviewWorkflow),
  remove: orgRoute("POST", "/v1/review-workflows/remove", "Xoá quy trình duyệt", "reviews")
    .input(z.object({ id: z.uuid() }))
    .output(z.object({ ok: z.literal(true) })),
  dryRun: orgRoute("POST", "/v1/review-workflows/dry-run", "Chạy thử quy trình trên một tài liệu", "reviews")
    .input(dryRunInput)
    .output(dryRunResult),
};

export const reviewsContract = {
  list: orgRoute("GET", "/v1/reviews", "Phiên duyệt tài liệu", "reviews")
    .input(reviewListInput)
    .output(z.object({ items: z.array(reviewSummary), nextCursor: z.string().nullable() })),
  get: orgRoute("GET", "/v1/reviews/item", "Chi tiết phiên duyệt", "reviews")
    .input(z.object({ id: z.uuid() }))
    .output(reviewDetail),
  decide: orgRoute("POST", "/v1/reviews/decide", "Duyệt hoặc trả lại ở checkpoint hiện tại", "reviews")
    .input(reviewDecideInput)
    .output(reviewDetail),
};

// ---- Khung mẫu -------------------------------------------------------------------------------------------------

const human = (
  id: string,
  name: string,
  roles: z.input<typeof reviewerRole>[],
  slaHours: number | null,
  extra: Partial<ReviewGateInput> = {},
): ReviewGateInput => ({
  id,
  name,
  kind: "human",
  reviewers: { users: [], roles, quorum: 1 },
  slaHours,
  ...extra,
});
const ai = (id: string, name: string, checks: string[], extra: Partial<ReviewGateInput> = {}): ReviewGateInput => ({
  id,
  name,
  kind: "ai",
  ai: { checks, passScore: 7 },
  slaHours: null,
  ...extra,
});

/** Khung mẫu tài liệu theo AI-DLC, Spec Kit, BMAD (Workflows.dc.html). Quản trị chọn rồi sửa người duyệt, điều kiện. */
const DOC_PRESET_PHASES: Record<(typeof DOC_PRESET_IDS)[number], z.input<typeof reviewPhase>[]> = {
  aidlc: [
    {
      name: "Inception",
      outputs: ["PRD", "stories.md"],
      gates: [
        ai("ai-prd", "AI kiểm đủ mục PRD", [
          "Đủ mục theo mẫu PRD",
          "Mỗi yêu cầu có mã R-n và tiêu chí chấp nhận",
          "Không mâu thuẫn với tài liệu đã chốt",
          "Không có dữ liệu nhạy cảm",
        ]),
        human("po", "Product owner duyệt", ["team-admin"], 24),
        human("legal", "Pháp chế", ["org-admin"], 48, {
          conditions: {
            docTypes: [],
            keywords: ["phí", "hoàn tiền", "fee", "refund"],
            minChangedLines: null,
            skipFormattingOnly: false,
          },
        }),
      ],
    },
    {
      name: "Construction",
      outputs: ["design.md", "ADR", "tasks.md"],
      gates: [
        human("design", "Kiến trúc sư duyệt thiết kế", ["team-admin"], 24),
        { id: "trace", name: "Truy vết R-n → tiêu chí", kind: "rule", rules: ["requirements"], slaHours: null },
      ],
    },
    {
      name: "Operations",
      outputs: ["runbook.md", "release-notes"],
      gates: [
        { id: "ci", name: "CI của repo xanh", kind: "ext", ext: { check: "ci" }, slaHours: null },
        human("ops", "Trực vận hành duyệt runbook", ["team-admin"], 24, { onPass: "baseline" }),
      ],
    },
  ],
  speckit: [
    { name: "Specify", outputs: ["spec.md"], gates: [human("po", "Duyệt spec", ["team-admin"], 24)] },
    {
      name: "Plan",
      outputs: ["plan.md"],
      gates: [
        ai("ai-plan", "AI đối chiếu constitution", [
          "Plan tuân theo các nguyên tắc trong constitution",
          "Không có ràng buộc mâu thuẫn",
        ]),
        human("design", "Duyệt plan", ["team-admin"], 24),
      ],
    },
    {
      name: "Tasks",
      outputs: ["tasks.md"],
      gates: [{ id: "trace", name: "Mọi yêu cầu có tiêu chí", kind: "rule", rules: ["requirements"], slaHours: null }],
    },
  ],
  bmad: [
    {
      name: "Analysis · PM",
      outputs: ["brief.md", "prd.md"],
      gates: [human("po", "Review gate #1: PRD", ["team-admin"], 24)],
    },
    {
      name: "Architect · UX",
      outputs: ["architecture.md"],
      gates: [
        human("design", "Review gate #2: kiến trúc", ["team-admin"], 24),
        ai("ai-arch", "AI so PRD ↔ kiến trúc", ["Kiến trúc đáp ứng mọi yêu cầu của PRD"]),
      ],
    },
    {
      name: "Scrum master · Dev",
      outputs: ["stories/*.md"],
      gates: [human("plan", "Story sẵn sàng", ["team-member"], 8)],
    },
  ],
};

/** Rubric mặc định của checkpoint AI cho code; khung mẫu và "Tạo từ cấu hình dự án" dùng chung. */
export const CODE_REVIEW_RUBRIC = [
  "Thay đổi làm đúng yêu cầu của task, không thừa",
  "Có test cho hành vi mới hoặc đã sửa",
  "Không có lỗi bảo mật, không lộ bí mật",
  "Code dễ đọc và theo quy ước của repo",
];

const codeRules = (rules: RuleCheck[], extra: Partial<ReviewGateInput> = {}): ReviewGateInput => ({
  id: "rules",
  name: "Quy tắc tự động",
  kind: "rule",
  rules,
  slaHours: null,
  onReject: "agent",
  ...extra,
});
const codeAi = (
  reviewers: { cli: ReviewerCli }[],
  passScore: number,
  extra: Partial<NonNullable<ReviewGateInput["ai"]>> = {},
): ReviewGateInput => ({
  id: "ai-review",
  name: "Review AI",
  kind: "ai",
  ai: { checks: CODE_REVIEW_RUBRIC, passScore, reviewers, ...extra },
  slaHours: null,
  onReject: "agent",
});
const ci = (whenNone: "pass" | "fail"): ReviewGateInput => ({
  id: "ci",
  name: "CI trên commit đầu của PR",
  kind: "ext",
  ext: { check: "ci", whenNone },
  slaHours: null,
  onReject: "agent",
});

/** Khung mẫu code (FR-008): Cơ bản, Chặt, Làn nhanh. Phạm vi để quản trị tự điền. */
export const CODE_WORKFLOW_PRESETS: Record<CodeWorkflowPreset, z.input<typeof reviewPhase>[]> = {
  "code-basic": [
    { name: "Kiểm tự động", gates: [codeRules(["no-secrets", "max-diff"], { maxDiffLines: 1500 })] },
    { name: "Review AI", gates: [codeAi([{ cli: "claude" }], 7)] },
    { name: "Người duyệt", gates: [human("reviewer", "Thành viên đội duyệt", ["team-member"], 24)] },
  ],
  "code-strict": [
    {
      name: "Kiểm tự động",
      gates: [codeRules(["no-secrets", "max-diff", "max-files", "agent-report"], { maxDiffLines: 1000, maxFiles: 50 })],
    },
    {
      name: "Review AI",
      gates: [codeAi([{ cli: "claude" }, { cli: "codex" }], 8, { aggregate: "all", blockOn: "major" })],
    },
    { name: "CI", gates: [ci("fail")] },
    {
      name: "Người duyệt",
      gates: [
        human("reviewer", "Hai thành viên đội duyệt", ["team-member"], 24, {
          reviewers: { users: [], roles: ["team-member"], quorum: 2 },
        }),
      ],
    },
  ],
  "code-fast": [
    {
      name: "Máy kiểm",
      gates: [codeRules(["no-secrets", "max-diff"], { maxDiffLines: 300 }), codeAi([{ cli: "claude" }], 7), ci("pass")],
    },
    {
      name: "Người duyệt",
      gates: [human("reviewer", "Duyệt khi đổi nhiều", ["team-member"], 8, { conditions: { minChangedLines: 200 } })],
    },
  ],
};

/** Mọi khung mẫu theo mã, để client chỉ cần tra một bảng. */
export const WORKFLOW_PRESETS: Record<Exclude<WorkflowPreset, "custom">, z.input<typeof reviewPhase>[]> = {
  ...DOC_PRESET_PHASES,
  ...CODE_WORKFLOW_PRESETS,
};

/** Loại đối tượng của khung mẫu; `custom` dùng được cho cả hai. */
export function presetSubject(preset: WorkflowPreset): WorkflowSubject | null {
  if (preset === "custom") return null;
  return isCodePreset(preset) ? "code" : "doc";
}
