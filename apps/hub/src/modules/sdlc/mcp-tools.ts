import { sdlcAskInput, sdlcItemRef, sdlcReportInput } from "@xdev-hive/contracts";
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { loadProject } from "../catalog/index.ts";
import type { McpPrincipal, McpToolRegistry } from "../mcp/index.ts";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError, type Tx } from "../platform/index.ts";
import { projectItemsWhere } from "./access.ts";
import { contractsFromRunReport } from "./contracts.ts";
import { recordQaReport } from "./qa.ts";
import { askQuestions } from "./questions.ts";
import { proposeLessons } from "./release.ts";
import {
  sdlcArtifacts,
  sdlcItemPhases,
  sdlcItemProjects,
  sdlcItems,
  sdlcItemTasks,
  sdlcQuestions,
  sdlcSteps,
} from "./schema.ts";

/*
 * Tool MCP cho agent trong run (plan.md "MCP"). Run chỉ thấy hạng mục có dự án của run (D22); loại run lấy từ token nên
 * agent không tự nhận mình là run khác được.
 */

function requireRun(principal: McpPrincipal) {
  const { kind, runId, projectId } = principal;
  if (kind !== "run" || !runId || !projectId)
    throw new ForbiddenError(
      "RUN_TOKEN_REQUIRED",
      "Chỉ agent đang chạy trong run (HIVE_RUN_TOKEN) mới gọi được tool này.",
    );
  return { runId, projectId, taskId: principal.taskId ?? null };
}

/** Bước đang chạy của run `sdlc`; run đã kết thúc thì không ghi gì thêm. */
async function runningStep(tx: Tx, runId: string) {
  const [step] = await tx.select().from(sdlcSteps).where(eq(sdlcSteps.runId, runId)).for("update");
  if (!step || (step.status !== "running" && step.status !== "queued"))
    throw new ConflictError("SDLC_STEP_NOT_RUNNING", "Run không còn phục vụ bước agent nào; kết quả không được ghi.");
  return step;
}

/** Hạng mục của run: run `sdlc` theo bước, run code theo task của hạng mục. */
async function itemOfRun(tx: Tx, run: ReturnType<typeof requireRun>, itemId: string | undefined) {
  let id = itemId ?? null;
  let requirementIds: string[] = [];
  if (!id) {
    const [step] = await tx.select({ itemId: sdlcSteps.itemId }).from(sdlcSteps).where(eq(sdlcSteps.runId, run.runId));
    id = step?.itemId ?? null;
  }
  if (run.taskId) {
    const [link] = await tx
      .select({ itemId: sdlcItemTasks.itemId, requirementIds: sdlcItemTasks.requirementIds })
      .from(sdlcItemTasks)
      .where(eq(sdlcItemTasks.taskId, run.taskId));
    if (link && (!id || id === link.itemId)) {
      id = link.itemId;
      requirementIds = link.requirementIds;
    }
  }
  if (!id) throw new NotFoundError("SDLC_ITEM_NOT_FOUND", "Run này không thuộc hạng mục AI SDLC nào.");
  const [item] = await tx
    .select()
    .from(sdlcItems)
    .where(and(eq(sdlcItems.id, id), projectItemsWhere(run.projectId)));
  if (!item) throw new NotFoundError("SDLC_ITEM_NOT_FOUND", "Không tìm thấy hạng mục trong dự án của run.");
  return { item, requirementIds };
}

const reportShape = z.object({
  kind: z
    .enum(["size", "findings", "analysis", "summary", "contracts", "lessons", "test-results"])
    .describe("Loại kết quả của bước."),
  data: z.record(z.string(), z.unknown()).describe("Dữ liệu theo loại; xem mô tả tool."),
});

