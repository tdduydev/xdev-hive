import type { SdlcSize, SdlcSuggestion } from "@xdev-hive/contracts";

/**
 * Gợi ý cỡ việc và chế độ bằng luật tất định (spec 011 FR-007): nhãn issue, độ dài và cấu trúc mô tả, từ khoá rủi ro do
 * dự án khai. Thuần để chạy trong ≤ 3 giây không cần database hay agent; bước agent `size` là tuỳ chọn, chạy riêng.
 */

const SIZES: readonly SdlcSize[] = ["S", "M", "L", "XL"];
const sizeIndex = (s: SdlcSize) => SIZES.indexOf(s);

/** Chế độ dự án cho dùng, đủ để chọn mà không cần cả định nghĩa. */
export interface SuggestMode {
  ref: string;
  name: string;
  sizes: readonly SdlcSize[];
  profile: string;
}

export interface SuggestInput {
  title: string;
  idea: string;
  /** Nhãn của issue, khi hạng mục tạo từ issue. */
  labels?: readonly string[];
  /** `settings.sdlc.riskKeywords` của dự án chính. */
  riskKeywords: readonly string[];
  /** Có ít nhất một chế độ: người gọi trả lỗi "dự án chưa có chế độ" trước khi tới đây. */
  modes: readonly [SuggestMode, ...SuggestMode[]];
  defaultMode?: string | null;
}

/**
 * Bỏ dấu và hạ chữ thường để so khớp từ khoá không phụ thuộc cách gõ ("Thanh toán" = "thanh toan"). Tách ra để luật tự
 * duyệt (từ khoá nhạy cảm) dùng cùng một cách chuẩn hoá với gợi ý.
 */
export function foldText(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[đĐ]/g, "d").toLowerCase();
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Từ khoá nằm trọn từ: "token" không khớp "tokenize". Cả hai vế đã qua `foldText`. */
function hasKeyword(folded: string, keyword: string): boolean {
  const kw = foldText(keyword).trim();
  if (!kw) return false;
  return new RegExp(`(?<![a-z0-9])${escapeRe(kw)}(?![a-z0-9])`).test(folded);
}

const BUG_LABELS = new Set(["bug", "bugfix", "defect", "hotfix", "regression", "loi", "crash", "incident"]);
const SMALL_LABELS = new Set([
  "chore",
  "docs",
  "documentation",
  "typo",
  "tai-lieu",
  "dependencies",
  "good-first-issue",
]);
const FEATURE_LABELS = new Set(["feature", "enhancement", "story", "tinh-nang"]);
const BREAKING_LABELS = new Set(["breaking", "breaking-change"]);

const labelKey = (label: string) =>
  foldText(label)
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const isBugfixMode = (m: SuggestMode) => m.profile === "bugfix" || m.ref.includes("bugfix");

/** Mô tả càng dài và càng nhiều gạch đầu dòng thì việc càng lớn; ngưỡng thô nhưng ổn định giữa các lần gọi. */
function lengthPoints(idea: string): { points: number; note: string } {
  const chars = idea.trim().length;
  const items = idea.split("\n").filter((l) => /^\s*(?:[-*+]|\d+[.)])\s+\S/.test(l)).length;
  let points = chars < 400 ? 0 : chars < 1000 ? 1 : chars < 2500 ? 2 : 3;
  if (items >= 8) points += 2;
  else if (items >= 4) points += 1;
  const note = points === 0 ? "mô tả ngắn" : points <= 1 ? "mô tả vừa" : "mô tả dài";
  return { points, note };
}

function sizeOf(points: number): SdlcSize {
  if (points <= 1) return "S";
  if (points <= 3) return "M";
  if (points <= 5) return "L";
  return "XL";
}

export function suggestSdlc(input: SuggestInput): SdlcSuggestion {
  const folded = foldText(`${input.title}\n${input.idea}`);
  const labels = (input.labels ?? []).map(labelKey).filter(Boolean);
  const signals: string[] = [];
  let points = 0;

  const bugLabel = (input.labels ?? []).find((l) => BUG_LABELS.has(labelKey(l)));
  const featureLabel = labels.some((l) => FEATURE_LABELS.has(l));
  // Tiêu đề kiểu "Lỗi …" chỉ là tín hiệu yếu, nhường nhãn "feature" của issue.
  const bugTitle = !featureLabel && /^(?:bug|loi|fix|sua loi)\b/.test(foldText(input.title).trim());
  const bug = Boolean(bugLabel) || bugTitle;
  if (bugLabel) signals.push(`nhãn ${bugLabel}`);
  else if (bugTitle) signals.push("tiêu đề báo lỗi");

  const smallLabel = (input.labels ?? []).find((l) => SMALL_LABELS.has(labelKey(l)));
  if (smallLabel) {
    signals.push(`nhãn ${smallLabel}`);
    points -= 3;
  }
  if (bug) points -= 3;
  if (labels.includes("epic")) {
    signals.push("nhãn epic");
    points += 3;
  }
  if (labels.some((l) => BREAKING_LABELS.has(l))) {
    signals.push("thay đổi phá vỡ tương thích");
    points += 2;
  }
  if (featureLabel) {
    signals.push("nhãn tính năng");
    points += 1;
  }

  const length = lengthPoints(input.idea);
  points += length.points;
  signals.push(length.note);

  const hits = input.riskKeywords.filter((k) => hasKeyword(folded, k));
  if (hits.length) {
    signals.push(`nhắc “${hits.slice(0, 3).join("”, “")}”`);
    points += Math.min(hits.length, 2);
  }

  let size = sizeOf(points);
  // Việc đụng vùng rủi ro không bao giờ là cỡ S: S bỏ cổng duyệt tài liệu.
  if (hits.length && size === "S") size = "M";

  const ranked = input.modes
    .map((mode, index) => ({
      mode,
      index,
      distance: Math.min(...mode.sizes.map((s) => Math.abs(sizeIndex(s) - sizeIndex(size)))),
      // Việc thường không rơi vào chế độ sửa lỗi dù cùng cỡ S, và ngược lại.
      mismatch: bug === isBugfixMode(mode) ? 0 : 1,
      notDefault: mode.ref === input.defaultMode ? 0 : 1,
    }))
    .sort(
      (a, b) =>
        a.distance - b.distance ||
        a.mismatch - b.mismatch ||
        a.notDefault - b.notDefault ||
        a.mode.sizes.length - b.mode.sizes.length ||
        a.index - b.index,
    );
  const [best, ...rest] = ranked as [(typeof ranked)[number], ...typeof ranked];

  const fits = best.distance === 0;
  const reason = `${capitalize(signals.join(", "))} → ${size} → ${best.mode.name}${
    fits ? "" : `. Chưa có chế độ cho cỡ ${size}, chọn chế độ gần nhất`
  }.`;
  return {
    size,
    modeRef: best.mode.ref,
    reason,
    alternatives: rest.slice(0, 10).map((r) => ({
      modeRef: r.mode.ref,
      reason:
        r.distance === 0 ? `Cũng hợp cỡ ${size}.` : `Dành cho cỡ ${r.mode.sizes.join(", ")}, không đúng cỡ ${size}.`,
    })),
  };
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
