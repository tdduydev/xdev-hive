import { type SdlcPhase, type SdlcStep, sdlcFinding, sdlcItemRef } from "@xdev-hive/contracts";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/index.ts";
import { loadProject } from "../catalog/index.ts";
import { notify } from "../notify/index.ts";
import { ConflictError, type Tx } from "../platform/index.ts";
import { activeItemProjects, itemViewers } from "./access.ts";
import type { SdlcDeps, SdlcItemRow, SdlcStepStart } from "./phases.ts";
import { sdlcItemPhases, sdlcItems, sdlcSteps, sdlcTraceLinks } from "./schema.ts";

/*
 * Converge (US10, plan.md "Luồng" bước 8): agent đối chiếu tài liệu đã duyệt với code ở đầu nhánh mặc định. Hạng mục nhiều
 * dự án chạy một run mỗi dự án (repo và máy của đội đó) cùng một vòng; vòng xong khi mọi run kết luận. Còn yêu cầu chưa
 * đạt và còn vòng thì phát hiện thành chỉ dẫn cho bước soạn tài liệu tách việc (thêm task, đi cổng như thường).
 */

type StepRow = typeof sdlcSteps.$inferSelect;

/** Tác nhân của bước soạn tài liệu tách việc mà converge giao. */
export const SDLC_CONVERGE_ACTOR = "system:sdlc-converge";

/** `sdlc_report findings` gắn dự án của run (mcp-tools.ts); thiếu thì coi là dự án chính. */
export const convergeFinding = sdlcFinding.extend({ projectId: z.string().optional() });
export type ConvergeFinding = z.output<typeof convergeFinding>;

const RANK: Record<ConvergeFinding["status"], number> = { met: 0, partial: 1, missing: 2, contradicts: 3 };
const MAX_LISTED = 50;
const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

export function findingsOf(result: Record<string, unknown> | null): ConvergeFinding[] | null {
  const parsed = convergeFinding.array().safeParse(result?.findings);
  return parsed.success ? parsed.data : null;
}

/**
 * Gộp phát hiện của các dự án theo yêu cầu, lấy mức xấu nhất: dự án nào còn thiếu thì yêu cầu chưa đạt. Trả yêu cầu chưa
 * đạt theo thứ tự xuất hiện; rỗng là đã hội tụ.
 */
export function convergeGaps(findings: readonly ConvergeFinding[]): { requirementId: string; status: string }[] {
  const worst = new Map<string, ConvergeFinding["status"]>();
  for (const f of findings) {
    const was = worst.get(f.requirementId);
    if (!was || RANK[f.status] > RANK[was]) worst.set(f.requirementId, f.status);
  }
  return [...worst].filter(([, s]) => s !== "met").map(([requirementId, status]) => ({ requirementId, status }));
}

/** Chỉ dẫn cho bước soạn tài liệu tách việc: hai hướng của `contradicts` để người duyệt chọn ở cổng tách task. */
export function convergeFeedback(
  round: number,
  findings: readonly ConvergeFinding[],
  keys: ReadonlyMap<string, string>,
): string {
  const open = findings
    .filter((f) => f.status !== "met")
    .sort((a, b) => RANK[b.status] - RANK[a.status] || a.requirementId.localeCompare(b.requirementId));
  const lines = open.slice(0, MAX_LISTED).map((f) => {
    const where = f.projectId && keys.get(f.projectId) ? ` · @${keys.get(f.projectId)}` : "";
    const task = f.suggestedTask ? ` Đề xuất: ${clip(f.suggestedTask, 300)}` : "";
    return `- ${f.requirementId} · ${f.status}${where}: ${clip(f.evidence.replace(/\s+/g, " ").trim(), 400)}${task}`;
  });
  if (open.length > MAX_LISTED) lines.push(`- … và ${open.length - MAX_LISTED} phát hiện khác.`);
  return [
    `Converge vòng ${round} còn ${convergeGaps(open).length} yêu cầu chưa đạt. Bổ sung task vào tài liệu này, giữ nguyên task`,
    "đã có và đánh số tiếp; mỗi task mới ghi mã yêu cầu và thẻ dự án nếu hạng mục có nhiều dự án.",
    "- missing, partial: thêm task làm phần còn thiếu.",
    "- contradicts: thêm task sửa code cho khớp tài liệu. Nếu chính tài liệu sai, người duyệt bỏ task đó ở cổng và sửa",
    '  tài liệu chứa yêu cầu (hướng "Sửa tài liệu").',
    "Phát hiện:",
    ...lines,
  ].join("\n");
}

