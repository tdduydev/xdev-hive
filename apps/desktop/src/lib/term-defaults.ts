import type { CliProfile } from "@/lib/agent.ts";
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

/**
 * Gói mở được terminal của cli: đang bật và không biết là chưa đăng nhập (null là app không kiểm được, vd. Antigravity),
 * ưu tiên cao trước như worker chọn gói cho run.
 */
export function usablePlans(plans: readonly CliProfile[], cli: string): CliProfile[] {
  return plans
    .filter((p) => p.cli === cli && p.enabled && p.loggedIn !== false)
    .sort((a, b) => b.priority - a.priority);
}

/**
 * Gói mở terminal của cli; null là đăng nhập mặc định của CLI. `remembered` là gói nhớ ở dự án: undefined khi chưa nhớ,
 * null khi người dùng đã chọn đăng nhập mặc định. Gói nhớ đã tắt hay đăng xuất thì đổi sang gói dùng được có ưu tiên
 * cao nhất, để terminal không mở bằng gói không chạy được.
 */
export function pickPlan(
  plans: readonly CliProfile[],
  cli: TermCli,
  remembered: string | null | undefined,
): string | null {
  if (cli === "shell" || remembered === null) return null;
  // Chưa đọc được danh sách gói (worker cũ, lỗi): giữ gói đã nhớ như trước, không tự đổi sang đăng nhập mặc định.
  if (plans.length === 0) return remembered ?? null;
  const usable = usablePlans(plans, cli);
  if (remembered && usable.some((p) => p.id === remembered)) return remembered;
  return usable[0]?.id ?? null;
}
