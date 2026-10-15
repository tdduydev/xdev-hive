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
/** Claude: tuần theo từng model ("Current week (Sonnet only)"). */
export interface ModelLimit {
  name: string;
  percent: number;
  resetsAt: string | null;
}
/** Antigravity: mỗi nhóm model có hạn mức phiên 5 giờ và tuần riêng; `sessionDisabled` thì nhóm không có hạn mức phiên. */
export interface GroupLimit {
  name: string;
  models: string;
  session: Limit | null;
  week: Limit | null;
  sessionDisabled?: boolean;
}
export interface Usage {
  session: Limit | null;
  week: Limit | null;
  checkedAt: string | null;
  /** Vì sao không có số (worker viết tiếng Việt): "Chưa đăng nhập", "CLI không báo", … */
  reason: string | null;
  /** Hai trường dưới do worker mới trả; worker cũ không có thì màn chỉ vẽ hai thước chung. */
  models?: ModelLimit[];
  groups?: GroupLimit[];
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
  /** Worker chọn được gói của CLI này (Claude Code, Codex, Antigravity). */
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
/** Mở Terminal chạy CLI của gói; Rust tự lấy binary và thư mục đăng nhập theo id, nên chỉ gửi id và thư mục làm việc. */
export const openCliTerminal = (id: string, folder: string, bypass = false) =>
  invoke<void>("open_cli_terminal", { id, folder: folder.trim() || null, bypass });

/** Đăng nhập tìm thấy trên máy mà accounts.json chưa có (`accounts discover`). */
export interface FoundLogin {
  cli: string;
  configDir: string | null;
  loggedIn: boolean | null;
  email: string | null;
  suggestedId: string;
  note: string | null;
}

/** Worker cũ chưa có lệnh `accounts discover` thì lệnh lỗi; nơi gọi nuốt lỗi và ẩn băng tìm gói. */
export const discoverPlans = () => invoke<{ found: FoundLogin[] }>("cli_profile_discover");
export const addFoundPlan = (f: Pick<FoundLogin, "cli" | "configDir">) =>
  invoke<Plans>("cli_profile_discover_add", { cli: f.cli, configDir: f.configDir, label: null });

export const CLI_NAME: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  gemini: "Gemini",
  antigravity: "Antigravity",
};

/** Thứ tự khối trên màn; CLI lạ xếp sau theo thứ tự xuất hiện. */
export const CLI_ORDER = ["claude", "codex", "antigravity"] as const;

/** CLI có luồng đăng nhập để thêm gói từ app; Antigravity chỉ vào danh sách qua "tìm trên máy". */
export const ADDABLE_CLIS = ["claude", "codex"] as const;
export type AddableCli = (typeof ADDABLE_CLIS)[number];

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

/** Gói gom theo CLI, mỗi CLI giữ thứ tự của `planRows` (gói cần ra tay lên đầu, gói tắt gom riêng). */
export function cliBlocks(list: Plan[], now = Date.now()): { cli: string; on: Plan[]; off: Plan[] }[] {
  const { on, off } = planRows(list, now);
  const seen = new Set(list.map((p) => p.cli));
  const clis = [
    ...CLI_ORDER.filter((c) => seen.has(c)),
    ...[...seen].filter((c) => !(CLI_ORDER as readonly string[]).includes(c)),
  ];
  return clis.map((cli) => ({ cli, on: on.filter((p) => p.cli === cli), off: off.filter((p) => p.cli === cli) }));
}

/** Phần quota còn lại (0–100) của các gói: gói thấp nhất và trung bình. */
export interface Spread {
  lowest: number;
  average: number;
}

const left = (l: Limit) => Math.max(0, Math.min(100, 100 - Math.round(l.percent)));

function spread(limits: Limit[]): Spread | null {
  if (limits.length === 0) return null;
  const values = limits.map(left);
  return { lowest: Math.min(...values), average: Math.round(values.reduce((a, b) => a + b, 0) / values.length) };
}

/** Ô "Cả máy" theo từng CLI: số gói, quota phiên và tuần còn lại, lần reset sớm nhất của các gói đang bật. */
export function cliSummary(list: Plan[], now = Date.now()) {
  return cliBlocks(list, now).map(({ cli, on, off }) => {
    const reset = machineSummary(on, now).reset;
    const pick = (f: (p: Plan) => Limit | null | undefined) => spread(on.map(f).filter((l): l is Limit => !!l));
    return {
      cli,
      plans: on.length + off.length,
      session: pick((p) => p.usage?.session),
      week: pick((p) => p.usage?.week),
      reset,
    };
  });
}

/**
 * Gói trùng tài khoản: cùng CLI, cùng email đăng nhập. Hai gói như vậy dùng chung một quota nên hiện số giống hệt; màn
 * phải nói rõ thay vì để người dùng nghĩ là đọc nhầm. Trả về id → các gói trùng với nó.
 */
export function sameAccount(list: Plan[]): Record<string, string[]> {
  const key = (p: Plan) => (p.loggedIn !== false && p.email?.trim() ? `${p.cli}\n${p.email.trim().toLowerCase()}` : "");
  const out: Record<string, string[]> = {};
  for (const p of list) {
    const k = key(p);
    if (!k) continue;
    const twins = list.filter((o) => o.id !== p.id && key(o) === k).map((o) => o.id);
    if (twins.length > 0) out[p.id] = twins;
  }
  return out;
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
