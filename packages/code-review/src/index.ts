// UI review PR của quy trình code (spec 009 US3) dùng chung cho web quản trị và app desktop.
export { AiResults } from "./ai-results.tsx";
export {
  type CodeReviewLink,
  type CodeReviewLinkRenderer,
  CodeReviewPane,
  type FilesState,
} from "./code-review-pane.tsx";
export { DecisionForm, type DecisionSubmit, OverrideForm } from "./decision-form.tsx";
export { FileDiff } from "./file-diff.tsx";
export { anchorFindings, collectFindings, type DiffFinding } from "./findings.ts";
export { formatScore, formatSla, shortSha } from "./format.ts";
export { GateStepper, stepOf } from "./gate-stepper.tsx";
export { MachineChecks } from "./machine-checks.tsx";
export { MAX_PATCH_LINES, type PatchLine, parsePatch } from "./patch.ts";
export { type CodeReviewLang, type CodeReviewText, codeReviewText } from "./text.ts";
