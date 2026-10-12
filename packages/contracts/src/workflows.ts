import { z } from "zod";
import { orgRoute } from "./common.ts";

/**
 * Quy trình duyệt tài liệu (specs/004-review-workflows, Workflows.dc.html, DocReview.dc.html). Một quy trình gồm các
 * giai đoạn, mỗi giai đoạn có các checkpoint (gate): AI tự kiểm, người duyệt, quy tắc tự động, cổng CI. Đề xuất sửa tài
 * liệu khớp quy trình thì đi lần lượt qua các gate; qua hết thì hub lưu phiên bản (baseline).
 */
export const workflowPreset = z.enum(["aidlc", "speckit", "bmad", "custom"]);
export type WorkflowPreset = z.output<typeof workflowPreset>;
export const gateKind = z.enum(["ai", "human", "rule", "ext"]);
export type GateKind = z.output<typeof gateKind>;
export const reviewerRole = z.enum(["org-admin", "team-admin", "team-member"]);
export type ReviewerRole = z.output<typeof reviewerRole>;
export const ruleCheck = z.enum(["sections", "requirements", "no-secrets", "max-diff"]);
export type RuleCheck = z.output<typeof ruleCheck>;
export const rejectRoute = z.enum(["author", "agent", "previous"]);
export type RejectRoute = z.output<typeof rejectRoute>;
export const passAction = z.enum(["next", "task", "baseline"]);

const shortText = (max: number) => z.string().trim().min(1).max(max);

export const gateConditions = z.object({
  /** Loại tài liệu: đoạn cuối của key (`prd`, `design`…) bằng hoặc bắt đầu bằng `<loại>-`. Rỗng là mọi loại. */
  docTypes: z.array(shortText(40)).max(20).default([]),
  /** Chỉ chạy khi nội dung mới có một trong các từ khoá (không phân biệt hoa thường). */
  keywords: z.array(shortText(60)).max(20).default([]),
  /** Chỉ chạy khi số dòng thêm và xoá so với baseline từ ngưỡng này trở lên. */
  minChangedLines: z.number().int().min(1).max(100_000).nullable().default(null),
  /** Bỏ qua khi thay đổi chỉ là khoảng trắng, dấu câu, định dạng Markdown. */
  skipFormattingOnly: z.boolean().default(false),
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
    })
    .optional(),
  /** Gate quy tắc. */
  rules: z.array(ruleCheck).max(4).optional(),
  /** Tiêu đề mục bắt buộc cho quy tắc `sections`. */
  sections: z.array(shortText(120)).max(30).optional(),
  maxDiffLines: z.number().int().min(1).max(100_000).optional(),
  /** Gate AI: agent đọc tài liệu và chấm theo danh sách kiểm. */
  ai: z
    .object({
      checks: z.array(shortText(300)).min(1).max(20),
      passScore: z.number().min(0).max(10),
      /** Model agent dùng khi kiểm; bỏ trống là model review của dự án. Chính sách agent của tổ chức vẫn áp. */
      model: z.string().trim().min(1).max(200).optional(),
    })
    .optional(),
  /** Gate CI: trạng thái CI của nhánh chính trong repo của dự án. */
  ext: z.object({ check: z.literal("ci") }).optional(),
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

export const workflowInput = z
  .object({
    id: z.uuid().optional(),
    name: shortText(120),
    preset: workflowPreset,
    /** Đội sở hữu quy trình; null là quy trình của tổ chức. */
    teamId: z.uuid().nullable(),
    docPrefixes: z.array(docPrefix).min(1).max(20),
    phases: z.array(reviewPhase).min(1).max(10),
    enabled: z.boolean(),
  })
  .superRefine((w, ctx) => {
    const ids = w.phases.flatMap((p) => p.gates.map((g) => g.id));
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: "custom", message: "Mã checkpoint trùng nhau.", path: ["phases"] });
    for (const [pi, p] of w.phases.entries()) {
      for (const [gi, g] of p.gates.entries()) {
        const path = ["phases", pi, "gates", gi];
        if (
          g.kind === "human" &&
          !(g.reviewers && (g.reviewers.users.length || g.reviewers.roles.length || g.reviewers.teams.length))
        )
          ctx.addIssue({ code: "custom", message: `Checkpoint “${g.name}” cần người duyệt.`, path });
        if (g.kind === "rule" && !g.rules?.length)
          ctx.addIssue({ code: "custom", message: `Checkpoint “${g.name}” cần ít nhất một quy tắc.`, path });
        if (g.kind === "ai" && !g.ai)
          ctx.addIssue({ code: "custom", message: `Checkpoint “${g.name}” cần danh sách AI kiểm.`, path });
      }
    }
  });
export type WorkflowInput = z.input<typeof workflowInput>;

export const reviewWorkflow = z.object({
  id: z.uuid(),
  name: z.string(),
  preset: workflowPreset,
  teamId: z.uuid().nullable(),
  docPrefixes: z.array(z.string()),
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

export const workflowsContract = {
  list: orgRoute("GET", "/v1/review-workflows", "Quy trình duyệt tài liệu", "reviews").output(z.array(reviewWorkflow)),
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

/** Khung mẫu theo AI-DLC, Spec Kit, BMAD (Workflows.dc.html). Quản trị chọn rồi sửa người duyệt, điều kiện. */
export const WORKFLOW_PRESETS: Record<Exclude<WorkflowPreset, "custom">, z.input<typeof reviewPhase>[]> = {
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
