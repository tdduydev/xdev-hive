import {
  type ChecklistItem,
  type Doc,
  type DryRunResult,
  dryRunInput,
  type GateRun,
  type Proposal,
  type ProposalCreateInput,
  type RequirementTrace,
  type ReviewDecideInput,
  type ReviewDetail,
  type ReviewGate,
  type ReviewPhase,
  type ReviewSummary,
  type ReviewWorkflow,
  reviewDecideInput,
  reviewListInput,
  scanSecrets,
  type WorkflowInput,
  type WorkflowSubject,
  workflowInput,
} from "@xdev-hive/contracts";
import { and, asc, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import type { z } from "zod";
import { loadPolicy } from "../governance/index.ts";
import { authUser } from "../identity/index.ts";
import { notify } from "../notify/index.ts";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  type Jobs,
  NotFoundError,
  type Tx,
} from "../platform/index.ts";
import { createSystemTask, listTasks } from "../tasks/index.ts";
import { allowWith, notificationRecipients, requireOrgRole, requireTeamRole, teamMemberIds } from "../tenancy/index.ts";
import {
  audit,
  canRead,
  docGrant,
  type Principal,
  type Reader,
  readerFor,
  type Scope,
  versionConflict,
  visibleWhere,
} from "./access.ts";
import { applyDocSave, DocSecretError, secretsAcknowledged } from "./docs.ts";
import { approvedSource, createProposal, type ProposalOptions, proposalApproved, proposalView } from "./proposals.ts";
import {
  type BreakdownRuleInput,
  diffCounts,
  docTypeOf,
  type FlatGate,
  flatGates,
  gateApplies,
  requiredApprovals,
  requirementsOf,
  ruleChecklist,
  slaOf,
} from "./review-rules.ts";
import { docs, docVersions, proposals, reviewGateRuns, reviewInstances, reviewWorkflows } from "./schema.ts";

export const REVIEW_QUEUE = "knowledge-review";
export const reviewQueue = {
  name: REVIEW_QUEUE,
  // Gate CI hỏi lại nhà cung cấp Git; chạy lại an toàn vì job chỉ xử lý gate còn chờ.
  retryLimit: 5,
  retryDelay: 60,
  retryBackoff: true,
  expireInSeconds: 10 * 60,
} as const;

export type ReviewJob =
  | { kind: "ext"; orgId: string; instanceId: string; attempt?: number }
  | { kind: "ai"; orgId: string; instanceId: string }
  | {
      kind: "ai-result";
      orgId: string;
      instanceId: string;
      runId: string;
      score: number | null;
      checklist: ChecklistItem[];
      summary: string | null;
      error: string | null;
    }
  | { kind: "sla" };

/** Quy trình dựng ngoài bảng `review_workflows`, vd. AI SDLC dựng từ cổng của giai đoạn (specs/011 D3). */
export interface DerivedWorkflow {
  name: string;
  phases: ReviewPhase[];
}

export interface BaselineEvent {
  docKey: string;
  version: number;
  proposalId: string;
  reviewId: string;
  /** Duyệt lại bản baseline hiện tại sau khi thu hồi tự duyệt: không có phiên bản mới, `version` là bản đang hiệu lực. */
  reaffirm: boolean;
  /** Mọi checkpoint người của phiên đều do hub tự duyệt, không có người nào duyệt. */
  autoApproved: boolean;
}

export interface AuthorFixRequest {
  reviewId: string;
  docKey: string;
  docTitle: string;
  projectId: string | null;
  /** Góp ý của người duyệt. */
  note: string;
  decider: string | null;
}

export interface TraceRequest {
  userId: string;
  docKey: string;
  content: string;
  projectId: string | null;
}

/** Kết quả các checkpoint đã qua của phiên, để luật tự duyệt đọc điểm review AI. */
export interface AutoCheckpoint {
  gateId: string;
  kind: ReviewGate["kind"];
  status: GateRunRow["status"];
  score: number | null;
  checklist: ChecklistItem[];
  decidedBy: string | null;
}

export interface AutoDecideRequest {
  review: {
    id: string;
    proposalId: string;
    docKey: string;
    docTitle: string;
    teamId: string | null;
    projectId: string | null;
    workflowName: string;
    authorUserId: string | null;
    authorRunId: string | null;
  };
  gate: ReviewGate;
  checkpoints: AutoCheckpoint[];
}

/** `null`: tài liệu không thuộc phạm vi tự duyệt, chạy như cũ. `approve: false` không kèm lý do là im lặng. */
export type AutoDecision =
  | { approve: true; score: number; threshold: number; approvalId: string; reasons?: string[] | undefined }
  | { approve: false; reason?: string | undefined };

/** Dữ liệu cho luật `no-open-questions`, `breakdown`, `coverage`; chỉ `sdlc` có. */
export interface RuleContextExtras {
  openQuestions?: number | undefined;
  breakdown?: BreakdownRuleInput | undefined;
}

/** Điểm nối của module khác vào máy trạng thái duyệt; không đặt thì hành vi y như trước. */
export interface ReviewHooks {
  /** Hỏi trước `matchWorkflow`: tài liệu của hạng mục có quy trình dựng riêng. */
  workflowFor?: ((tx: Tx, docKey: string) => Promise<DerivedWorkflow | null>) | undefined;
  /** Gọi trong transaction của baseline: giai đoạn không "đạt" khi baseline bị rollback. */
  onBaseline?: ((tx: Tx, event: BaselineEvent) => Promise<void>) | undefined;
  /** `true`: đã nhận việc sửa theo góp ý (thay task chung của `knowledge`). */
  queueAuthorFix?: ((tx: Tx, request: AuthorFixRequest) => Promise<boolean>) | undefined;
  /** `null`: dùng cách truy vết theo mã R-n và tiêu đề task. */
  traceFor?: ((tx: Tx, request: TraceRequest) => Promise<RequirementTrace[] | null>) | undefined;
  autoDecide?: ((tx: Tx, request: AutoDecideRequest) => Promise<AutoDecision | null>) | undefined;
  ruleContext?: ((tx: Tx, docKey: string, content: string) => Promise<RuleContextExtras | null>) | undefined;
}

export interface ReviewDeps extends ReviewHooks {
  jobs?: Jobs | undefined;
  /** Địa chỉ web để link trong thông báo. */
  publicUrl?: string | undefined;
}

// Router, MCP và worker mỗi nơi dựng deps riêng; hook tiêm một lần lúc khởi động hub (như `provide*` của
// mcp/registry.ts) để không đường nào bỏ sót. Deps truyền vào thắng, để test đổi hành vi từng ca.
let installed: ReviewHooks = {};
export function provideReviewHooks(hooks: ReviewHooks): void {
  installed = hooks;
}

export function hooksOf(deps: ReviewDeps = {}): ReviewDeps {
  return {
    ...deps,
    workflowFor: deps.workflowFor ?? installed.workflowFor,
    onBaseline: deps.onBaseline ?? installed.onBaseline,
    queueAuthorFix: deps.queueAuthorFix ?? installed.queueAuthorFix,
    traceFor: deps.traceFor ?? installed.traceFor,
    autoDecide: deps.autoDecide ?? installed.autoDecide,
    ruleContext: deps.ruleContext ?? installed.ruleContext,
  };
}

