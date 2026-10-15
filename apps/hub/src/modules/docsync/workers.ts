import type { Jobs } from "../platform/index.ts";
import { registerConflicts } from "./conflicts.ts";
import { registerExtracts } from "./extracts.ts";
import { registerImport } from "./import.ts";
import { registerPull } from "./pull.ts";
import { registerPush } from "./push.ts";
import type { DocSyncDeps } from "./routes/deps.ts";

/** Tách khỏi jobs.ts: worker import tên queue từ jobs.ts, đăng ký ở đây để không thành vòng import. */
export async function registerDocSync(jobs: Jobs, deps: DocSyncDeps): Promise<void> {
  await registerPush(jobs, deps);
  await registerPull(jobs, deps);
  await registerImport(jobs, deps);
  await registerConflicts(jobs, deps);
  await registerExtracts(jobs, deps);
}
