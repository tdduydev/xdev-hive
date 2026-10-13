// Trình soạn tài liệu dùng chung cho web quản trị và app desktop (ADR 0017, spec 008 FR-027).
export * from "./blocks.ts";
export { type DocEditorEnv, type DocEditorLink, DocEditorProvider, type Lang } from "./env.tsx";
export { DocEditor, MarkdownEditor } from "./lazy.tsx";
export {
  REVIEWER_ROLE_LABEL,
  ReviewPane,
  ReviewStatusPill,
  reviewText,
  SlaBadge,
  useReviewFormat,
} from "./review-pane.tsx";
export { docEditorText } from "./text.ts";