/** Tác nhân ghi ở `decidedBy` và lượt duyệt của checkpoint do hub tự duyệt. */
export const AI_AUTO_ACTOR = "system:ai-auto";
/** Phiên duyệt lại baseline: dùng cột `route` (chưa có hướng trả lại nào) vì không có cột riêng; trả lại thì bị ghi đè. */
const REAFFIRM_ROUTE = "reaffirm";
/** Id giả cho quy trình dựng sẵn khi hợp đồng đòi uuid (bản xem trước); phiên thật lưu `workflow_id = null`. */
export const DERIVED_WORKFLOW_ID = "00000000-0000-0000-0000-000000000000";

type StoredApproval = { userId: string; at: string; auto?: { score: number; threshold: number; approvalId: string } };

type InstanceRow = typeof reviewInstances.$inferSelect;
type GateRunRow = typeof reviewGateRuns.$inferSelect;
type ProposalRow = typeof proposals.$inferSelect;

const notFound = () => new NotFoundError("REVIEW_NOT_FOUND", "Không tìm thấy phiên duyệt.");
const iso = (d: Date | null) => (d ? d.toISOString() : null);

// ---- Quy trình -------------------------------------------------------------------------------------------------

async function requireWorkflowWrite(tx: Tx, userId: string, teamId: string | null) {
  if (teamId)
    await allowWith(tx, userId, "workflows.write", () => requireTeamRole(tx, userId, teamId, "admin"), teamId);
  else await allowWith(tx, userId, "workflows.write", () => requireOrgRole(tx, userId, "admin"));
}

function workflowView(row: typeof reviewWorkflows.$inferSelect, inFlight: number): ReviewWorkflow {
  return {
    id: row.id,
    name: row.name,
    preset: row.preset as ReviewWorkflow["preset"],
    subject: row.subject,
    teamId: row.teamId,
    docPrefixes: row.docPrefixes,
    code: row.code,
    phases: row.phases,
    enabled: row.enabled,
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
    inFlight,
  };
}

/**
 * Số phiên đang chạy theo từng quy trình. Phiên review code nằm ở bảng của module `codereview` (nó import module này
 * nên không import ngược được), vì vậy đếm bằng SQL thẳng; chỉ đọc hai cột.
 */
async function inFlightCounts(tx: Tx): Promise<Map<string, number>> {
  const docs = await tx
    .select({ id: reviewInstances.workflowId, n: sql<number>`count(*)::int` })
    .from(reviewInstances)
    .where(eq(reviewInstances.status, "in_review"))
    .groupBy(reviewInstances.workflowId);
  const code = await tx.execute<{ id: string; n: number }>(
    sql`select workflow_id as id, count(*)::int as n from hive.code_reviews
        where status = 'in_review' and workflow_id is not null group by workflow_id`,
  );
  const out = new Map<string, number>();
  for (const c of docs) if (c.id) out.set(c.id, c.n);
  for (const c of code.rows) out.set(c.id, c.n);
  return out;
}

export async function listWorkflows(
  tx: Tx,
  principal: Principal,
  subject?: WorkflowSubject,
): Promise<ReviewWorkflow[]> {
  const reader = await readerFor(tx, principal);
  const rows = (
    await tx
      .select()
      .from(reviewWorkflows)
      .where(subject ? eq(reviewWorkflows.subject, subject) : undefined)
      .orderBy(asc(reviewWorkflows.name))
  ).filter((w) => canRead(reader, { teamId: w.teamId, projectId: null }));
  const by = await inFlightCounts(tx);
  return rows.map((r) => workflowView(r, by.get(r.id) ?? 0));
}

/**
 * Quy trình code đang bật mà đội của dự án áp dụng được (của tổ chức hoặc của đúng đội đó), cho `codereview` chọn quy
 * trình khớp một run. Phạm vi dự án, nhánh, loại task và đường dẫn do `codereview/match.ts` lọc tiếp.
 */
export async function listCodeWorkflows(tx: Tx, scope: Scope): Promise<ReviewWorkflow[]> {
  const rows = await tx
    .select()
    .from(reviewWorkflows)
    .where(and(eq(reviewWorkflows.subject, "code"), eq(reviewWorkflows.enabled, true)))
    .orderBy(desc(reviewWorkflows.updatedAt));
  return rows.filter((w) => !w.teamId || w.teamId === scope.teamId).map((w) => workflowView(w, 0));
}

/**
 * Model reviewer của quy trình code không được ngoài danh sách chính sách agent (FR-011). Chính sách không có khái
 * niệm cấm cả CLI: danh sách rỗng là không giới hạn, nên chỉ kiểm model.
 */
async function requireAllowedByPolicy(tx: Tx, input: WorkflowInput & { subject: WorkflowSubject }) {
  if (input.subject !== "code") return;
  const policy = await loadPolicy(tx);
  for (const phase of input.phases)
    for (const gate of phase.gates)
      for (const r of gate.ai?.reviewers ?? []) {
        const allowed = policy.allowedModels[r.cli];
        if (r.model && allowed.length && !allowed.includes(r.model))
          throw new BadRequestError(
            "WORKFLOW_MODEL_FORBIDDEN",
            `Chính sách agent của tổ chức không cho dùng model ${r.model} với ${r.cli}. Chọn một trong: ${allowed.join(", ")}.`,
          );
      }
}

export async function saveWorkflow(tx: Tx, userId: string, raw: WorkflowInput): Promise<ReviewWorkflow> {
  const input = workflowInput.parse(raw);
  await requireWorkflowWrite(tx, userId, input.teamId);
  await requireAllowedByPolicy(tx, input);
  let row: typeof reviewWorkflows.$inferSelect | undefined;
  if (input.id) {
    const [old] = await tx.select().from(reviewWorkflows).where(eq(reviewWorkflows.id, input.id)).for("update");
    if (!old) throw new NotFoundError("WORKFLOW_NOT_FOUND", "Không tìm thấy quy trình.");
    // Checkpoint, điều kiện và phiên đang chạy của hai loại khác nhau, nên đổi loại là tạo quy trình mới.
    if (old.subject !== input.subject)
      throw new BadRequestError(
        "WORKFLOW_SUBJECT_FIXED",
        "Loại áp dụng cố định sau khi tạo; nhân bản quy trình nếu muốn đổi.",
      );
    // Chuyển quy trình sang đội khác cần quyền ở cả hai phía.
    await requireWorkflowWrite(tx, userId, old.teamId);
    [row] = await tx
      .update(reviewWorkflows)
      .set({
        name: input.name,
        preset: input.preset,
        teamId: input.teamId,
        docPrefixes: input.docPrefixes,
        code: input.code,
        phases: input.phases,
        enabled: input.enabled,
        updatedBy: userId,
        updatedAt: sql`now()`,
      })
      .where(eq(reviewWorkflows.id, input.id))
      .returning();
  } else {
    [row] = await tx
      .insert(reviewWorkflows)
      .values({
        orgId: sql`hive.ctx_org()`,
        teamId: input.teamId,
        name: input.name,
        preset: input.preset,
        subject: input.subject,
        docPrefixes: input.docPrefixes,
        code: input.code,
        phases: input.phases,
        enabled: input.enabled,
        updatedBy: userId,
      })
      .returning();
  }
  if (!row) throw new Error("Không lưu được quy trình.");
  await audit(
    tx,
    { kind: "user", userId },
    "review_workflow.save",
    { type: "review_workflow", id: row.id },
    {
      name: row.name,
      preset: row.preset,
      subject: row.subject,
      enabled: row.enabled,
      gates: flatGates(row.phases).length,
    },
  );
  return workflowView(row, 0);
}

