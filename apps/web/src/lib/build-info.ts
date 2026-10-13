import type { Health } from "@xdev-hive/contracts";

/** Mã commit rút gọn: deploy đặt HIVE_VERSION là SHA đầy đủ, bản phát hành là số semver thì giữ nguyên. */
export function shortVersion(version: string): string {
  return /^[0-9a-f]{12,40}$/.test(version) ? version.slice(0, 7) : version;
}

/** Ngày giờ build theo giờ máy người xem: 13/10/2026 14:05. null khi hub chạy từ mã nguồn (không có BUILD_TIME). */
export function formatBuiltAt(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export async function fetchHealth(): Promise<Health> {
  const res = await fetch("/api/v1/health");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as Health;
}
