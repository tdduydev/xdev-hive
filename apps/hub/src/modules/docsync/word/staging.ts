import { WORD_IMPORT_ERRORS } from "@xdev-hive/contracts";
import type { Principal } from "../../knowledge/index.ts";
import { ForbiddenError, type Jobs, type Tx } from "../../platform/index.ts";
import type { DocSyncDeps } from "../routes/deps.ts";
import type { WordImportFileRow } from "./tools.ts";

/**
 * Người chỉ có `propose` tạo tài liệu từ Word thì mỗi file thành một đề xuất (P2, Q14, plan.md mục 9). Chưa có luồng
 * đề xuất thì báo như P1 (Q2): cần quyền quản lý.
 */
export async function stageProposal(_tx: Tx, _principal: Principal, _file: WordImportFileRow): Promise<void> {
  throw new ForbiddenError("WORD_IMPORT_NEEDS_MANAGE", WORD_IMPORT_ERRORS.WORD_IMPORT_NEEDS_MANAGE.message);
}

/** Cron dọn file và ảnh giữ tạm của đề xuất bị từ chối hoặc quá `HIVE_DOC_WORD_STAGING_DAYS`. */
export async function registerWordStaging(_jobs: Jobs, _deps: DocSyncDeps): Promise<void> {}