export async function removeWorkflow(tx: Tx, userId: string, id: string): Promise<void> {
  const [row] = await tx.select().from(reviewWorkflows).where(eq(reviewWorkflows.id, id));
  if (!row) throw new NotFoundError("WORKFLOW_NOT_FOUND", "Không tìm thấy quy trình.");
  await requireWorkflowWrite(tx, userId, row.teamId);
  // Phiên đang chạy giữ bản chép của quy trình nên vẫn đi tiếp được.
  await tx.delete(reviewWorkflows).where(eq(reviewWorkflows.id, id));
  await audit(
    tx,
    { kind: "user", userId },
    "review_workflow.remove",
    { type: "review_workflow", id },
    { name: row.name, subject: row.subject },
  );
}

/** Quy trình áp cho tài liệu: tiền tố dài nhất thắng, cùng độ dài thì quy trình của đội thắng của tổ chức. */
export async function matchWorkflow(tx: Tx, key: string, scope: Scope) {
  // Quy trình code không có tiền tố tài liệu nên không bao giờ khớp, nhưng lọc rõ để không lẫn khi cột đó có giá trị.
  const rows = await tx
    .select()
    .from(reviewWorkflows)
    .where(and(eq(reviewWorkflows.enabled, true), eq(reviewWorkflows.subject, "doc")));
  let best: { row: (typeof rows)[number]; len: number } | null = null;
  for (const row of rows) {
    if (row.teamId && row.teamId !== scope.teamId) continue;
    for (const prefix of row.docPrefixes) {
      if (!key.startsWith(prefix)) continue;
      const len = prefix.length * 2 + (row.teamId ? 1 : 0);
      if (!best || len > best.len) best = { row, len };
    }
  }
  return best?.row ?? null;
}

/**
 * Quy trình áp cho tài liệu: của hook `workflowFor` (hạng mục AI SDLC) trước, rồi tới quy trình khớp tiền tố. `id` null
 * là quy trình dựng sẵn, không có dòng trong `review_workflows`.
 */
export async function resolveWorkflow(
  tx: Tx,
  key: string,
  scope: Scope,
  deps?: ReviewDeps,
): Promise<{ id: string | null; name: string; phases: ReviewPhase[] } | null> {
  const derived = await hooksOf(deps).workflowFor?.(tx, key);
  if (derived) return { id: null, name: derived.name, phases: derived.phases };
  const row = await matchWorkflow(tx, key, scope);
  return row ? { id: row.id, name: row.name, phases: row.phases } : null;
}

const NEEDS_EXTRAS = new Set(["no-open-questions", "breakdown", "coverage"]);

/** Dữ liệu của hạng mục cho các luật cần nó; chỉ hỏi hook khi quy trình thật sự có luật đó. */
async function ruleExtras(
  tx: Tx,
  deps: ReviewDeps,
  flat: FlatGate[],
  docKey: string,
  content: string,
): Promise<RuleContextExtras> {
  if (!deps.ruleContext || !flat.some((f) => f.gate.rules?.some((r) => NEEDS_EXTRAS.has(r)))) return {};
  return (await deps.ruleContext(tx, docKey, content)) ?? {};
}

async function docContentAt(tx: Tx, key: string, version: number): Promise<string> {
  if (version <= 0) return "";
  const [row] = await tx
    .select({ content: docVersions.content })
    .from(docVersions)
    .innerJoin(docs, eq(docs.id, docVersions.docId))
    .where(and(eq(docs.key, key), eq(docVersions.version, version)));
  return row?.content ?? "";
}

export async function dryRunWorkflow(
  tx: Tx,
  principal: Principal,
  raw: z.input<typeof dryRunInput>,
): Promise<DryRunResult> {
  const { workflow, docKey } = dryRunInput.parse(raw);
  if (workflow.subject !== "doc")
    throw new BadRequestError("WORKFLOW_SUBJECT_MISMATCH", "Chạy thử trên tài liệu chỉ dùng cho quy trình tài liệu.");
  const reader = await readerFor(tx, principal);
  const [doc] = await tx.select().from(docs).where(eq(docs.key, docKey));
  if (!doc || !canRead(reader, doc)) throw new NotFoundError("DOC_NOT_FOUND", "Không tìm thấy tài liệu.");
  // Coi bản hiện tại như một đề xuất sửa từ bản trước đó.
  const content = await docContentAt(tx, docKey, doc.currentVersion);
  const base = await docContentAt(tx, docKey, doc.currentVersion - 1);
  const docType = docTypeOf(docKey);
  const hooks = hooksOf();
  const flat = flatGates(workflow.phases);
  const ctx = { docType, content, base, ...(await ruleExtras(tx, hooks, flat, docKey, content)) };
  return {
    docKey,
    docType,
    matched: workflow.docPrefixes.some((p) => docKey.startsWith(p)),
    gates: flat.map(({ gate }) => {
      const applies = gateApplies(gate, ctx);
      return {
        gateId: gate.id,
        name: gate.name,
        kind: gate.kind,
        runs: applies.runs,
        reason: applies.reason,
        checklist: applies.runs && gate.kind === "rule" ? ruleChecklist(gate, ctx) : [],
      };
    }),
  };
}

// ---- Phiên duyệt -----------------------------------------------------------------------------------------------

/**
 * Tạo đề xuất sửa tài liệu và, nếu tài liệu khớp một quy trình đang bật, bắt đầu phiên duyệt trong cùng transaction.
 * Router và tool MCP doc_propose đều đi qua đây để mọi đề xuất đều theo quy trình.
 */
export async function proposeWithReview(
  tx: Tx,
  principal: Principal,
  input: ProposalCreateInput,
  deps: ReviewDeps,
  options: ProposalOptions = {},
): Promise<Proposal> {
  const proposal = await createProposal(tx, principal, input, options);
  if (proposal.kind === "doc") await startReview(tx, proposal.id, hooksOf(deps));
  return proposal;
}

export interface StartReviewOptions {
  /** Quy trình do người gọi dựng, bỏ qua `workflowFor` và quy trình khớp tiền tố (duyệt lại sau khi thu hồi tự duyệt). */
  workflow?: DerivedWorkflow | undefined;
  /**
   * Đề xuất là chính baseline hiện tại, chỉ để người duyệt lại: đạt thì gọi `onBaseline` với `reaffirm`, không tạo
   * phiên bản mới.
   */
  reaffirm?: boolean | undefined;
}

export async function startReview(
  tx: Tx,
  proposalId: string,
  rawDeps: ReviewDeps,
  options: StartReviewOptions = {},
): Promise<InstanceRow | null> {
  const deps = hooksOf(rawDeps);
  const [p] = await tx.select().from(proposals).where(eq(proposals.id, proposalId));
  if (p?.kind !== "doc" || p.status !== "pending") return null;
  const wf = options.workflow
    ? { id: null, name: options.workflow.name, phases: options.workflow.phases }
    : await resolveWorkflow(tx, p.target, p, deps);
  if (!wf) return null;
  const base = await docContentAt(tx, p.target, p.baseVersion);
  const { added, deleted } = diffCounts(base, p.content);
  const [doc] = await tx.select({ title: docs.title }).from(docs).where(eq(docs.key, p.target));
  // Agent sửa theo góp ý rồi đề xuất lại: tiếp tục ở gate đã trả về, không chạy lại các gate đã qua.
  const [prev] = await tx
    .select()
    .from(reviewInstances)
    .where(and(eq(reviewInstances.docKey, p.target), eq(reviewInstances.status, "changes_requested")))
    .orderBy(desc(reviewInstances.updatedAt))
    .limit(1);
  const sameWorkflow = prev && (wf.id ? prev.workflowId === wf.id : prev.workflowName === wf.name);
  const resume = prev && prev.route === "agent" && sameWorkflow ? prev.gateIndex : 0;
  const [inst] = await tx
    .insert(reviewInstances)
    .values({
      orgId: sql`hive.ctx_org()`,
      teamId: p.teamId,
      projectId: p.projectId,
      proposalId: p.id,
      workflowId: wf.id,
      workflowName: wf.name,
      phases: wf.phases,
      route: options.reaffirm ? REAFFIRM_ROUTE : null,
      docKey: p.target,
      docTitle: p.title ?? doc?.title ?? docTypeOf(p.target),
      gateIndex: resume,
      addedLines: added,
      deletedLines: deleted,
      authorUserId: p.authorUserId,
      authorRunId: p.authorRunId,
    })
    .returning();
  if (!inst) throw new Error("Không tạo được phiên duyệt.");
  await audit(
    tx,
    authorPrincipal(p),
    "review.start",
    { type: "review", id: inst.id },
    {
      proposalId: p.id,
      workflow: wf.name,
      docKey: p.target,
      resumeAt: resume,
      ...(options.reaffirm ? { reaffirm: true } : {}),
    },
  );
  await advance(tx, inst, deps, null);
  return inst;
}

