import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectPandoc, PANDOC_VERSION, type PandocCommand, runPandoc } from "./pandoc.ts";

// Pandoc giả là script Node, chạy bằng chính node đang chạy test: không qua shell nên Windows không chạy được .cmd/.sh.
const fake = (name: string): PandocCommand => [
  process.execPath,
  fileURLToPath(new URL(`./test-bin/pandoc-${name}.mjs`, import.meta.url)),
];
const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const filter = fileURLToPath(new URL("./test-bin/warn.lua", import.meta.url));

// Trên Windows, libuv tự thêm các biến hệ thống mà tiến trình con cần (HOMEDRIVE, TEMP, WINDIR…).
const WINDOWS_ENV_KEYS =
  "HOMEDRIVE HOMEPATH LOGONSERVER SYSTEMDRIVE SYSTEMROOT TEMP USERDOMAIN USERNAME USERPROFILE WINDIR";
const ENV_KEYS = new Set([
  "PATH",
  "HOME",
  "LANG",
  ...(process.platform === "win32" ? WINDOWS_ENV_KEYS.split(" ") : []),
]);

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hive-pandoc-test-"));
  await writeFile(join(dir, "in.docx"), "không phải docx");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

const run = (path: PandocCommand, extra: Partial<Parameters<typeof runPandoc>[0]> = {}) =>
  runPandoc({ path, input: "in.docx", from: "docx", cwd: dir, filter, keepFront: false, ...extra });

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Mỗi test chạy tiến trình con; máy dev bận (nhiều agent cùng build) có lúc khởi động node mất vài giây.
const SPAWN_TESTS = { timeout: 30_000 };

describe("detectPandoc", SPAWN_TESTS, () => {
  it("nhận bản ghim", async () => {
    expect(await detectPandoc(fake("echo"))).toEqual({ ok: true, version: PANDOC_VERSION, reason: null });
  });

  it("từ chối bản cũ hơn bản ghim", async () => {
    const check = await detectPandoc(fake("old"));
    expect(check.ok).toBe(false);
    expect(check.version).toBe("2.17.1.1");
    expect(check.reason).toContain(PANDOC_VERSION);
  });

  it("báo không tìm thấy khi đường dẫn sai", async () => {
    const check = await detectPandoc(join(dir, "khong-co-pandoc"));
    expect(check).toMatchObject({ ok: false, version: null });
    expect(check.reason).toMatch(/Không chạy được pandoc/);
  });

  it("pandoc treo khi hỏi phiên bản thì bị giết, không chờ", async () => {
    const started = Date.now();
    const check = await detectPandoc(fake("hang"), { timeoutMs: 300 });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(check).toMatchObject({ ok: false, version: null });
  });
});

