import { parseTestCaseTable, type QaView, qaCaseDefinition, qaTestReport } from "@xdev-hive/contracts";
import { and, desc, eq, sql } from "drizzle-orm";
import { recordAudit } from "../audit/index.ts";
import { getDoc } from "../knowledge/index.ts";
import { BadRequestError, ConflictError, NotFoundError, type Tx } from "../platform/index.ts";
import { hasTeamPermission, itemForUser, requireProjectWrite, type SdlcItemRow } from "./access.ts";
import { qaChecks, qaFingerprint } from "./qa-gate.ts";
import { type sdlcArtifacts, sdlcItems, sdlcQaCases, sdlcSteps } from "./schema.ts";

export async function qaCases(tx: Tx, itemId: string) {
  return tx.select().from(sdlcQaCases).where(eq(sdlcQaCases.itemId, itemId)).orderBy(sdlcQaCases.code);
}

/** Lỗi bảng phải rollback baseline, tránh cổng qua trong khi TC chưa đồng bộ. */
export async function onQaBaseline(
  tx: Tx,
  item: SdlcItemRow,
  artifact: typeof sdlcArtifacts.$inferSelect,
  version: number,
) {
  if (artifact.artifactId !== "test-cases") return;
  const doc = await getDoc(tx, { kind: "user", userId: item.ownerUserId }, { key: artifact.docKey, version });
  const parsed = parseTestCaseTable(doc.content);
  if (!parsed.ok)
    throw new BadRequestError("QA_CASES_INVALID", parsed.errors.map((e) => `Dòng ${e.line}: ${e.message}`).join(" "));
  const existing = await qaCases(tx, item.id);
  for (const definition of parsed.cases) {
    const old = existing.find((c) => c.code === definition.code);
    if (
      old &&
      !old.retired &&
      JSON.stringify(qaCaseDefinition.parse(old.definition)) === JSON.stringify(qaCaseDefinition.parse(definition))
    )
      continue;
    // Miễn chỉ có hiệu lực với TC đã duyệt lúc quyết định; sửa TC bắt buộc xét lại.
    await tx
      .insert(sdlcQaCases)
      .values({ orgId: item.orgId, itemId: item.id, code: definition.code, definition })
      .onConflictDoUpdate({
        target: [sdlcQaCases.itemId, sdlcQaCases.code],
        set: {
          definition,
          revision: sql`${sdlcQaCases.revision} + 1`,
          retired: false,
          waivedBy: null,
          waiverReason: null,
          waivedAt: null,
          updatedAt: sql`now()`,
        },
      });
  }
  for (const old of existing.filter((c) => !c.retired && !parsed.cases.some((d) => d.code === c.code)))
    await tx
      .update(sdlcQaCases)
      .set({
        retired: true,
        revision: sql`${sdlcQaCases.revision} + 1`,
        waivedBy: null,
        waiverReason: null,
        waivedAt: null,
        updatedAt: sql`now()`,
      })
      .where(eq(sdlcQaCases.id, old.id));
  await recordAudit(tx, {
    action: "sdlc.qa.cases",
    targetType: "sdlc_item",
    targetId: item.id,
    data: { count: parsed.cases.length, version },
  });
}

export async function qaState(tx: Tx, itemId: string) {
  const cases = await qaCases(tx, itemId);
  const [step] = await tx
    .select()
    .from(sdlcSteps)
    .where(and(eq(sdlcSteps.itemId, itemId), eq(sdlcSteps.action, "test-run")))
    .orderBy(desc(sdlcSteps.createdAt), desc(sdlcSteps.id))
    .limit(1);
  const report = qaTestReport.safeParse(step?.result?.["test-results"]);
  const current = step?.status === "succeeded" && step.result?.qaBaseline === qaFingerprint(cases);
  const evidence = report.success ? { report: report.data, current } : null;
  return { cases, step, evidence, checks: qaChecks(cases, evidence) };
}

export async function recordQaReport(tx: Tx, step: typeof sdlcSteps.$inferSelect, raw: unknown) {
  if (step.action !== "test-run")
    throw new BadRequestError("QA_STEP_REQUIRED", "Chỉ bước test-run được gửi kết quả QA.");
  // Cùng khoá hạng mục với baseline và miễn để kết quả không chen giữa một lần đổi TC.
  await tx.select({ id: sdlcItems.id }).from(sdlcItems).where(eq(sdlcItems.id, step.itemId)).for("update");
  const report = qaTestReport.parse(raw);
  const cases = await qaCases(tx, step.itemId);
  if (step.result?.qaBaseline !== qaFingerprint(cases))
    throw new ConflictError("QA_BASELINE_CHANGED", "TC đã đổi sau khi giao chạy; hãy chạy lại bộ test.");
  if (report.cases.some((r) => !cases.some((c) => !c.retired && c.code === r.code)))
    throw new BadRequestError("QA_CASE_UNKNOWN", "Báo cáo chứa TC chưa có trong baseline của hạng mục.");
  await recordAudit(tx, {
    action: "sdlc.qa.report",
    targetType: "sdlc_item",
    targetId: step.itemId,
    data: { runId: step.runId, totals: report.totals },
  });
  return report;
}

export async function qaViewFor(tx: Tx, userId: string, itemId: string): Promise<QaView> {
  const item = await itemForUser(tx, userId, itemId);
  const state = await qaState(tx, item.id);
  return {
    cases: state.cases.map((c) => ({
      ...c.definition,
      id: c.id,
      retired: c.retired,
      waivedBy: c.waivedBy,
      waiverReason: c.waiverReason,
      lastStatus: state.evidence?.current
        ? (state.evidence.report.cases.find((r) => r.code === c.code)?.status ?? null)
        : null,
    })),
    report:
      state.evidence && state.step?.runId
        ? { runId: state.step.runId, createdAt: state.step.createdAt.toISOString(), data: state.evidence.report }
        : null,
    checks: state.checks,
    canWaive: await hasTeamPermission(tx, userId, item.teamId, "sdlc.override"),
  };
}

export async function waiveQaCase(tx: Tx, userId: string, input: { caseId: string; waived: boolean; reason: string }) {
  const [row] = await tx.select().from(sdlcQaCases).where(eq(sdlcQaCases.id, input.caseId));
  if (!row) throw new NotFoundError("QA_CASE_NOT_FOUND", "Không tìm thấy TC.");
  const item = await itemForUser(tx, userId, row.itemId, true);
  await requireProjectWrite(tx, userId, [item.projectId], "sdlc.override");
  if (item.status !== "active")
    throw new ConflictError("QA_ITEM_CLOSED", "Chỉ đổi miễn QA khi hạng mục đang hoạt động.");
  const [current] = await tx.select().from(sdlcQaCases).where(eq(sdlcQaCases.id, row.id)).for("update");
  if (!current || current.retired) throw new ConflictError("QA_CASE_RETIRED", "TC đã ngừng dùng.");
  const reason = input.reason.trim();
  if (reason.length < 10 || reason.length > 500)
    throw new BadRequestError("QA_WAIVER_REASON", "Lý do miễn cần từ 10 đến 500 ký tự.");
  await tx
    .update(sdlcQaCases)
    .set({
      waivedBy: input.waived ? userId : null,
      waiverReason: input.waived ? reason : null,
      waivedAt: input.waived ? new Date() : null,
    })
    .where(eq(sdlcQaCases.id, row.id));
  await recordAudit(tx, {
    action: input.waived ? "sdlc.qa.waive" : "sdlc.qa.revoke",
    actorUserId: userId,
    targetType: "sdlc_item",
    targetId: item.id,
    data: { code: row.code, reason },
  });
  return item;
}
