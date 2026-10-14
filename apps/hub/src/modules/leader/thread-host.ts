import { eq, inArray, sql } from "drizzle-orm";
import { artifactError, type LinkTarget, type Reader, type ThreadHost } from "../artifacts/index.ts";
import { NotFoundError, type Tx } from "../platform/index.ts";
import { runs } from "../runs/index.ts";
import { chatMessages, chatThreads } from "./schema.ts";

/**
 * Cuộc trò chuyện của run `leader` đang gọi. Cùng kiểm với `leader_reply`: run phải là run leader và cuộc trò chuyện
 * phải cùng dự án (hoặc chưa gắn dự án).
 */
export async function loadRunThread(tx: Tx, runId: string, threadId: string) {
  const [run] = await tx
    .select({
      kind: runs.kind,
      projectId: runs.projectId,
      orgId: runs.orgId,
      attempt: runs.attempt,
      leaderThreadId: runs.leaderThreadId,
    })
    .from(runs)
    .where(eq(runs.id, runId));
  const [thread] = await tx.select().from(chatThreads).where(eq(chatThreads.id, threadId));
  if (run?.kind !== "leader" || !thread || (thread.projectId && thread.projectId !== run.projectId)) {
    throw new NotFoundError("LEADER_THREAD_NOT_FOUND", "Không tìm thấy cuộc trò chuyện của leader run.");
  }
  return { run, thread };
}

/**
 * Phần `ThreadHost` mà module `leader` cài cho `artifacts` (plan.md D10). `postFixRequest` do T016 thêm.
 *
 * Artifact `private` thuộc người mở cuộc trò chuyện, nên ngoài kiểm của `leader_reply` còn đòi cuộc trò chuyện chính là
 * cuộc trò chuyện mà run này được giao: không thì run của một người ghi được artifact vào cuộc trò chuyện khác cùng dự án.
 */
export function createThreadHost(): Pick<ThreadHost, "assertRunThread" | "postArtifactCard"> {
  return {
    assertRunThread: async (tx, runId, threadId) => {
      try {
        const { run, thread } = await loadRunThread(tx, runId, threadId);
        if (run.leaderThreadId !== thread.id) throw artifactError("ARTIFACT_LINK_FORBIDDEN");
        return { projectId: thread.projectId, userId: thread.createdBy };
      } catch (error) {
        if (error instanceof NotFoundError) throw artifactError("ARTIFACT_LINK_FORBIDDEN");
        throw error;
      }
    },
    postArtifactCard: async (tx, input) => {
      const [thread] = await tx.select().from(chatThreads).where(eq(chatThreads.id, input.threadId));
      if (!thread) throw artifactError("ARTIFACT_LINK_FORBIDDEN");
      await tx.insert(chatMessages).values({
        orgId: thread.orgId,
        threadId: thread.id,
        role: "leader",
        content: input.title,
        runId: input.runId,
        artifactId: input.artifactId,
        artifactVersion: input.version,
      });
      await tx.update(chatThreads).set({ updatedAt: sql`now()` }).where(eq(chatThreads.id, thread.id));
    },
  };
}

const actorOf = (reader: Reader) => (reader.kind === "user" ? reader.userId : (reader.actor?.userId ?? null));

/**
 * Cuộc trò chuyện làm đích gắn artifact. Chỉ người mở cuộc trò chuyện gắn/bỏ gắn được (artifact `private` của họ đi theo
 * cuộc trò chuyện). `existing` cho job dọn xoá liên kết tới cuộc trò chuyện đã mất: artifact_links không có khoá ngoại.
 */
export function createThreadLinkTarget(): LinkTarget {
  return {
    kind: "chat_thread",
    assertWritable: async (tx, reader, threadId) => {
      const [thread] = await tx.select().from(chatThreads).where(eq(chatThreads.id, threadId));
      if (!thread || thread.createdBy !== actorOf(reader)) throw artifactError("ARTIFACT_LINK_FORBIDDEN");
    },
    projectOf: async (tx, threadId) => {
      const [thread] = await tx
        .select({ projectId: chatThreads.projectId })
        .from(chatThreads)
        .where(eq(chatThreads.id, threadId));
      return thread?.projectId ?? null;
    },
    titles: async (tx, reader, threadIds) => {
      const rows = await tx
        .select({ id: chatThreads.id, title: chatThreads.title, createdBy: chatThreads.createdBy })
        .from(chatThreads)
        .where(inArray(chatThreads.id, threadIds));
      // Tên cuộc trò chuyện của người khác không hiện cho người xem artifact.
      return new Map(rows.filter((r) => r.createdBy === actorOf(reader)).map((r) => [r.id, r.title]));
    },
    existing: async (tx, threadIds) => {
      const rows = await tx.select({ id: chatThreads.id }).from(chatThreads).where(inArray(chatThreads.id, threadIds));
      return new Set(rows.map((r) => r.id));
    },
  };
}
