// Chế độ AI SDLC (specs/011-ai-sdlc-mode): hạng mục, giai đoạn, cổng. Module khác chỉ import file này.
import type { Tx } from "../platform/index.ts";

export { canReadItem, requireProjectWrite, visibleItemsWhere } from "./access.ts";
export { type CodeRunGate, codeRunGate } from "./gate.ts";
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
export { onSdlcRunFinished, queueAuthorFix, type SdlcRunOutcome, stepRoutes, withStepRuns } from "./steps.ts";

/** Run code của task vừa kết luận, cho truy vết và đợt kế (plan.md "Luồng" bước 7). */
export interface SettledCodeRun {
  id: string;
  taskId: string | null;
  projectId: string;
  state: string;
  prUrl: string | null;
}

/**
 * `runs` gọi trong transaction kết luận run code (D17). Khung để `runs` nối trước; T031 (`trace.ts`) làm thân: liên kết
 * run, PR, test từ `task_update.evidence`, xét đợt kế. Chưa có thân thì không làm gì (SC-011).
 */
export async function onCodeRunSettled(_tx: Tx, _run: SettledCodeRun): Promise<void> {}
