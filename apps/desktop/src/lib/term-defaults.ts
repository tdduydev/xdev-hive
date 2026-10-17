import { folderKey } from "@/lib/folder.ts";
import type { TermCli } from "@/lib/pty.ts";

/**
 * CLI và gói agent mở lần cuối ở từng dự án, để nút Terminal của dự án mở lại đúng gói. Không nhớ "bỏ hỏi quyền": mỗi
 * terminal bỏ hỏi quyền phải xác nhận lại.
 */
export interface TermDefault {
  cli: TermCli;
  planId: string | null;
}

const KEY = "hive.terminal.defaults";
const CLIS: readonly TermCli[] = ["claude", "codex", "antigravity", "shell"];

function readAll(): Record<string, TermDefault> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return raw && typeof raw === "object" ? (raw as Record<string, TermDefault>) : {};
  } catch {
    return {};
  }
}

export function termDefault(folder: string): TermDefault | null {
  const d = readAll()[folderKey(folder)];
  if (!d || !CLIS.includes(d.cli)) return null;
  return { cli: d.cli, planId: typeof d.planId === "string" && d.planId ? d.planId : null };
}

export function rememberTermDefault(folder: string, d: TermDefault): void {
  const all = readAll();
  all[folderKey(folder)] = { cli: d.cli, planId: d.cli === "shell" ? null : d.planId };
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* Không lưu được thì lần sau mở bằng mặc định. */
  }
}
