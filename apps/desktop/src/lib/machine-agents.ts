import type { CliProfile } from "@/lib/agent.ts";
import { folderKey } from "@/lib/folder.ts";
import { getLang, type Lang } from "@/lib/i18n.ts";
import type { LocalProject } from "@/lib/local-projects.ts";
import { invoke } from "@/lib/tauri.ts";

/**
 * Màn Agent trên máy (spec 021, src-tauri/src/agents.rs): mọi tiến trình Claude Code, Codex, Antigravity đang chạy trên
 * máy. Rust chỉ trả thư mục, thư mục gói và việc đang làm; ghép với dự án và gói agent làm ở đây vì giao diện đã có hai
 * danh sách đó.
 */
export type AgentCli = "claude" | "codex" | "antigravity";

export type AgentSource =
  | { kind: "run"; runId: string }
  | { kind: "hive"; sessionId: string | null; hubId: string | null }
  | { kind: "app"; pty: string | null }
  | { kind: "claudeDesktop" }
  | { kind: "otherApp"; name: string }
  | { kind: "terminal" };

export interface AgentActivity {
  title: string | null;
  status: string | null;
  prompt: string | null;
  step: string | null;
  at: string | null;
  /** Không có file nối pid với phiên: phiên mới nhất của thư mục. */
  guessed: boolean;
}

export interface MachineAgent {
  pid: number;
  cli: AgentCli;
  background: boolean;
  bypass: boolean;
  /** Giây kể từ epoch. */
  startedAt: number;
  /** Phần trăm của cả máy. */
  cpu: number;
  memory: number;
  cwd: string | null;
  configDir: string | null;
  hiveProject: string | null;
  source: AgentSource;
  own: boolean;
  children: number;
  activity: AgentActivity | null;
}

export interface AgentScan {
  agents: MachineAgent[];
  home: string | null;
}

export type AgentCounts = Record<AgentCli, number>;

export const machineAgents = () => invoke<AgentScan>("machine_agents");
export const machineAgentCounts = () => invoke<AgentCounts>("machine_agent_counts");
export const stopMachineAgent = (pid: number, startedAt: number) =>
  invoke<void>("machine_agent_stop", { pid, startedAt });

/** Một mục của khung Hoạt động (src-tauri/src/agents/feed.rs), đọc từ file phiên của chính CLI trên máy. */
export interface FeedEntry {
  at: string | null;
  kind: "user" | "assistant" | "tool" | "result" | "error";
  tool: string | null;
  text: string;
  /** Rust đã chặn trên chữ: che bí mật rồi bỏ mẩu cuối dở và thêm "…". */
  cut: boolean;
}

export interface AgentFeed {
  /** File phiên đang đọc; gửi lại ở lần sau để Rust biết còn cùng file (Rust không mở theo đường dẫn này). */
  path: string | null;
  entries: FeedEntry[];
  /** Byte đầu của mục cũ nhất đã nhận; 0 là đã tới đầu file. */
  start: number;
  /** Byte sau dòng cuối đã đọc. */
  end: number;
  /** Đọc lại từ đầu file khác (phiên mới, file bị ghi đè): thay danh sách. */
  reset: boolean;
  guessed: boolean;
  readable: boolean;
}

export const machineAgentFeed = (pid: number, startedAt: number, cursor: { path: string; end: number } | null) =>
  invoke<AgentFeed>("machine_agent_feed", { pid, startedAt, cursor });
export const machineAgentFeedOlder = (pid: number, startedAt: number, path: string, before: number) =>
  invoke<AgentFeed>("machine_agent_feed_older", { pid, startedAt, path, before });

export const CLI_LABEL: Record<AgentCli, string> = {
  claude: "Claude Code",
  codex: "Codex",
  antigravity: "Antigravity",
};

/** Đường dẫn để so (folderKey), sau khi mở `~` của thư mục gói (`~/.xdev-hive/accounts/claude-2`). */
export function normPath(path: string, home: string | null): string {
  const p = path.trim();
  return folderKey(home && (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) ? home + p.slice(1) : p);
}

const inside = (child: string, parent: string) => child === parent || child.startsWith(`${parent}/`);

/** Dự án trên máy chứa thư mục làm việc của agent; nhiều dự án lồng nhau thì lấy thư mục sâu nhất. */
export function projectOf(agent: MachineAgent, projects: LocalProject[], home: string | null): LocalProject | null {
  if (!agent.cwd) return null;
  const cwd = normPath(agent.cwd, home);
  let best: LocalProject | null = null;
  let bestLen = -1;
  for (const p of projects) {
    if (!p.exists) continue;
    const folder = normPath(p.folder, home);
    if (inside(cwd, folder) && folder.length > bestLen) {
      best = p;
      bestLen = folder.length;
    }
  }
  return best;
}

/** Gói agent của tiến trình theo thư mục đăng nhập; "default" là đăng nhập mặc định, null là thư mục không thuộc gói nào. */
export function planOf(agent: MachineAgent, plans: CliProfile[], home: string | null): CliProfile | "default" | null {
  if (!agent.configDir) return "default";
  const dir = normPath(agent.configDir, home);
  return plans.find((p) => p.cli === agent.cli && p.configDir && normPath(p.configDir, home) === dir) ?? null;
}

const LOCALE: Record<Lang, string> = { vi: "vi-VN", en: "en-GB" };

export function formatBytes(n: number, lang: Lang = getLang()): string {
  const gb = n / 1024 ** 3;
  if (gb >= 1) {
    return `${gb.toLocaleString(LOCALE[lang], { minimumFractionDigits: 1, maximumFractionDigits: 1 })} GB`;
  }
  const mb = n / 1024 ** 2;
  if (mb >= 1) return `${Math.round(mb)} MB`;
  return `${Math.round(n / 1024)} KB`;
}
