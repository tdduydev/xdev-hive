import { getLang, type Lang } from "@/lib/i18n.ts";

/*
 * Ngày theo ngôn ngữ giao diện: bản VI là 11/10/2026, bản EN viết tên tháng (Oct 11, 2026) vì người đọc tiếng Anh hiểu
 * 11/10 là ngày 10 tháng 11. Hàm nhận `lang` để test và chuỗi chỉ có tiếng Việt cố định được; bỏ trống thì theo ngôn ngữ
 * đang chọn, component gọi đã vẽ lại khi đổi ngôn ngữ vì dùng `useT`.
 */
const day: Record<Lang, Intl.DateTimeFormat> = {
  vi: new Intl.DateTimeFormat("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" }),
  en: new Intl.DateTimeFormat("en-US", { day: "numeric", month: "short", year: "numeric" }),
};
const monthDay = new Intl.DateTimeFormat("en-US", { day: "numeric", month: "short" });
const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** Ngày (11/10/2026 hay Oct 11, 2026), theo múi giờ của máy người xem. */
export function formatDay(iso: string, lang: Lang = getLang()): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : day[lang].format(date);
}

const clock = new Intl.DateTimeFormat("vi-VN", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});
const hourMinute = new Intl.DateTimeFormat("vi-VN", { hour: "2-digit", minute: "2-digit", hour12: false });
const usd = new Intl.NumberFormat("vi-VN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const integer = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 });

/** Giờ:phút:giây (14:02:11), cho dòng sự kiện và log. */
export function formatClock(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : clock.format(date);
}

/** Giờ:phút và ngày/tháng (14:02, 11/10 hay 14:02, Oct 11), cho mốc bắt đầu của run. */
export function formatDayTime(iso: string, lang: Lang = getLang()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  if (lang === "en") return `${hourMinute.format(date)}, ${monthDay.format(date)}`;
  // Tự ghép ngày/tháng: Intl của vi-VN cho "11-10" khi bỏ năm.
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${hourMinute.format(date)}, ${pad(date.getDate())}/${pad(date.getMonth() + 1)}`;
}

/** Số tiền USD kiểu Việt Nam: 0,42 USD. null là CLI không báo USD (Codex, Gemini). */
export function formatUsd(value: number | null): string {
  return value === null ? "—" : `${usd.format(value)} USD`;
}

/** Số nguyên có dấu chấm ngăn nghìn: 182.400. */
export function formatInt(value: number): string {
  return integer.format(value);
}

/**
 * Tỉ lệ cache trúng: token đọc từ cache trên tổng token vào (đọc cache + ghi cache + vào thường), như 97,3%. Không có
 * token vào nào (CLI không báo, run chưa chạy) là gạch ngang thay vì 0%, để không lẫn với cache trượt hoàn toàn.
 */
export function formatCacheHit(read: number, write: number, input: number): string {
  const total = read + write + input;
  if (total <= 0) return "—";
  return `${new Intl.NumberFormat("vi-VN", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format((read / total) * 100)}%`;
}

/** Tỉ lệ 0..1 thành phần trăm nguyên: 0,39 thành "39%". */
export function formatPercent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/** Khoảng thời gian: 45 giây, 6 phút 12 giây, 1 giờ 5 phút. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return m > 0 ? `${h} giờ ${m} phút` : `${h} giờ`;
  if (m > 0) return s > 0 ? `${m} phút ${s} giây` : `${m} phút`;
  return `${s} giây`;
}

/** Thời điểm so với `now`: vừa xong, 12 phút trước, 3 giờ trước, hôm qua, rồi tới ngày. */
export function formatAgo(iso: string, now: number, lang: Lang = getLang()): string {
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return "—";
  const sec = Math.max(0, Math.floor((now - at) / 1000));
  const en = lang === "en";
  if (sec < 60) return en ? "just now" : "vừa xong";
  if (sec < 3600) return en ? relative.format(-Math.floor(sec / 60), "minute") : `${Math.floor(sec / 60)} phút trước`;
  if (sec < 24 * 3600)
    return en ? relative.format(-Math.floor(sec / 3600), "hour") : `${Math.floor(sec / 3600)} giờ trước`;
  if (sec < 48 * 3600) return en ? "yesterday" : "hôm qua";
  return formatDay(iso, lang);
}
