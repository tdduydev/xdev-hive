import type { MachineTokenScore, TokenScoreReport } from "@xdev-hive/contracts";
import type { Tone } from "@/lib/run-view.ts";

export type TokenScoreLevel = NonNullable<TokenScoreReport["machine"]["level"]>;
export type TokenScoreStatus = TokenScoreReport["profiles"][number]["criteria"][number]["status"];

const LEVEL_TONE: Record<TokenScoreLevel, Tone> = { good: "ok", fair: "warn", low: "bad" };
const STATUS_TONE: Record<TokenScoreStatus, Tone> = {
  ok: "ok",
  partial: "warn",
  low: "bad",
  unknown: "neutral",
  unsupported: "neutral",
};

export const levelTone = (level: TokenScoreLevel | null): Tone => (level ? LEVEL_TONE[level] : "neutral");
export const statusTone = (status: TokenScoreStatus): Tone => STATUS_TONE[status];

/** Điểm hiện số nguyên: phần lẻ do trọng số gói không mang thêm ý nghĩa cho quản trị. */
export const formatScore = (score: number | null | undefined): string =>
  score === null || score === undefined ? "—" : String(Math.round(score));

/** Giá trị đo kèm đơn vị; "%" dính liền số, đơn vị chữ cách một khoảng. */
export function formatCriterionValue(value: number | undefined, unit: string | undefined): string {
  if (value === undefined) return "—";
  const number = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 1 }).format(value);
  if (!unit) return number;
  return unit === "%" ? `${number}%` : `${number} ${unit}`;
}

/** Điểm earned/max gọn: bỏ phần lẻ ,0 để cột không dài vô ích. */
export function formatPoints(earned: number, max: number): string {
  const format = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 1 });
  return `${format.format(earned)}/${format.format(max)}`;
}

/**
 * Toạ độ đường xu hướng điểm 0–100 trong khung `width`×`height`. Bỏ các lần gửi không có điểm (phạm vi đo quá thấp)
 * thay vì vẽ về 0, để không lẫn "chưa đo" với "điểm 0". Trục ngang theo thời gian thật, không theo thứ tự lần gửi:
 * máy tắt vài ngày thì đường giãn ra đúng khoảng trống đó.
 */
export function trendPoints(
  history: MachineTokenScore["history"],
  width: number,
  height: number,
): Array<{ x: number; y: number; at: string; score: number }> {
  const scored = history.filter((point): point is typeof point & { score: number } => point.score !== null);
  if (scored.length === 0) return [];
  const times = scored.map((point) => new Date(point.reportedAt).getTime());
  const first = Math.min(...times);
  const span = Math.max(...times) - first;
  return scored.map((point, index) => ({
    x: span === 0 ? width / 2 : (((times[index] ?? first) - first) / span) * width,
    y: height - (Math.min(100, Math.max(0, point.score)) / 100) * height,
    at: point.reportedAt,
    score: point.score,
  }));
}