function authorPrincipal(p: {
  authorUserId: string | null;
  authorRunId: string | null;
  projectId: string | null;
}): Principal {
  if (p.authorUserId) return { kind: "user", userId: p.authorUserId };
  return { kind: "run", runId: p.authorRunId ?? "", projectId: p.projectId ?? "" };
}

async function loadProposal(tx: Tx, id: string): Promise<ProposalRow> {
  const [p] = await tx.select().from(proposals).where(eq(proposals.id, id));
  if (!p) throw notFound();
  return p;
}

/**
 * Chạy các gate từ vị trí hiện tại: gate không đủ điều kiện thì bỏ qua, gate quy tắc chấm ngay, gate người duyệt, AI
 * và CI thì dừng lại chờ. Qua hết thì chốt phiên bản.
 */
async function advance(tx: Tx, inst: InstanceRow, deps: ReviewDeps, decider: string | null): Promise<InstanceRow> {
  const flat = flatGates(inst.phases);
  const p = await loadProposal(tx, inst.proposalId);
  const base = await docContentAt(tx, inst.docKey, p.baseVersion);
  const ctx = {
    docType: docTypeOf(inst.docKey),
    content: p.content,
    base,
    ...(await ruleExtras(tx, deps, flat, inst.docKey, p.content)),
  };
  let i = inst.gateIndex;
  while (i < flat.length) {
    const { gate } = flat[i] as FlatGate;
    const applies = gateApplies(gate, ctx);
    if (!applies.runs) {
      await recordRun(tx, inst, i, gate, { status: "skipped", note: applies.reason, finished: true });
      i++;
      continue;
    }
    if (gate.kind === "rule") {
      const checklist = ruleChecklist(gate, ctx);
      const passed = checklist.every((c) => c.passed);
      await recordRun(tx, inst, i, gate, { status: passed ? "passed" : "failed", checklist, finished: true });
      if (!passed) {
        return requestChanges(
          tx,
          { ...inst, gateIndex: i },
          "author",
          `Không đạt quy tắc của “${gate.name}”: ${checklist
            .filter((c) => !c.passed)
            .map((c) => c.label)
            .join("; ")}.`,
          null,
          deps,
        );
      }
      const next = await afterPass(tx, { ...inst, gateIndex: i }, gate, p, deps, decider);
      if (next === "done") return finish(tx, inst, p, decider, deps);
      i++;
      continue;
    }
    // Gate chờ: người duyệt, AI, CI.
    const due = gate.kind === "human" && gate.slaHours ? new Date(Date.now() + gate.slaHours * 3_600_000) : null;
    const waitingRunId = await recordRun(tx, inst, i, gate, { status: "waiting", dueAt: due });
    const [row] = await tx
      .update(reviewInstances)
      .set({ gateIndex: i, status: "in_review", updatedAt: sql`now()` })
      .where(eq(reviewInstances.id, inst.id))
      .returning();
    if (gate.kind === "human") {
      if (await tryAutoDecide(tx, row ?? inst, i, gate, waitingRunId, p, deps)) {
        const next = await afterPass(tx, { ...inst, gateIndex: i }, gate, p, deps, null);
        if (next === "done") return finish(tx, inst, p, null, deps);
        i++;
        continue;
      }
      await notifyReviewers(tx, row ?? inst, gate, deps);
    }
    if (gate.kind === "ext" && deps.jobs)
      await deps.jobs.enqueue(
        REVIEW_QUEUE,
        { kind: "ext", orgId: inst.orgId, instanceId: inst.id } satisfies ReviewJob,
        { tx },
      );
    if (gate.kind === "ai" && deps.jobs)
      await deps.jobs.enqueue(
        REVIEW_QUEUE,
        { kind: "ai", orgId: inst.orgId, instanceId: inst.id } satisfies ReviewJob,
        { tx },
      );
    return row ?? inst;
  }
  return finish(tx, inst, p, decider, deps);
}

/**
 * Checkpoint người mà hook `autoDecide` đồng ý: ghi như một lượt duyệt của `system:ai-auto` rồi đi tiếp y như người
 * duyệt. Không đồng ý thì checkpoint vẫn chờ người; lý do ghi vào `note` và audit để người duyệt biết vì sao.
 */
async function tryAutoDecide(
  tx: Tx,
  inst: InstanceRow,
  index: number,
  gate: ReviewGate,
  runId: string,
  p: ProposalRow,
  deps: ReviewDeps,
): Promise<boolean> {
  if (!deps.autoDecide) return false;
  const flat = flatGates(inst.phases);
  const runs = await tx
    .select()
    .from(reviewGateRuns)
    .where(eq(reviewGateRuns.instanceId, inst.id))
    .orderBy(asc(reviewGateRuns.startedAt), asc(reviewGateRuns.gateIndex));
  const latest = new Map<number, GateRunRow>();
  for (const r of runs) if (r.gateIndex < index) latest.set(r.gateIndex, r);
  const checkpoints: AutoCheckpoint[] = flat.slice(0, index).flatMap((f) => {
    const r = latest.get(f.index);
    return r
      ? [
          {
            gateId: f.gate.id,
            kind: f.gate.kind,
            status: r.status,
            score: r.score,
            checklist: r.checklist,
            decidedBy: r.decidedBy,
          },
        ]
      : [];
  });
  if (checkpoints.length !== index || checkpoints.some((c) => c.status !== "passed" && c.status !== "skipped"))
    return false;
  const decision = await deps.autoDecide(tx, {
    review: {
      id: inst.id,
      proposalId: inst.proposalId,
      docKey: inst.docKey,
      docTitle: inst.docTitle,
      teamId: inst.teamId,
      projectId: inst.projectId,
      workflowName: inst.workflowName,
      authorUserId: inst.authorUserId,
      authorRunId: inst.authorRunId,
    },
    gate,
    checkpoints,
  });
  if (!decision) return false;
  if (!decision.approve) {
    if (decision.reason) {
      await tx
        .update(reviewGateRuns)
        .set({ note: `Không tự duyệt: ${decision.reason}` })
        .where(eq(reviewGateRuns.id, runId));
      await audit(
        tx,
        authorPrincipal(p),
        "review.auto_declined",
        { type: "review", id: inst.id },
        { gate: gate.id, reason: decision.reason },
      );
    }
    return false;
  }
  const approval: StoredApproval = {
    userId: AI_AUTO_ACTOR,
    at: new Date().toISOString(),
    auto: { score: decision.score, threshold: decision.threshold, approvalId: decision.approvalId },
  };
  await tx
    .update(reviewGateRuns)
    .set({
      approvals: [approval],
      status: "passed",
      decidedBy: AI_AUTO_ACTOR,
      note: [`Tự duyệt AI: điểm ${decision.score} đạt ngưỡng ${decision.threshold}.`, ...(decision.reasons ?? [])].join(
        " ",
      ),
      finishedAt: sql`now()`,
    })
    .where(eq(reviewGateRuns.id, runId));
  await audit(
    tx,
    authorPrincipal(p),
    "review.auto_approve",
    { type: "review", id: inst.id },
    { gate: gate.id, score: decision.score, threshold: decision.threshold, approvalId: decision.approvalId },
  );
  return true;
}

