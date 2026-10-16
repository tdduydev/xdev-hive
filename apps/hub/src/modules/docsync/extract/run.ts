import { Worker } from "node:worker_threads";
import { EXTRACT_LIMITS, type ExtractKind, type ExtractLimits } from "./types.ts";
import { EXTRACT_WORKER_TAG, type ExtractReply, type ExtractRequest } from "./worker.ts";

export interface RunExtractOptions {
  timeoutMs?: number;
  memoryMb?: number;
  limits?: ExtractLimits;
  probe?: ExtractRequest["probe"];
}

export const EXTRACT_TIMEOUT_MS = 60_000;
export const EXTRACT_MEMORY_MB = 512;

/**
 * Mỗi file một luồng mới: luồng chết vì OOM hay bị cắt giờ không để lại trạng thái cho file sau. Không bao giờ reject;
 * mọi lỗi của file thành `ok: false` để job ghi vào bản trích.
 */
export function runExtract(kind: ExtractKind, bytes: Uint8Array, opts: RunExtractOptions = {}): Promise<ExtractReply> {
  const timeoutMs = opts.timeoutMs ?? EXTRACT_TIMEOUT_MS;
  const memoryMb = opts.memoryMb ?? EXTRACT_MEMORY_MB;
  const data: ExtractRequest = {
    tag: EXTRACT_WORKER_TAG,
    kind,
    bytes,
    limits: opts.limits ?? EXTRACT_LIMITS,
    ...(opts.probe ? { probe: opts.probe } : {}),
  };
  return new Promise((resolve) => {
    let settled = false;
    const worker = new Worker(new URL("./worker.ts", import.meta.url), {
      workerData: data,
      resourceLimits: { maxOldGenerationSizeMb: memoryMb, maxYoungGenerationSizeMb: Math.min(64, memoryMb / 4) },
      stdout: true,
      stderr: true,
    });
    const settle = (reply: ExtractReply) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(reply);
      void worker.terminate();
    };
    const timer = setTimeout(
      () =>
        settle({ ok: false, message: `Trích nội dung quá lâu (quá ${Math.round(timeoutMs / 1000)} giây), đã dừng.` }),
      timeoutMs,
    );
    worker.on("message", (reply: ExtractReply) => settle(reply));
    worker.on("error", (error: Error & { code?: string }) =>
      settle({
        ok: false,
        message:
          error.code === "ERR_WORKER_OUT_OF_MEMORY"
            ? `Trích nội dung vượt giới hạn bộ nhớ ${memoryMb} MB, đã dừng.`
            : "Luồng trích nội dung gặp lỗi.",
      }),
    );
    worker.on("exit", () => settle({ ok: false, message: "Luồng trích nội dung dừng bất thường." }));
  });
}
