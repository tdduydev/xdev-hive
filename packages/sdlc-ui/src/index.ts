// Màn AI SDLC dùng chung cho web và app desktop (specs/011 plan.md D16). App chủ chỉ dựng route, menu và `SdlcEnv`.
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
export { ItemCard, ItemList, type ItemListProps, ProjectChips } from "./item-list.tsx";
export { allowedModes, NewItem, type NewItemProps } from "./new-item.tsx";
export { EmptyState } from "./parts.tsx";
export { ProjectPicker, type ProjectPickerProps, type ProjectPickerValue } from "./project-picker.tsx";
export { answerOf, Questions, type QuestionsProps, useOpenQuestionCount } from "./questions.tsx";
export { type SdlcText, sdlcText } from "./text.ts";
