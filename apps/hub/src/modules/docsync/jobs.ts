import type { Jobs } from "../platform/index.ts";
import { registerConflicts } from "./conflicts.ts";
import { registerExtracts } from "./extracts.ts";
import { registerImport } from "./import.ts";
import { registerPull } from "./pull.ts";
import { registerPush } from "./push.ts";
import type { DocSyncDeps } from "./routes/deps.ts";
import { registerWordDoc, registerWordImport } from "./word/convert.ts";
import { registerWordStaging } from "./word/staging.ts";

// Hằng và hàm xếp hàng nằm ở queues.ts để file nghiệp vụ dùng được mà không vòng lại qua phần đăng ký worker.
export * from "./queues.ts";

export async function registerDocSync(jobs: Jobs, deps: DocSyncDeps): Promise<void> {
  await registerPush(jobs, deps);
  await registerPull(jobs, deps);
  await registerImport(jobs, deps);
  await registerConflicts(jobs, deps);
  await registerExtracts(jobs, deps);
  await registerWordImport(jobs, deps);
  await registerWordDoc(jobs, deps);
  await registerWordStaging(jobs, deps);
}
