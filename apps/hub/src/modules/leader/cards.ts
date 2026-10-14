import type { ChatArtifactRef } from "@xdev-hive/contracts";
import { artifactFor, readerFor, visibleSummaries } from "../artifacts/index.ts";
import { ForbiddenError, NotFoundError, type Tx } from "../platform/index.ts";
import type { chatMessages } from "./schema.ts";

type Row = typeof chatMessages.$inferSelect;
type Facts = Pick<ChatArtifactRef, "title" | "type" | "deleted">;

/**
 * Tiêu đề, loại, tình trạng của artifact trong các thẻ, theo id artifact. Chỉ trả artifact người xem đọc được: thẻ của
 * artifact `private` người khác (hay đã xoá hẳn) không có mục nên `artifact` là null, không lộ tiêu đề. Artifact trong
 * thùng rác chỉ chủ hoặc quản trị thấy tiêu đề; thẻ hiện "đã bị xoá".
 */
export async function cardFacts(tx: Tx, userId: string, rows: Row[]): Promise<Map<string, Facts>> {
  const ids = [...new Set(rows.map((r) => r.artifactId).filter((id): id is string => !!id))];
  const facts = new Map<string, Facts>();
  if (ids.length === 0) return facts;
  const reader = await readerFor(tx, { kind: "user", userId });
  for (const [id, a] of await visibleSummaries(tx, reader, ids)) {
    facts.set(id, { title: a.title, type: a.type, deleted: false });
  }
  for (const id of ids) {
    if (facts.has(id)) continue;
    try {
      const row = await artifactFor(tx, reader, id);
      facts.set(id, { title: row.title, type: row.type, deleted: row.deletedAt !== null });
    } catch (error) {
      if (!(error instanceof NotFoundError || error instanceof ForbiddenError)) throw error;
    }
  }
  return facts;
}

export function cardOf(row: Row, facts: Map<string, Facts>): ChatArtifactRef | null {
  const found = row.artifactId ? facts.get(row.artifactId) : undefined;
  if (!row.artifactId || !row.artifactVersion || !found) return null;
  return { id: row.artifactId, version: row.artifactVersion, ...found };
}
