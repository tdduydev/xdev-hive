import type { ArtifactToDoc } from "@xdev-hive/contracts";
import { ConflictError, type Tx } from "../platform/index.ts";
import { artifactError, audit, type Reader, readerUserId } from "./access.ts";
import { docProposerOf } from "./hooks.ts";
import { artifactFor } from "./service.ts";
import { versionRow } from "./versions.ts";

/**
 * Chuyển một phiên bản Markdown thành đề xuất tài liệu (specs/012 FR-110, US11). Chỉ đọc artifact: người gọi cần
 * quyền đọc artifact và quyền đề xuất trên tài liệu, do `knowledge` kiểm. Không ghi thẳng vào tài liệu.
 */
export async function toDoc(tx: Tx, reader: Reader, input: ArtifactToDoc): Promise<{ proposalId: string }> {
  const userId = readerUserId(reader);
  if (!userId) throw artifactError("ARTIFACT_LINK_FORBIDDEN", "Chỉ người dùng mới chuyển được thành tài liệu.");
  const row = await artifactFor(tx, reader, input.id);
  if (row.deletedAt) throw artifactError("ARTIFACT_NOT_FOUND");
  if (row.type !== "markdown") throw artifactError("ARTIFACT_NOT_MARKDOWN");
  const version = await versionRow(tx, row.id, input.version);
  if (!version) throw artifactError("ARTIFACT_NOT_FOUND", "Không tìm thấy phiên bản này.");
  // Phiên bản đã xoá nội dung vì bí mật thì không còn gì để đề xuất.
  if (version.tombstonedAt || version.content === null)
    throw artifactError("ARTIFACT_NOT_FOUND", "Phiên bản này đã bị xoá nội dung.");
  const proposer = docProposerOf();
  if (!proposer) throw new ConflictError("DOCS_DISABLED", "Hub chưa cấu hình tài liệu.");
  const result = await proposer.propose(tx, {
    userId,
    key: input.key,
    title: input.title ?? row.title,
    content: version.content,
    reason: `Chuyển từ artifact "${row.title}" (phiên bản ${version.version}).`,
  });
  await audit(tx, reader, "artifact.to_doc", row.id, {
    version: version.version,
    key: input.key,
    proposalId: result.proposalId,
  });
  return result;
}
