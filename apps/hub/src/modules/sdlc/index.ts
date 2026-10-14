// Chế độ AI SDLC (specs/011-ai-sdlc-mode): hạng mục, giai đoạn, cổng. Module khác chỉ import file này.
import type { Tx } from "../platform/index.ts";

export { canReadItem, requireProjectWrite, visibleItemsWhere } from "./access.ts";
export {
  allowedModes,
  type CreateItemOptions,
  createItem,
  getItem,
  insertArtifacts,
  issueNumberOf,
  itemDetail,
  type PlannedArtifact,
  planArtifacts,
  sdlcSettingsOf,
} from "./items.ts";
export { handleSdlcJob, registerSdlcWorker, type SdlcWorkerDeps, sdlcQueue } from "./jobs.ts";
export { listModes, type ResolvedMode, resolveMode } from "./modes.ts";
export {
  advance,
  approvePhase,
  onBaseline,
  SDLC_QUEUE,
  type SdlcBaselineEvent,
  type SdlcDeps,
  type SdlcJob,
  type SdlcStepStart,
  type SdlcWorkflow,
  scheduleAdvance,
  workflowFor,
} from "./phases.ts";
export { sdlcRouter } from "./router.ts";

export type CodeRunGate =
  | { block: false; warn: string | null }
  | { block: true; code: "SDLC_GATE_BLOCKED" | "TASK_DEPENDENCIES_OPEN"; message: string; missing: string[] };

/**
 * Cổng chặn run code (plan.md "Chặn ở engine", D10). Khung để `runs.queueRun` nối trước; T013 thay bằng `gate.ts`
 * (tài liệu bắt buộc theo dự án của task, phụ thuộc, ngoại lệ). Chưa có thân thì không chặn gì (SC-011).
 */
export async function codeRunGate(_tx: Tx, _input: { taskId: string; kind: string }): Promise<CodeRunGate> {
  return { block: false, warn: null };
}
