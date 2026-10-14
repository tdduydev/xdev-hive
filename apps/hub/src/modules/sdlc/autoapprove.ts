import { implement } from "@orpc/server";
import {
  contract,
  type FindingSeverity,
  foldText,
  isHeavySdlc,
  matchGlob,
  type OrgSdlcPolicy,
  type ProjectSdlcSettings,
  type ReviewGate,
  type ReviewPhase,
  type SdlcArtifactScope,
  type SdlcAutoApproval,
  type SdlcAutoApprove,
  type SdlcPhaseKind,
  type SdlcSize,
  sdlcItemRef,
} from "@xdev-hive/contracts";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { recordAudit } from "../audit/index.ts";
import { loadProject } from "../catalog/index.ts";
import { sdlcPolicyOf } from "../governance/index.ts";
import { authUser } from "../identity/index.ts";
import {
  type AutoDecideRequest,
  createProposal,
  eligible,
  flatGates,
  getDoc,
  type AutoDecision as ReviewAutoDecision,
  type ReviewDeps,
  readerFor,
  startReview,
} from "../knowledge/index.ts";
import { notify } from "../notify/index.ts";
import {
  ConflictError,
  ForbiddenError,
  type Jobs,
  NotFoundError,
  type RequestContext,
  type Tx,
} from "../platform/index.ts";
import { type OrgDeps, orgMiddlewares, teamMemberIds } from "../tenancy/index.ts";
import { activeItemProjects, hasTeamPermission, itemForUser, itemViewers, type SdlcItemRow } from "./access.ts";
import { sdlcArtifacts, sdlcAutoApprovals, sdlcItemPhases, sdlcItems } from "./schema.ts";

// Tự duyệt AI (specs/011 D25, D26): `decide` giữ phần thuần (điều kiện nào cho phép hub thay người duyệt một
// checkpoint); phần dưới đọc DB cho hook `autoDecide` của knowledge, ghi `sdlc_auto_approvals` và thu hồi.

/** Một dự án có tiếng nói trong quyết định: dự án của checkpoint, hoặc mọi dự án tham gia khi cổng là cổng chung. */
export interface AutoProjectInput {
  key: string;
  autoApprove: ProjectSdlcSettings["autoApprove"];
}

/** Một reviewer AI của checkpoint `ai` đã đạt trong phiên. */
export interface AutoReviewerInput {
  cli: string;
  model: string | null;
  score: number | null;
}

export interface AutoDecideInput {
  org: OrgSdlcPolicy["autoApprove"];
  projects: AutoProjectInput[];
  mode: { sizes: readonly SdlcSize[] };
  item: { size?: SdlcSize | undefined };
  phase: { id: string; kind: SdlcPhaseKind; autoApprove?: SdlcAutoApprove | undefined };
  /** Id checkpoint người đang chờ. */
  gateId: string;
  artifact: { scope: SdlcArtifactScope };
  /** `null`: phiên chưa có checkpoint AI nào đạt. */
  ai: {
    reviewers: AutoReviewerInput[];
    /** Mức nặng nhất trong các phát hiện của reviewer; `null` là không có phát hiện. */
    worstFinding: FindingSeverity | null;
    /** Mục kiểm không đạt (nhãn). */
    failedChecks: string[];
  } | null;
  /** CLI và model của run viết bản nháp; `null` khi người viết tay. */
  author: { cli: string; model: string | null } | null;
  /** Chữ đổi so với baseline (bản đầu thì cả tài liệu) để dò từ khoá nhạy cảm. */
  changedText: string;
  /** Đường dẫn repo nêu trong tài liệu hoặc file của task, để khớp `denyPaths`. */
  paths: string[];
}

export type AutoDecision =
  | { approve: true; score: number; threshold: number; revokeHours: number; reasons: [] }
  | {
      approve: false;
      /** Chế độ không cho tự duyệt cổng này: không phải lý do để hiện cho người duyệt. */
      silent: boolean;
      reasons: string[];
    };

const refuse = (...reasons: string[]): AutoDecision => ({ approve: false, silent: false, reasons });

