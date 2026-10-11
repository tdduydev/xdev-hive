import { sql } from "drizzle-orm";
import type { Tx } from "../platform/index.ts";
import { chatMessages, chatThreads } from "./schema.ts";

export async function appendLeaderSystemMessage(tx: Tx, threadId: string, content: string): Promise<void> {
  const [thread] = await tx.select({ orgId: chatThreads.orgId }).from(chatThreads).where(sql`id = ${threadId}`);
  if (!thread) return;
  await tx.insert(chatMessages).values({ orgId: thread.orgId, threadId, role: "system", content });
  await tx.update(chatThreads).set({ updatedAt: sql`now()` }).where(sql`id = ${threadId}`);
}
