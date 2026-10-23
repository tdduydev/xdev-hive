import { eq, inArray } from "drizzle-orm";
import { artifactError, type LinkTarget, readerUserId } from "../artifacts/index.ts";
import { ForbiddenError, NotFoundError } from "../platform/index.ts";
import { taskSummaries } from "../tasks/index.ts";
import { runForUser } from "./engine.ts";
import { runs } from "./schema.ts";

const KIND_LABEL: Record<string, string> = { code: "code", leader: "leader", review: "review", plan: "kế hoạch" };

/**
 * Run làm đích gắn artifact (specs/012 T065). Quyền gắn là quyền sửa của run: `member` ở đội sở hữu task (run leader:
 * ở dự án), cùng kiểm với các thao tác ghi khác lên run. Gắn chỉ là siêu dữ liệu: không đổi prompt hay kết quả run.
 */
export function createRunLinkTarget(): LinkTarget {
  return {
    kind: "run",
    assertWritable: async (tx, reader, runId) => {
      const userId = readerUserId(reader);
      if (!userId) throw artifactError("ARTIFACT_LINK_FORBIDDEN");
      try {
        await runForUser(tx, userId, runId, "member");
      } catch (error) {
        if (error instanceof NotFoundError || error instanceof ForbiddenError)
          throw artifactError("ARTIFACT_LINK_FORBIDDEN");
        throw error;
      }
    },
    projectOf: async (tx, runId) => {
      const [row] = await tx.select({ projectId: runs.projectId }).from(runs).where(eq(runs.id, runId));
      return row?.projectId ?? null;
    },
    titles: async (tx, reader, runIds) => {
      const userId = readerUserId(reader);
      const titles = new Map<string, string>();
      if (!userId) return titles;
      const rows = await tx
        .select({ id: runs.id, kind: runs.kind, taskId: runs.taskId })
        .from(runs)
        .where(inArray(runs.id, runIds));
      const summaries = await taskSummaries(
        tx,
        rows.flatMap((r) => (r.taskId ? [r.taskId] : [])),
      );
      for (const row of rows) {
        // runForUser đã kiểm đúng quyền xem run; không xem được thì không có tên.
        const visible = await runForUser(tx, userId, row.id, "viewer").then(
          () => true,
          () => false,
        );
        if (!visible) continue;
        const task = row.taskId ? summaries.get(row.taskId) : undefined;
        titles.set(row.id, `Run ${KIND_LABEL[row.kind] ?? row.kind}${task ? ` · ${task.key}` : ""}`);
      }
      return titles;
    },
    existing: async (tx, runIds) => {
      const rows = await tx.select({ id: runs.id }).from(runs).where(inArray(runs.id, runIds));
      return new Set(rows.map((r) => r.id));
    },
  };
}
