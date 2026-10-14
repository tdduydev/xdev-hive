import { type ArtifactAskLeaderFix, artifactAskLeaderFix } from "@xdev-hive/contracts";
import { ConflictError, type Tx } from "../platform/index.ts";
import { artifactError, audit, type Reader, readerUserId } from "./access.ts";
import { type ThreadHost, threadHostOf } from "./hooks.ts";
import { artifactFor, getArtifact, linkInternal } from "./service.ts";

// Hook giữ chữ ký MVP; callback nội bộ không được đưa vào phản hồi API.
type FixRequestResult = Awaited<ReturnType<ThreadHost["postFixRequest"]>> & { afterCommit?: () => void };

export async function askLeaderFix(tx: Tx, reader: Reader, input: ArtifactAskLeaderFix) {
  const parsed = artifactAskLeaderFix.parse(input);
  const userId = readerUserId(reader);
  if (reader.kind !== "user" || !userId) throw artifactError("ARTIFACT_LINK_FORBIDDEN");
  const row = await artifactFor(tx, reader, parsed.id, { lock: true });
  const detail = await getArtifact(tx, reader, parsed);
  if (row.deletedAt || detail.version.tombstonedAt) throw artifactError("ARTIFACT_NOT_FOUND");
  const host = threadHostOf();
  if (!host) throw new ConflictError("RUNS_DISABLED", "Hub chưa cấu hình giao leader run.");
  const result: FixRequestResult = await host.postFixRequest(tx, {
    userId,
    threadId: parsed.threadId ?? null,
    projectId: row.projectId ?? row.originProjectId,
    artifactId: row.id,
    version: parsed.version,
    title: row.title,
    errors: parsed.errors,
    note: parsed.note ?? null,
    canWrite: detail.access.write,
  });
  await linkInternal(tx, reader, row, { kind: "chat_thread", id: result.threadId });
  await audit(tx, reader, "artifact.fix.request", row.id, {
    threadId: result.threadId,
    version: parsed.version,
    errorCount: parsed.errors.length,
  });
  return {
    response: { threadId: result.threadId, messageId: result.messageId, runId: result.runId },
    afterCommit: result.afterCommit,
  };
}
