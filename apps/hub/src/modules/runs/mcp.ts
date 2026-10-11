import type { Task } from "@xdev-hive/contracts";
import { eq } from "drizzle-orm";
import type pg from "pg";
import { z } from "zod";
import type { McpPrincipal, RunTokenVerifier as McpRunTokenVerifier, McpToolRegistry } from "../mcp/index.ts";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError, withTenant } from "../platform/index.ts";
import { loadTask, taskByKeyForUser, toTask } from "../tasks/index.ts";
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
          .select({ state: runs.state, attempt: runs.attempt, taskId: runs.taskId, createdBy: runs.createdBy })
          .from(runs)
          .where(eq(runs.id, claims.run_id));
        return row;
      });
      if (!run || run.attempt !== claims.attempt || run.taskId !== claims.task_id) return null;
      if (!ON_MACHINE.includes(run.state)) return null;
      return {
        kind: "run",
        // Agent làm thay người đã giao run: tool đọc dữ liệu theo quyền của người đó.
        userId: run.createdBy,
        orgId: claims.org_id,
        runId: claims.run_id,
        taskId: claims.task_id,
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

/** Tool cho agent trong run: đọc task, gửi báo cáo cho kiểm tra `agentReport` của chính sách kết quả. */
export function registerMcpTools(registry: McpToolRegistry): void {
  registry.register({
    name: "task_get",
    title: "Xem task",
    description:
      "Đọc task. Trong run (HIVE_RUN_TOKEN) bỏ trống key để lấy task của run hiện tại; ngoài run phải truyền key.",
    input: z.object({
      key: z.string().min(1).max(100).optional().describe("Key của task, vd. HD-12. Bỏ trống để lấy task của run."),
    }),
    readOnly: true,
    handler: async ({ key }, { tx, principal }) => {
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
      if (principal.kind !== "run" || task.id !== principal.taskId) return { task };
      const [run] = await tx
        .select({ id: runs.id, state: runs.state, attempt: runs.attempt, branch: runs.branch })
        .from(runs)
        .where(eq(runs.id, principal.runId ?? ""));
      return { task, run: run ?? null };
    },
  });

  registry.register({
    name: "task_update",
    title: "Báo cáo task",
    description:
      "Gửi báo cáo của agent cho task của run hiện tại (tóm tắt việc đã làm, bằng chứng). status là đề xuất của " +
      "agent (review hoặc done); trạng thái thật của task do chính sách kết quả quyết định khi run kết thúc.",
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
}
