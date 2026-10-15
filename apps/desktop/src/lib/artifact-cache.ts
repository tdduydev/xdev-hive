/*
 * Bộ đệm artifact để đọc offline (specs/012-artifacts T040, FR-091). Rust giữ bộ đệm theo hub và tổ chức của token
 * đang liên kết (src-tauri/src/artifacts.rs); giao diện không truyền phạm vi nên không đọc được bản của tổ chức khác.
 * Khung cách ly nạp tài liệu đã đệm qua giao thức `hive-artifact`, không cần hub.
 */
import type { ArtifactDetail, ArtifactSummary, ArtifactTheme } from "@xdev-hive/contracts";
import { invoke } from "@/lib/tauri.ts";

export interface CachedArtifact {
  id: string;
  version: number;
  detail: ArtifactDetail;
  /** Tài liệu khung (`artifacts.frameDocument`) theo giao diện đã tải. */
  frames: Partial<Record<ArtifactTheme, string>>;
  savedAt: number;
}

export interface CachedSummary {
  id: string;
  version: number;
  artifact: ArtifactSummary;
  themes: ArtifactTheme[];
  savedAt: number;
  sizeBytes: number;
}

/**
 * CSP của khung app, giống hệt khung trên hub ngoài nguồn thư viện. Rust gửi đúng chuỗi này (test `cargo test`
 * so với file này); test TypeScript so với `buildCsp` của runtime nên hai bên không lệch nhau.
 */
export const APP_FRAME_CSP =
  "default-src 'none'; script-src 'unsafe-inline' hive-artifact://localhost/lib/; style-src 'unsafe-inline' hive-artifact://localhost/lib/; img-src data: blob:; connect-src 'none'; form-action 'none'; frame-src 'none'; base-uri 'none'; sandbox allow-scripts";

/** Lưu phiên bản vừa mở, kèm tài liệu khung nếu loại đó chạy trong khung. Chưa liên kết tài khoản thì báo lỗi. */
export function cachePut(
  detail: ArtifactDetail,
  frame?: { theme: ArtifactTheme; html: string },
): Promise<CachedSummary> {
  return invoke<CachedSummary>("artifact_cache_put", { entry: { detail, frame } });
}

/** Một phiên bản đã đệm; không nêu phiên bản thì bản mới nhất đã tải. Chưa có thì `null`. */
export function cacheGet(id: string, version?: number): Promise<CachedArtifact | null> {
  return invoke<CachedArtifact | null>("artifact_cache_get", { id, version: version ?? null });
}

/** Các phiên bản đã tải, mới nhất trước. */
export function cacheList(): Promise<CachedSummary[]> {
  return invoke<CachedSummary[]>("artifact_cache_list");
}

/** Bỏ bản đệm của artifact đã mất quyền hoặc bị xoá; không nêu `ids` thì xoá cả bộ đệm của tài khoản. */
export function cacheClear(ids?: string[]): Promise<void> {
  return invoke<void>("artifact_cache_clear", { ids: ids ?? null });
}

/** WebView2 phục vụ giao thức riêng dưới `http://<tên>.localhost`; macOS và Linux giữ `hive-artifact://`. */
export function frameBase(userAgent: string = navigator.userAgent): string {
  return /Windows/i.test(userAgent) ? "http://hive-artifact.localhost/" : "hive-artifact://localhost/";
}

/** Địa chỉ khung của một phiên bản đã đệm, cho `<iframe src>`. */
export function cachedFrameUrl(
  id: string,
  version: number,
  theme: ArtifactTheme,
  userAgent?: string,
): string {
  return `${frameBase(userAgent)}frame/${encodeURIComponent(id)}/${version}?theme=${theme}`;
}

/** Mỗi artifact một dòng (phiên bản mới nhất đã tải), cho danh sách khi mất mạng. */
export function latestPerArtifact(list: CachedSummary[]): CachedSummary[] {
  const latest = new Map<string, CachedSummary>();
  for (const item of list) {
    const seen = latest.get(item.id);
    if (!seen || item.version > seen.version) latest.set(item.id, item);
  }
  return [...latest.values()].sort((a, b) => b.savedAt - a.savedAt);
}
