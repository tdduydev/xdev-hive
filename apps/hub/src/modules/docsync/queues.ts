import type { EnqueueOptions, JobQueue, Jobs } from "../platform/index.ts";

export const DOCSYNC_SCAN_IMPORT_QUEUE = "docsync-scan-import";
export const DOCSYNC_IMPORT_QUEUE = "docsync-import";
export const DOCSYNC_PUSH_QUEUE = "docsync-push";
export const DOCSYNC_PULL_QUEUE = "docsync-pull";
export const DOCSYNC_EXTRACT_QUEUE = "docsync-extract";
export const DOC_INDEX_QUEUE = "knowledge-doc-index";
export const BLOB_GC_QUEUE = "platform-blob-gc";
/** Chuyển một file Word bằng pandoc (plan.md mục 3). */
export const DOCSYNC_WORD_IMPORT_QUEUE = "docsync-word-import";
/** `.doc` qua LibreOffice, mỗi tiến trình hub một job (plan.md mục 12b). */
export const DOCSYNC_WORD_DOC_QUEUE = "docsync-word-doc";
/** Cron dọn file và ảnh giữ tạm của đề xuất nguồn Word (P2, plan.md mục 9). */
export const DOCSYNC_WORD_STAGING_QUEUE = "docsync-word-staging";

export const docSyncQueues: JobQueue[] = [
  { name: DOCSYNC_SCAN_IMPORT_QUEUE, policy: "stately" },
  { name: DOCSYNC_IMPORT_QUEUE, policy: "stately" },
  { name: DOCSYNC_PUSH_QUEUE, policy: "stately" },
  { name: DOCSYNC_PULL_QUEUE, policy: "stately" },
  { name: DOCSYNC_EXTRACT_QUEUE, policy: "stately" },
  { name: DOC_INDEX_QUEUE, policy: "stately" },
  { name: BLOB_GC_QUEUE, policy: "singleton" },
  { name: DOCSYNC_WORD_IMPORT_QUEUE, policy: "stately" },
  { name: DOCSYNC_WORD_DOC_QUEUE, policy: "stately" },
  { name: DOCSYNC_WORD_STAGING_QUEUE, policy: "singleton" },
];

/** Job mang tổ chức để handler mở withTenant; không dò tenant bằng kết nối bỏ qua RLS. */
export interface DocSyncHomeJob {
  orgId: string;
  homeId: string;
}

export function queuePush(jobs: Jobs, data: DocSyncHomeJob, options: Pick<EnqueueOptions, "tx"> = {}) {
  return jobs.enqueue(DOCSYNC_PUSH_QUEUE, data, {
    ...options,
    singletonKey: data.homeId,
    startAfter: new Date(Date.now() + 60_000),
  });
}

export function queuePull(jobs: Jobs, data: DocSyncHomeJob, options: Pick<EnqueueOptions, "tx"> = {}) {
  return jobs.enqueue(DOCSYNC_PULL_QUEUE, data, {
    ...options,
    singletonKey: data.homeId,
    startAfter: new Date(Date.now() + 30_000),
  });
}

export interface WordImportFileJob {
  orgId: string;
  fileId: string;
}

// Khoá theo file: xếp lại một file đang chờ (đổi keepFront, hub khởi động lại) không sinh lần chuyển thứ hai.
export function queueWordImport(jobs: Jobs, data: WordImportFileJob, options: Pick<EnqueueOptions, "tx"> = {}) {
  return jobs.enqueue(DOCSYNC_WORD_IMPORT_QUEUE, data, { ...options, singletonKey: data.fileId });
}

export function queueWordDoc(jobs: Jobs, data: WordImportFileJob, options: Pick<EnqueueOptions, "tx"> = {}) {
  return jobs.enqueue(DOCSYNC_WORD_DOC_QUEUE, data, { ...options, singletonKey: data.fileId });
}
