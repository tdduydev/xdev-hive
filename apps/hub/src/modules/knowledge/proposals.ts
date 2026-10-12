import {
  type Proposal,
  type ProposalCreateInput,
  type ProposalDecideInput,
  type ProposalListInput,
  proposalCreateInput,
  proposalDecideInput,
  proposalListInput,
} from "@xdev-hive/contracts";
import { and, desc, eq, sql } from "drizzle-orm";
import { ConflictError, NotFoundError, type Tx } from "../platform/index.ts";
import {
  audit,
  authorColumns,
  authorize,
  authorView,
  canRead,
  iso,
  type Principal,
  projectContext,
  readerFor,
  resolveScope,
  type Scope,
  scopeView,
  versionConflict,
  visibleWhere,
} from "./access.ts";
import { applyDocSave, currentDocVersion, docScope } from "./docs.ts";
import { proposals, reviewInstances } from "./schema.ts";
import { applySkillSave, currentSkillVersion } from "./skills.ts";

type ProposalRow = typeof proposals.$inferSelect;

const notFound = () => new NotFoundError("PROPOSAL_NOT_FOUND", "Không tìm thấy đề xuất.");

function view(p: ProposalRow): Proposal {
  return {
    id: p.id,
    kind: p.kind,
    target: p.target,
    scope: scopeView(p),
    baseVersion: p.baseVersion,
    title: p.title,
    description: p.description,
    content: p.content,
    reason: p.reason,
    status: p.status,
    author: authorView(p),
    createdAt: iso(p.createdAt),
    decidedBy: p.decidedBy,
    decidedAt: p.decidedAt ? iso(p.decidedAt) : null,
    decisionNote: p.decisionNote,
    resultVersion: p.resultVersion,
  };
}

/**
 * Tạo đề xuất sửa tài liệu hoặc skill. Base đã cũ thì báo CONFLICT ngay, để agent đọc lại bản mới rồi đề xuất trên
 * đó, thay vì để người duyệt nhận một đề xuất chắc chắn xung đột.
 */
export async function createProposal(tx: Tx, principal: Principal, input: ProposalCreateInput): Promise<Proposal> {
  const data = proposalCreateInput.parse(input);
  const reader = await readerFor(tx, principal);
  let scope: Scope;
  let current: number;
  if (data.kind === "doc") {
    scope = await docScope(tx, reader, data.key);
    current = await currentDocVersion(tx, data.key);
  } else {
    scope = await resolveScope(tx, reader, data.scope);
    current = await currentSkillVersion(tx, scope, data.name);
  }
  await authorize(tx, reader, scope, "propose");
  if (current !== data.baseVersion)
    throw versionConflict(data.kind === "doc" ? "Tài liệu" : "Skill", current, data.baseVersion);
  const [row] = await tx
    .insert(proposals)
    .values({
      orgId: sql`hive.ctx_org()`,
      teamId: scope.teamId,
      projectId: scope.projectId,
      kind: data.kind,
      target: data.kind === "doc" ? data.key : data.name,
      baseVersion: data.baseVersion,
      title: data.kind === "doc" ? (data.title ?? null) : null,
      description: data.kind === "skill" ? data.description : null,
      content: data.content,
      reason: data.reason ?? null,
      ...authorColumns(principal),
    })
    .returning();
  if (!row) throw new Error("Không ghi được đề xuất.");
  await audit(
    tx,
    principal,
    "proposal.create",
    { type: "proposal", id: row.id },
    { kind: row.kind, target: row.target },
  );
  return view(row);
}

/** Đề xuất sửa tài liệu. Hàm public cho MCP: agent không lưu tài liệu trực tiếp. */
export function proposeDoc(
  tx: Tx,
  principal: Principal,
  input: Omit<Extract<ProposalCreateInput, { kind: "doc" }>, "kind">,
): Promise<Proposal> {
  return createProposal(tx, principal, { ...input, kind: "doc" });
}

export async function listProposals(tx: Tx, principal: Principal, input: ProposalListInput): Promise<Proposal[]> {
  const data = proposalListInput.parse(input);
  const reader = await readerFor(tx, principal);
  const project = await projectContext(tx, reader, data.project);
  const rows = await tx
    .select()
    .from(proposals)
    .where(
      and(
        visibleWhere(reader, proposals, project),
        data.status ? eq(proposals.status, data.status) : undefined,
        data.kind ? eq(proposals.kind, data.kind) : undefined,
      ),
    )
    .orderBy(desc(proposals.createdAt), desc(proposals.id))
    .limit(data.limit)
    .offset(data.offset);
  return rows.map(view);
}