async function recordRun(
  tx: Tx,
  inst: InstanceRow,
  index: number,
  gate: ReviewGate,
  run: {
    status: "waiting" | "passed" | "failed" | "skipped";
    note?: string | null;
    checklist?: ChecklistItem[];
    dueAt?: Date | null;
    finished?: boolean;
  },
): Promise<string> {
  const [row] = await tx
    .insert(reviewGateRuns)
    .values({
      orgId: inst.orgId,
      instanceId: inst.id,
      gateIndex: index,
      gateId: gate.id,
      status: run.status,
      note: run.note ?? null,
      checklist: run.checklist ?? [],
      dueAt: run.dueAt ?? null,
      finishedAt: run.finished ? sql`now()` : null,
    })
    .returning({ id: reviewGateRuns.id });
  if (!row) throw new Error("Không ghi được lượt chạy checkpoint.");
  return row.id;
}

/** Việc sau khi gate đạt: tạo việc cho agent của bước sau, hoặc chốt luôn. */
async function afterPass(
  tx: Tx,
  inst: InstanceRow,
  gate: ReviewGate,
  p: ProposalRow,
  _deps: ReviewDeps,
  decider: string | null,
): Promise<"next" | "done"> {
  if (gate.onPass === "baseline") return "done";
  if (gate.onPass === "task" && inst.projectId) {
    const title = (gate.nextTaskTitle ?? "Bước tiếp theo cho {title}").replaceAll("{title}", inst.docTitle);
    await createSystemTask(
      tx,
      decider ?? p.authorUserId ?? "system",
      {
        projectId: inst.projectId,
        title: title.slice(0, 200),
        body: `Tài liệu \`${inst.docKey}\` đã qua checkpoint “${gate.name}” của quy trình ${inst.workflowName}. Đọc bản mới nhất bằng \`doc_get\`.`,
      },
      { kind: "review", reviewId: inst.id, gateId: gate.id },
    );
  }
  return "next";
}

/** Qua hết gate: lưu nội dung đề xuất thành phiên bản mới (baseline) và đánh dấu đề xuất đã duyệt. */
async function finish(
  tx: Tx,
  inst: InstanceRow,
  p: ProposalRow,
  decider: string | null,
  deps: ReviewDeps,
): Promise<InstanceRow> {
  const principal: Principal = decider ? { kind: "user", userId: decider } : authorPrincipal(p);
  const reaffirm = inst.route === REAFFIRM_ROUTE;
  let version: number;
  let saved: Doc | null = null;
  if (reaffirm) {
    // Đề xuất là bản đang hiệu lực: không lưu gì, chỉ xác nhận lại. Tài liệu đã sang bản khác thì xác nhận này cũ rồi.
    const [current] = await tx.select({ version: docs.currentVersion }).from(docs).where(eq(docs.key, p.target));
    if (current?.version !== p.baseVersion) throw versionConflict("Tài liệu", current?.version ?? 0, p.baseVersion);
    version = current.version;
  } else {
    // Bước chốt không có người gửi kèm xác nhận; nội dung chưa được xác nhận lúc gửi duyệt (đề xuất của agent, hoặc
    // gửi từ trước khi có kiểm tra) thì trả về người viết thay vì lưu bản mà agent và repo không dùng được.
    const findings = scanSecrets(p.content);
    if (findings.length > 0 && !(await secretsAcknowledged(tx, p.target, p.content)))
      return requestChanges(tx, inst, "author", new DocSecretError(findings).message, decider, deps);
    saved = await applyDocSave(
      tx,
      principal,
      p,
      {
        key: p.target,
        title: p.title ?? undefined,
        content: p.content,
        baseVersion: p.baseVersion,
        message: p.reason ?? undefined,
        source: approvedSource(p),
      },
      p.id,
    );
    version = saved.version;
  }
  const [approved] = await tx
    .update(proposals)
    .set({
      status: "approved",
      decidedBy: decider,
      decidedAt: new Date(),
      decisionNote: `Qua quy trình ${inst.workflowName}.`,
      resultVersion: version,
    })
    .where(eq(proposals.id, p.id))
    .returning();
  const [row] = await tx
    .update(reviewInstances)
    .set({ status: "approved", gateIndex: flatGates(inst.phases).length, updatedAt: sql`now()` })
    .where(eq(reviewInstances.id, inst.id))
    .returning();
  await audit(
    tx,
    principal,
    reaffirm ? "review.reaffirm" : "review.baseline",
    { type: "review", id: inst.id },
    { docKey: p.target, version },
  );
  if (deps.onBaseline)
    await deps.onBaseline(tx, {
      docKey: p.target,
      version,
      proposalId: p.id,
      reviewId: inst.id,
      reaffirm,
      autoApproved: await onlyAutoApproved(tx, inst),
    });
  if (saved && approved) await proposalApproved(tx, proposalView(approved), saved);
  return row ?? inst;
}

/** Có checkpoint người đã đạt và tất cả đều do hub tự duyệt (lượt chạy cuối của mỗi checkpoint). */
async function onlyAutoApproved(tx: Tx, inst: InstanceRow): Promise<boolean> {
  const flat = flatGates(inst.phases);
  const runs = await tx
    .select()
    .from(reviewGateRuns)
    .where(eq(reviewGateRuns.instanceId, inst.id))
    .orderBy(asc(reviewGateRuns.startedAt), asc(reviewGateRuns.gateIndex));
  const latest = new Map<number, GateRunRow>();
  for (const r of runs) latest.set(r.gateIndex, r);
  const humans = [...latest.entries()].filter(
    ([index, r]) => flat[index]?.gate.kind === "human" && r.status === "passed",
  );
  return humans.length > 0 && humans.every(([, r]) => r.decidedBy === AI_AUTO_ACTOR);
}

