import { spawn } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { dirname, join, sep } from "node:path";

/** Bản đã chạy trên 261 SRS; Dockerfile và CI cài đúng bản này (ARG PANDOC_VERSION). */
export const PANDOC_VERSION = "3.12";
export const PANDOC_TIMEOUT_MS = 120_000;
export const PANDOC_MEMORY_MB = 512;

/**
 * Đường dẫn binary, hoặc lệnh kèm tham số đứng trước (test chạy pandoc giả bằng `node script.mjs`: không qua shell thì
 * Windows không chạy được file .cmd).
 */
export type PandocCommand = string | readonly [string, ...string[]];

export interface PandocCheck {
  ok: boolean;
  version: string | null;
  reason: string | null;
}

export interface PandocLogEntry {
  type: string;
  verbosity: string;
  message?: string;
  [key: string]: unknown;
}

export interface RunPandocInput {
  path: PandocCommand;
  /** Tên file đầu vào, tương đối với `cwd`. */
  input: string;
  from: "docx" | "odt";
  /** Thư mục tạm riêng của lần chạy; người gọi tạo và xoá. pandoc ghi out.md, log.json, m/ vào đây. */
  cwd: string;
  filter: string;
  keepFront: boolean;
  timeoutMs?: number;
  memoryMb?: number;
}

export type PandocRun =
  | { ok: true; markdown: string; mediaDir: string; log: PandocLogEntry[] }
  | { ok: false; reason: "timeout" | "memory" | "failed" | "spawn"; message: string; stderr: string };

const OUT = "out.md";
const LOG = "log.json";
const MEDIA = "m";
const STDERR_LINES = 10;
const STDERR_CHARS = 2_000;
// Runtime Haskell thoát mã này khi vượt +RTS -M.
const HEAP_EXHAUSTED = 251;

export async function detectPandoc(path: PandocCommand, opts: { timeoutMs?: number } = {}): Promise<PandocCheck> {
  const run = await spawnLimited(path, ["--version"], { timeoutMs: opts.timeoutMs ?? 10_000, stdout: true });
  if (run.kind === "spawn") return { ok: false, version: null, reason: `Không chạy được pandoc: ${run.error}` };
  if (run.kind === "timeout") return { ok: false, version: null, reason: "pandoc --version không trả lời kịp." };
  const version = /^pandoc(?:\.exe)?\s+(\d+(?:\.\d+)*)/m.exec(run.stdout)?.[1] ?? null;
  if (run.code !== 0 || !version) return { ok: false, version, reason: "Không đọc được phiên bản pandoc." };
  if (compareVersions(version, PANDOC_VERSION) < 0) {
    return { ok: false, version, reason: `pandoc ${version} quá cũ, cần ${PANDOC_VERSION} trở lên.` };
  }
  return { ok: true, version, reason: null };
}

/**
 * Chạy pandoc trên một file Word. Không bao giờ reject: lỗi thành `ok: false` để job ghi vào lượt nhập. `--sandbox` chặn
 * pandoc đọc, ghi file ngoài đầu vào và ra mạng (plan.md R1).
 */