export function registerMcpTools(registry: McpToolRegistry): void {
  registry.register({
    name: "sdlc_context",
    title: "Ngữ cảnh hạng mục AI SDLC",
    description:
      "Đọc hạng mục AI SDLC của run: ý tưởng, dự án tham gia, giai đoạn, tài liệu (key, đường dẫn repo, phiên bản đã " +
      "duyệt), contract, câu hỏi và câu trả lời. Nội dung tài liệu đọc bằng doc_get.",
    input: z.object({ itemId: z.uuid().optional().describe("Bỏ trống để lấy hạng mục của run.") }),
    // Run code của task hạng mục đã có ngữ cảnh spec trong prompt (specContextFor); thêm tool vào mọi run code làm
    // tools/list vượt ngân sách byte của run code (mcp-run.db.test.ts).
    runKinds: ["sdlc"],
    readOnly: true,
    handler: async ({ itemId }, { tx, principal }) => {
      const run = requireRun(principal);
      const { item, requirementIds } = await itemOfRun(tx, run, itemId);
      const members = await tx
        .select()
        .from(sdlcItemProjects)
        .where(and(eq(sdlcItemProjects.itemId, item.id), isNull(sdlcItemProjects.removedAt)));
      const keys = new Map<string, string>();
      for (const m of members) keys.set(m.projectId, (await loadProject(tx, m.projectId))?.key ?? m.projectId);
      const phases = await tx
        .select()
        .from(sdlcItemPhases)
        .where(eq(sdlcItemPhases.itemId, item.id))
        .orderBy(asc(sdlcItemPhases.phaseIndex));
      const artifacts = await tx.select().from(sdlcArtifacts).where(eq(sdlcArtifacts.itemId, item.id));
      const questions = await tx
        .select()
        .from(sdlcQuestions)
        .where(eq(sdlcQuestions.itemId, item.id))
        .orderBy(asc(sdlcQuestions.round), asc(sdlcQuestions.position));
      const names = new Map(item.mode.phases.flatMap((p) => p.artifacts.map((a) => [`${p.id}/${a.id}`, a.name])));
      return {
        item: {
          id: item.id,
          ref: sdlcItemRef(item.number),
          title: item.title,
          idea: item.idea,
          size: item.size,
          status: item.status,
          mode: { id: item.mode.id, name: item.mode.name, method: item.mode.method },
          currentPhase: item.mode.phases[item.phaseIndex]?.id ?? null,
        },
        projects: members.map((m) => ({ key: keys.get(m.projectId) ?? "", role: m.role })),
        phases: phases.map((p) => ({ id: p.phaseId, kind: p.kind, status: p.status })),
        artifacts: artifacts
          .filter((a) => a.scope !== "contract")
          .map((a) => ({
            name: names.get(`${a.phaseId}/${a.artifactId}`) ?? a.artifactId,
            phase: a.phaseId,
            scope: a.scope,
            project: keys.get(a.projectId) ?? "",
            key: a.docKey,
            repoPath: a.repoPath,
            baselineVersion: a.baselineVersion,
            approval: a.approval,
          })),
        contracts: artifacts
          .filter((a) => a.scope === "contract")
          .map((a) => ({
            name: a.instance,
            format: a.contractFormat,
            provider: keys.get(a.projectId) ?? "",
            consumers: a.consumerProjectIds.map((id) => keys.get(id) ?? id),
            key: a.docKey,
            repoPath: a.repoPath,
            baselineVersion: a.baselineVersion,
          })),
        questions: questions.map((q) => ({
          phase: q.phaseId,
          round: q.round,
          text: q.text,
          status: q.status,
          answer: q.answer,
        })),
        ...(requirementIds.length ? { taskRequirements: requirementIds } : {}),
      };
    },
  });

  registry.register({
    name: "sdlc_ask",
    title: "Hỏi người giao việc",
    description:
      "Chỉ dành cho run soạn tài liệu AI SDLC: gửi câu hỏi cho người giao (tối đa 5 câu mỗi lượt, mỗi câu nên có " +
      "phương án và đề xuất). Run vẫn kết thúc bình thường; khi người trả lời đủ, hub chạy lượt soạn mới kèm câu trả lời.",
    input: sdlcAskInput,
    runKinds: ["sdlc"],
    // Chỉ ghi câu hỏi lên hub, không đụng repo hay máy; cờ để CLI chạy không tương tác gọi được như plan_submit.
    readOnly: true,
    handler: async (input, { tx, principal }) => {
      const run = requireRun(principal);
      const result = await askQuestions(tx, run.runId, input);
      return {
        questionIds: result.ids,
        ...(result.dropped
          ? {
              note: `Hub chỉ nhận ${result.limit} câu mỗi lượt; ${result.dropped} câu sau bị bỏ, hãy chọn câu quan trọng nhất.`,
            }
          : {}),
      };
    },
  });

  registry.register({
    name: "sdlc_report",
    title: "Báo kết quả bước AI SDLC",
    description:
      "Chỉ dành cho run AI SDLC: báo kết quả có cấu trúc của bước. `size`: {size: S|M|L|XL, modeRef, reason}. " +
      "`findings`: {findings: [{requirementId, status: met|partial|missing|contradicts, evidence, suggestedTask?}]} cho " +
      "yêu cầu thuộc repo của run. " +
      "`analysis`: {score?, findings: [{severity, message, artifact?}], checklist?}. `summary`: {summary}. " +
      "`contracts`: {contracts: [{name, format, provider, consumers[], content}]} với provider/consumers là key dự án " +
      "tham gia; mỗi contract thành bản nháp chờ duyệt. `lessons` (bước retro): {content, reason, key?} là toàn bộ nội " +
      "dung mới của constitution/steering, hub tạo đề xuất chờ duyệt (bỏ key là project/<dự án chính>/constitution). " +
      "`test-results`: JSON metadata từ hive test-summary, chỉ bước test-run; không gửi log hay code. Gọi lại cùng loại thì lần sau ghi đè.",
    input: reportShape,
    runKinds: ["sdlc"],
    readOnly: true,
    handler: async (raw, { tx, principal }) => {
      const run = requireRun(principal);
      const parsed = sdlcReportInput.safeParse(raw);
      if (!parsed.success)
        throw new BadRequestError(
          "SDLC_REPORT_INVALID",
          `Dữ liệu ${raw.kind} không đúng dạng: ${parsed.error.issues[0]?.message ?? "sai dạng"}.`,
        );
      const report = parsed.data;
      const step = await runningStep(tx, run.runId);
      if (report.kind === "test-results") await recordQaReport(tx, step, report.data);
      let extra: Record<string, unknown> = {};
      if (report.kind === "contracts") {
        const out = await contractsFromRunReport(tx, step.itemId, report, {
          kind: "run",
          runId: run.runId,
          projectId: run.projectId,
        });
        extra = { created: out.created, rejected: out.rejected };
      }
      if (report.kind === "lessons") {
        if (step.action !== "retro")
          throw new BadRequestError("SDLC_REPORT_INVALID", "Chỉ bước retro mới báo bài học (lessons).");
        const { item } = await itemOfRun(tx, run, step.itemId);
        const out = await proposeLessons(tx, item, run, report.data);
        await tx
          .update(sdlcSteps)
          .set({ result: { ...(step.result ?? {}), lessons: { ...out, reason: report.data.reason } } })
          .where(eq(sdlcSteps.id, step.id));
        return { recorded: report.kind, ...out };
      }
      // Phát hiện converge là danh sách gắn dự án của run (màn Hội tụ đọc thẳng `result.findings`); hạng mục nhiều dự
      // án có một run mỗi dự án, hub gộp theo dự án khi chốt vòng.
      const value =
        report.kind === "findings"
          ? report.data.findings.map((f) => ({ ...f, projectId: run.projectId }))
          : { ...report.data, ...extra };
      await tx
        .update(sdlcSteps)
        .set({ result: { ...(step.result ?? {}), [report.kind]: value } })
        .where(eq(sdlcSteps.id, step.id));
      return { recorded: report.kind, ...extra };
    },
  });
}
