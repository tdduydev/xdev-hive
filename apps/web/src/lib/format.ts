const day = new Intl.DateTimeFormat("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" });

/** Ngày theo kiểu Việt Nam (11/10/2026), theo múi giờ của máy người xem. */
export function formatDay(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : day.format(date);
}
