import { readFile } from "node:fs/promises";

type PlatformRelease = { signature: string; url: string };
type Manifest = {
  version: string;
  notes?: string | null;
  pub_date?: string | null;
  platforms: Record<string, PlatformRelease>;
};
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function validVersion(v: string) {
  return semver.test(v);
}
export function newerVersion(a: string, b: string): boolean {
  const x = semver.exec(a),
    y = semver.exec(b);
  if (!x || !y) return false;
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d) return d > 0;
  }
  const xp = x[4],
    yp = y[4];
  if (xp === undefined || yp === undefined) return xp === undefined && yp !== undefined;
  const xs = xp.split("."),
    ys = yp.split(".");
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    if (xs[i] === undefined) return false;
    if (ys[i] === undefined) return true;
    const xv = xs[i];
    const yv = ys[i];
    if (xv === yv) continue;
    if (xv === undefined || yv === undefined) continue;
    const xn = /^\d+$/.test(xv),
      yn = /^\d+$/.test(yv);
    if (xn && yn) return BigInt(xv) > BigInt(yv);
    if (xn !== yn) return !xn;
    return xv > yv;
  }
  return false;
}

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
