import { briefSubmitInput, planContent, skillProposalSubmitInput, type Task } from "@xdev-hive/contracts";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { loadProject } from "../catalog/index.ts";
import { findMachineByRef } from "../fleet/index.ts";
import type { McpPrincipal, McpToolRegistry } from "../mcp/index.ts";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../platform/index.ts";
import { loadTask, taskByKeyForUser, toTask, updateChecklist } from "../tasks/index.ts";
import { teamRoleOf } from "../tenancy/index.ts";
import { searchRuns } from "./queries.ts";
import { reviewReportInput } from "./review.ts";
import { runs } from "./schema.ts";
import { hubEvent, lockRun, notifyRun, ON_MACHINE } from "./state.ts";

/** Run không có task (leader, doccheck) cũng gọi được: tool tự kiểm loại run của mình. */
function requireRun(principal: McpPrincipal) {
  const { kind, runId, taskId, attempt } = principal;
  if (kind !== "run" || !runId || attempt === undefined) {
    throw new ForbiddenError(
      "RUN_TOKEN_REQUIRED",
      "Chỉ agent đang chạy trong run (HIVE_RUN_TOKEN) mới gọi được tool này.",
    );
  }
  return { runId, taskId, attempt };
}

const runNotActive = () =>
  new ConflictError("RUN_NOT_ACTIVE", "Run không còn chạy hoặc đã sang lần thử khác; báo cáo không được ghi.");

/**
 * Tool cho agent trong run: đọc task, gửi báo cáo cho kiểm tra `agentReport` của chính sách kết quả, nộp kết quả
 * review chéo (chỉ run review) và nộp kế hoạch (chỉ run plan).
 */