/** Trả lại: về người viết (đề xuất bị từ chối), agent sửa theo góp ý, hoặc về gate người duyệt trước đó. */
async function requestChanges(
  tx: Tx,
  inst: InstanceRow,
  route: "author" | "agent" | "previous",
  note: string,
  decider: string | null,
  deps: ReviewDeps,
): Promise<InstanceRow> {
  const flat = flatGates(inst.phases);
  if (route === "previous") {
    const prev = flat
      .slice(0, inst.gateIndex)
      .reverse()
      .find((f) => f.gate.kind === "human");
    if (!prev)
      throw new BadRequestError("REVIEW_NO_PREVIOUS", "Không có checkpoint người duyệt nào trước checkpoint này.");
    const back = { ...inst, gateIndex: prev.index };
    return advance(tx, back, deps, decider);
  }
  if (route === "agent") {
    // Hạng mục AI SDLC tự giao run soạn lại với góp ý; tài liệu khác thì dùng task chung.
    const queued = await deps.queueAuthorFix?.(tx, {
      reviewId: inst.id,
      docKey: inst.docKey,
      docTitle: inst.docTitle,
      projectId: inst.projectId,
      note,
      decider,
    });
    if (!queued) {
      if (!inst.projectId)
        throw new BadRequestError(
          "REVIEW_AGENT_NEEDS_PROJECT",
          "Tài liệu không thuộc dự án nào nên không giao agent sửa được; hãy trả về người viết.",
        );
      await createSystemTask(
        tx,
        decider ?? "system",
        {
          projectId: inst.projectId,
          title: `Sửa tài liệu “${inst.docTitle}” theo góp ý`.slice(0, 200),
          body: `Người duyệt trả lại đề xuất sửa \`${inst.docKey}\` ở quy trình ${inst.workflowName}.\n\nGóp ý:\n${note}\n\nĐọc bản hiện tại bằng \`doc_get\`, sửa theo góp ý rồi gọi \`doc_propose\`. Phiên duyệt sẽ tiếp tục ở checkpoint đã trả lại.`,
        },
        { kind: "review", reviewId: inst.id, route: "agent" },
      );
    }
  }
  await tx
    .update(proposals)
    .set({ status: "rejected", decidedBy: decider, decidedAt: new Date(), decisionNote: note })
    .where(and(eq(proposals.id, inst.proposalId), eq(proposals.status, "pending")));
  const [row] = await tx
    .update(reviewInstances)
    .set({ status: "changes_requested", route, gateIndex: inst.gateIndex, updatedAt: sql`now()` })
    .where(eq(reviewInstances.id, inst.id))
    .returning();
  return row ?? inst;
}

async function currentRun(tx: Tx, inst: InstanceRow): Promise<GateRunRow | null> {
  const [run] = await tx
    .select()
    .from(reviewGateRuns)
    .where(and(eq(reviewGateRuns.instanceId, inst.id), eq(reviewGateRuns.gateIndex, inst.gateIndex)))
    .orderBy(desc(reviewGateRuns.startedAt))
    .limit(1);
  return run ?? null;
}

const isOrgAdmin = (reader: Reader) =>
  reader.kind === "user" && (reader.orgRole === "owner" || reader.orgRole === "admin");

/** Người dùng được chỉ định duyệt gate người duyệt này (theo tên hoặc theo vai trò trong phạm vi tài liệu). */
export function eligible(reader: Reader, gate: ReviewGate, scope: Scope): boolean {
  if (reader.kind !== "user") return false;
  const r = gate.reviewers;
  if (!r) return false;
  if (r.users.includes(reader.principal.userId)) return true;
  if (
    r.teams.some((t) => {
      const role = reader.teams.get(t);
      return role === "admin" || role === "member";
    })
  )
    return true;
  // Checkpoint theo đội của hạng mục (specs/011 D21) tính vai trò trong đội đó, không phải đội sở hữu tài liệu.
  const teamId = r.teamScope ?? scope.teamId;
  // Hợp đồng đã có vai trò `ba` nhưng enum đội của hub chưa có (T018), nên đọc như chuỗi.
  const teamRole: string | undefined = teamId ? reader.teams.get(teamId) : undefined;
  return r.roles.some((role) => {
    if (role === "org-admin") return isOrgAdmin(reader);
    if (role === "team-admin") return teamId ? teamRole === "admin" : isOrgAdmin(reader);
    if (role === "team-ba") return teamId ? teamRole === "admin" || teamRole === "member" || teamRole === "ba" : true;
    return teamId ? teamRole === "admin" || teamRole === "member" : true;
  });
}

/** Đọc được phiên duyệt: thấy qua phạm vi, qua quyền riêng của tài liệu, hoặc là người duyệt checkpoint theo đội. */
async function canSeeReview(tx: Tx, reader: Reader, inst: InstanceRow): Promise<boolean> {
  if (canRead(reader, inst)) return true;
  if (reader.kind !== "user") return false;
  if (flatGates(inst.phases).some((f) => f.gate.reviewers?.teamScope && reader.teams.has(f.gate.reviewers.teamScope)))
    return true;
  return !!(await docGrant(tx, reader, inst.docKey));
}

/** Được quyết ở gate hiện tại: người được chỉ định (không phải người viết), hoặc owner/admin tổ chức. */
function canDecideAt(reader: Reader, gate: ReviewGate, inst: InstanceRow, run: GateRunRow | null): boolean {
  if (inst.status !== "in_review" || gate.kind !== "human" || run?.status !== "waiting") return false;
  if (reader.kind !== "user") return false;
  const me = reader.principal.userId;
  if (run.approvals.some((a) => a.userId === me)) return false;
  if (isOrgAdmin(reader)) return true;
  return me !== inst.authorUserId && eligible(reader, gate, inst);
}

async function notifyReviewers(tx: Tx, inst: InstanceRow, gate: ReviewGate, deps: ReviewDeps) {
  const r = gate.reviewers;
  if (!r) return;
  const ids = new Set(await notificationRecipients(tx, r.users));
  const teamId = r.teamScope ?? inst.teamId;
  for (const role of r.roles) {
    if (role === "org-admin" || !teamId) for (const id of await notificationRecipients(tx)) ids.add(id);
    // Người có vai trò `ba` thấp hơn `member` nên chưa nhận được tới khi tenancy thêm thứ hạng đó (T018).
    else for (const id of await teamMemberIds(tx, teamId, role === "team-admin" ? "admin" : "member")) ids.add(id);
  }
  for (const t of r.teams) for (const id of await teamMemberIds(tx, t, "member")) ids.add(id);
  if (inst.authorUserId) ids.delete(inst.authorUserId);
  if (!ids.size) return;
  await notify(
    tx,
    {
      orgId: inst.orgId,
      event: "review.awaiting",
      title: `Tài liệu chờ duyệt: ${inst.docTitle}`,
      body: `Checkpoint “${gate.name}” của quy trình ${inst.workflowName} chờ bạn duyệt (${inst.docKey}).`,
      eventKey: `review:${inst.id}:${inst.gateIndex}:${Date.now()}`,
      recipientIds: [...ids],
      link: deps.publicUrl ? `${deps.publicUrl.replace(/\/+$/, "")}/knowledge/reviews?id=${inst.id}` : null,
      actions: [
        { kind: "review.approve", reviewId: inst.id },
        { kind: "review.changes", reviewId: inst.id },
      ],
    },
    { jobs: deps.jobs },
  );
}

