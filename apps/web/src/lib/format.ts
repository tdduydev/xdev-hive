const day = new Intl.DateTimeFormat("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" });

/** Ngày theo kiểu Việt Nam (11/10/2026), theo múi giờ của máy người xem. */
export function formatDay(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : day.format(date);
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

/** Giờ:phút và ngày/tháng (14:02, 11/10), cho mốc bắt đầu của run. */
export function formatDayTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
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
export function formatAgo(iso: string, now: number): string {
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return "—";
  const sec = Math.max(0, Math.floor((now - at) / 1000));
  if (sec < 60) return "vừa xong";
  if (sec < 3600) return `${Math.floor(sec / 60)} phút trước`;
  if (sec < 24 * 3600) return `${Math.floor(sec / 3600)} giờ trước`;
  if (sec < 48 * 3600) return "hôm qua";
  return formatDay(iso);
}
