import { invoke } from "@/lib/tauri.ts";

/*
 * Cầu nối tới `hive-worker optimize all` (spec 029). Kiểu khớp fixture của worker Go
 * (worker/internal/optimizeall/testdata/optimize-{plan,run,run-undone}.json) và contracts/sidecar-cli.md.
 */

export type StepGroup = "cli" | "tools" | "context" | "score";
export type RunStepStatus = "planned" | "skipped" | "ok" | "failed" | "undone";

export interface PlanChange {
  file: string;
  key: string;
  before: string | null;
  after: string | null;
}

export interface PlanStep {
  /** optimizer.enable | fix.<fixId> | tool.<id> | context.sync | score.recompute */
  id: string;
  group: StepGroup;
  /** Id gói, khoá dự án hoặc id công cụ. */
  target: string;
  /** Tiếng Việt, do sidecar viết. */
  title: string;
  changes: PlanChange[];
  /** Mặc định do sidecar đặt; aggressive là false. */
  selected: boolean;
  requiresConfirm: boolean;
  /** tool.* là false: công cụ đã cài không gỡ. */
  undoable: boolean;
  reason: string;
  // Dữ liệu để sidecar chạy đúng bước người dùng đã xem; giao diện chỉ đổi `selected`.
  profile?: string;
  project?: string;
  level?: "balanced" | "aggressive";
  rtk?: boolean;
  autoCompactWindow?: number;
}

export interface OptimizePlan {
  createdAt: string;
  scoreBefore: number | null;
  policySources: string[];
  steps: PlanStep[];
}

export type RunStep = PlanStep & {
  status: RunStepStatus;
  error: string | null;
  /** Dữ liệu hoàn tác của worker; giao diện không đọc. */
  undo: unknown;
};

export interface OptimizeRun {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  scoreBefore: number | null;
  scoreAfter: number | null;
  policySources: string[];
  steps: RunStep[];
  undoneAt: string | null;
}

/** Chính sách dự án đưa cho bản xem trước: `{ [projectId]: DevOptimizerPolicy }`. */
export type OptimizePolicies = Record<string, unknown>;

const GROUPS: readonly string[] = ["cli", "tools", "context", "score"];
const RUN_STATUSES: readonly string[] = ["planned", "skipped", "ok", "failed", "undone"];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isNumberOrNull = (v: unknown): v is number | null => v === null || (typeof v === "number" && Number.isFinite(v));
const isStringOrNull = (v: unknown): v is string | null => v === null || typeof v === "string";
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");
const isOptional = (v: unknown, type: "string" | "boolean" | "number") => v === undefined || typeof v === type;

function isPlanChange(v: unknown): v is PlanChange {
  return (
    isRecord(v) &&
    typeof v.file === "string" &&
    typeof v.key === "string" &&
    isStringOrNull(v.before) &&
    isStringOrNull(v.after)
  );
}

function isPlanStep(v: unknown): v is PlanStep {
  return (
    isRecord(v) &&
    typeof v.id === "string" &&
    typeof v.group === "string" &&
    GROUPS.includes(v.group) &&
    typeof v.target === "string" &&
    typeof v.title === "string" &&
    Array.isArray(v.changes) &&
    v.changes.every(isPlanChange) &&
    typeof v.selected === "boolean" &&
    typeof v.requiresConfirm === "boolean" &&
    typeof v.undoable === "boolean" &&
    typeof v.reason === "string" &&
    isOptional(v.profile, "string") &&
    isOptional(v.project, "string") &&
    (v.level === undefined || v.level === "balanced" || v.level === "aggressive") &&
    isOptional(v.rtk, "boolean") &&
    isOptional(v.autoCompactWindow, "number")
  );
}

function isRunStep(v: unknown): v is RunStep {
  if (!isPlanStep(v)) return false;
  const step = v as unknown as Record<string, unknown>;
  return (
    "undo" in step &&
    typeof step.status === "string" &&
    RUN_STATUSES.includes(step.status) &&
    isStringOrNull(step.error)
  );
}

/** Kiểm hình kế hoạch sidecar trả về trước khi giao diện dùng; test so với fixture của Go. */
export function isOptimizePlan(v: unknown): v is OptimizePlan {
  return (
    isRecord(v) &&
    typeof v.createdAt === "string" &&
    isNumberOrNull(v.scoreBefore) &&
    isStrings(v.policySources) &&
    Array.isArray(v.steps) &&
    v.steps.every(isPlanStep)
  );
}

/** Kiểm hình nhật ký một lần tối ưu (kể cả bản đã hoàn tác). */
export function isOptimizeRun(v: unknown): v is OptimizeRun {
  return (
    isRecord(v) &&
    typeof v.id === "string" &&
    typeof v.startedAt === "string" &&
    isStringOrNull(v.finishedAt) &&
    isNumberOrNull(v.scoreBefore) &&
    isNumberOrNull(v.scoreAfter) &&
    isStrings(v.policySources) &&
    Array.isArray(v.steps) &&
    v.steps.every(isRunStep) &&
    isStringOrNull(v.undoneAt)
  );
}

/** Kế hoạch với cờ `selected` mới; mọi trường khác giữ nguyên để sidecar chạy đúng bước đã xem. */
export function withSelection(plan: OptimizePlan, selected: (step: PlanStep, index: number) => boolean): OptimizePlan {
  return { ...plan, steps: plan.steps.map((step, i) => ({ ...step, selected: selected(step, i) })) };
}

/** Xem trước: dựng kế hoạch, không ghi gì lên máy. */
export const optimizeAllPreview = (policy?: OptimizePolicies | null) =>
  invoke<OptimizePlan>("optimize_all_preview", { policy: policy ?? null });
/** Chạy các bước đã chọn: Rust cài công cụ trước, rồi sidecar ghi cấu hình và ngữ cảnh. */
export const optimizeAllApply = (plan: OptimizePlan) => invoke<OptimizeRun>("optimize_all_apply", { plan });
export const optimizeAllUndo = (runId: string) => invoke<OptimizeRun>("optimize_all_undo", { runId });
/** Lần tối ưu gần nhất; null khi chưa có. */
export const optimizeAllLast = () => invoke<OptimizeRun | null>("optimize_all_last");