/** Đề xuất đang chờ mà người gọi được quyết; khoá dòng để hai người duyệt cùng lúc không tạo hai phiên bản. */
async function decidable(tx: Tx, principal: Principal, id: string): Promise<ProposalRow> {
  const reader = await readerFor(tx, principal);
  const [p] = await tx.select().from(proposals).where(eq(proposals.id, id)).for("update");
  if (!p || !canRead(reader, p)) throw notFound();
  await authorize(tx, reader, p, "manage");
  if (p.status !== "pending")
    throw new ConflictError(
      "PROPOSAL_DECIDED",
      p.status === "approved" ? "Đề xuất đã được duyệt." : "Đề xuất đã bị từ chối.",
    );
  return p;
}

/**
 * Duyệt: lưu nội dung đề xuất thành phiên bản mới với đúng base của đề xuất. Tài liệu đã đổi sau khi đề xuất thì
 * CONFLICT và đề xuất vẫn chờ, để người duyệt từ chối hoặc nhờ tác giả đề xuất lại trên bản mới.
 */
/** Đề xuất đang đi theo quy trình duyệt thì chỉ quy trình được chốt (trang Duyệt tài liệu), không duyệt tay ở đây. */
async function inReview(tx: Tx, proposalId: string): Promise<boolean> {
  const [r] = await tx
    .select({ id: reviewInstances.id })
    .from(reviewInstances)
    .where(and(eq(reviewInstances.proposalId, proposalId), eq(reviewInstances.status, "in_review")));
  return !!r;
}

export async function approveProposal(tx: Tx, principal: Principal, input: ProposalDecideInput): Promise<Proposal> {
  const data = proposalDecideInput.parse(input);
  const p = await decidable(tx, principal, data.id);
  if (await inReview(tx, p.id))
    throw new ConflictError(
      "PROPOSAL_IN_REVIEW",
      "Đề xuất đang đi theo quy trình duyệt; hãy duyệt ở trang Duyệt tài liệu.",
    );
  const message = data.note ?? p.reason ?? undefined;
  const version =
    p.kind === "doc"
      ? (
          await applyDocSave(
            tx,
            principal,
            p,
            { key: p.target, title: p.title ?? undefined, content: p.content, baseVersion: p.baseVersion, message },
            p.id,
          )
        ).version
      : (
          await applySkillSave(
            tx,
            principal,
            p,
            {
              name: p.target,
              description: p.description ?? "",
              content: p.content,
              baseVersion: p.baseVersion,
              message,
            },
            p.id,
          )
        ).version;
  const row = await decide(tx, principal, p, "approved", data.note, version);
  await audit(tx, principal, "proposal.approve", { type: "proposal", id: p.id }, { kind: p.kind, version });
  return view(row);
}

export async function rejectProposal(tx: Tx, principal: Principal, input: ProposalDecideInput): Promise<Proposal> {
  const data = proposalDecideInput.parse(input);
  const p = await decidable(tx, principal, data.id);
  const row = await decide(tx, principal, p, "rejected", data.note, null);
  // Từ chối thẳng đề xuất đang theo quy trình thì huỷ phiên duyệt của nó.
  await tx
    .update(reviewInstances)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(and(eq(reviewInstances.proposalId, p.id), eq(reviewInstances.status, "in_review")));
  await audit(tx, principal, "proposal.reject", { type: "proposal", id: p.id }, { kind: p.kind });
  return view(row);
}

async function decide(
  tx: Tx,
  principal: Principal,
  p: ProposalRow,
  status: "approved" | "rejected",
  note: string | undefined,
  resultVersion: number | null,
): Promise<ProposalRow> {
  const [row] = await tx
    .update(proposals)
    .set({
      status,
      // authorize("manage") đã chặn run, nên người quyết luôn là người dùng.
      decidedBy: principal.kind === "user" ? principal.userId : null,
      decidedAt: new Date(),
      decisionNote: note ?? null,
      resultVersion,
    })
    .where(eq(proposals.id, p.id))
    .returning();
  if (!row) throw notFound();
  return row;
}
