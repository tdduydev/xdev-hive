import type { Lang } from "@/lib/i18n.ts";
import { invoke } from "@/lib/tauri.ts";

/**
 * Gói agent của máy: mỗi gói là một đăng nhập của Claude Code hay Codex mà worker chia run cho (`hive-worker accounts`,
 * spec 008 US13, US14). Dữ liệu do worker trả, không có token; trường mới là tuỳ chọn để app vẫn chạy với worker cũ.
 */
export type PlanState = "running" | "ready" | "disabled" | "noCli" | "signedOut" | "overLimit" | "cooling" | "near";
export type Role = "plan" | "implement" | "review";
export const ROLES: readonly Role[] = ["plan", "implement", "review"];

export interface Limit {
  percent: number;
  resetsAt: string | null;
}
export interface Usage {
  session: Limit | null;
  week: Limit | null;
  checkedAt: string | null;
  /** Vì sao không có số (worker viết tiếng Việt): "Chưa đăng nhập", "CLI không báo", … */
  reason: string | null;
}

export interface Plan {
  id: string;
  label: string;
  cli: string;
  configDir?: string;
  enabled: boolean;
  priority: number;
  maxConcurrent: number;
  cooldownMinutes: number;
  stopAtSession?: number;
  stopAtWeek?: number;
  roles?: Role[];
  timeoutMinutes?: number;
  /** Worker chọn được gói của CLI này (Claude Code, Codex). */
  supported: boolean;
  /** null khi không biết cách kiểm đăng nhập của CLI này. */
  loggedIn: boolean | null;
  email?: string;
  usage?: Usage | null;
  state?: PlanState;
  coolUntil?: string | null;
  /** Số run đang chạy trên gói. */
  active?: number;
  /** Dùng tiếp còn hiệu lực: ngưỡng dừng tạm bỏ tới lúc này. */
  resumeUntil?: string | null;
}

export interface Plans {
  path: string;
  imported?: number;
  accounts: Plan[];
}

export type LoginWay = "plan" | "sso" | "console" | "browser" | "device";
export const LOGIN_WAYS: Record<"claude" | "codex", readonly LoginWay[]> = {
  claude: ["plan", "sso", "console"],
  codex: ["browser", "device"],
};

export interface NewPlan {
  cli: "claude" | "codex";
  label: string;
  how: LoginWay;
  email?: string;
}

/** Kết quả `accounts add`: gói mới và lệnh đăng nhập để mở trong Terminal. */
export interface AddedPlan {
  account: Plan;
  loginCommand: string;
  env: Record<string, string>;
}

export interface PlanPatch {
  label: string;
  priority: number;
  maxConcurrent: number;
  cooldownMinutes: number;
  timeoutMinutes: number;
  stopAtSession: number;
  stopAtWeek: number;
  roles: Role[];
}

export const plans = () => invoke<Plans>("cli_profiles");
export const setPlanEnabled = (id: string, enabled: boolean) => invoke<Plans>("cli_profile_set", { id, enabled });
export const addPlan = (p: NewPlan) =>
  invoke<AddedPlan>("cli_profile_add", {
    cli: p.cli,
    label: p.label,
    how: p.how,
    email: p.cli === "claude" && p.email?.trim() ? p.email.trim() : null,
  });
export const updatePlan = (id: string, patch: PlanPatch) => invoke<Plans>("cli_profile_update", { id, patch });
export const removePlan = (id: string) => invoke<Plans>("cli_profile_remove", { id });
export const readUsage = (id?: string) => invoke<Plans>("cli_profile_usage", { id: id ?? null });
export const resumePlan = (id: string) => invoke<Plans>("cli_profile_resume", { id });
export const openLoginTerminal = (command: string, env: Record<string, string>) =>
  invoke<void>("open_login_terminal", { command, env });

export const CLI_NAME: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  gemini: "Gemini",
  antigravity: "Antigravity",
};

/** Mặc định của worker khi gói chưa có trường (accounts.json của bản cũ). */
export const DEFAULTS = { stopAtSession: 95, stopAtWeek: 90, timeoutMinutes: 60, roles: ROLES };

/**
 * Trạng thái worker tính; worker cũ chưa trả thì đoán từ phần đã biết. Thứ tự như app v1: tắt, chưa có CLI, chưa đăng
 * nhập, rồi mới tới đang chạy và ngưỡng.
 */