export function registerMcpTools(registry: McpToolRegistry): void {
  registry.register({
    name: "task_get",
    title: "Xem task",
    description: "Đọc task theo key hoặc task của run hiện tại.",
    input: z.object({
      key: z.string().min(1).max(100).optional().describe("Key task; bỏ trống để lấy task của run."),
      full: z.boolean().optional().describe("Lấy đầy đủ nội dung task."),
    }),
    readOnly: true,
    handler: async ({ key, full }, { tx, principal }) => {
      let task: Task;
      if (key) {
        task = toTask(await taskByKeyForUser(tx, principal.userId, key, "viewer"));
      } else {
        if (principal.kind !== "run" || !principal.taskId) {
          throw new BadRequestError("TASK_KEY_REQUIRED", "Cần truyền key của task khi không gọi từ trong run.");
        }
        const row = await loadTask(tx, principal.taskId);
        if (!row) throw new NotFoundError("TASK_NOT_FOUND", "Không tìm thấy task của run.");
        task = toTask(row);
      }
      const result = full
        ? task
        : {
            id: task.id,
            key: task.key,
            title: task.title,
            status: task.status,
            type: task.type,
            body: task.body.slice(0, 2000),
            truncated: task.body.length > 2000,
          };
      if (principal.kind !== "run" || task.id !== principal.taskId) return { task: result };
      const [run] = await tx
        .select({ id: runs.id, state: runs.state, attempt: runs.attempt, branch: runs.branch })
        .from(runs)
        .where(eq(runs.id, principal.runId ?? ""));
      return { task: result, run: run ?? null };
    },
  });

  registry.register({
    name: "task_update",
    writes: true,
    title: "Báo cáo task",
    // Mô tả ngắn: tools/list của run code có ngân sách byte (mcp-run.db.test.ts).
    description:
      "Ghi báo cáo, đề xuất trạng thái task của run. `checklist`: mục đã xong; `evidence`: requirement, test đã chạy.",
    input: z.object({
      status: z.enum(["review", "done"]).optional().describe("Đề xuất trạng thái task sau run."),
      note: z.string().min(1).max(20_000).describe("Báo cáo: đã làm gì, kiểm tra ra sao, còn vướng gì."),
      checklist: z
        .array(z.object({ id: z.string().max(40), done: z.boolean() }))
        .max(50)
        .optional(),
      evidence: z
        .object({ requirements: z.array(z.string().max(40)).max(100), tests: z.array(z.string().max(500)).max(100) })
        .partial()
        .optional(),
    }),
    handler: async ({ status, note, checklist, evidence }, { tx, principal }) => {
      const { runId, attempt } = requireRun(principal);
      // Khoá dòng run để báo cáo không lọt vào giữa lúc run chuyển sang verifying hay lần thử mới.
      const run = await lockRun(tx, runId);
      if (!run || run.attempt !== attempt || !ON_MACHINE.includes(run.state)) throw runNotActive();
      // Checklist là tiến độ của task, không phải kết luận run: ghi ngay để người xem thấy agent đang tới đâu.
      if (checklist?.length && run.taskId) await updateChecklist(tx, run.taskId, checklist);
      // Ghi sự kiện thay vì đổi thẳng task.status: run kết thúc sẽ đặt trạng thái task theo chính sách kết quả, đổi
      // trước thì bị ghi đè và người xem thấy task nhảy trạng thái.
      await hubEvent(tx, run, "agent_report", {
        note,
        status: status ?? null,
        ...(checklist?.length ? { checklist } : {}),
        ...(evidence ? { evidence } : {}),
      });
      await notifyRun(tx, run.id);
      return { runId: run.id, attempt: run.attempt, taskId: run.taskId, recorded: "agent_report" };
    },
  });

  registry.register({
    name: "review_submit",
    writes: true,
    title: "Nộp kết quả review chéo",
    description:
      "Chỉ dành cho run review chéo: nộp điểm (0–10), tóm tắt và các phát hiện cho PR của run cha, kèm checklist " +
      "khi lời nhắc có danh sách mục kiểm. Hub đăng nhận xét lên PR và dùng điểm cho kiểm tra review của chính sách " +
      "kết quả hoặc checkpoint AI của quy trình review code. Gọi lại thì lần sau cùng được tính.",
    input: reviewReportInput,
    runKinds: ["review"],
    // Run review chạy chỉ đọc: Claude ở chế độ plan chỉ gọi được tool có readOnlyHint (như plan_submit).
    readOnly: true,
    handler: async (report, { tx, principal }) => {
      const { runId, attempt } = requireRun(principal);
      const run = await lockRun(tx, runId);
      if (!run || run.attempt !== attempt || !ON_MACHINE.includes(run.state)) throw runNotActive();
      // Run code mà tự chấm điểm được thì kiểm tra review mất nghĩa.
      if (run.kind !== "review") {
        throw new ForbiddenError("REVIEW_RUN_REQUIRED", "Chỉ run review chéo mới gọi được review_submit.");
      }
      await hubEvent(tx, run, "review_report", report);
      await notifyRun(tx, run.id);
      return { runId: run.id, attempt: run.attempt, recorded: "review_report", score: report.score };
    },
  });

  registry.register({
    name: "plan_submit",
    writes: true,
    title: "Nộp kế hoạch",
    description:
      "Chỉ dành cho run lập kế hoạch (plan mode): nộp tóm tắt, các bước, file dự kiến đụng, rủi ro và câu hỏi cho " +
      "người duyệt. Hub giữ kế hoạch chờ người duyệt; duyệt xong mới có run viết code theo kế hoạch. Gọi lại thì lần " +
      "sau cùng được tính.",
    input: planContent,
    runKinds: ["plan"],
    // Claude Code ở `--permission-mode plan` từ chối mọi tool MCP không có readOnlyHint, kể cả khi --allowedTools có
    // tên tool (đã thử trên claude 2.1.296). Tool chỉ ghi kế hoạch lên hub, không đụng repo hay máy của agent.
    readOnly: true,
    handler: async (content, { tx, principal }) => {
      const { runId, attempt } = requireRun(principal);
      const run = await lockRun(tx, runId);
      if (!run || run.attempt !== attempt || !ON_MACHINE.includes(run.state)) throw runNotActive();
      // Run code mà tự nộp kế hoạch được thì người duyệt duyệt một kế hoạch không ai chờ.
      if (run.kind !== "plan") {
        throw new ForbiddenError("PLAN_RUN_REQUIRED", "Chỉ run lập kế hoạch mới gọi được plan_submit.");
      }
      await hubEvent(tx, run, "plan_report", content);
      await notifyRun(tx, run.id);
      return { runId: run.id, attempt: run.attempt, recorded: "plan_report", steps: content.steps.length };
    },
  });

  registry.register({
    name: "skill_proposal_submit",
    writes: true,
    title: "Nộp đề xuất skill",
    description:
      "Chỉ dành cho run đề xuất skill: nộp tối đa 3 SKILL.md mới hoặc bản sửa skill đã có, mỗi cái kèm lý do. Nộp " +
      "mảng rỗng khi không có gì đáng thành skill. Hub chỉ nhận lần gọi cuối cùng; người duyệt quyết định có dùng không.",
    input: skillProposalSubmitInput,
    runKinds: ["skill_proposal"],
    // Như brief_submit: run chạy chỉ đọc nên Claude ở chế độ plan chỉ gọi được tool có readOnlyHint.
    readOnly: true,
    handler: async (input, { tx, principal }) => {
      const { runId, attempt } = requireRun(principal);
      const run = await lockRun(tx, runId);
      if (!run || run.attempt !== attempt || !ON_MACHINE.includes(run.state)) throw runNotActive();
      if (run.kind !== "skill_proposal") {
        throw new ForbiddenError(
          "SKILL_PROPOSAL_RUN_REQUIRED",
          "Chỉ run đề xuất skill mới gọi được skill_proposal_submit.",
        );
      }
      await hubEvent(tx, run, "skill_proposal_report", input);
      await notifyRun(tx, run.id);
      return { runId: run.id, attempt: run.attempt, recorded: "skill_proposal_report", count: input.proposals.length };
    },
  });

  registry.register({
    name: "brief_submit",
    writes: true,
    title: "Nộp brief của dự án",
    description:
      "Chỉ dành cho run viết brief: nộp bản tóm tắt repo (Markdown) và commit của nhánh chính đã đọc. Hub lưu brief " +
      "khi run kết thúc êm; gọi lại thì lần sau cùng được tính.",
    input: briefSubmitInput,
    runKinds: ["brief"],
    // Như plan_submit: run brief chạy chỉ đọc, Claude ở chế độ plan chỉ gọi được tool có readOnlyHint.
    readOnly: true,
    handler: async (input, { tx, principal }) => {
      const { runId, attempt } = requireRun(principal);
      const run = await lockRun(tx, runId);
      if (!run || run.attempt !== attempt || !ON_MACHINE.includes(run.state)) throw runNotActive();
      if (run.kind !== "brief") {
        throw new ForbiddenError("BRIEF_RUN_REQUIRED", "Chỉ run viết brief mới gọi được brief_submit.");
      }
      await hubEvent(tx, run, "brief_report", input);
      await notifyRun(tx, run.id);
      return { runId: run.id, attempt: run.attempt, recorded: "brief_report", chars: input.content.length };
    },
  });

  registry.register({
    name: "doc_check_submit",
    writes: true,
    title: "Nộp kết quả kiểm tài liệu",
    description:
      "Chỉ dành cho run kiểm tài liệu của quy trình duyệt: nộp điểm 0–10, kết quả từng mục kiểm (đạt hay không, ghi " +
      "chú) và tóm tắt cho người duyệt. Gọi lại thì lần sau cùng được tính.",
    input: z.object({
      score: z.number().min(0).max(10).describe("Điểm chất lượng 0–10."),
      checklist: z
        .array(
          z.object({
            label: z.string().trim().min(1).max(300).describe("Mục kiểm, đúng chữ trong danh sách được giao."),
            passed: z.boolean(),
            note: z.string().trim().max(2000).nullable().optional().describe("Lý do khi không đạt; trích dòng nếu có."),
          }),
        )
        .min(1)
        .max(30),
      summary: z.string().trim().min(1).max(4000).describe("Tóm tắt cho người duyệt."),
    }),
    runKinds: ["doccheck"],
    // Như plan_submit: chế độ plan của Claude Code chỉ cho gọi tool MCP có readOnlyHint; tool chỉ ghi kết quả lên hub.
    readOnly: true,
    handler: async (input, { tx, principal }) => {
      const { runId, attempt } = requireRun(principal);
      const run = await lockRun(tx, runId);
      if (!run || run.attempt !== attempt || !ON_MACHINE.includes(run.state)) throw runNotActive();
      if (run.kind !== "doccheck") {
        throw new ForbiddenError("DOCCHECK_RUN_REQUIRED", "Chỉ run kiểm tài liệu mới gọi được doc_check_submit.");
      }
      await hubEvent(tx, run, "doccheck_result", {
        score: input.score,
        checklist: input.checklist.map((c) => ({ label: c.label, passed: c.passed, note: c.note ?? null })),
        summary: input.summary,
      });
      await notifyRun(tx, run.id);
      return { runId: run.id, attempt: run.attempt, recorded: "doccheck_result" };
    },
  });

  registry.register({
    name: "doc_assist_submit",
    writes: true,
    title: "Nộp kết quả trợ lý tài liệu",
    description:
      "Chỉ dành cho run trợ lý của trình soạn tài liệu: gọi một lần khi đã góp ý xong (doc_suggest, doc_comment), " +
      "kèm tóm tắt vài câu cho người viết.",
    input: z.object({ summary: z.string().trim().min(1).max(4000).describe("Tóm tắt cho người viết.") }),
    runKinds: ["docassist"],
    readOnly: true,
    handler: async ({ summary }, { tx, principal }) => {
      const { runId, attempt } = requireRun(principal);
      const run = await lockRun(tx, runId);
      if (!run || run.attempt !== attempt || !ON_MACHINE.includes(run.state)) throw runNotActive();
      if (run.kind !== "docassist") {
        throw new ForbiddenError("DOCASSIST_RUN_REQUIRED", "Chỉ run trợ lý tài liệu mới gọi được doc_assist_submit.");
      }
      await hubEvent(tx, run, "docassist_result", { summary });
      await notifyRun(tx, run.id);
      return { runId: run.id, attempt: run.attempt, recorded: "docassist_result" };
    },
  });

  registry.register({
    name: "run_list",
    title: "Danh sách run",
    description:
      "Liệt kê run gần nhất trong các đội bạn có vai trò, mới nhất trước. `machine` (id hoặc tên máy) lọc theo máy " +
      "chạy; app desktop dùng để hiện lượt chạy trên chính máy đó.",
    input: z.object({
      machine: z.string().trim().min(1).max(200).optional().describe("Id hoặc tên máy."),
      limit: z.number().int().min(1).max(50).optional().describe("Số run; mặc định 20."),
    }),
    readOnly: true,
    handler: async ({ machine, limit }, { tx, principal }) => {
      if (principal.kind !== "user") throw new ForbiddenError("USER_TOKEN_REQUIRED", "Tool này dành cho người dùng.");
      let machineId: string | undefined;
      if (machine) {
        const found = await findMachineByRef(tx, machine);
        // Máy của đội mình không có vai trò thì coi như không có, để không lộ tên máy của đội khác.
        if (!found || !(await teamRoleOf(tx, principal.userId, found.teamId)))
          throw new NotFoundError("MACHINE_NOT_FOUND", "Không tìm thấy máy trong các đội của bạn.");
        machineId = found.id;
      }
      const { items } = await searchRuns(tx, principal.userId, { machineId, limit: limit ?? 20 });
      const projects = new Map<string, { key: string; name: string } | null>();
      for (const id of new Set(items.map((r) => r.projectId))) {
        const p = await loadProject(tx, id);
        projects.set(id, p ? { key: p.key, name: p.name } : null);
      }
      return {
        runs: items.map((r) => ({
          id: r.id,
          kind: r.kind,
          state: r.state,
          taskKey: r.taskKey,
          title: r.taskTitle,
          projectId: r.projectId,
          project: projects.get(r.projectId) ?? null,
          cli: r.cli,
          model: r.model,
          machine: r.machineName,
          costUsd: r.cost.costUsd,
          tokensIn: r.cost.tokensIn,
          prUrl: r.prUrl,
          createdAt: r.createdAt,
          startedAt: r.startedAt,
          finishedAt: r.finishedAt,
        })),
      };
    },
  });
}