export async function runPandoc(input: RunPandocInput): Promise<PandocRun> {
  const memoryMb = input.memoryMb ?? PANDOC_MEMORY_MB;
  const timeoutMs = input.timeoutMs ?? PANDOC_TIMEOUT_MS;
  const args = [
    input.input,
    "-f",
    input.from,
    "-t",
    "gfm",
    "--wrap=none",
    "--track-changes=accept",
    "--sandbox",
    `--extract-media=${MEDIA}`,
    `--lua-filter=${input.filter}`,
    ...(input.keepFront ? ["--metadata", "keep-front=true"] : []),
    `--log=${LOG}`,
    // Cảnh báo đã có trong log.json; stderr chỉ còn lỗi.
    "--quiet",
    "-o",
    OUT,
    "+RTS",
    `-M${memoryMb}m`,
    "-RTS",
  ];
  const run = await spawnLimited(input.path, args, { timeoutMs, cwd: input.cwd, stdout: false });
  const stderr = run.kind === "spawn" ? "" : await cleanStderr(run.stderr, input.cwd, input.filter);
  if (run.kind === "spawn") {
    return { ok: false, reason: "spawn", message: `Không chạy được pandoc: ${run.error}`, stderr };
  }
  if (run.kind === "timeout") {
    const message = `Chuyển Word quá lâu (quá ${Math.round(timeoutMs / 1000)} giây), đã dừng.`;
    return { ok: false, reason: "timeout", message, stderr };
  }
  if (run.code === HEAP_EXHAUSTED) {
    const message = `Chuyển Word vượt giới hạn bộ nhớ ${memoryMb} MB, đã dừng.`;
    return { ok: false, reason: "memory", message, stderr };
  }
  if (run.code !== 0) {
    return { ok: false, reason: "failed", message: `pandoc thoát lỗi (mã ${run.code ?? run.signal}).`, stderr };
  }
  try {
    const [markdown, log] = await Promise.all([
      readFile(join(input.cwd, OUT), "utf8"),
      readFile(join(input.cwd, LOG), "utf8").then((text) => JSON.parse(text) as PandocLogEntry[]),
    ]);
    return { ok: true, markdown, mediaDir: join(input.cwd, MEDIA), log };
  } catch {
    return { ok: false, reason: "failed", message: "pandoc không ghi đủ kết quả.", stderr };
  }
}

type Spawned =
  | { kind: "exit"; code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }
  | { kind: "timeout"; stderr: string }
  | { kind: "spawn"; error: string };

function spawnLimited(
  path: PandocCommand,
  args: string[],
  opts: { timeoutMs: number; cwd?: string; stdout: boolean },
): Promise<Spawned> {
  const [command, ...prefix] = typeof path === "string" ? [path] : path;
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const settle = (result: Spawned) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const child = spawn(command, [...prefix, ...args], {
      cwd: opts.cwd,
      env: minimalEnv(opts.cwd),
      shell: false,
      stdio: ["ignore", opts.stdout ? "pipe" : "ignore", "pipe"],
      windowsHide: true,
    });
    // Không chờ tiến trình đóng sau SIGKILL: tiến trình kẹt trong nhân cũng không giữ job của hub.
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle({ kind: "timeout", stderr });
    }, opts.timeoutMs);
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      if (stdout.length < 64_000) stdout += chunk;
    });
    // Giữ phần cuối: dòng lỗi thật của pandoc nằm sau cùng.
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-64_000);
    });
    child.on("error", (error) => settle({ kind: "spawn", error: error.message }));
    child.on("close", (code, signal) => settle({ kind: "exit", code, signal, stdout, stderr }));
  });
}

// Không đưa secret của hub (database, token…) cho tiến trình con. HOME trỏ vào thư mục tạm để pandoc không đọc
// defaults hay bộ lọc trong thư mục người dùng.
function minimalEnv(cwd: string | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { LANG: "C.UTF-8" };
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (cwd) env.HOME = cwd;
  if (process.platform === "win32" && process.env.SYSTEMROOT) env.SYSTEMROOT = process.env.SYSTEMROOT;
  return env;
}

async function cleanStderr(stderr: string, cwd: string, filter: string): Promise<string> {
  const roots = new Set([cwd, await realpath(cwd).catch(() => cwd)]);
  let text = stderr;
  for (const root of roots) {
    for (const form of [root, root.replaceAll("\\", "/")]) text = text.replaceAll(form, ".");
  }
  text = text.replaceAll(dirname(filter) + sep, "");
  const lines = text.trimEnd().split(/\r?\n/).slice(-STDERR_LINES).join("\n");
  return lines.length > STDERR_CHARS ? lines.slice(-STDERR_CHARS) : lines;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
