import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { type LibManifest, parseLibManifest } from "@xdev-hive/artifacts-runtime";
import { sha256 } from "@/artifacts/cache.ts";

export function safeLibraryPath(path: string): boolean {
  return (
    /^[a-zA-Z0-9@._/-]+$/.test(path) &&
    !path.startsWith("/") &&
    path.split("/").every((p) => p !== "." && p !== ".." && p !== "")
  );
}

export function verifyLibrary(data: Uint8Array, entry: LibManifest[string]): boolean {
  return (
    data.byteLength === entry.bytes &&
    `sha384-${createHash("sha384").update(data).digest("base64")}` === entry.integrity
  );
}

async function boundedBody(response: Response, limit: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Thư viện artifact không có nội dung.");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.length;
      if (length > limit) throw new Error("Thư viện artifact quá lớn.");
      chunks.push(part.value);
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel();
  }
}

// Manifest hiện tại dùng SRI sha384; vẫn kiểm đúng SRI rồi đặt bộ thư viện theo sha256 của manifest.
export async function loadLibraries(root: string, hub: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(new URL("/_artifact/lib/lib-manifest.json", hub), {
    redirect: "error",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error("Không tải được manifest artifact.");
  const json = Buffer.from(await boundedBody(response, 100_000)).toString("utf8");
  if (json.length > 100_000) throw new Error("Manifest artifact quá lớn.");
  const manifest = parseLibManifest(JSON.parse(json));
  const entries = Object.values(manifest);
  if (entries.length > 100 || entries.reduce((sum, e) => sum + e.bytes, 0) > 100 * 1024 * 1024)
    throw new Error("Bộ thư viện artifact quá lớn.");
  const dir = join(root, sha256(json));
  const checksums: Record<string, string> = {};
  for (const entry of entries) {
    if (!safeLibraryPath(entry.path)) throw new Error("Đường dẫn thư viện artifact không hợp lệ.");
    const path = join(dir, entry.path);
    let data: Uint8Array | undefined;
    try {
      data = await readFile(path);
    } catch {
      /* Chưa tải thư viện này. */
    }
    if (data && verifyLibrary(data, entry)) {
      checksums[entry.path] = sha256(data);
      continue;
    }
    const reply = await fetch(new URL(`/_artifact/lib/${entry.path}`, hub), {
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    });
    if (!reply.ok) throw new Error("Không tải được thư viện artifact.");
    data = await boundedBody(reply, entry.bytes);
    if (!verifyLibrary(data, entry)) throw new Error("Thư viện artifact không khớp mã kiểm tra.");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data, { mode: 0o600 });
    checksums[entry.path] = sha256(data);
    if (sha256(await readFile(path)) !== checksums[entry.path])
      throw new Error("Thư viện artifact không khớp SHA-256.");
  }
  await writeFile(join(dir, "sha256.json"), JSON.stringify(checksums), { mode: 0o600 });
  await writeFile(join(dir, "lib-manifest.json"), json, { mode: 0o600 });
  return dir;
}

export async function verifyCachedLibraries(dir: string): Promise<void> {
  const json = await readFile(join(dir, "lib-manifest.json"), "utf8");
  if (sha256(json) !== basename(dir)) throw new Error("Manifest trong bộ đệm không hợp lệ.");
  const manifest = parseLibManifest(JSON.parse(json));
  const checksums = JSON.parse(await readFile(join(dir, "sha256.json"), "utf8")) as Record<string, string>;
  for (const entry of Object.values(manifest)) {
    if (!safeLibraryPath(entry.path)) throw new Error("Đường dẫn thư viện artifact không hợp lệ.");
    const data = await readFile(join(dir, entry.path));
    if (!verifyLibrary(data, entry) || sha256(data) !== checksums[entry.path]) {
      throw new Error("Bộ đệm thư viện artifact không hợp lệ.");
    }
  }
}
