import { ORPCError } from "@orpc/client";
import {
  defaultTokenSaving,
  type OutcomeCheck,
  type ProjectSettings,
  type ProjectSettingsPatch,
  projectSettingsPatch,
  type TokenSaving,
} from "@xdev-hive/contracts";
import { apiErrorMessage } from "@/lib/api-errors.ts";

export const SETTINGS_CLIS = ["claude", "codex", "gemini", "antigravity"] as const;
export type SettingsCli = (typeof SETTINGS_CLIS)[number];
/** Antigravity không gọi được tool MCP khi chạy chỉ đọc nên không nộp được review_submit. */
export const REVIEW_CLIS = ["claude", "codex", "gemini"] as const;
export type ReviewCli = (typeof REVIEW_CLIS)[number];
export type MergeMode = ProjectSettings["merge"]["mode"];
export type PermissionMode = "workspace" | "full";

type ReviewCheck = Extract<OutcomeCheck, { check: "review" }>;

/**
 * Giá trị các ô của màn cấu hình dự án. Ô số giữ dạng chuỗi như người gõ, để ô trống (không giới hạn) và chữ gõ dở
 * không bị ép thành 0 trước khi kiểm.
 */
export interface SettingsForm {
  mergeMode: MergeMode;
  requiredApprovals: string;
  /** "" là để hub chọn mặc định (squash). */
  mergeMethod: "" | "merge" | "squash" | "rebase";
  requireCi: boolean;
  mergeQueue: boolean;
  planMode: boolean;
  /** Run code chạy trên runner host trong container gVisor thay cho máy dev. */
  sandbox: boolean;
  crossReview: boolean;
  reviewBy: ReviewCli;
  reviewMinScore: string;
  reviewRequired: boolean;
  reviewMinLines: string;
  /** Mỗi dòng một mẫu đường dẫn. */
  reviewPaths: string;
  perRunUsd: string;
  perTaskUsd: string;
  maxTurns: string;
  models: Record<SettingsCli, { code: string; review: string }>;
  runPermissions: PermissionMode;
  /** Tiết kiệm token cho run Claude Code; ô số giữ dạng chuỗi như các ô khác. */
  tokenSaving: boolean;
  bashMaxChars: string;
  autocompactPct: string;
  subagentModel: string;
  cacheTtl: TokenSaving["cacheTtl"];
}

const text = (n: number | undefined): string => (n === undefined ? "" : String(n));

/** Bước review chéo do màn này sửa: bước review đầu tiên trong chính sách mặc định của dự án. */
const reviewIndex = (checks: OutcomeCheck[]): number => checks.findIndex((c) => c.check === "review");

export function formFromSettings(s: ProjectSettings): SettingsForm {
  const review = s.outcome.default.find((c): c is ReviewCheck => c.check === "review");
  const model = (cli: SettingsCli) => ({ code: s.models?.[cli]?.code ?? "", review: s.models?.[cli]?.review ?? "" });
  // Hub cũ chưa gửi mục này: hiện mặc định, như hub mới điền cho dự án lưu từ trước.
  const saving = s.tokenSaving ?? defaultTokenSaving;
  return {
    mergeMode: s.merge.mode,
    requiredApprovals: String(s.merge.requiredApprovals),
    mergeMethod: s.merge.method ?? "",
    requireCi: s.merge.requireCi ?? false,
    mergeQueue: s.features.mergeQueue,
    planMode: s.features.planMode,
    sandbox: s.features.sandbox,
    crossReview: s.features.crossReview,
    reviewBy: review?.by ?? "codex",
    reviewMinScore: text(review?.minScore ?? 7),
    reviewRequired: review?.required ?? true,
    reviewMinLines: text(review?.when?.minChangedLines),
    reviewPaths: (review?.when?.paths ?? []).join("\n"),
    perRunUsd: text(s.budget?.perRunUsd),
    perTaskUsd: text(s.budget?.perTaskUsd),
    maxTurns: text(s.budget?.maxTurns),
    models: {
      claude: model("claude"),
      codex: model("codex"),
      gemini: model("gemini"),
      antigravity: model("antigravity"),
    },
    runPermissions: s.runPermissions?.mode ?? "workspace",
    tokenSaving: saving.enabled,
    bashMaxChars: String(saving.bashMaxChars),
    autocompactPct: String(saving.autocompactPct),
    subagentModel: saving.subagentModel,
    cacheTtl: saving.cacheTtl,
  };
}

