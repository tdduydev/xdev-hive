import { createHash, verify } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { exec } from "@/lib/exec.ts";
import { extract } from "@/worker/archive.ts";
import { releaseKey } from "@/worker/release-key.ts";

export const MIN_WORKER_VERSION = "0.2.16";
export const LATEST_API = "https://api.github.com/repos/tdduydev/xdev-hive/releases/latest";
const RELEASES = "https://github.com/tdduydev/xdev-hive/releases";
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\w.-]+))?(?:\+[\w.-]+)?$/;

export function supportedVersion(value: string, minimum = MIN_WORKER_VERSION): boolean {
  const a = SEMVER.exec(value),
    b = SEMVER.exec(minimum);
  if (!a || !b) return false;
  for (let i = 1; i <= 3; i++) {
    if (Number(a[i]) !== Number(b[i])) return Number(a[i]) > Number(b[i]);
  }
  return !a[4];
}

export type Binary = { path: string; version: string };

export async function findBinary(
  name: "hive" | "hive-worker",
  configured = "",
  home = homedir(),
  path = process.env.PATH ?? "",
): Promise<Binary | undefined> {
  const file = name + (process.platform === "win32" ? ".exe" : "");
  // PATH tương đối có thể trỏ vào workspace, nên không dùng để chọn chương trình thực thi.
  const dirs = [configured, join(home, ".xdev-hive", "bin"), ...path.split(delimiter)].filter(
    (dir) => dir && isAbsolute(dir),
  );
  for (const dir of new Set(dirs)) {
    const candidate = join(dir, file);
    try {
      await access(candidate);
      const result = await exec(candidate, ["version", "--json"], { timeoutMs: 5000 });
      // Các bản hiện tại vẫn in chuỗi thuần dù có --json; hive còn có dòng trạng thái IPC phía sau.
      let version =
        result.stdout
          .split(/\r?\n/)[0]
          ?.replace(/^hive\s+/, "")
          .trim() ?? "";
      try {
        version = JSON.parse(version).version;
      } catch {
        /* Bản CLI cũ in semver thuần. */
      }
      if ((name === "hive" || result.code === 0) && supportedVersion(version)) return { path: candidate, version };
    } catch {
      /* Thử vị trí tiếp theo nếu file không chạy được. */
    }
  }
  return undefined;
}

async function get(url: string, limit: number, fetcher: typeof fetch): Promise<Buffer> {
  const response = await fetcher(url, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok || !response.body) throw new Error(`Tải bản phát hành thất bại: HTTP ${response.status}`);
  const chunks: Buffer[] = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error("File phát hành quá lớn");
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks);
}

export type InstallOptions = {
  directory?: string;
  platform?: string;
  arch?: string;
  fetcher?: typeof fetch;
  publicKey?: string;
  releases?: string;
  latestAPI?: string;
};

export async function installBinaries(options: InstallOptions = {}): Promise<string> {
  const {
    directory = join(homedir(), ".xdev-hive", "bin"),
    platform = process.platform,
    arch = process.arch,
    fetcher = fetch,
    publicKey = releaseKey,
    releases = RELEASES,
    latestAPI = LATEST_API,
  } = options;
  const os = platform === "win32" ? "windows" : platform;
  const goarch = arch === "x64" ? "amd64" : arch;
  if (!["darwin", "linux", "windows"].includes(os) || !["amd64", "arm64"].includes(goarch)) {
    throw new Error("Nền tảng chưa hỗ trợ tải worker");
  }
  const release = JSON.parse((await get(latestAPI, 1 << 20, fetcher)).toString());
  const version = String(release.tag_name ?? "").replace(/^v/, "");
  if (!supportedVersion(version)) throw new Error("Bản phát hành chưa đạt phiên bản worker tối thiểu");
  const base = `${releases}/download/v${version}/`;
  const sums = await get(`${base}checksums.txt`, 1 << 20, fetcher);
  const signature = await get(`${base}checksums.txt.sig`, 1 << 20, fetcher);
  if (!verify("sha256", sums, publicKey, signature)) throw new Error("Chữ ký của checksums.txt không hợp lệ");
  const asset = `hive-worker_${os}_${goarch}.${os === "windows" ? "zip" : "tar.gz"}`;
  const checksum = sums
    .toString()
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find((fields) => fields[1]?.replace(/^\*/, "") === asset)?.[0];
  if (!checksum || !/^[a-f\d]{64}$/i.test(checksum)) throw new Error("Bản phát hành thiếu checksum cho máy này");
  const archive = await get(base + asset, 200 << 20, fetcher);
  if (createHash("sha256").update(archive).digest("hex") !== checksum.toLowerCase())
    throw new Error("SHA256 của gói phát hành không khớp");
  const binaries = extract(archive, os === "windows");
  await mkdir(directory, { recursive: true });
  const temporary = await mkdtemp(join(directory, ".download-"));
  try {
    for (const [name, data] of binaries) {
      const path = join(temporary, name);
      await writeFile(path, data, { mode: 0o755, flag: "wx" });
      // writeFile áp dụng umask; chmod giữ quyền chạy ngay cả trên máy đặt umask 077.
      if (process.platform !== "win32") await chmod(path, 0o755);
    }
    // Tất cả dữ liệu đã được xác minh trước khi thay binary đang dùng chung với desktop.
    for (const name of binaries.keys()) await rename(join(temporary, name), join(directory, name));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return version;
}