/** `items.step` với bước converge: đã hội tụ hoặc hết vòng thì không chạy thêm (US10-1: không tự tạo vòng vượt mức). */
export function assertCanConverge(item: SdlcItemRow): void {
  if (item.convergedAt) throw new ConflictError("SDLC_CONVERGED", "Hạng mục đã hội tụ, không cần chạy converge thêm.");
  const max = item.mode.converge.maxRounds;
  if (max > 0 && item.convergeRound >= max)
    throw new ConflictError(
      "SDLC_CONVERGE_ROUNDS",
      `Đã chạy hết ${max} vòng converge. Sửa tay hoặc bỏ qua giai đoạn để đi tiếp.`,
    );
}

/**
 * Mở vòng mới: dòng bước vừa ghi là của dự án chính, mỗi dự án tham gia thêm một dòng cùng vòng; `start` tạo run trên
 * repo và máy của dự án đó. Trả run của dự án chính như bước thường.
 */
export async function startConverge(
  tx: Tx,
  input: SdlcStepStart,
  start: (tx: Tx, input: SdlcStepStart, projectId: string) => Promise<{ runId: string } | null>,
): Promise<{ runId: string } | null> {
  const { item } = input;
  const round = item.convergeRound + 1;
  await tx.update(sdlcItems).set({ convergeRound: round, updatedAt: sql`now()` }).where(eq(sdlcItems.id, item.id));
  const [row] = await tx.update(sdlcSteps).set({ round }).where(eq(sdlcSteps.id, input.stepRowId)).returning();
  if (!row) return null;
  const projects = (await activeItemProjects(tx, item.id)).map((m) => m.projectId);
  const others = projects.filter((id) => id !== item.projectId);
  const first = await start(tx, { ...input, round }, item.projectId);
  for (const projectId of others) {
    const [extra] = await tx
      .insert(sdlcSteps)
      .values({
        orgId: row.orgId,
        itemId: row.itemId,
        phaseId: row.phaseId,
        stepId: row.stepId,
        action: row.action,
        round,
        instructions: row.instructions,
        createdBy: row.createdBy,
      })
      .returning({ id: sdlcSteps.id });
    if (extra) await start(tx, { ...input, stepRowId: extra.id, round }, projectId);
  }
  return first;
}

/** Ghi phát hiện của một run thành liên kết `finding` (ma trận truy vết đọc lần gần nhất); ghi lại thì cập nhật. */
async function linkFindings(tx: Tx, item: SdlcItemRow, row: StepRow, findings: readonly ConvergeFinding[]) {
  const values = findings.map((f) => {
    const projectId = f.projectId ?? item.projectId;
    return {
      orgId: item.orgId,
      itemId: item.id,
      requirementId: f.requirementId,
      kind: "finding" as const,
      ref: `converge-${row.round}-${projectId}`,
      projectId,
      runId: row.runId,
      data: {
        status: f.status,
        evidence: f.evidence,
        round: row.round,
        ...(f.suggestedTask ? { suggestedTask: f.suggestedTask } : {}),
      },
    };
  });
  // Agent báo hai lần cùng yêu cầu trong một run: lần sau thắng, như `sdlc_report` ghi đè.
  const unique = [...new Map(values.map((v) => [`${v.requirementId}\u0000${v.ref}`, v])).values()];
  if (!unique.length) return;
  await tx
    .insert(sdlcTraceLinks)
    .values(unique)
    .onConflictDoUpdate({
      target: [sdlcTraceLinks.itemId, sdlcTraceLinks.requirementId, sdlcTraceLinks.kind, sdlcTraceLinks.ref],
      set: { data: sql`excluded.data`, runId: sql`excluded.run_id` },
    });
}

export interface ConvergeFollowUp {
  phase: SdlcPhase;
  step: SdlcStep;
  instructions: string;
}

export interface ConvergeSettled {
  message: string;
  followUp: ConvergeFollowUp | null;
}

async function noteConverge(tx: Tx, item: SdlcItemRow, phaseId: string, note: string | null) {
  await tx
    .update(sdlcItemPhases)
    .set({ note })
    .where(and(eq(sdlcItemPhases.itemId, item.id), eq(sdlcItemPhases.phaseId, phaseId)));
}

async function notifyOwner(tx: Tx, item: SdlcItemRow, title: string, body: string, deps: SdlcDeps) {
  const recipientIds = await itemViewers(tx, item, [item.ownerUserId]);
  if (!recipientIds.length) return;
  const home = await loadProject(tx, item.projectId);
  const ref = sdlcItemRef(item.number);
  await notify(
    tx,
    {
      orgId: item.orgId,
      event: "sdlc.converged",
      title,
      body,
      recipientIds,
      eventKey: `sdlc.converged:${item.id}:${item.convergeRound}`,
      link: deps.publicUrl && home ? `${deps.publicUrl.replace(/\/+$/, "")}/sdlc/${home.key}/${ref}` : null,
    },
    { jobs: deps.jobs },
  );
}