// So khi thiếu dữ liệu: một bên chưa rõ model thì không chứng minh được là khác tác giả, nên coi là trùng.
const sameAgent = (a: { cli: string; model: string | null }, b: { cli: string; model: string | null }) =>
  a.cli === b.cli && (a.model === null || b.model === null || a.model === b.model);

const normalizePath = (p: string) =>
  p
    .trim()
    .replace(/^(?:\.\/)+/, "")
    .replace(/^\/+/, "");

const SEVERE: readonly FindingSeverity[] = ["critical", "major"];

/**
 * Điều kiện cấu trúc (tổ chức, chế độ, dự án, loại tài liệu) dừng ngay: có một điều kiện trượt là phần còn lại vô nghĩa.
 * Điều kiện chất lượng (điểm, phát hiện, reviewer, nhạy cảm) gom hết để người duyệt thấy đủ lý do trong một lần.
 */
export function decide(input: AutoDecideInput): AutoDecision {
  const { org, phase, projects } = input;
  if (!org.allowed) return refuse("Tổ chức đã tắt tự duyệt.");
  const rule = phase.autoApprove;
  if (!rule?.gates.includes(input.gateId)) return { approve: false, silent: true, reasons: [] };

  const off = projects.filter((p) => {
    const only = p.autoApprove.phases;
    return !p.autoApprove.enabled || (only !== undefined && only.length > 0 && !only.includes(phase.id));
  });
  if (projects.length === 0 || off.length > 0)
    return refuse(
      off.length > 0
        ? `Dự án ${off.map((p) => p.key).join(", ")} chưa bật tự duyệt cho giai đoạn này.`
        : "Hạng mục chưa có dự án nào bật tự duyệt.",
    );
  if (input.artifact.scope === "contract") return refuse("Contract luôn cần người duyệt.");
  if (phase.kind === "requirements" && isHeavySdlc(input.mode.sizes, input.item.size))
    return refuse("Yêu cầu của hạng mục nặng luôn cần người duyệt.");
  if (!input.ai || input.ai.reviewers.length === 0) return refuse("Chưa có điểm review AI.");

  const reasons: string[] = [];
  const scores = input.ai.reviewers.map((r) => r.score);
  // Mức thấp nhất của các reviewer (injection vào một reviewer không kéo điểm chung lên); thiếu điểm của ai là chưa chấm xong.
  const score = scores.includes(null) ? null : Math.min(...(scores as number[]));
  const threshold = Math.max(rule.minScore, org.minScoreFloor, ...projects.map((p) => p.autoApprove.minScore ?? 0));
  if (score === null) reasons.push("Chưa có điểm review AI.");
  else if (score < threshold) reasons.push(`Điểm ${score} < ngưỡng ${threshold}.`);
  if (input.ai.worstFinding && SEVERE.includes(input.ai.worstFinding))
    reasons.push(`Review AI có phát hiện mức ${input.ai.worstFinding}.`);
  if (input.ai.failedChecks.length > 0) reasons.push(`Mục kiểm không đạt: ${input.ai.failedChecks.join("; ")}.`);

  const { author } = input;
  if (author && input.ai.reviewers.some((r) => sameAgent(r, author))) reasons.push("Reviewer trùng tác giả.");

  const folded = foldText(input.changedText);
  const keywords = [...org.denyKeywords, ...projects.flatMap((p) => p.autoApprove.denyKeywords)];
  const keyword = keywords.find((k) => folded.includes(foldText(k)));
  if (keyword) reasons.push(`Từ khoá nhạy cảm '${keyword}'.`);

  const globs = [...org.denyPaths, ...projects.flatMap((p) => p.autoApprove.denyPaths)];
  for (const path of input.paths.map(normalizePath)) {
    if (globs.some((g) => matchGlob(g, path))) {
      reasons.push(`Đường dẫn nhạy cảm ${path}.`);
      break;
    }
  }

  if (reasons.length > 0 || score === null) return refuse(...reasons);
  const revokeHours = Math.max(rule.revokeHours, ...projects.map((p) => p.autoApprove.revokeHours ?? 0));
  return { approve: true, score, threshold, revokeHours, reasons: [] };
}

