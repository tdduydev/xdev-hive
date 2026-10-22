import type { WordImportApproveInput, WordImportGetOutput } from "@xdev-hive/contracts";
import { and, eq, inArray } from "drizzle-orm";
import { approveProposal, type Principal } from "../../knowledge/index.ts";
import { ConflictError, NotFoundError, type Tx } from "../../platform/index.ts";
import { docWordImportFiles } from "../schema.ts";
import { wordImportView } from "../word/commit.ts";
import { loadWordTarget } from "../word/shared.ts";
import { type DocSyncRouteDeps, docSyncApi } from "./common.ts";

/**
 * Duyệt đề xuất của các file đã chọn (plan.md mục 9). Mỗi đề xuất vẫn qua cổng duyệt của nó (`approveProposal`: quyền
 * `manage` ở phạm vi tài liệu, đề xuất đang theo quy trình thì phải duyệt ở trang Duyệt tài liệu). Một file lỗi thì cả lô
 * không duyệt, để người duyệt thấy lỗi thay vì lô duyệt nửa chừng.
 */
export async function approveWordImport(
  tx: Tx,
  principal: Principal,
  input: WordImportApproveInput,
): Promise<WordImportGetOutput> {
  // Khoá lượt trước file, cùng thứ tự với bước tạo và job chuyển.
  const target = await loadWordTarget(tx, input.importId, true);
  const ids = [...new Set(input.fileIds)];
  const files = await tx
    .select()
    .from(docWordImportFiles)
    .where(and(eq(docWordImportFiles.importId, target.imp.id), inArray(docWordImportFiles.id, ids)));
  if (files.length !== ids.length)
    throw new NotFoundError("WORD_IMPORT_FILE_NOT_FOUND", "Không tìm thấy file trong lượt nhập Word.");
  for (const id of ids) {
    const file = files.find((f) => f.id === id);
    if (!file?.proposalId || file.state !== "proposed")
      throw new ConflictError(
        "WORD_IMPORT_NOT_PROPOSED",
        `File ${file?.fileName ?? id} không có đề xuất đang chờ duyệt.`,
      );
    await approveProposal(tx, principal, { id: file.proposalId, ...(input.note ? { note: input.note } : {}) });
  }
  return wordImportView(tx, principal, target.imp.id);
}

export function wordStagingRoutes(deps: DocSyncRouteDeps) {
  const api = docSyncApi(deps).wordImports;
  return {
    approve: api.approve.handler(({ context, input }) =>
      approveWordImport(context.tx, { kind: "user", userId: context.user.id }, input),
    ),
  };
}