/** Lỗi theo ô: khoá là tên ô trong SettingsForm (`models.claude.code` với ô model). */
export type FieldErrors = Partial<Record<string, string>>;

const NOT_A_NUMBER = "Nhập một số, hoặc để trống.";

/** Chuỗi trong ô số: trống là null, chữ không phải số thì ghi lỗi vào ô và trả NaN để zod không báo trùng. */
function num(value: string, field: string, errors: FieldErrors): number | null {
  const v = value.trim().replace(",", ".");
  if (!v) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) errors[field] = NOT_A_NUMBER;
  return n;
}

/** Ô số bắt buộc: trống là lỗi ô (không có "không giới hạn" như ngân sách), trả NaN để zod không báo trùng. */
function requiredNum(value: string, field: string, errors: FieldErrors): number {
  const n = num(value, field, errors);
  if (n === null) {
    errors[field] = "Nhập một số.";
    return Number.NaN;
  }
  return n;
}

/** Bước review sau khi sửa trên form; không đổi các trường form không có (vd. bước tuỳ biến bằng API). */
function reviewFromForm(form: SettingsForm, base: ReviewCheck | undefined, errors: FieldErrors): ReviewCheck {
  const minChangedLines = num(form.reviewMinLines, "reviewMinLines", errors);
  const paths = form.reviewPaths
    .split("\n")
    .map((p) => p.trim())
    .filter(Boolean);
  const when = {
    ...(minChangedLines !== null ? { minChangedLines } : {}),
    ...(paths.length > 0 ? { paths } : {}),
  };
  const { when: _, ...rest } = base ?? { check: "review" as const };
  return {
    ...rest,
    check: "review",
    by: form.reviewBy,
    required: form.reviewRequired,
    minScore: num(form.reviewMinScore, "reviewMinScore", errors) ?? 7,
    ...(Object.keys(when).length > 0 ? { when } : {}),
  };
}

/** Bản vá đầy đủ mọi mục màn này sửa được, chưa bỏ mục không đổi. */
function fullPatch(form: SettingsForm, current: ProjectSettings, errors: FieldErrors) {
  const checks = current.outcome.default;
  const at = reviewIndex(checks);
  let outcomeDefault = checks;
  // Chỉ thêm bước review khi bật review chéo; tắt thì giữ nguyên bước cũ (hub bỏ qua khi cờ tắt) để bật lại không mất
  // cấu hình.
  if (form.crossReview || at >= 0) {
    const review = reviewFromForm(form, at >= 0 ? (checks[at] as ReviewCheck) : undefined, errors);
    outcomeDefault = at >= 0 ? checks.map((c, i) => (i === at ? review : c)) : [...checks, review];
  }
  const model = (v: string) => v.trim() || null;
  return {
    merge: {
      mode: form.mergeMode,
      requiredApprovals: num(form.requiredApprovals, "requiredApprovals", errors) ?? 0,
      method: form.mergeMethod || null,
      requireCi: form.requireCi,
    },
    features: {
      planMode: form.planMode,
      crossReview: form.crossReview,
      mergeQueue: form.mergeQueue,
      sandbox: form.sandbox,
    },
    outcome: { default: outcomeDefault },
    budget: {
      perRunUsd: num(form.perRunUsd, "perRunUsd", errors),
      perTaskUsd: num(form.perTaskUsd, "perTaskUsd", errors),
      maxTurns: num(form.maxTurns, "maxTurns", errors),
    },
    models: Object.fromEntries(
      SETTINGS_CLIS.map((cli) => [cli, { code: model(form.models[cli].code), review: model(form.models[cli].review) }]),
    ),
    runPermissions: { mode: form.runPermissions },
    tokenSaving: {
      enabled: form.tokenSaving,
      bashMaxChars: requiredNum(form.bashMaxChars, "bashMaxChars", errors),
      autocompactPct: requiredNum(form.autocompactPct, "autocompactPct", errors),
      subagentModel: form.subagentModel.trim(),
      cacheTtl: form.cacheTtl,
    },
  };
}