/** Các điều kiện đã xét khi đồng ý, để màn hạng mục hiện vì sao hub thay người duyệt (US18-1). */
function approvedChecks(
  input: AutoDecideInput,
  decision: Extract<AutoDecision, { approve: true }>,
): { check: string; passed: boolean; detail: string }[] {
  return [
    { check: "org", passed: true, detail: "Tổ chức cho phép tự duyệt." },
    { check: "phase", passed: true, detail: `Chế độ cho tự duyệt cổng ${input.gateId} ở giai đoạn ${input.phase.id}.` },
    {
      check: "projects",
      passed: true,
      detail: `Dự án ${input.projects.map((p) => p.key).join(", ")} đã bật tự duyệt.`,
    },
    { check: "score", passed: true, detail: `Điểm ${decision.score} ≥ ngưỡng ${decision.threshold}.` },
    { check: "findings", passed: true, detail: "Không có phát hiện mức critical/major, mục kiểm đều đạt." },
    { check: "reviewer", passed: true, detail: "Reviewer AI khác tác giả bản nháp." },
    { check: "sensitive", passed: true, detail: "Không có từ khoá hay đường dẫn nhạy cảm." },
  ];
}

// ---- Đọc DB cho hook `autoDecide` ----------------------------------------------------------------------------------

type ArtifactRow = typeof sdlcArtifacts.$inferSelect;
type ApprovalRow = typeof sdlcAutoApprovals.$inferSelect;

/** Lưu trong cột `reasons` để màn hạng mục hiện lại mà không phải tính lại. */
interface StoredReasons {
  checks: { check: string; passed: boolean; detail: string }[];
  reviewer: { cli: string; model: string | null } | null;
  author: { cli: string; model: string | null } | null;
}

export interface AutoApproveDeps {
  jobs?: Jobs | undefined;
  /** Địa chỉ web để link trong thông báo. */
  publicUrl?: string | undefined;
  /** Deps của phiên duyệt lại khi thu hồi; không đặt thì dùng hook đã cài ở main.ts. */
  review?: ReviewDeps | undefined;
}

/** Id checkpoint gốc trong chế độ: cổng theo đội (D21) mang id `<gate>-<đội>` hoặc `<gate>-<n>`. */
function baseGateId(phaseGate: readonly ReviewPhase[], gateId: string): string {
  const ids = phaseGate.flatMap((p) => p.gates.map((g) => g.id));
  if (ids.includes(gateId)) return gateId;
  const prefix = ids.filter((id) => gateId.startsWith(`${id}-`)).sort((a, b) => b.length - a.length)[0];
  if (prefix) return prefix;
  // Id quá dài bị cắt còn 36 ký tự trước số thứ tự đội (phases.teamGateId).
  return ids.find((id) => id.length > 36 && gateId.startsWith(`${id.slice(0, 36)}-`)) ?? gateId;
}

/** Dòng mới trong bản đề xuất so với baseline: từ khoá nhạy cảm chỉ xét phần đổi (D26). */
function addedText(base: string, content: string): string {
  const old = new Set(base.split("\n"));
  return content
    .split("\n")
    .filter((l) => !old.has(l))
    .join("\n");
}