export async function decideReview(
  tx: Tx,
  userId: string,
  raw: ReviewDecideInput,
  rawDeps: ReviewDeps,
): Promise<ReviewDetail> {
  const deps = hooksOf(rawDeps);
  const input = reviewDecideInput.parse(raw);
  const principal: Principal = { kind: "user", userId };
  const reader = await readerFor(tx, principal);
  const [inst] = await tx.select().from(reviewInstances).where(eq(reviewInstances.id, input.id)).for("update");
  if (!inst || !(await canSeeReview(tx, reader, inst))) throw notFound();
  const flat = flatGates(inst.phases);
  const cur = flat[inst.gateIndex];
  const run = await currentRun(tx, inst);
  if (!cur || !run || !canDecideAt(reader, cur.gate, inst, run)) {
    if (inst.status !== "in_review")
      throw new ConflictError("REVIEW_CLOSED", "Phiên duyệt đã kết thúc hoặc đang chờ checkpoint khác.");
    throw new ForbiddenError("REVIEW_NOT_REVIEWER", "Bạn không phải người duyệt của checkpoint hiện tại.");
  }
  const gate = cur.gate;
  if (input.decision === "approve") {
    const approvals = [...run.approvals, { userId, at: new Date().toISOString() }];
    const done = approvals.length >= requiredApprovals(gate) || isOrgAdmin(reader);
    await tx
      .update(reviewGateRuns)
      .set({
        approvals,
        ...(done ? { status: "passed", decidedBy: userId, note: input.note ?? null, finishedAt: sql`now()` } : {}),
      })
      .where(eq(reviewGateRuns.id, run.id));
    await audit(tx, principal, "review.approve", { type: "review", id: inst.id }, { gate: gate.id, done });
    if (done) {
      const p = await loadProposal(tx, inst.proposalId);
      const next = await afterPass(tx, inst, gate, p, deps, userId);
      if (next === "done") await finish(tx, inst, p, userId, deps);
      else await advance(tx, { ...inst, gateIndex: inst.gateIndex + 1 }, deps, userId);
    }
  } else {
    const route = input.route ?? gate.onReject;
    await tx
      .update(reviewGateRuns)
      .set({ status: "failed", decidedBy: userId, note: input.note ?? null, finishedAt: sql`now()` })
      .where(eq(reviewGateRuns.id, run.id));
    await audit(tx, principal, "review.request_changes", { type: "review", id: inst.id }, { gate: gate.id, route });
    await requestChanges(tx, inst, route, input.note ?? "", userId, deps);
  }
  return getReview(tx, userId, inst.id, deps);
}

// ---- Gate AI và CI (job) ---------------------------------------------------------------------------------------

/** Kết quả gate chờ việc nền (AI, CI): đạt thì đi tiếp, không đạt thì trả về người viết. */
export async function completeWaitingGate(
  tx: Tx,
  instanceId: string,
  kind: "ai" | "ext",
  result: {
    passed: boolean;
    score?: number | null;
    checklist?: ChecklistItem[];
    note?: string | null;
    runId?: string | null;
  },
  rawDeps: ReviewDeps,
): Promise<void> {
  const deps = hooksOf(rawDeps);
  const [inst] = await tx.select().from(reviewInstances).where(eq(reviewInstances.id, instanceId)).for("update");
  if (inst?.status !== "in_review") return;
  const cur = flatGates(inst.phases)[inst.gateIndex];
  const run = await currentRun(tx, inst);
  if (!cur || cur.gate.kind !== kind || run?.status !== "waiting") return;
  await tx
    .update(reviewGateRuns)
    .set({
      status: result.passed ? "passed" : "failed",
      score: result.score ?? null,
      checklist: result.checklist ?? [],
      note: result.note ?? null,
      runId: result.runId ?? run.runId,
      finishedAt: sql`now()`,
    })
    .where(eq(reviewGateRuns.id, run.id));
  const p = await loadProposal(tx, inst.proposalId);
  if (!result.passed) {
    await requestChanges(tx, inst, "author", result.note ?? `Không đạt checkpoint “${cur.gate.name}”.`, null, deps);
    return;
  }
  const next = await afterPass(tx, inst, cur.gate, p, deps, null);
  if (next === "done") await finish(tx, inst, p, null, deps);
  else await advance(tx, { ...inst, gateIndex: inst.gateIndex + 1 }, deps, null);
}

/** Kết quả run kiểm của gate AI: đạt khi run không lỗi và điểm từ ngưỡng của gate trở lên. */
export async function applyAiResult(
  tx: Tx,
  data: Extract<ReviewJob, { kind: "ai-result" }>,
  deps: ReviewDeps,
): Promise<void> {
  const [inst] = await tx.select().from(reviewInstances).where(eq(reviewInstances.id, data.instanceId));
  const passScore = inst ? (flatGates(inst.phases)[inst.gateIndex]?.gate.ai?.passScore ?? null) : null;
  const passed = data.error === null && data.score !== null && passScore !== null && data.score >= passScore;
  const note =
    data.error ?? data.summary ?? (passed ? null : `Điểm ${data.score ?? "—"} dưới ngưỡng ${passScore ?? "—"}.`);
  await completeWaitingGate(
    tx,
    data.instanceId,
    "ai",
    { passed, score: data.score, checklist: data.checklist, note, runId: data.runId },
    deps,
  );
}

/** Gate AI đang chờ: ghi run của agent kiểm để hiện ở phiên duyệt. */
export async function attachGateRun(tx: Tx, instanceId: string, runId: string): Promise<void> {
  const [inst] = await tx.select().from(reviewInstances).where(eq(reviewInstances.id, instanceId));
  if (!inst) return;
  const run = await currentRun(tx, inst);
  if (run?.status === "waiting") await tx.update(reviewGateRuns).set({ runId }).where(eq(reviewGateRuns.id, run.id));
}

/** Dữ liệu để dựng lời nhắc cho agent kiểm của gate AI. */
export async function aiGateContext(tx: Tx, instanceId: string) {
  const [inst] = await tx.select().from(reviewInstances).where(eq(reviewInstances.id, instanceId));
  if (inst?.status !== "in_review") return null;
  const cur = flatGates(inst.phases)[inst.gateIndex];
  if (cur?.gate.kind !== "ai" || !cur.gate.ai) return null;
  const run = await currentRun(tx, inst);
  if (run?.status !== "waiting" || run.runId) return null;
  const p = await loadProposal(tx, inst.proposalId);
  return {
    instance: inst,
    gate: cur.gate,
    checks: cur.gate.ai.checks,
    passScore: cur.gate.ai.passScore,
    model: cur.gate.ai.model ?? null,
    content: p.content,
    base: await docContentAt(tx, inst.docKey, p.baseVersion),
  };
}

// ---- Đọc -------------------------------------------------------------------------------------------------------

