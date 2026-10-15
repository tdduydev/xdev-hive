import * as vscode from "vscode";
import { config } from "@/lib/config.ts";
import { exec } from "@/lib/exec.ts";
import { t } from "@/lib/i18n.ts";
import { redact } from "@/lib/redact.ts";
import { findBinary } from "@/worker/bin.ts";
import { workerAllowed } from "@/worker/index.ts";
import "@/local/strings.ts";

/** Lỗi đã có chữ tiếng Việt để hiện thẳng cho người dùng. */
export class LocalError extends Error {}

export function localAvailable(): "ok" | "untrusted" | "unavailable" {
  if (!vscode.workspace.isTrusted) return "untrusted";
  // Cùng điều kiện với worker: bản web và remote không có máy dev đều không chạy được tiến trình.
  return workerAllowed() ? "ok" : "unavailable";
}

export type RunOptions = { cwd?: string; timeoutMs?: number };

/** Chạy `hive-worker <args> --json` rồi đọc JSON. Mã thoát khác 0 thành LocalError kèm stderr đã che bí mật. */
export async function runWorker<T>(args: readonly string[], opts: RunOptions = {}): Promise<T> {
  const state = localAvailable();
  if (state === "untrusted") throw new LocalError(t("local.untrusted"));
  if (state === "unavailable") throw new LocalError(t("local.unavailable"));
  const binary = await findBinary("hive-worker", config.binPath());
  if (!binary) throw new LocalError(t("local.noBinary"));
  const result = await exec(binary.path, [...args, "--json"], {
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    timeoutMs: opts.timeoutMs ?? 60_000,
  });
  if (result.code !== 0) {
    const message = redact(result.stderr.trim().split(/\r?\n/).slice(-3).join(" ") || `mã ${result.code}`);
    throw new LocalError(t("local.failed", { message }));
  }
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    throw new LocalError(t("local.badJson"));
  }
}
