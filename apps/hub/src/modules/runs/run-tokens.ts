import { eq } from "drizzle-orm";
import type pg from "pg";
import type { RunTokenVerifier as McpRunTokenVerifier } from "../mcp/index.ts";
import { withTenant } from "../platform/index.ts";
import { runs } from "./schema.ts";
import { ON_MACHINE } from "./state.ts";
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
            createdBy: runs.createdBy,
          })
          .from(runs)
          .where(eq(runs.id, claims.run_id));
        return row;
      });
      if (!run || run.attempt !== claims.attempt) return null;
      if (run.kind !== "leader" && run.taskId !== claims.task_id) return null;
      if (!ON_MACHINE.includes(run.state)) return null;
      return {
        kind: "run",
        // Agent làm thay người đã giao run: tool đọc dữ liệu theo quyền của người đó.
        userId: run.createdBy,
        orgId: claims.org_id,
        runId: claims.run_id,
        runKind: run.kind,
        taskId: run.taskId ?? undefined,
        attempt: claims.attempt,
        clientId: `run:${claims.run_id}`,
        scopes: [],
      };
    },
  };
}