/**
 * Gọi khi một run converge kết luận (dòng bước đã ghi trạng thái). Vòng còn run chạy thì chờ; có run lỗi thì vòng không
 * kết luận được. Hết yêu cầu chưa đạt thì hội tụ; còn thì giao bước soạn tài liệu tách việc nếu còn vòng, hết vòng thì
 * dừng và báo chủ hạng mục. `item` đã khoá; người gọi đi tiếp (`scheduleAdvance`) để giai đoạn đạt khi hội tụ.
 */
export async function settleConverge(
  tx: Tx,
  item: SdlcItemRow,
  row: StepRow,
  deps: SdlcDeps,
): Promise<ConvergeSettled> {
  const round = row.round;
  const rows = await tx
    .select()
    .from(sdlcSteps)
    .where(
      and(
        eq(sdlcSteps.itemId, item.id),
        eq(sdlcSteps.phaseId, row.phaseId),
        eq(sdlcSteps.action, "converge"),
        eq(sdlcSteps.round, round),
      ),
    );
  const tagged = (r: StepRow) =>
    (findingsOf(r.result) ?? []).map((f) => ({ ...f, projectId: f.projectId ?? item.projectId }));
  const current = rows.find((r) => r.id === row.id);
  if (current?.status === "succeeded") await linkFindings(tx, item, current, tagged(current));

  const pending = rows.filter((r) => r.status === "queued" || r.status === "running").length;
  if (pending) return { message: `Vòng converge ${round} còn ${pending} run chưa xong.`, followUp: null };
  const failed = rows.filter((r) => r.status !== "succeeded").length;
  if (failed) {
    await noteConverge(
      tx,
      item,
      row.phaseId,
      `Vòng converge ${round} có ${failed} run lỗi hoặc bị huỷ nên chưa kết luận; xem log rồi chạy vòng mới.`,
    );
    return { message: `Vòng converge ${round} chưa kết luận vì có run lỗi.`, followUp: null };
  }

  const findings = rows.flatMap(tagged);
  const gaps = convergeGaps(findings);
  const max = item.mode.converge.maxRounds;
  const ref = sdlcItemRef(item.number);
  await recordAudit(tx, {
    action: "sdlc.converge.round",
    actorUserId: null,
    targetType: "sdlc_item",
    targetId: item.id,
    data: { round, runs: rows.length, findings: findings.length, gaps: gaps.map((g) => g.requirementId) },
  });
  if (!gaps.length) {
    await tx.update(sdlcItems).set({ convergedAt: sql`now()`, updatedAt: sql`now()` }).where(eq(sdlcItems.id, item.id));
    await noteConverge(tx, item, row.phaseId, null);
    await notifyOwner(tx, item, `Hạng mục ${ref} đã hội tụ`, `${item.title}: mọi yêu cầu đạt ở vòng ${round}.`, deps);
    return { message: `Đã hội tụ ở vòng ${round}.`, followUp: null };
  }
  if (max > 0 && round >= max) {
    const note = `Hết ${max} vòng converge, còn ${gaps.length} yêu cầu chưa đạt: sửa tay hoặc bỏ qua giai đoạn.`;
    await noteConverge(tx, item, row.phaseId, note);
    await notifyOwner(tx, item, `Hạng mục ${ref} chưa hội tụ sau ${max} vòng`, `${item.title}: ${note}`, deps);
    return { message: note, followUp: null };
  }

  const d = item.mode.decomposition;
  const phase = d ? item.mode.phases.find((p) => p.id === d.phase) : undefined;
  const step = phase?.steps.find((s) => s.action === "draft" && d && s.artifacts.includes(d.artifact));
  if (!phase || !step) {
    const note = `Vòng converge ${round} còn ${gaps.length} yêu cầu chưa đạt; chế độ không có bước soạn tài liệu tách việc nên cần thêm task tay.`;
    await noteConverge(tx, item, row.phaseId, note);
    return { message: note, followUp: null };
  }
  const keys = new Map<string, string>();
  for (const id of new Set(findings.map((f) => f.projectId))) keys.set(id, (await loadProject(tx, id))?.key ?? id);
  await noteConverge(
    tx,
    item,
    row.phaseId,
    `Vòng converge ${round} còn ${gaps.length} yêu cầu chưa đạt; agent bổ sung task vào tài liệu tách việc.`,
  );
  return {
    message: `Vòng converge ${round} còn ${gaps.length} yêu cầu chưa đạt.`,
    followUp: { phase, step, instructions: convergeFeedback(round, findings, keys) },
  };
}
