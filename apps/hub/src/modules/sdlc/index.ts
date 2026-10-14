// Chế độ AI SDLC (specs/011-ai-sdlc-mode): hạng mục, giai đoạn, cổng. Module khác chỉ import file này.
import type { Tx } from "../platform/index.ts";
import { traceSettledRun } from "./trace.ts";

export { canReadItem, requireProjectWrite, visibleItemsWhere } from "./access.ts";
export { type CodeRunGate, codeRunGate } from "./gate.ts";
export { IMPORT_MAX_FILES, importItem, importRoute, importTitle, parseItemFolder } from "./import.ts";
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
export { registerMcpTools } from "./mcp-tools.ts";
export { listModes, type ResolvedMode, resolveMode } from "./modes.ts";
export {
  advance,
  approvePhase,
  onBaseline,
  SDLC_QUEUE,
  type SdlcBaselineEvent,
  type SdlcDeps,
  type SdlcJob,
  type SdlcRunRequest,
  type SdlcStepStart,
  type SdlcTaskRunRequest,
  type SdlcWorkflow,
  scheduleAdvance,
  workflowFor,
} from "./phases.ts";
export { specContextFor } from "./prompt.ts";
export {
  QUESTION_REMIND_MS,
  questionRoutes,
  registerQuestionReminders,
  remindOpenQuestions,
  sdlcQuestionsQueue,
} from "./questions.ts";
export { sdlcRouter } from "./router.ts";
export { finishImplementation, onSdlcMerged, registerSdlcScmHandlers, type SdlcScmDeps, traceCi } from "./scm.ts";
export { onSdlcRunFinished, queueAuthorFix, type SdlcRunOutcome, stepRoutes, withStepRuns } from "./steps.ts";
export {
  handleSdlcPullJob,
  onSdlcPush,
  pullProject,
  registerSdlcSync,
  requestSync,
  type SdlcPullJob,
  type SdlcSyncJob,
  type SyncDeps,
  scanProjects,
  sdlcPullQueue,
  sdlcSyncQueue,
  syncItemProject,
  syncRoute,
} from "./sync.ts";
export { buildTrace, getTrace, traceCsv, traceRoute } from "./trace.ts";
export { autoWave, runWave, startWave, type WaveResult, waveRoutes } from "./waves.ts";

/** Run code của task vừa kết luận, cho truy vết (plan.md "Luồng" bước 7). */
export interface SettledCodeRun {
  id: string;
  taskId: string | null;
  projectId: string;
  state: string;
  prUrl: string | null;
}

/**
 * `runs` gọi trong transaction kết luận run code (D17): liên kết `run`, `pr`, `test` từ `task_update.evidence`. Đợt kế
 * chạy khi PR merge (scm.ts), không chạy ở đây: run kết luận chưa làm task `done`.
 */
export async function onCodeRunSettled(tx: Tx, run: SettledCodeRun): Promise<void> {
  await traceSettledRun(tx, run);
}
