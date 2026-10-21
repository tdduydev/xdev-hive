import type { CliProfile } from "@/lib/agent.ts";
import { invoke } from "@/lib/tauri.ts";
import { pickPlan, rememberTermDefault, termDefault } from "@/lib/term-defaults.ts";

/**
 * Terminal của dự án mở bằng terminal của máy (Terminal của macOS, terminal mặc định của Windows), không vẽ trong app:
 * terminal tự làm bằng xterm.js và PTY hay lỗi gõ, dán, IME và màu. Rust (`open_agent_terminal`) chỉ nhận loại CLI, id
 * gói và thư mục.
 */
export type TermCli = "claude" | "codex" | "antigravity" | "shell";

export const TERM_CLI_LABEL: Record<TermCli, string> = {
  claude: "Claude Code",
  codex: "Codex",
  antigravity: "Antigravity (agy)",
  shell: "Shell",
};

export interface TermOptions {
  cli: TermCli;
  /** Gói agent của worker (thư mục đăng nhập riêng); null là đăng nhập mặc định của CLI. */
  planId: string | null;
  bypass: boolean;
  folder: string;
}

/** Mở cửa sổ terminal của máy chạy CLI trong thư mục; nhớ CLI và gói cho lần mở sau ở dự án này. */
export async function openAgentTerminal(o: TermOptions): Promise<void> {
  await invoke<void>("open_agent_terminal", {
    cli: o.cli,
    planId: o.cli === "shell" ? null : o.planId,
    bypass: o.cli === "shell" ? false : o.bypass,
    folder: o.folder,
  });
  rememberTermDefault(o.folder, { cli: o.cli, planId: o.planId });
}

/**
 * Nút Terminal của một dự án: mở bằng CLI và gói dùng lần cuối ở đó. Gói đó đã tắt hay đăng xuất, hoặc dự án chưa nhớ
 * gói nào, thì mở bằng gói dùng được có ưu tiên cao nhất trong `plans`. Không bao giờ bỏ hỏi quyền.
 */
export function openProjectTerminal(folder: string, plans: readonly CliProfile[] = []): Promise<void> {
  const d = termDefault(folder);
  const cli = d?.cli ?? "claude";
  return openAgentTerminal({ cli, planId: pickPlan(plans, cli, d ? d.planId : undefined), bypass: false, folder });
}
