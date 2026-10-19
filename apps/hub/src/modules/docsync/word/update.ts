import type { Principal } from "../../knowledge/index.ts";
import type { Tx } from "../../platform/index.ts";
import { notImplemented } from "../routes/common.ts";
import type { DocSyncDeps } from "../routes/deps.ts";
import type { WordImportFileRow } from "./tools.ts";

/**
 * Lượt `update` (P2, plan.md mục 8): job chuyển gọi sau khi file `ready`, để báo trước "hợp sạch", "N chỗ chồng nhau"
 * hay "không có gì thay đổi". Chưa làm thì để file ở `ready`.
 */
export async function prepareUpdate(_tx: Tx, _file: WordImportFileRow): Promise<void> {}

/** Bước tạo của lượt `update`: hợp ba bên rồi lưu nguồn `word`, hoặc ghi xung đột `origin = 'word'`. */
export async function commitUpdate(
  _tx: Tx,
  _deps: DocSyncDeps,
  _principal: Principal,
  _file: WordImportFileRow,
): Promise<void> {
  notImplemented();
}
