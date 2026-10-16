import { parentPort, workerData } from "node:worker_threads";
import { extractInThread } from "./extract.ts";
import { ExtractError, type ExtractKind, type ExtractLimits } from "./types.ts";

/*
 * Luồng phụ trích nội dung (plan.md mục 9). File độc (zip bomb, PDF lặp) chỉ làm chết luồng này; run.ts cắt theo giờ
 * và theo heap, tiến trình hub vẫn chạy.
 */

export const EXTRACT_WORKER_TAG = "hive-docsync-extract";

export interface ExtractRequest {
  tag: typeof EXTRACT_WORKER_TAG;
  kind: ExtractKind;
  bytes: Uint8Array;
  limits: ExtractLimits;
  /** Chỉ test dùng: giữ luồng bận hoặc ăn bộ nhớ để kiểm hủy theo giờ và theo heap. */
  probe?: "hang" | "oom";
}

export type ExtractReply = { ok: true; markdown: string; warnings: string[] } | { ok: false; message: string };

async function run(req: ExtractRequest): Promise<ExtractReply> {
  if (req.probe === "hang") await new Promise(() => setInterval(() => {}, 1_000));
  if (req.probe === "oom") {
    const hog: string[][] = [];
    for (;;) hog.push(Array.from({ length: 100_000 }, (_, i) => `${i}-${hog.length}`));
  }
  try {
    return { ok: true, ...(await extractInThread(req.kind, req.bytes, req.limits)) };
  } catch (error) {
    return { ok: false, message: error instanceof ExtractError ? error.message : "Không trích được nội dung file." };
  }
}

// Test chạy trong luồng của vitest cũng có `parentPort`; chỉ chạy khi đúng là luồng do run.ts tạo.
const req = workerData as ExtractRequest | null;
if (req?.tag === EXTRACT_WORKER_TAG) void run(req).then((reply) => parentPort?.postMessage(reply));