async function names(tx: Tx, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const rows = await tx
    .select({ id: authUser.id, name: authUser.name })
    .from(authUser)
    .where(inArray(authUser.id, unique));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Dấu tự duyệt của checkpoint (lưu cùng lượt duyệt của `system:ai-auto`), để màn duyệt hiện và cho phép thu hồi. */
function autoOf(run: GateRunRow | undefined): { auto: NonNullable<StoredApproval["auto"]> } | Record<string, never> {
  const auto = (run?.approvals as StoredApproval[] | undefined)?.find((a) => a.userId === AI_AUTO_ACTOR)?.auto;
  return auto ? { auto } : {};
}

/** Lượt chạy bắt đầu sau cùng, như `order by started_at desc limit 1` của currentRun. */
function latestRun(rows: GateRunRow[]): GateRunRow | null {
  return rows.reduce<GateRunRow | null>((a, r) => (!a || r.startedAt > a.startedAt ? r : a), null);
}

/** Mọi lượt chạy gate của các phiên, theo phiên; một truy vấn cho cả trang danh sách. */
async function gateRunsOf(tx: Tx, instanceIds: string[]): Promise<Map<string, GateRunRow[]>> {
  const byInstance = new Map<string, GateRunRow[]>();
  if (!instanceIds.length) return byInstance;
  const rows = await tx.select().from(reviewGateRuns).where(inArray(reviewGateRuns.instanceId, instanceIds));
  for (const r of rows) byInstance.set(r.instanceId, [...(byInstance.get(r.instanceId) ?? []), r]);
  return byInstance;
}

/** `gateRuns` là mọi lượt chạy gate của phiên, người gọi đọc sẵn để danh sách không hỏi database cho từng phiên. */
function summarize(
  reader: Reader,
  inst: InstanceRow,
  nameOf: Map<string, string>,
  gateRuns: GateRunRow[],
): ReviewSummary {
  const flat = flatGates(inst.phases);
  const cur = inst.status === "in_review" ? flat[inst.gateIndex] : undefined;
  const run = cur ? latestRun(gateRuns.filter((r) => r.gateIndex === inst.gateIndex)) : null;
  const ai = latestRun(gateRuns.filter((r) => r.score !== null));
  return {
    id: inst.id,
    proposalId: inst.proposalId,
    docKey: inst.docKey,
    docTitle: inst.docTitle,
    docType: docTypeOf(inst.docKey),
    workflowId: inst.workflowId ?? inst.id,
    workflowName: inst.workflowName,
    status: inst.status as ReviewSummary["status"],
    gate: cur
      ? {
          id: cur.gate.id,
          name: cur.gate.name,
          kind: cur.gate.kind,
          phase: cur.phase,
          index: cur.index,
          total: flat.length,
          dueAt: iso(run?.dueAt ?? null),
          sla: run ? slaOf(run.dueAt, run.startedAt) : "none",
        }
      : null,
    author: {
      userId: inst.authorUserId,
      runId: inst.authorRunId,
      name: inst.authorUserId ? (nameOf.get(inst.authorUserId) ?? inst.authorUserId) : "Agent",
    },
    awaitingMe: !!cur && canDecideAt(reader, cur.gate, inst, run),
    aiScore: ai?.score ?? null,
    addedLines: inst.addedLines,
    deletedLines: inst.deletedLines,
    createdAt: inst.createdAt.toISOString(),
    updatedAt: inst.updatedAt.toISOString(),
  };
}

export async function listReviews(
  tx: Tx,
  userId: string,
  raw: z.input<typeof reviewListInput>,
): Promise<{ items: ReviewSummary[]; nextCursor: string | null }> {
  const input = reviewListInput.parse(raw);
  const reader = await readerFor(tx, { kind: "user", userId });
  const items: ReviewSummary[] = [];
  let cursor = input.cursor ?? null;
  // "Chờ tôi duyệt" lọc theo người duyệt sau khi đọc; đọc thêm vài trang để đủ một trang kết quả.
  for (let page = 0; page < 10 && items.length < input.limit; page++) {
    const [at, id] = cursor ? cursor.split("~") : [];
    const rows = await tx
      .select()
      .from(reviewInstances)
      .where(
        and(
          visibleWhere(reader, reviewInstances, undefined),
          input.status ? eq(reviewInstances.status, input.status) : undefined,
          input.scope === "mine" ? eq(reviewInstances.status, "in_review") : undefined,
          at && id
            ? or(
                lt(reviewInstances.updatedAt, new Date(at)),
                and(eq(reviewInstances.updatedAt, new Date(at)), lt(reviewInstances.id, id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(reviewInstances.updatedAt), desc(reviewInstances.id))
      .limit(input.limit);
    if (!rows.length) {
      cursor = null;
      break;
    }
    const nameOf = await names(
      tx,
      rows.map((r) => r.authorUserId ?? ""),
    );
    const gateRuns = await gateRunsOf(
      tx,
      rows.map((r) => r.id),
    );
    for (const r of rows) {
      const s = summarize(reader, r, nameOf, gateRuns.get(r.id) ?? []);
      if (input.scope === "all" || s.awaitingMe) items.push(s);
      cursor = `${r.updatedAt.toISOString()}~${r.id}`;
      if (items.length >= input.limit) break;
    }
    if (rows.length < input.limit && items.length < input.limit) {
      cursor = null;
      break;
    }
  }
  return { items, nextCursor: items.length >= input.limit ? cursor : null };
}

async function traceOf(
  tx: Tx,
  userId: string,
  inst: InstanceRow,
  content: string,
  deps: ReviewDeps,
): Promise<RequirementTrace[]> {
  const custom = await deps.traceFor?.(tx, { userId, docKey: inst.docKey, content, projectId: inst.projectId });
  if (custom) return custom;
  const reqs = requirementsOf(content);
  if (!reqs.length) return [];
  const tasks = inst.projectId ? await listTasks(tx, userId, inst.projectId).catch(() => []) : [];
  return reqs.map((r) => ({
    id: r.id,
    text: r.text,
    acceptance: r.acceptance,
    tasks: tasks
      .filter((t) => new RegExp(`\\b${r.id}\\b`).test(`${t.title}\n${t.body ?? ""}`))
      .map((t) => ({ key: t.key, title: t.title, status: t.status })),
  }));
}

export async function getReview(tx: Tx, userId: string, id: string, rawDeps?: ReviewDeps): Promise<ReviewDetail> {
  const deps = hooksOf(rawDeps);
  const reader = await readerFor(tx, { kind: "user", userId });
  const [inst] = await tx.select().from(reviewInstances).where(eq(reviewInstances.id, id));
  if (!inst || !(await canSeeReview(tx, reader, inst))) throw notFound();
  const p = await loadProposal(tx, inst.proposalId);
  const runs = await tx
    .select()
    .from(reviewGateRuns)
    .where(eq(reviewGateRuns.instanceId, inst.id))
    .orderBy(asc(reviewGateRuns.startedAt), asc(reviewGateRuns.gateIndex));
  const nameOf = await names(tx, [
    inst.authorUserId ?? "",
    ...runs.flatMap((r) => [r.decidedBy ?? "", ...r.approvals.map((a) => a.userId)]),
  ]);
  nameOf.set(AI_AUTO_ACTOR, "Tự duyệt AI");
  const flat = flatGates(inst.phases);
  const latest = new Map<number, GateRunRow>();
  for (const r of runs) latest.set(r.gateIndex, r);
  const gates: GateRun[] = flat.map(({ gate, phase, index }) => {
    const r = latest.get(index);
    return {
      gateId: gate.id,
      name: gate.name,
      kind: gate.kind,
      phase,
      status: (r?.status as GateRun["status"] | undefined) ?? "waiting",
      score: r?.score ?? null,
      checklist: r?.checklist ?? [],
      approvals: (r?.approvals ?? []).map((a) => ({
        userId: a.userId,
        name: nameOf.get(a.userId) ?? a.userId,
        at: a.at,
      })),
      note: r?.note ?? null,
      decidedBy: r?.decidedBy ? (nameOf.get(r.decidedBy) ?? r.decidedBy) : null,
      startedAt: iso(r?.startedAt ?? null),
      finishedAt: iso(r?.finishedAt ?? null),
      runId: r?.runId ?? null,
      ...autoOf(r),
    };
  });
  // Gate chưa tới (sau gate hiện tại) chưa có lượt chạy: hiện là chờ nhưng không có thời điểm bắt đầu.
  const summary = summarize(reader, inst, nameOf, runs);
  const cur = flat[inst.gateIndex];
  const previous = flat
    .slice(0, inst.gateIndex)
    .reverse()
    .find((f) => f.gate.kind === "human");
  return {
    ...summary,
    baseVersion: p.baseVersion,
    baseContent: await docContentAt(tx, inst.docKey, p.baseVersion),
    content: p.content,
    reason: p.reason,
    gates,
    trace: await traceOf(tx, userId, inst, p.content, deps),
    canDecide:
      !!cur && canDecideAt(reader, cur.gate, inst, latestRun(runs.filter((r) => r.gateIndex === inst.gateIndex))),
    previousGate: previous?.gate.id ?? null,
    currentGate: inst.status === "in_review" ? (cur?.gate ?? null) : null,
  };
}