const PATH_RE = /(?:^|[\s`'"(<[])((?:[\w.@-]+\/)+[\w.@-]+)/g;

/** Đường dẫn repo nêu trong phần đổi (vd. `.github/workflows/ci.yml`, `migrations/0001.sql`) để khớp `denyPaths`. */
export function pathsIn(text: string): string[] {
  return [...new Set([...text.matchAll(PATH_RE)].map((m) => m[1] as string).filter((p) => !p.includes("://")))];
}

async function runAgent(tx: Tx, runId: string | null): Promise<{ cli: string; model: string | null } | null> {
  if (!runId) return null;
  // sdlc không import runs (runs gọi cổng của sdlc); đọc cột của run bằng SQL như participants.ts.
  const { rows } = await tx.execute<{ cli: string | null; model: string | null }>(
    sql`select cli, model from hive.runs where id = ${runId}`,
  );
  const row = rows[0];
  return row ? { cli: row.cli ?? "unknown", model: row.model } : null;
}

/** Run của checkpoint AI đã đạt (lượt mới nhất); máy chấm của nó là "reviewer" để so với tác giả. */
async function aiReviewers(
  tx: Tx,
  reviewId: string,
  gateIds: string[],
): Promise<Map<string, { cli: string; model: string | null }>> {
  const out = new Map<string, { cli: string; model: string | null }>();
  if (!gateIds.length) return out;
  const { rows } = await tx.execute<{ gate_id: string; cli: string | null; model: string | null }>(
    sql`select distinct on (g.gate_id) g.gate_id, r.cli, r.model
        from hive.review_gate_runs g join hive.runs r on r.id = g.run_id
        where g.instance_id = ${reviewId} and g.gate_id in ${gateIds} and g.status = 'passed'
        order by g.gate_id, g.started_at desc`,
  );
  for (const r of rows) out.set(r.gate_id, { cli: r.cli ?? "unknown", model: r.model });
  return out;
}

/** Bản đề xuất và baseline nó dựa vào; baseline đọc bằng quyền chủ hạng mục như `onBaseline`. */
async function proposalText(tx: Tx, item: SdlcItemRow, request: AutoDecideRequest): Promise<string> {
  const { rows } = await tx.execute<{ content: string; base_version: number }>(
    sql`select content, base_version from hive.proposals where id = ${request.review.proposalId}`,
  );
  const p = rows[0];
  if (!p) return "";
  if (p.base_version <= 0) return p.content;
  try {
    const base = await getDoc(
      tx,
      { kind: "user", userId: item.ownerUserId },
      { key: request.review.docKey, version: p.base_version },
    );
    return addedText(base.content, p.content);
  } catch {
    // Không đọc được baseline thì xét cả bản: dò nhạy cảm thừa còn hơn sót.
    return p.content;
  }
}

/** Dự án có tiếng nói: dự án của tài liệu riêng, các dự án của đội ở cổng theo đội, hoặc mọi dự án khi cổng chung. */
async function deciderProjects(
  tx: Tx,
  item: SdlcItemRow,
  artifact: ArtifactRow,
  gate: ReviewGate,
): Promise<AutoProjectInput[]> {
  const members = await activeItemProjects(tx, item.id);
  const teamScope = gate.reviewers?.teamScope;
  const chosen =
    artifact.scope === "project"
      ? members.filter((m) => m.projectId === artifact.projectId)
      : teamScope
        ? members.filter((m) => m.teamId === teamScope)
        : members;
  const out: AutoProjectInput[] = [];
  for (const m of chosen)
    out.push({ key: (await loadProject(tx, m.projectId))?.key ?? m.projectId, autoApprove: m.settings.autoApprove });
  return out;
}

async function notifyItem(
  tx: Tx,
  item: SdlcItemRow,
  extraRecipients: string[],
  input: { event: "sdlc.auto_approved" | "sdlc.auto_revoked"; title: string; body: string; eventKey: string },
  deps: AutoApproveDeps,
): Promise<void> {
  const admins = await teamMemberIds(tx, item.teamId, "admin");
  const recipientIds = await itemViewers(tx, item, [item.ownerUserId, ...admins, ...extraRecipients]);
  if (!recipientIds.length) return;
  const home = await loadProject(tx, item.projectId);
  const link =
    deps.publicUrl && home
      ? `${deps.publicUrl.replace(/\/+$/, "")}/sdlc/${home.key}/${sdlcItemRef(item.number)}`
      : null;
  await notify(tx, { orgId: item.orgId, ...input, recipientIds, link }, { jobs: deps.jobs });
}

/**
 * Hook `autoDecide` của knowledge (tiêm ở main.ts): tài liệu không thuộc hạng mục thì `null` để phiên chạy như cũ.
 * Đồng ý thì ghi `sdlc_auto_approvals` trước khi knowledge ghi lượt duyệt `system:ai-auto`, để id lần tự duyệt nằm
 * trong lượt duyệt và nút Thu hồi tìm lại được.
 */
export async function autoDecide(
  tx: Tx,
  request: AutoDecideRequest,
  deps: AutoApproveDeps = {},
): Promise<ReviewAutoDecision | null> {
  const [artifact] = await tx.select().from(sdlcArtifacts).where(eq(sdlcArtifacts.docKey, request.review.docKey));
  if (!artifact) return null;
  const [item] = await tx.select().from(sdlcItems).where(eq(sdlcItems.id, artifact.itemId));
  const phase = item?.mode.phases.find((p) => p.id === artifact.phaseId);
  if (!item || !phase) return null;
  // Phiên duyệt lại sau khi thu hồi: người đã bác lần tự duyệt trước, hub không được tự duyệt lại chính bản đó.
  if (artifact.approval === "revoked")
    return { approve: false, reason: "Tự duyệt của bản này đã bị thu hồi; cần người duyệt." };

  const gateId = baseGateId(phase.gate, request.gate.id);
  const aiPassed = request.checkpoints.filter((c) => c.kind === "ai" && c.status === "passed");
  const agents = await aiReviewers(
    tx,
    request.review.id,
    aiPassed.map((c) => c.gateId),
  );
  const author = await runAgent(tx, request.review.authorRunId);
  const text = await proposalText(tx, item, request);
  const input: AutoDecideInput = {
    org: (await sdlcPolicyOf(tx)).autoApprove,
    projects: await deciderProjects(tx, item, artifact, request.gate),
    mode: { sizes: item.mode.sizes },
    item: { size: item.size },
    phase: { id: phase.id, kind: phase.kind, autoApprove: phase.autoApprove },
    gateId,
    artifact: { scope: artifact.scope },
    ai: aiPassed.length
      ? {
          // Không biết máy nào chấm thì coi như trùng tác giả (cùng luật `sameAgent`): thiếu dữ liệu không được mở cửa.
          reviewers: aiPassed.map((c) => ({
            ...(agents.get(c.gateId) ?? { cli: author?.cli ?? "unknown", model: null }),
            score: c.score,
          })),
          worstFinding: null,
          failedChecks: aiPassed.flatMap((c) => c.checklist.filter((i) => !i.passed).map((i) => i.label)),
        }
      : null,
    author,
    changedText: text,
    paths: pathsIn(text),
  };
  const decision = decide(input);
  if (!decision.approve)
    return decision.silent ? { approve: false } : { approve: false, reason: decision.reasons.join(" ") };

  const reasons: StoredReasons = {
    checks: approvedChecks(input, decision),
    reviewer: input.ai?.reviewers[0] ? { cli: input.ai.reviewers[0].cli, model: input.ai.reviewers[0].model } : null,
    author,
  };
  const values = {
    proposalId: request.review.proposalId,
    score: decision.score,
    threshold: decision.threshold,
    reasons: reasons as unknown as Record<string, unknown>,
    decidedAt: new Date(),
    revocableUntil: new Date(Date.now() + decision.revokeHours * 3_600_000),
  };
  const [row] = await tx
    .insert(sdlcAutoApprovals)
    .values({
      orgId: item.orgId,
      itemId: item.id,
      artifactId: artifact.id,
      reviewId: request.review.id,
      gateId: request.gate.id,
      ...values,
    })
    // Phiên trả lại rồi chạy lại cùng checkpoint: một dòng mỗi (phiên, checkpoint), lần sau thay lần trước.
    .onConflictDoUpdate({ target: [sdlcAutoApprovals.reviewId, sdlcAutoApprovals.gateId], set: values })
    .returning({ id: sdlcAutoApprovals.id });
  if (!row) return { approve: false, reason: "Không ghi được lần tự duyệt." };
  await recordAudit(tx, {
    action: "sdlc.auto_approve",
    targetType: "sdlc_item",
    targetId: item.id,
    data: {
      approvalId: row.id,
      artifactId: artifact.id,
      docKey: artifact.docKey,
      reviewId: request.review.id,
      gateId: request.gate.id,
      score: decision.score,
      threshold: decision.threshold,
      reviewer: reasons.reviewer,
      author,
    },
  });
  await notifyItem(
    tx,
    item,
    [],
    {
      event: "sdlc.auto_approved",
      title: `AI tự duyệt ${request.review.docTitle}`,
      body: `Checkpoint “${request.gate.name}” được tự duyệt với điểm ${decision.score} (ngưỡng ${decision.threshold}). Thu hồi được trong ${decision.revokeHours} giờ nếu thấy chưa ổn.`,
      eventKey: `sdlc:${item.id}:auto_approved:${row.id}`,
    },
    deps,
  );
  return { approve: true, score: decision.score, threshold: decision.threshold, approvalId: row.id };
}

// ---- Danh sách, thu hồi ------------------------------------------------------------------------------------------

/** Tên checkpoint theo bản chụp chế độ; cổng theo đội giữ tên gốc kèm đuôi đội trong id. */
function gateNameOf(item: SdlcItemRow, artifact: ArtifactRow, gateId: string): string {
  const phase = item.mode.phases.find((p) => p.id === artifact.phaseId);
  if (!phase) return gateId;
  const base = baseGateId(phase.gate, gateId);
  const gate = phase.gate.flatMap((p) => p.gates).find((g) => g.id === base);
  return gate ? (base === gateId ? gate.name : `${gate.name} (${gateId.slice(base.length + 1)})`) : gateId;
}

/** Người đủ điều kiện duyệt checkpoint đó trong phiên đã tự duyệt (theo quy trình đã chụp vào phiên). */
async function isGateReviewer(tx: Tx, userId: string, row: ApprovalRow): Promise<boolean> {
  const { rows } = await tx.execute<{ phases: ReviewPhase[]; team_id: string | null; project_id: string | null }>(
    sql`select phases, team_id, project_id from hive.review_instances where id = ${row.reviewId}`,
  );
  const inst = rows[0];
  const gate = inst && flatGates(inst.phases).find((f) => f.gate.id === row.gateId)?.gate;
  if (!inst || !gate) return false;
  const reader = await readerFor(tx, { kind: "user", userId });
  return eligible(reader, gate, { teamId: inst.team_id, projectId: inst.project_id });
}

/** Còn hạn, đã thành baseline, và người xem là chủ hạng mục, có `sdlc.override` ở đội chủ trì, hay người duyệt cổng đó. */
async function canRevoke(tx: Tx, userId: string, item: SdlcItemRow, row: ApprovalRow, now: Date): Promise<boolean> {
  if (row.revokedAt || row.version === null || row.revocableUntil <= now) return false;
  if (item.ownerUserId === userId) return true;
  if (await hasTeamPermission(tx, userId, item.teamId, "sdlc.override")) return true;
  return isGateReviewer(tx, userId, row);
}

async function approvalViews(
  tx: Tx,
  userId: string,
  item: SdlcItemRow,
  rows: ApprovalRow[],
): Promise<SdlcAutoApproval[]> {
  if (!rows.length) return [];
  const artifacts = await tx
    .select()
    .from(sdlcArtifacts)
    .where(
      inArray(
        sdlcArtifacts.id,
        rows.map((r) => r.artifactId),
      ),
    );
  const byId = new Map(artifacts.map((a) => [a.id, a]));
  const nameOfArtifact = new Map(item.mode.phases.flatMap((p) => p.artifacts.map((a) => [`${p.id}/${a.id}`, a.name])));
  const revokers = [...new Set(rows.flatMap((r) => (r.revokedBy ? [r.revokedBy] : [])))];
  const names = new Map(
    (revokers.length
      ? await tx.select({ id: authUser.id, name: authUser.name }).from(authUser).where(inArray(authUser.id, revokers))
      : []
    ).map((u) => [u.id, u.name]),
  );
  const now = new Date();
  const out: SdlcAutoApproval[] = [];
  for (const r of rows) {
    const a = byId.get(r.artifactId);
    if (!a) continue;
    const stored = r.reasons as unknown as Partial<StoredReasons>;
    out.push({
      id: r.id,
      itemId: r.itemId,
      artifactId: r.artifactId,
      docKey: a.docKey,
      artifactName: nameOfArtifact.get(`${a.phaseId}/${a.artifactId}`) ?? a.artifactId,
      reviewId: r.reviewId,
      gateId: r.gateId,
      gateName: gateNameOf(item, a, r.gateId),
      version: r.version,
      score: r.score,
      threshold: r.threshold,
      reasons: stored.checks ?? [],
      reviewer: stored.reviewer ?? null,
      decidedAt: r.decidedAt.toISOString(),
      revocableUntil: r.revocableUntil.toISOString(),
      revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null,
      revokedBy: r.revokedBy ? { userId: r.revokedBy, name: names.get(r.revokedBy) ?? r.revokedBy } : null,
      revokeReason: r.revokeReason,
      rereviewId: r.rereviewId,
      canRevoke: await canRevoke(tx, userId, item, r, now),
    });
  }
  return out;
}

/** Lần tự duyệt của hạng mục, mới nhất trước; cho tab Tự duyệt và `itemDetail`. */
export async function itemAutoApprovals(tx: Tx, userId: string, item: SdlcItemRow): Promise<SdlcAutoApproval[]> {
  const rows = await tx
    .select()
    .from(sdlcAutoApprovals)
    .where(eq(sdlcAutoApprovals.itemId, item.id))
    .orderBy(desc(sdlcAutoApprovals.decidedAt));
  return approvalViews(tx, userId, item, rows);
}

export async function listAutoApprovals(tx: Tx, userId: string, itemId: string): Promise<SdlcAutoApproval[]> {
  return itemAutoApprovals(tx, userId, await itemForUser(tx, userId, itemId));
}

/**
 * Thu hồi (D26, US18-3): tài liệu về `revoked` nên cổng chặn run code mới (SC-015), giai đoạn về `in_review`, và mở một
 * phiên duyệt lại chính baseline đó (`reaffirm`) để người duyệt xác nhận hay trả lại. Run đang chạy không bị dừng.
 */
export async function revokeAutoApproval(
  tx: Tx,
  userId: string,
  input: { id: string; reason: string },
  deps: AutoApproveDeps = {},
): Promise<SdlcAutoApproval> {
  const reason = input.reason.trim();
  if (reason.length < 10) throw new ConflictError("SDLC_REVOKE_REASON", "Lý do thu hồi cần ít nhất 10 ký tự.");
  const [found] = await tx.select().from(sdlcAutoApprovals).where(eq(sdlcAutoApprovals.id, input.id));
  if (!found) throw new NotFoundError("SDLC_AUTO_APPROVAL_NOT_FOUND", "Không tìm thấy lần tự duyệt.");
  const item = await itemForUser(tx, userId, found.itemId, true);
  // Khoá sau hạng mục (cùng thứ tự với onBaseline) để hai người thu hồi cùng lúc thì người sau thấy đã thu hồi.
  const [row] = await tx.select().from(sdlcAutoApprovals).where(eq(sdlcAutoApprovals.id, found.id)).for("update");
  if (!row) throw new NotFoundError("SDLC_AUTO_APPROVAL_NOT_FOUND", "Không tìm thấy lần tự duyệt.");
  if (row.revokedAt) throw new ConflictError("SDLC_AUTO_APPROVAL_REVOKED", "Lần tự duyệt này đã bị thu hồi.");
  if (row.version === null)
    throw new ConflictError(
      "SDLC_AUTO_APPROVAL_PENDING",
      "Phiên duyệt chưa xong; người duyệt các checkpoint sau vẫn trả lại được.",
    );
  const now = new Date();
  if (row.revocableUntil <= now) throw new ConflictError("SDLC_REVOKE_EXPIRED", "Đã quá hạn thu hồi lần tự duyệt này.");
  if (!(await canRevoke(tx, userId, item, row, now)))
    throw new ForbiddenError(
      "SDLC_REVOKE_FORBIDDEN",
      "Chỉ chủ hạng mục, người duyệt checkpoint hoặc người có quyền ngoại lệ AI SDLC thu hồi được.",
    );
  const [artifact] = await tx.select().from(sdlcArtifacts).where(eq(sdlcArtifacts.id, row.artifactId));
  if (!artifact) throw new NotFoundError("SDLC_AUTO_APPROVAL_NOT_FOUND", "Không tìm thấy tài liệu của lần tự duyệt.");
  if (artifact.baselineVersion !== row.version)
    throw new ConflictError(
      "SDLC_REVOKE_STALE",
      "Tài liệu đã có bản duyệt mới hơn; lần tự duyệt này không còn hiệu lực.",
    );

  await tx.update(sdlcArtifacts).set({ approval: "revoked" }).where(eq(sdlcArtifacts.id, artifact.id));
  await tx
    .update(sdlcItemPhases)
    .set({ status: "in_review", approvedAt: null, decidedBy: null })
    .where(
      and(
        eq(sdlcItemPhases.itemId, item.id),
        eq(sdlcItemPhases.phaseId, artifact.phaseId),
        eq(sdlcItemPhases.status, "approved"),
      ),
    );
  await tx.update(sdlcItems).set({ updatedAt: sql`now()` }).where(eq(sdlcItems.id, item.id));

  const principal = { kind: "user" as const, userId };
  const baseline = await getDoc(tx, principal, { key: artifact.docKey, version: row.version });
  const proposal = await createProposal(tx, principal, {
    kind: "doc",
    key: artifact.docKey,
    title: baseline.title,
    content: baseline.content,
    baseVersion: row.version,
    reason: `Duyệt lại sau khi thu hồi tự duyệt: ${reason}`.slice(0, 500),
  });
  const rereview = await startReview(tx, proposal.id, deps.review ?? {}, { reaffirm: true });
  const [updated] = await tx
    .update(sdlcAutoApprovals)
    .set({ revokedAt: now, revokedBy: userId, revokeReason: reason, rereviewId: rereview?.id ?? null })
    .where(eq(sdlcAutoApprovals.id, row.id))
    .returning();
  await recordAudit(tx, {
    action: "sdlc.auto_revoke",
    targetType: "sdlc_item",
    targetId: item.id,
    data: {
      approvalId: row.id,
      artifactId: artifact.id,
      docKey: artifact.docKey,
      version: row.version,
      reason,
      rereviewId: rereview?.id ?? null,
    },
  });
  await notifyItem(
    tx,
    item,
    [],
    {
      event: "sdlc.auto_revoked",
      title: `Đã thu hồi tự duyệt ${baseline.title}`,
      body: `Lý do: ${reason}. Tài liệu đang được duyệt lại; run code mới của hạng mục bị chặn tới khi duyệt xong.`,
      eventKey: `sdlc:${item.id}:auto_revoked:${row.id}`,
    },
    deps,
  );
  const [view] = await approvalViews(tx, userId, item, [updated ?? row]);
  if (!view) throw new NotFoundError("SDLC_AUTO_APPROVAL_NOT_FOUND", "Không tìm thấy lần tự duyệt.");
  return view;
}

// ---- Route `autoApprovals.*` ---------------------------------------------------------------------------------------

/** Hàm đăng ký riêng để router.ts chỉ thêm một dòng `autoApprovals: autoApprovalRoutes(deps)` (T070 gộp). */
export function autoApprovalRoutes(deps: OrgDeps & AutoApproveDeps) {
  const { authed, inOrg } = orgMiddlewares(deps);
  const os = implement(contract.sdlc.autoApprovals).$context<RequestContext>().use(authed).use(inOrg);
  return {
    list: os.list.handler(({ context: { tx, user }, input }) => listAutoApprovals(tx, user.id, input.itemId)),
    revoke: os.revoke.handler(({ context: { tx, user }, input }) => revokeAutoApproval(tx, user.id, input, deps)),
  };
}
