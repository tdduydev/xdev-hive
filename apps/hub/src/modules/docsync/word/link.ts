import type { WordImportFile } from "@xdev-hive/contracts";
import type { Principal } from "../../knowledge/index.ts";
import type { Tx } from "../../platform/index.ts";
import { notImplemented } from "../routes/common.ts";
import type { WordImportFileRow } from "./tools.ts";

/**
 * Lượt `link` (FR-028, plan.md mục 8b): job chuyển gọi sau khi file `ready`, so với nội dung hiện tại của tài liệu đích.
 * Khớp thì file `done` không có `doc_version`, không thì chờ `confirmLink`. Chưa làm thì để file ở `ready`.
 */
export async function prepareLink(_tx: Tx, _file: WordImportFileRow): Promise<void> {}

/** Người gắn chọn "Lấy bản chuyển làm gốc" khi kết quả không khớp nội dung hiện tại. */
export async function confirmLink(_tx: Tx, _principal: Principal, _input: { fileId: string }): Promise<WordImportFile> {
  notImplemented();
}
