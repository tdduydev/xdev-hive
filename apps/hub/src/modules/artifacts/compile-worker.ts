import { parentPort, workerData } from "node:worker_threads";
import { parse } from "es-module-lexer/js";
import { transform } from "sucrase";

/*
 * Luồng phụ biên dịch `react` (plan.md D8). `sucrase` chạy đồng bộ: để ở luồng chính thì nguồn độc làm treo cả hub và
 * không cắt được ở 2 s. Chỉ import `sucrase` và `es-module-lexer` để luồng khởi động nhanh.
 */

export type CompileRequest = { id: number; source: string };

export type CompileReply =
  | {
      id: number;
      ok: true;
      code: string;
      /** Tên module của import tĩnh và `export … from`; `null` là `import()` động. */
      imports: (string | null)[];
      hasDefault: boolean;
    }
  | { id: number; ok: false; message: string };

export function compileOnce({ id, source }: CompileRequest): CompileReply {
  let code: string;
  try {
    code = transform(source, {
      // Không bật `imports`: giữ ESM để khung nạp bằng import map.
      transforms: ["jsx", "typescript"],
      jsxRuntime: "automatic",
      production: true,
    }).code;
  } catch (error) {
    return { id, ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  try {
    const [imports, exports] = parse(code);
    return {
      id,
      ok: true,
      code,
      imports: imports.flatMap((i) => {
        if (i.type === "import-meta") return [];
        return i.type === "dynamic" ? [null] : [i.specifier];
      }),
      hasDefault: exports.some((e) => e.type !== "reexport-all" && e.name === "default"),
    };
  } catch (error) {
    return { id, ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

// Test chạy trong luồng của vitest cũng có `parentPort`; chỉ nghe khi đúng là luồng do `compile.ts` tạo (cùng chuỗi
// `workerData` ở đó; không import qua lại để luồng chính không phải nạp `sucrase`).
if (workerData === "hive-artifact-compile") {
  parentPort?.on("message", (req: CompileRequest) => parentPort?.postMessage(compileOnce(req)));
}
