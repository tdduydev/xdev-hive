import { planContent, type Task } from "@xdev-hive/contracts";
import { eq } from "drizzle-orm";
import type pg from "pg";
import { z } from "zod";
import type { McpPrincipal, RunTokenVerifier as McpRunTokenVerifier, McpToolRegistry } from "../mcp/index.ts";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError, withTenant } from "../platform/index.ts";
import { loadTask, taskByKeyForUser, toTask } from "../tasks/index.ts";
import { reviewReportInput } from "./review.ts";
import { runs } from "./schema.ts";
import { hubEvent, lockRun, notifyRun, ON_MACHINE } from "./state.ts";
import { createRunTokenVerifier } from "./token.ts";

/**
 * Cài run token vào cổng MCP. Ngoài chữ ký và thời hạn, run phải còn ở trên máy và đúng lần thử của token: run đã
 * giao lại (attempt mới) hay đã kết thúc thì token cũ, dù chưa hết hạn, không được ghi vào run nữa.
 */
export function createMcpRunTokens(opts: {
  pool: pg.Pool;
  authSecret: string;
  publicUrl: string;
  now?: () => number;
}): McpRunTokenVerifier {
  const verifyJwt = createRunTokenVerifier(opts);
  return {
    async verify(token) {
      const claims = verifyJwt(token);
      if (!claims) return null;
      const run = await withTenant(opts.pool, { orgId: claims.org_id }, async (tx) => {
        const [row] = await tx
          .select({
            kind: runs.kind,
            state: runs.state,
            attempt: runs.attempt,
            taskId: runs.taskId,
            projectId: runs.projectId,
            createdBy: runs.createdBy,
          })
          .from(runs)
          .where(eq(runs.id, claims.run_id));
        return row;
      });
      if (!run || run.attempt !== claims.attempt) return null;
      // Run không có task (leader, doccheck) được ký task_id bằng chính id của run.
      if ((run.taskId ?? claims.run_id) !== claims.task_id) return null;
      if (!ON_MACHINE.includes(run.state)) return null;
      return {
        kind: "run",
        // Agent làm thay người đã giao run: tool đọc dữ liệu theo quyền của người đó.
        userId: run.createdBy,
        orgId: claims.org_id,
        runId: claims.run_id,
        runKind: run.kind,
        taskId: run.taskId ?? undefined,
        projectId: run.projectId,
        attempt: claims.attempt,
        clientId: `run:${claims.run_id}`,
        scopes: [],
      };
    },
  };
}

function requireRun(principal: McpPrincipal) {
  const { kind, runId, taskId, attempt } = principal;
  if (kind !== "run" || !runId || !taskId || attempt === undefined) {
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
    title: "Báo cáo task",
    description: "Ghi báo cáo và đề xuất trạng thái cho task của run hiện tại.",
    input: z.object({
      status: z.enum(["review", "done"]).optional().describe("Đề xuất trạng thái task sau run."),
      note: z.string().min(1).max(20_000).describe("Báo cáo: đã làm gì, kiểm tra ra sao, còn vướng gì."),
    }),
    handler: async ({ status, note }, { tx, principal }) => {
      const { runId, attempt } = requireRun(principal);
      // Khoá dòng run để báo cáo không lọt vào giữa lúc run chuyển sang verifying hay lần thử mới.
      const run = await lockRun(tx, runId);
      if (!run || run.attempt !== attempt || !ON_MACHINE.includes(run.state)) throw runNotActive();
      // Ghi sự kiện thay vì đổi thẳng task.status: run kết thúc sẽ đặt trạng thái task theo chính sách kết quả, đổi
      // trước thì bị ghi đè và người xem thấy task nhảy trạng thái.
      await hubEvent(tx, run, "agent_report", { note, status: status ?? null });
      await notifyRun(tx, run.id);
      return { runId: run.id, attempt: run.attempt, taskId: run.taskId, recorded: "agent_report" };
    },
  });

  registry.register({
    name: "review_submit",
    title: "Nộp kết quả review chéo",
    description:
      "Chỉ dành cho run review chéo: nộp điểm (0–10), tóm tắt và các phát hiện cho PR của run cha. Hub đăng nhận " +
      "xét lên PR và dùng điểm cho kiểm tra review của chính sách kết quả. Gọi lại thì lần sau cùng được tính.",
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
    name: "doc_check_submit",
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
}
