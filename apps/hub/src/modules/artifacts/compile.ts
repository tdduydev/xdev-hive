import { Worker } from "node:worker_threads";
import type { LibManifest } from "@xdev-hive/artifacts-runtime";
import { readLibManifest } from "@xdev-hive/artifacts-runtime/node";
import type { CompileReply } from "./compile-worker.ts";

/*
 * Biên dịch artifact `react` (specs/012 T014, plan.md D8): `sucrase` bỏ JSX/TS thành ESM, `es-module-lexer` liệt kê
 * import. Biên dịch một lần khi lưu nên khung, app offline và trang công khai không cần trình biên dịch.
 */

/**
 * Tên import mà trang `react` của khung khai báo trong import map (`REACT_MODULES` trong `frame-document.ts` của
 * `@xdev-hive/artifacts-runtime`). Thư viện khác trong manifest (mermaid, markdown-it) không có trong import map của
 * trang này nên cho import là trang hỏng lúc chạy. `compile.test.ts` kiểm hai danh sách khớp nhau.
 */
export const REACT_IMPORTS = [
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  "recharts",
  "lucide-react",
] as const;

export const COMPILE_TIMEOUT_MS = 2000;
/** Chữ lỗi lưu cùng phiên bản và hiện trong khung; thông báo của `sucrase` ngắn, cắt để nguồn lạ không phình dòng. */
const ERROR_CHARS = 2000;
/** Ghi trong `importNotAllowed` thay cho tên module của `import()` động. */
export const DYNAMIC_IMPORT = "import()";

export type CompileResult =
  | { compiled: string; compileError: null }
  | { compiled: null; compileError: string }
  | { importNotAllowed: string[] };

export function allowedReactImports(manifest: LibManifest): Set<string> {
  return new Set(REACT_IMPORTS.filter((name) => manifest[name]?.kind === "module"));
}

const failed = (message: string): CompileResult => ({ compiled: null, compileError: message.slice(0, ERROR_CHARS) });

/**
 * Lỗi cú pháp, thiếu `export default` và quá giờ trả `compileError` để lưu cùng phiên bản (agent đọc được và sửa).
 * Import lạ hay `import()` động trả `importNotAllowed`: không lưu, vì khung không nạp được và không được nạp mã ngoài.
 */
export async function compileReact(
  source: string,
  manifest: LibManifest,
  opts: { timeoutMs?: number } = {},
): Promise<CompileResult> {
  const reply = await runner.run(source, opts.timeoutMs ?? COMPILE_TIMEOUT_MS);
  if (!reply.ok) return failed(reply.message);
  const allowed = allowedReactImports(manifest);
  const rejected = [...new Set(reply.imports.map((name) => name ?? DYNAMIC_IMPORT))].filter(
    (name) => name === DYNAMIC_IMPORT || !allowed.has(name),
  );
  if (rejected.length > 0) return { importNotAllowed: rejected };
  if (!reply.hasDefault) return failed("Thiếu `export default`: artifact react cần export default là component gốc.");
  return { compiled: reply.code, compileError: null };
}

let manifest: LibManifest | null = null;

/** Manifest của bản thư viện hub đang phục vụ; thiếu (chưa dựng `artifacts-runtime`) thì ném lỗi và lần sau đọc lại. */
export function reactLibManifest(): LibManifest {
  manifest ??= readLibManifest();
  return manifest;
}

// ---- Luồng biên dịch -----------------------------------------------------------------------------------------------

type Job = { source: string; timeoutMs: number; resolve: (r: CompileReply) => void; reject: (e: Error) => void };

/**
 * Một luồng phụ dùng lại giữa các lần biên dịch (khởi động luồng và nạp `sucrase` tốn hơn biên dịch 1 MiB), việc xếp
 * hàng lần lượt. Quá giờ thì huỷ luồng vì không ngắt được `sucrase` đang chạy, luồng mới tạo khi có việc tiếp.
 */
class CompileRunner {
  #worker: Worker | null = null;
  #queue: Job[] = [];
  #busy: { job: Job; id: number; timer: NodeJS.Timeout } | null = null;
  #seq = 0;

  run(source: string, timeoutMs: number): Promise<CompileReply> {
    return new Promise((resolve, reject) => {
      this.#queue.push({ source, timeoutMs, resolve, reject });
      this.#next();
    });
  }

  #spawn(): Worker {
    const worker = new Worker(new URL("./compile-worker.ts", import.meta.url), {
      workerData: "hive-artifact-compile",
      // Nguồn tới 16 MiB ký tự (trần của contract) không được kéo bộ nhớ của cả hub theo.
      resourceLimits: { maxOldGenerationSizeMb: 1024 },
    });
    worker.on("message", (reply: CompileReply) => this.#settle(reply.id, reply));
    worker.on("error", (error) => this.#crashed(worker, error));
    worker.on("exit", (code) => this.#crashed(worker, new Error(`Luồng biên dịch artifact dừng (mã ${code}).`)));
    return worker;
  }

  #next(): void {
    if (this.#busy) return;
    const job = this.#queue.shift();
    if (!job) {
      // Luồng rảnh không giữ tiến trình sống (test, tắt hub).
      this.#worker?.unref();
      return;
    }
    this.#worker ??= this.#spawn();
    const worker = this.#worker;
    worker.ref();
    const id = ++this.#seq;
    const timer = setTimeout(() => {
      this.#drop(worker);
      this.#settle(id, { id, ok: false, message: `Biên dịch quá lâu (quá ${job.timeoutMs / 1000} giây).` });
    }, job.timeoutMs);
    this.#busy = { job, id, timer };
    worker.postMessage({ id, source: job.source });
  }

  #settle(id: number, outcome: CompileReply | Error): void {
    const busy = this.#busy;
    if (busy?.id !== id) return;
    clearTimeout(busy.timer);
    this.#busy = null;
    if (outcome instanceof Error) busy.job.reject(outcome);
    else busy.job.resolve(outcome);
    this.#next();
  }

  #crashed(worker: Worker, error: Error): void {
    if (this.#worker !== worker) return;
    this.#drop(worker);
    if (this.#busy) this.#settle(this.#busy.id, error);
  }

  #drop(worker: Worker): void {
    if (this.#worker === worker) this.#worker = null;
    worker.removeAllListeners();
    // Sự kiện `error` không có người nghe sẽ ném ở luồng chính.
    worker.on("error", () => {});
    void worker.terminate();
  }
}

const runner = new CompileRunner();
