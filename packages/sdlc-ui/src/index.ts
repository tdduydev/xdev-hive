// Màn AI SDLC dùng chung cho web và app desktop (specs/011 plan.md D16). App chủ chỉ dựng route, menu và `SdlcEnv`.
export { AutoApproval, AutoApprovalBadge, formatScore } from "./auto-approval.tsx";
export { ContractsPanel } from "./contracts-panel.tsx";
export {
  type Lang,
  type SdlcCan,
  type SdlcEnv,
  type SdlcItemTab,
  type SdlcLink,
  SdlcProvider,
  useSdlcEnv,
} from "./env.tsx";
export { formatUsd, formatWhen } from "./format.ts";
export { type BoardView, ItemBoard, type ItemBoardProps } from "./item-board.tsx";
export { ITEM_TABS, ItemDetail, type ItemDetailProps, TaskList } from "./item-detail.tsx";
export { ItemCard, ItemList, type ItemListProps, ProjectChips } from "./item-list.tsx";
export { allowedModes, NewItem, type NewItemProps } from "./new-item.tsx";
export { OverrideDialog, type OverrideDialogProps } from "./override-dialog.tsx";
export { EmptyState } from "./parts.tsx";
export { currentPhase, PhaseStepper } from "./phase-stepper.tsx";
export { ProjectPicker, type ProjectPickerProps, type ProjectPickerValue } from "./project-picker.tsx";
export { ProjectsPanel } from "./projects-panel.tsx";
export { answerOf, Questions, type QuestionsProps, useOpenQuestionCount } from "./questions.tsx";
export { latestRuns, StepsPanel } from "./steps-panel.tsx";
export { SyncStatus, type SyncStatusProps } from "./sync-status.tsx";
export { type SdlcText, sdlcText } from "./text.ts";
// Bản tách (`@xdev-hive/sdlc-ui/breakdown`) không xuất ở đây: nó kéo theo `@xyflow/react` và CSS của nó.
export { downloadCsv, TraceMatrix } from "./trace-matrix.tsx";
