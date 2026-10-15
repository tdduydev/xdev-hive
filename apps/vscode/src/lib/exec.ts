import { execFile } from "node:child_process";
import { redact } from "@/lib/redact.ts";

export type ExecResult = { code: number; stdout: string; stderr: string };
export type ExecOptions = { cwd?: string; input?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv };

/**
 * Chạy binary với mảng argv, không qua shell: đối số do người dùng hay workspace cung cấp không thành lệnh.
 * Không bao giờ reject vì mã thoát khác 0; người gọi tự xử lý `code` (vd `hive auth token` thoát 3 khi chưa có token).
 */
export function exec(file: string, args: readonly string[], opts: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      [...args],
      { cwd: opts.cwd, env: opts.env, timeout: opts.timeoutMs ?? 30_000, maxBuffer: 8 * 1024 * 1024, shell: false },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") {
          reject(new Error(redact(`${file}: ${error.message}`)));
          return;
        }
        resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout, stderr });
      },
    );
    // Token đưa qua stdin, không qua argv, để không lộ trong `ps`.
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}
