import type { Jobs } from "../../platform/index.ts";
import type { DocSyncDeps } from "../routes/deps.ts";

// Job chuyển file Word (plan.md mục 3, 12b). Chưa có handler thì không nhận job, để job đã xếp chờ tới bản hub có
// handler thay vì bị đánh dấu xong mà không chuyển.

/** Hàng `docsync-word-import`: pandoc cho `.docx`, `.odt`. */
export async function registerWordImport(_jobs: Jobs, _deps: DocSyncDeps): Promise<void> {}

/** Hàng `docsync-word-doc`: `.doc` qua LibreOffice, rồi đi tiếp như `.docx`. */
export async function registerWordDoc(_jobs: Jobs, _deps: DocSyncDeps): Promise<void> {}