/** Đổi đường dẫn issue của zod (theo bản vá) thành tên ô trên form. */
export function fieldOfPath(path: readonly PropertyKey[]): string | undefined {
  const [section, key, sub] = path.map(String);
  switch (section) {
    case "merge":
      return key === "requiredApprovals" ? "requiredApprovals" : key === "method" ? "mergeMethod" : undefined;
    case "budget":
      return key === "perRunUsd" || key === "perTaskUsd" || key === "maxTurns" ? key : undefined;
    case "models":
      return key && sub ? `models.${key}.${sub}` : undefined;
    case "runPermissions":
      return "runPermissions";
    case "tokenSaving":
      return key === "bashMaxChars" || key === "autocompactPct" || key === "subagentModel" || key === "cacheTtl"
        ? key
        : undefined;
    case "outcome": {
      // outcome.default.<i>.<trường>[.when.<trường>]
      const rest = path.slice(3).map(String);
      if (rest[0] === "minScore") return "reviewMinScore";
      if (rest[0] === "by") return "reviewBy";
      if (rest[0] === "when") return rest[1] === "paths" ? "reviewPaths" : "reviewMinLines";
      return undefined;
    }
    default:
      return undefined;
  }
}

export type BuildResult =
  | { ok: true; patch: ProjectSettingsPatch | null }
  | { ok: false; errors: FieldErrors; message?: string };

/**
 * Bản vá gửi projects.updateSettings: chỉ các mục khác với settings đang lưu, để audit chỉ ghi mục thật sự đổi. Kiểm
 * bằng chính schema của hub trước khi gửi, lỗi gắn vào ô. `patch: null` là không có gì đổi.
 */
export function buildPatch(form: SettingsForm, current: ProjectSettings): BuildResult {
  const errors: FieldErrors = {};
  const next = fullPatch(form, current, errors);
  const base = fullPatch(formFromSettings(current), current, {});
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(next) as Array<keyof typeof next>) {
    if (JSON.stringify(next[key]) !== JSON.stringify(base[key])) patch[key] = next[key];
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  if (Object.keys(patch).length === 0) return { ok: true, patch: null };
  const parsed = projectSettingsPatch.safeParse(patch);
  if (parsed.success) return { ok: true, patch: parsed.data };
  const out: FieldErrors = {};
  let message: string | undefined;
  for (const issue of parsed.error.issues) {
    const field = fieldOfPath(issue.path);
    if (field) out[field] ??= issue.message;
    else message ??= issue.message;
  }
  return { ok: false, errors: out, ...(message ? { message } : {}) };
}

/**
 * Lỗi hub trả khi lưu, gắn vào ô nếu biết: BAD_REQUEST của oRPC mang issues với đường dẫn `settings.<…>`, lỗi
 * SETTINGS_INVALID chỉ nói trường trong câu báo nên hiện chung.
 */
export function saveErrors(error: unknown): { errors: FieldErrors; message?: string } {
  if (error instanceof ORPCError && error.code === "BAD_REQUEST") {
    const data: unknown = error.data;
    const issues =
      typeof data === "object" && data !== null && "issues" in data && Array.isArray(data.issues) ? data.issues : [];
    const errors: FieldErrors = {};
    for (const issue of issues as { path?: unknown; message?: unknown }[]) {
      if (!Array.isArray(issue.path) || typeof issue.message !== "string") continue;
      const path = issue.path.map((p: unknown) =>
        typeof p === "object" && p !== null && "key" in p ? (p as { key: PropertyKey }).key : (p as PropertyKey),
      );
      const field = fieldOfPath(path[0] === "settings" ? path.slice(1) : path);
      if (field) errors[field] ??= issue.message;
    }
    if (Object.keys(errors).length > 0) return { errors };
  }
  return { errors: {}, message: apiErrorMessage(error) };
}
