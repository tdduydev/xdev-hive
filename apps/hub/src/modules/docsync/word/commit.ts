import type { WordImportCommitInput, WordImportGetOutput } from "@xdev-hive/contracts";
import type { Principal } from "../../knowledge/index.ts";
import type { Tx } from "../../platform/index.ts";
import { notImplemented } from "../routes/common.ts";
import type { DocSyncDeps } from "../routes/deps.ts";

/**
 * Tạo tài liệu từ các file `ready` của lượt (FR-017…FR-021, plan.md mục 6): tài liệu nguồn `word`, ảnh `pending_push`,
 * audit và lô đẩy. Thiếu quyền `manage` thì đi `stageProposal`.
 */
export async function commitWordImport(
  _tx: Tx,
  _deps: DocSyncDeps,
  _principal: Principal,
  _input: WordImportCommitInput,
): Promise<WordImportGetOutput> {
  notImplemented();
}
