import { readFile } from "node:fs/promises";
import { newerVersion, validVersion } from "@xdev-hive/contracts";

// Test và module khác vẫn lấy newerVersion từ đây như trước khi chuyển sang contracts.
export { newerVersion };

type PlatformRelease = { signature: string; url: string };
type Manifest = {
  version: string;
  notes?: string | null;
  pub_date?: string | null;
  platforms: Record<string, PlatformRelease>;
};
function parseManifest(value: unknown): Manifest {
  if (!value || typeof value !== "object") throw new Error("manifest không hợp lệ");
  const m = value as Manifest;
  if (typeof m.version !== "string" || !validVersion(m.version) || !m.platforms || typeof m.platforms !== "object")
    throw new Error("manifest không hợp lệ");
  return m;
}

export class DesktopReleaseCache {
  private loadedAt = Number.NEGATIVE_INFINITY;
  private manifest: Manifest | null = null;
  private readonly source: string | undefined;
  private readonly now: () => number;
  private readonly fetcher: typeof fetch;
  constructor(source: string | undefined, now: () => number = Date.now, fetcher: typeof fetch = fetch) {
    this.source = source;
    this.now = now;
    this.fetcher = fetcher;
  }
  async get(): Promise<Manifest | null> {
    if (this.now() - this.loadedAt < 300_000) return this.manifest;
    this.loadedAt = this.now();
    this.manifest = null;
    if (!this.source) return null;
    try {
      let raw: string;
      if (/^https:\/\//i.test(this.source)) {
        const response = await this.fetcher(this.source);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        raw = await response.text();
      } else if (/^https?:\/\//i.test(this.source)) throw new Error("chỉ hỗ trợ URL https");
      else raw = await readFile(this.source, "utf8");
      this.manifest = parseManifest(JSON.parse(raw));
    } catch (error) {
      // Lỗi nguồn phát hành không được làm hỏng API chính; giữ kết quả rỗng đến lần làm mới kế tiếp.
      console.warn("Không đọc được HIVE_DESKTOP_RELEASES:", error);
    }
    return this.manifest;
  }
}

export async function findDesktopUpdate(cache: DesktopReleaseCache, os: string, arch: string, currentVersion: string) {
  if (
    !["macos", "linux", "windows"].includes(os) ||
    !["aarch64", "x86_64"].includes(arch) ||
    !validVersion(currentVersion)
  )
    return { kind: "bad-request" as const };
  const manifest = await cache.get();
  const platform = manifest?.platforms[`${os === "macos" ? "darwin" : os}-${arch}`];
  if (!manifest || !platform || !newerVersion(manifest.version, currentVersion)) return { kind: "none" as const };
  try {
    const url = new URL(platform.url);
    if (url.protocol !== "https:" || typeof platform.signature !== "string") return { kind: "none" as const };
  } catch {
    return { kind: "none" as const };
  }
  return {
    kind: "update" as const,
    update: {
      version: manifest.version,
      notes: manifest.notes ?? null,
      pub_date: manifest.pub_date ?? null,
      url: platform.url,
      signature: platform.signature,
    },
  };
}
