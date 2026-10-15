import type { EnqueueOptions, JobQueue, Jobs } from "../platform/index.ts";
import { registerConflicts } from "./conflicts.ts";
import { registerExtracts } from "./extracts.ts";
import { registerImport } from "./import.ts";
import { registerPull } from "./pull.ts";
import { registerPush } from "./push.ts";
import type { DocSyncDeps } from "./routes/deps.ts";

export const DOCSYNC_SCAN_IMPORT_QUEUE = "docsync-scan-import";
export const DOCSYNC_IMPORT_QUEUE = "docsync-import";
export const DOCSYNC_PUSH_QUEUE = "docsync-push";
export const DOCSYNC_PULL_QUEUE = "docsync-pull";
export const DOCSYNC_EXTRACT_QUEUE = "docsync-extract";
export const DOC_INDEX_QUEUE = "knowledge-doc-index";
export const BLOB_GC_QUEUE = "platform-blob-gc";

export const docSyncQueues: JobQueue[] = [
  { name: DOCSYNC_SCAN_IMPORT_QUEUE, policy: "stately" },
  { name: DOCSYNC_IMPORT_QUEUE, policy: "stately" },
  { name: DOCSYNC_PUSH_QUEUE, policy: "stately" },
  { name: DOCSYNC_PULL_QUEUE, policy: "stately" },
  { name: DOCSYNC_EXTRACT_QUEUE, policy: "stately" },
  { name: DOC_INDEX_QUEUE, policy: "stately" },
  { name: BLOB_GC_QUEUE, policy: "singleton" },
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

export async function registerDocSync(jobs: Jobs, deps: DocSyncDeps): Promise<void> {
  await registerPush(jobs, deps);
  await registerPull(jobs, deps);
  await registerImport(jobs, deps);
  await registerConflicts(jobs, deps);
  await registerExtracts(jobs, deps);
}
