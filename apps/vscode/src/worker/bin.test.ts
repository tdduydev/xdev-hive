import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateRawSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exec } from "@/lib/exec.ts";
import { extract } from "@/worker/archive.ts";
import { findBinary, installBinaries, supportedVersion } from "@/worker/bin.ts";
import { releaseKey } from "@/worker/release-key.ts";

vi.mock("@/lib/exec.ts", () => ({ exec: vi.fn() }));

const directories: string[] = [];
async function directory() {
  const dir = await mkdtemp(join(process.cwd(), ".worker-test-"));
  directories.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

function tar(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, value] of Object.entries(files)) {
    const header = Buffer.alloc(512);
    header.write(name);
    header.write(value.length.toString(8).padStart(11, "0"), 124);
    header[156] = 48;
    blocks.push(header, Buffer.from(value), Buffer.alloc((512 - (value.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

function zip(name: string, value: string): Buffer {
  const data = deflateRawSync(Buffer.from(value));
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(local.length + name.length + data.length, 16);
  return Buffer.concat([local, Buffer.from(name), data, central, Buffer.from(name), end]);
}

function source(archive: Buffer, badSignature = false, badChecksum = false) {
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const sums = Buffer.from(
    `${badChecksum ? "0".repeat(64) : createHash("sha256").update(archive).digest("hex")}  hive-worker_linux_amd64.tar.gz\n`,
  );
  const signature = sign("sha256", sums, keys.privateKey);
  const fetcher = vi.fn(async (url: string | URL | Request) => {
    const path = String(url);
    if (path.endsWith("latest")) return new Response(JSON.stringify({ tag_name: "v0.2.16" }));
    if (path.endsWith(".sig")) return new Response(badSignature ? Buffer.alloc(64) : signature);
    if (path.endsWith(".txt")) return new Response(sums);
    return new Response(archive);
  });
  return {
    fetcher: fetcher as unknown as typeof fetch,
    platform: "linux",
    arch: "x64",
    publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

describe("worker binaries", () => {
  it("giữ khoá trong bundle và PEM giống khoá của worker Go", async () => {
    const original = await readFile(
      new URL("../../../../worker/internal/update/release-signing.pem", import.meta.url),
      "utf8",
    );
    expect(await readFile(new URL("./release-signing.pem", import.meta.url), "utf8")).toBe(original);
    expect(releaseKey).toBe(original);
  });
  it("kiểm bản tối thiểu và từ chối phiên bản không hợp lệ", () => {
    expect(supportedVersion("0.2.16")).toBe(true);
    expect(supportedVersion("0.2.15")).toBe(false);
    expect(supportedVersion("0.2.16-rc.1")).toBe(false);
    expect(supportedVersion("../../x")).toBe(false);
  });
  it("chỉ trích binary cố định từ TAR và ZIP", () => {
    expect([...extract(tar({ "../../evil": "x", "hive-worker": "worker", hive: "cli" }), false).keys()]).toEqual([
      "hive-worker",
      "hive",
    ]);
    expect(extract(zip("hive-worker.exe", "windows"), true).get("hive-worker.exe")?.toString()).toBe("windows");
    expect(() => extract(zip("../hive-worker.exe", "x"), true)).toThrow("thiếu");
  });
  it("cài cả hai binary sau khi xác minh ECDSA và SHA256, dọn file tạm", async () => {
    const dir = await directory();
    await installBinaries({ directory: dir, ...source(tar({ "hive-worker": "worker", hive: "cli" })) });
    expect(await readFile(join(dir, "hive"), "utf8")).toBe("cli");
    expect(await readFile(join(dir, "hive-worker"), "utf8")).toBe("worker");
    expect((await readdir(dir)).sort()).toEqual(["hive", "hive-worker"]);
  });
  it.each(["signature", "checksum"])("%s sai không để lại file tải hay thay bản cũ", async (kind) => {
    const dir = await directory();
    await writeFile(join(dir, "hive-worker"), "old");
    await expect(
      installBinaries({
        directory: dir,
        ...source(tar({ "hive-worker": "new" }), kind === "signature", kind === "checksum"),
      }),
    ).rejects.toThrow();
    expect(await readdir(dir)).toEqual(["hive-worker"]);
    expect(await readFile(join(dir, "hive-worker"), "utf8")).toBe("old");
  });
  it("không lấy binary ngoài các vị trí đã cấu hình", async () => {
    const dir = await directory();
    expect(await findBinary("hive-worker", dir, dir, "")).toBeUndefined();
  });
  it("tìm theo binPath, thư mục dùng chung rồi PATH; bỏ qua bản quá cũ", async () => {
    const dir = await directory();
    const configured = join(dir, "configured"),
      shared = join(dir, ".xdev-hive", "bin"),
      path = join(dir, "path");
    const { mkdir } = await import("node:fs/promises");
    const file = process.platform === "win32" ? "hive-worker.exe" : "hive-worker";
    for (const location of [configured, shared, path]) {
      await mkdir(location, { recursive: true });
      await writeFile(join(location, file), "fake");
    }
    vi.mocked(exec).mockResolvedValue({ code: 0, stdout: "0.2.16\n", stderr: "" });
    expect((await findBinary("hive-worker", configured, dir, path))?.path).toBe(join(configured, file));
    vi.mocked(exec).mockResolvedValueOnce({ code: 0, stdout: "0.2.15", stderr: "" });
    expect((await findBinary("hive-worker", configured, dir, path))?.path).toBe(join(shared, file));
    vi.mocked(exec)
      .mockResolvedValueOnce({ code: 0, stdout: "0.2.15", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: '{"version":"0.2.16"}', stderr: "" });
    expect((await findBinary("hive-worker", "", dir, path))?.path).toBe(join(path, file));
  });
});
