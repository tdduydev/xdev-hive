import { useQuery } from "@tanstack/react-query";
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

/**
 * Hub có nhận file Word không (FR-023). `unknown` là lúc chưa đọc được health: chưa hiện nút, cũng chưa nói "đang tắt".
 * Hub cũ không trả trường này nên coi là tắt: route nhập Word không có ở hub đó.
 */
export interface WordImportSupport {
  state: "unknown" | "on" | "off";
  /** Có LibreOffice để nhận `.doc`. */
  doc: boolean;
}

export function wordImportSupport(health: Health | undefined): WordImportSupport {
  if (!health) return { state: "unknown", doc: false };
  if (health.wordImport !== true) return { state: "off", doc: false };
  return { state: "on", doc: health.wordImportDoc === true };
}

/** Dùng chung khoá ["health"] với BuildInfo ở user-card để hai nơi chỉ gọi hub một lần. */
export function useWordImportSupport(): WordImportSupport {
  const health = useQuery({ queryKey: ["health"], queryFn: fetchHealth, staleTime: 5 * 60_000 });
  return wordImportSupport(health.data);
}
