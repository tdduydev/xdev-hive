export const TASK_KINDS = ["docs", "test", "small-fix", "feature", "ui", "refactor", "debug", "spec", "review", "merge", "ops"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];
export const TASK_SIZES = ["s", "m", "l"] as const;
export type TaskSize = (typeof TASK_SIZES)[number];
export const TASK_RISKS = ["normal", "high"] as const;
export type TaskRisk = (typeof TASK_RISKS)[number];
export type TaskClass = { kind: TaskKind; size: TaskSize; risk: TaskRisk };
export const DEFAULT_TASK_CLASS: TaskClass = { kind: "feature", size: "m", risk: "normal" };

/** Rules only use task metadata; an ambiguous title stays empty for the small classifier run. */
export function classifyTaskRule(title: string, note: string | null, role?: string | null, specStep?: string | null): Partial<TaskClass> {
  const text = `${title}\n${note ?? ""}`.toLocaleLowerCase();
  const matches = (pattern: RegExp) => pattern.test(text);
  const kind: TaskKind | undefined = role === "review" ? "review"
    : specStep && /^(spec|plan|tasks)$/.test(specStep) ? "spec"
    : matches(/\b(review|code review)\b|rà soát|kiểm duyệt/) ? "review"
    : matches(/\b(merge|conflict)\b|gộp|xung đột/) ? "merge"
    : matches(/\b(release|deploy|install|setup)\b|phát hành|triển khai|cài đặt/) ? "ops"
    : matches(/\b(spec|specification|planning|plan)\b|đặc tả|lập kế hoạch/) ? "spec"
    : matches(/\b(refactor|restructure)\b|tái cấu trúc/) ? "refactor"
    : matches(/\b(debug|investigate|root cause)\b|điều tra lỗi|tìm nguyên nhân/) ? "debug"
    : matches(/\b(ui|ux|interface|layout|css)\b|giao diện|bố cục/) ? "ui"
    : matches(/\b(test|tests|testing|e2e)\b|kiểm thử|bài kiểm tra/) ? "test"
    : matches(/\b(docs?|documentation|readme|changelog|i18n)\b|tài liệu|bản dịch|chuỗi giao diện/) ? "docs"
    : matches(/\b(small fix|typo|minor fix)\b|sửa nhỏ|lỗi chính tả/) ? "small-fix"
    : undefined;
  const risk: TaskRisk = matches(/\b(migration|security|auth|authorization|permission)\b|di trú|bảo mật|phân quyền|quyền truy cập/) ? "high" : "normal";
  // A precise size is better supplied by a person or the classifier than guessed from title length.
  return { ...(kind ? { kind } : {}), risk };
}

export function parseTaskClass(value: unknown): TaskClass | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  return TASK_KINDS.includes(v.kind as TaskKind) && TASK_SIZES.includes(v.size as TaskSize) && TASK_RISKS.includes(v.risk as TaskRisk)
    ? { kind: v.kind as TaskKind, size: v.size as TaskSize, risk: v.risk as TaskRisk }
    : null;
}