export function planState(p: Plan, now = Date.now()): PlanState {
  if (p.state) return p.state;
  if (!p.enabled) return "disabled";
  if (!p.supported) return "noCli";
  if (p.loggedIn === false) return "signedOut";
  if ((p.active ?? 0) > 0) return "running";
  if (p.coolUntil && Date.parse(p.coolUntil) > now) return "cooling";
  return "ready";
}

/** Gói người dùng phải ra tay (cài CLI, đăng nhập) lên đầu; còn lại giữ thứ tự của file. Gói tắt gom riêng. */
export function planRows(list: Plan[], now = Date.now()): { on: Plan[]; off: Plan[] } {
  const hand = (p: Plan) => {
    const s = planState(p, now);
    return s === "noCli" || s === "signedOut" ? 0 : 1;
  };
  const on = list.filter((p) => p.enabled).sort((a, b) => hand(a) - hand(b));
  return { on, off: list.filter((p) => !p.enabled) };
}

const slots = (p: Plan) => Math.max(1, p.maxConcurrent) - (p.active ?? 0);

/** Dải tóm tắt: gói nhận run được ngay, run đang chạy, chỗ trống và lần reset sớm nhất của các gói đang bật. */
export function machineSummary(list: Plan[], now = Date.now()) {
  const enabled = list.filter((p) => p.enabled);
  const ready = enabled.filter((p) => {
    const s = planState(p, now);
    return (s === "ready" || s === "near" || s === "running") && slots(p) > 0;
  });
  const resets = enabled
    .flatMap((p) =>
      [p.usage?.session?.resetsAt, p.usage?.week?.resetsAt]
        .filter((at): at is string => !!at && Date.parse(at) > now)
        .map((at) => ({ at, label: p.label || p.id })),
    )
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return {
    enabled: enabled.length,
    ready: ready.length,
    running: list.reduce((n, p) => n + (p.active ?? 0), 0),
    slots: ready.reduce((n, p) => n + Math.max(0, slots(p)), 0),
    reset: resets[0] ?? null,
  };
}

/** Lần đọc quota mới nhất của các gói đang bật. */
export function lastChecked(list: Plan[]): string | null {
  return (
    list
      .filter((p) => p.enabled)
      .map((p) => p.usage?.checkedAt ?? "")
      .filter(Boolean)
      .sort()
      .at(-1) ?? null
  );
}

/** Màu thanh so với ngưỡng dừng của gói: tới vạch thì worker thôi giao run cho gói. */
export const meterTone = (percent: number, stop: number): "ok" | "near" | "over" =>
  percent >= stop ? "over" : percent >= stop - 10 ? "near" : "ok";

const LOCALE: Record<Lang, string> = { vi: "vi-VN", en: "en-GB" };

/** "14:05" trong ngày, "T5 09:00" trong tuần (reset tuần không xa hơn), xa hơn thì kèm ngày. */
export function clock(iso: string, now: number, lang: Lang): string {
  const at = new Date(iso);
  const sameDay = at.toDateString() === new Date(now).toDateString();
  const inWeek = Math.abs(at.getTime() - now) < 6 * 86_400_000;
  const opts: Intl.DateTimeFormatOptions = sameDay
    ? { hour: "2-digit", minute: "2-digit" }
    : inWeek
      ? { weekday: "short", hour: "2-digit", minute: "2-digit" }
      : { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" };
  return at.toLocaleString(LOCALE[lang], opts);
}

/**
 * Lệnh đăng nhập lại cho gói đã có, theo cách mặc định của CLI (trang đăng nhập của claude.ai nhận cả Google, email và
 * SSO). Cùng dạng worker trả khi thêm gói; Rust chỉ mở Terminal cho đúng các lệnh này.
 */
export function reloginOf(p: Plan): { command: string; env: Record<string, string> } | null {
  const command = p.cli === "claude" ? "claude auth login" : p.cli === "codex" ? "codex login" : null;
  if (!command) return null;
  const key = p.cli === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
  return { command, env: p.configDir ? { [key]: p.configDir } : {} };
}

/** Khoảng giá trị của form Sửa, như worker kiểm (`accounts update`). */
export const RANGES = {
  priority: [0, 100],
  maxConcurrent: [1, 8],
  cooldownMinutes: [1, 1440],
  timeoutMinutes: [1, 720],
  stopAtSession: [1, 100],
  stopAtWeek: [1, 100],
} as const satisfies Record<string, readonly [number, number]>;

export type RangeField = keyof typeof RANGES;