describe("runPandoc với pandoc giả", SPAWN_TESTS, () => {
  it("không qua shell, env tối thiểu, đủ cờ sandbox và giới hạn bộ nhớ", async () => {
    process.env.HIVE_TEST_SECRET = "không được lộ";
    try {
      const result = await run(fake("echo"), { keepFront: true, memoryMb: 256 });
      if (!result.ok) throw new Error(result.message);
      const { argv, env } = JSON.parse(result.markdown) as { argv: string[]; env: Record<string, string> };
      expect(argv[0]).toBe("in.docx");
      expect(argv).toEqual(
        expect.arrayContaining(["-f", "docx", "-t", "gfm", "--sandbox", "--extract-media=m", "--log=log.json"]),
      );
      expect(argv).toContain(`--lua-filter=${filter}`);
      expect(argv.join(" ")).toContain("--metadata keep-front=true");
      expect(argv.slice(-3)).toEqual(["+RTS", "-M256m", "-RTS"]);
      expect(env.HIVE_TEST_SECRET).toBeUndefined();
      expect(Object.keys(env).filter((k) => !ENV_KEYS.has(k.toUpperCase()))).toEqual([]);
      expect(env.HOME).toBe(dir);
      expect(result.mediaDir).toBe(join(dir, "m"));
      expect(await readdir(join(result.mediaDir, "media"))).toEqual(["rId9.png"]);
      expect(result.log).toEqual([{ type: "ScriptingWarning", verbosity: "WARNING", message: "no_h1" }]);
    } finally {
      delete process.env.HIVE_TEST_SECRET;
    }
  });

  it("không bật keep-front khi không yêu cầu, đọc odt bằng -f odt", async () => {
    const result = await run(fake("echo"), { from: "odt" });
    if (!result.ok) throw new Error(result.message);
    const { argv } = JSON.parse(result.markdown) as { argv: string[] };
    expect(argv.join(" ")).not.toContain("keep-front");
    expect(argv.join(" ")).toContain("-f odt");
    expect(argv.slice(-3)).toEqual(["+RTS", "-M512m", "-RTS"]);
  });

  it("quá giờ thì SIGKILL đúng hạn, hub không chờ", async () => {
    const started = Date.now();
    // 2 giây đủ cho node của pandoc giả khởi động và ghi pid cả khi máy đang chạy song song cả bộ test.
    const result = await run(fake("hang"), { timeoutMs: 2_000 });
    const elapsed = Date.now() - started;
    expect(result).toMatchObject({ ok: false, reason: "timeout" });
    expect(elapsed).toBeGreaterThanOrEqual(1_950);
    expect(elapsed).toBeLessThan(5_000);
    const pid = Number(await readFile(join(dir, "pid"), "utf8"));
    for (let i = 0; i < 40 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50));
    expect(alive(pid)).toBe(false);
  });

  it("thoát lỗi: stderr cắt ngắn, không lộ thư mục tạm", async () => {
    const result = await run(fake("fail"));
    if (result.ok) throw new Error("phải lỗi");
    expect(result.reason).toBe("failed");
    expect(result.message).toContain("64");
    expect(result.stderr.split("\n").length).toBeLessThanOrEqual(10);
    expect(result.stderr).toContain("couldn't unpack docx container: ./in.docx");
    expect(result.stderr).not.toContain(dir);
    expect(result.stderr).not.toContain("dòng chẩn đoán 0\n");
  });

  it("hết bộ nhớ (mã 251) báo riêng", async () => {
    expect(await run(fake("oom"), { memoryMb: 64 })).toMatchObject({ ok: false, reason: "memory" });
  });

  it("không chạy được binary thì báo lỗi, không ném", async () => {
    expect(await run(join(dir, "khong-co-pandoc"))).toMatchObject({ ok: false, reason: "spawn" });
  });
});

// pandoc thật: CI cài bản ghim nên thiếu là lỗi; tại máy thì bỏ qua kèm thông báo (plan.md mục 12).
const realPath = process.env.HIVE_PANDOC_PATH || "pandoc";
const real = await detectPandoc(realPath);
const requireReal = process.env.CI === "true";
if (!real.ok && !requireReal) console.warn(`Bỏ qua test pandoc thật: ${real.reason}`);

describe.skipIf(!real.ok && !requireReal)("runPandoc với pandoc thật", SPAWN_TESTS, () => {
  it("có đúng bản ghim", () => {
    expect(real, real.reason ?? "").toMatchObject({ ok: true, version: PANDOC_VERSION });
  });

  it("chạy --sandbox với bộ lọc Lua ngoài thư mục tạm, tách ảnh, ghi log", async () => {
    // Sinh docx bằng chính pandoc (không sandbox) để không phụ thuộc file mẫu của task khác.
    await writeFile(join(dir, "a.png"), Buffer.from(PNG_1PX, "base64"));
    await writeFile(join(dir, "in.md"), "# Tiêu đề\n\nĐoạn văn.\n\n![](a.png)\n\n| a | b |\n|---|---|\n| 1 | 2 |\n");
    await promisify(execFile)(realPath, ["in.md", "-o", "in.docx"], { cwd: dir });
    await rm(join(dir, "a.png"));

    const result = await run(realPath, { keepFront: true, memoryMb: 256 });
    if (!result.ok) throw new Error(`${result.message}\n${result.stderr}`);
    expect(result.markdown).toContain("# Tiêu đề");
    expect(result.markdown).toContain("| 1   | 2   |");
    expect(await readdir(join(result.mediaDir, "media"))).toHaveLength(1);
    expect(result.log).toContainEqual(
      expect.objectContaining({ type: "ScriptingWarning", message: "keep-front=true" }),
    );
  });

  it("file hỏng thì thoát lỗi, không lộ thư mục tạm", async () => {
    const result = await run(realPath);
    expect(result).toMatchObject({ ok: false, reason: "failed" });
    if (!result.ok) expect(result.stderr).not.toContain(dir);
  });
});
