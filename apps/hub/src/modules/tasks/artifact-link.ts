import { inArray } from "drizzle-orm";
import { artifactError, type LinkTarget, readerUserId } from "../artifacts/index.ts";
import { ForbiddenError, NotFoundError } from "../platform/index.ts";
import { teamRolesOf } from "../tenancy/index.ts";
import { tasks } from "./schema.ts";
import { loadTask, taskForUser } from "./tasks.ts";

/**
 * Task làm đích gắn artifact (specs/012 T065). Gắn là sửa task nên đòi vai trò `member` ở đội sở hữu, như sửa task.
 * `existing` cho job dọn xoá liên kết tới task đã mất: artifact_links không có khoá ngoại.
 */
export function createTaskLinkTarget(): LinkTarget {
  return {
    kind: "task",
    assertWritable: async (tx, reader, taskId) => {
      const userId = readerUserId(reader);
      if (!userId) throw artifactError("ARTIFACT_LINK_FORBIDDEN");
      try {
        await taskForUser(tx, userId, taskId, "member");
      } catch (error) {
        // Không phân biệt "không có" với "không đủ quyền" để người ngoài không dò được task của đội khác.
        if (error instanceof NotFoundError || error instanceof ForbiddenError)
          throw artifactError("ARTIFACT_LINK_FORBIDDEN");
        throw error;
      }
    },
    projectOf: async (tx, taskId) => (await loadTask(tx, taskId))?.projectId ?? null,
    titles: async (tx, reader, taskIds) => {
      const userId = readerUserId(reader);
      if (!userId) return new Map();
      const rows = await tx
        .select({ id: tasks.id, teamId: tasks.teamId, key: tasks.key, title: tasks.title })
        .from(tasks)
        .where(inArray(tasks.id, taskIds));
      // Chỉ người xem được task (có vai trò trong đội) thấy mã và tiêu đề.
      const roles = await teamRolesOf(tx, userId, [...new Set(rows.map((r) => r.teamId))]);
      return new Map(rows.filter((r) => roles.has(r.teamId)).map((r) => [r.id, `${r.key} · ${r.title}`]));
    },
    existing: async (tx, taskIds) => {
      const rows = await tx.select({ id: tasks.id }).from(tasks).where(inArray(tasks.id, taskIds));
      return new Set(rows.map((r) => r.id));
    },
  };
}
