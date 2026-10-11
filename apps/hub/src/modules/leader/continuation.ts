import { and, eq, gt } from "drizzle-orm";
import { loadProject } from "../catalog/index.ts";
import type { Tx } from "../platform/index.ts";
import { assembleLeaderPrompt, formatTranscript, projectContext } from "./prompt.ts";
import { chatMessages, chatThreads } from "./schema.ts";

export async function queuedLeaderPrompt(tx: Tx, threadId: string, after: Date) {
  const [thread] = await tx.select().from(chatThreads).where(eq(chatThreads.id, threadId));
  if (!thread?.projectId) return null;
  const [queued] = await tx
    .select({ id: chatMessages.id, senderId: chatMessages.senderId })
    .from(chatMessages)
    .where(and(eq(chatMessages.threadId, threadId), eq(chatMessages.role, "user"), gt(chatMessages.createdAt, after)))
    .limit(1);
  if (!queued) return null;
  const [project] = await tx
    .select({ id: chatThreads.projectId })
    .from(chatThreads)
    .where(eq(chatThreads.id, threadId));
  const details = project?.id ? await loadProject(tx, project.id) : null;
  if (!details) return null;
  const messages = await tx
    .select({ role: chatMessages.role, content: chatMessages.content })
    .from(chatMessages)
    .where(eq(chatMessages.threadId, threadId))
    .orderBy(chatMessages.createdAt);

  const transcript = formatTranscript(messages);
  const context = await projectContext(tx, thread.createdBy, details.id, details.teamId);
  const prompt = assembleLeaderPrompt({
    transcript,
    projectName: details.name,
    projectKey: details.key,
    defaultBranch: details.defaultBranch,
    context,
  });

  return { userId: queued.senderId ?? thread.createdBy, projectId: details.id, prompt };
}
