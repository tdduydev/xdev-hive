/** What a task is (roadmap 54b), so the router (54c) can start it on a fitting model tier. */
export const TASK_KINDS = ["docs", "test", "small-fix", "feature", "ui", "refactor", "debug", "spec", "review", "merge", "ops"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];
export const TASK_SIZES = ["s", "m", "l"] as const;
export type TaskSize = (typeof TASK_SIZES)[number];
export const TASK_RISKS = ["normal", "high"] as const;
export type TaskRisk = (typeof TASK_RISKS)[number];
export type TaskClass = { kind: TaskKind; size: TaskSize; risk: TaskRisk };
/** Where a classifier fails, times out or runs over its cap: the middle of the table, never a cheap guess. */
export const DEFAULT_TASK_CLASS: TaskClass = { kind: "feature", size: "m", risk: "normal" };

/**
 * Keywords in the title or note, vi and en, most specific first: "Review the docs" is a review, "Merge the test fixes"
 * a merge. Vietnamese words go without \b, which only knows ASCII word characters.
 */
const KIND_RULES: [TaskKind, RegExp][] = [
  ["review", /\b(code review|review)\b|rà soát|kiểm duyệt/],
  ["merge", /\b(merge|rebase|conflicts?)\b|gộp nhánh|gộp branch|giải xung đột|xung đột/],
  // Not "cài đặt": it is also "settings", and "Thêm trang cài đặt" is a page, not an install.
  ["ops", /\b(release|deploy|publish|install)\b|phát hành|triển khai/],
  ["spec", /\b(spec|specification)\b|đặc tả|lập kế hoạch/],
  ["refactor", /\b(refactor|restructure)\b|tái cấu trúc/],
  ["debug", /\b(debug|investigate|root cause)\b|điều tra|tìm nguyên nhân/],
  ["test", /\b(tests?|testing|e2e|smoke)\b|kiểm thử|viết test|sửa test/],
  ["docs", /\b(docs?|documentation|readme|changelog|i18n|translations?)\b|tài liệu|bản dịch|chuỗi giao diện/],
  ["ui", /\b(ui|ux|layout|css)\b|giao diện|bố cục/],
  ["small-fix", /\b(typo|small fix|minor fix|hotfix)\b|sửa nhỏ|lỗi chính tả/],
];
const HIGH_RISK = /\b(migrations?|security|auth|authorization|permissions?|secrets?)\b|bảo mật|phân quyền|quyền truy cập|di chuyển dữ liệu/;

/**
 * The hub's rules (no model): a review run, a Spec Kit step, then keywords. Size is left to a person or the classifier
 * run, since a title says little about it; risk only when a keyword says high, so "normal" stays a real answer.
 */
export function classifyTaskRule(title: string, note: string | null, role?: string | null, specStep?: string | null): Partial<TaskClass> {
  const text = `${title}\n${note ?? ""}`.toLocaleLowerCase("vi");
  const kind: TaskKind | undefined = role === "review" ? "review" : specStep ? "spec" : KIND_RULES.find(([, re]) => re.test(text))?.[0];
  return { ...(kind ? { kind } : {}), ...(HIGH_RISK.test(text) ? { risk: "high" as const } : {}) };
}

/** A classifier's answer, or null when any field is missing or not one of ours. */
export function parseTaskClass(value: unknown): TaskClass | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  return TASK_KINDS.includes(v.kind as TaskKind) && TASK_SIZES.includes(v.size as TaskSize) && TASK_RISKS.includes(v.risk as TaskRisk)
    ? { kind: v.kind as TaskKind, size: v.size as TaskSize, risk: v.risk as TaskRisk }
    : null;
}
