import { ORPCError } from "@orpc/client";
import {
  LEADER_TIER_GUIDE,
  type TaskTier,
  type TerminalMachineOption,
  type TerminalModel,
  type TerminalOptions,
  type TerminalSession,
} from "@xdev-hive/contracts";
import { TERMINAL_LIMITS } from "@xdev-hive/contracts/worker-protocol";
import type { Dict, Lang } from "@/lib/i18n.ts";
import type { Tone } from "@/lib/run-view.ts";

/** Cỡ khung dự kiến khi chưa đo được (hộp thoại mở phiên). Terminal thật fit lại ngay khi trang phiên mở. */
export const DEFAULT_TERMINAL_SIZE = { cols: 120, rows: 32 } as const;

/** Khoảng hợp lệ của hợp đồng (`terminalCols`, `terminalRows`): fit ra số ngoài khoảng thì hub từ chối khung. */
const COLS = { min: 20, max: 500 } as const;
const ROWS = { min: 5, max: 200 } as const;

export function clampSize(cols: number, rows: number): { cols: number; rows: number } {
  const fit = (value: number, { min, max }: { min: number; max: number }) =>
    Math.min(max, Math.max(min, Math.round(value)));
  return { cols: fit(cols, COLS), rows: fit(rows, ROWS) };
}

// ---- base64 của khung WebSocket ----

/** Cắt chuỗi gõ/dán thành các phần ≤ `TERMINAL_LIMITS.inputBytes` byte UTF-8, không cắt giữa một ký tự. */
export function splitInput(data: string, limit: number = TERMINAL_LIMITS.inputBytes): string[] {
  const encoder = new TextEncoder();
  const parts: string[] = [];
  let current = "";
  let size = 0;
  for (const char of data) {
    const bytes = encoder.encode(char).length;
    if (size + bytes > limit && current) {
      parts.push(current);
      current = "";
      size = 0;
    }
    current += char;
    size += bytes;
  }
  if (current) parts.push(current);
  return parts;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  // Từng đoạn nhỏ: String.fromCharCode(...bytes) với mảng lớn làm tràn ngăn xếp.
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function base64ToBytes(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Phím gõ vào xterm là chuỗi Unicode; hub nhận UTF-8 trong base64. */
export function encodeInput(data: string): string {
  return bytesToBase64(new TextEncoder().encode(data));
}

// ---- Trạng thái phiên ----

export const STATE_VIEW: Record<TerminalSession["state"], { label: Dict<string>; tone: Tone }> = {
  opening: { label: { vi: "Đang mở", en: "Opening" }, tone: "sel" },
  running: { label: { vi: "Đang chạy", en: "Running" }, tone: "ok" },
  closed: { label: { vi: "Đã kết thúc", en: "Ended" }, tone: "neutral" },
  failed: { label: { vi: "Lỗi", en: "Failed" }, tone: "bad" },
};

export const MODE_VIEW: Record<TerminalSession["mode"], { label: Dict<string>; tone: Tone }> = {
  propose: { label: { vi: "Đề xuất", en: "Propose" }, tone: "neutral" },
  bypass: { label: { vi: "Bypass", en: "Bypass" }, tone: "warn" },
};

export const MODEL_LABEL: Record<TerminalModel, string> = { sonnet: "Sonnet", opus: "Opus" };

export const PERMISSIONS_LABEL: Record<"full" | "workspace", Dict<string>> = {
  full: { vi: "Toàn quyền", en: "Full access" },
  workspace: { vi: "Accept edits trong worktree tạm", en: "Accept edits in a temporary worktree" },
};

export const isLive = (session: Pick<TerminalSession, "state">): boolean =>
  session.state === "opening" || session.state === "running";

/** Phiên đã đóng hẳn: xem lại bằng bản ghi, không nối WebSocket. */
export const isEnded = (session: Pick<TerminalSession, "state">): boolean => !isLive(session);

/** Lý do phiên kết thúc do worker/hub ghi (`endReason`) đổi thành câu cho người dùng; mã lạ thì giữ nguyên câu hub gửi. */
export function endReasonText(session: TerminalSession, lang: Lang): string {
  const known: Record<string, { vi: string; en: string }> = {
    exit: { vi: "Claude đã thoát.", en: "Claude exited." },
    closed: { vi: "Phiên đã được đóng.", en: "The session was closed." },
    idle: { vi: "Phiên bị đóng vì không hoạt động quá lâu.", en: "Closed after being idle for too long." },
    denied: { vi: "Máy từ chối mở phiên.", en: "The machine refused to open the session." },
    error: { vi: "Phiên gặp lỗi khi chuẩn bị.", en: "The session failed while starting." },
  };
  const reason = session.endReason;
  if (reason && known[reason]) return known[reason][lang];
  if (reason) return reason;
  if (session.state === "failed") return lang === "en" ? "The session failed." : "Phiên bị lỗi.";
  return lang === "en" ? "The session has ended." : "Phiên đã kết thúc.";
}

// ---- Mở phiên ----

/** Máy chọn được khi mở phiên: chỉ máy online; máy đã đủ số phiên thì khoá kèm lý do. */
export type MachineChoice = { selectable: true; reason: null } | { selectable: false; reason: "offline" | "busy" };

export function machineChoice(machine: Pick<TerminalMachineOption, "online" | "busy">): MachineChoice {
  if (!machine.online) return { selectable: false, reason: "offline" };
  if (machine.busy) return { selectable: false, reason: "busy" };
  return { selectable: true, reason: null };
}

/** Máy online còn chỗ đầu tiên, để chọn sẵn. */
export function firstSelectable(machines: readonly TerminalMachineOption[]): TerminalMachineOption | undefined {
  return machines.find((machine) => machineChoice(machine).selectable);
}

/** Chi phí ước tính của model (trung bình mỗi run code 30 ngày). `null` là chưa đủ dữ liệu. */
export function costOf(options: Pick<TerminalOptions, "costs">, model: TerminalModel): number | null {
  return options.costs.find((cost) => cost.model === model)?.avgRunUsd ?? null;
}

/** Quyền thật sự áp trên máy: máy cho toàn quyền với dự án này thì Toàn quyền, không thì Accept edits trong worktree tạm. */
export const expectedPermissions = (machine: Pick<TerminalMachineOption, "fullAccess">): "full" | "workspace" =>
  machine.fullAccess ? "full" : "workspace";

/** Người dùng chọn Bypass: bắt buộc tick xác nhận trước khi gửi (`confirmBypass`). */
export function canSubmitOpen(input: { machineId: string; mode: "propose" | "bypass"; confirmed: boolean }): boolean {
  if (!input.machineId) return false;
  return input.mode === "propose" || input.confirmed;
}

// ---- Cấp độ ----

const TIER_EN: Record<TaskTier, { label: string; meaning: string }> = {
  light: { label: "Light", meaning: "Docs, wording changes, small config edits, adding or fixing a small test." },
  medium: {
    label: "Medium",
    meaning: "One UI screen, CRUD with e2e, a tidy refactor inside one module.",
  },
  heavy: {
    label: "Heavy",
    meaning: "Several modules, protocols, security, data migrations, performance, hard work that needs deep reasoning.",
  },
};

export const TIERS: readonly TaskTier[] = LEADER_TIER_GUIDE.map((entry) => entry.tier);

export function tierLabel(tier: TaskTier, lang: Lang): string {
  if (lang === "en") return TIER_EN[tier].label;
  return LEADER_TIER_GUIDE.find((entry) => entry.tier === tier)?.label ?? tier;
}

/** Ý nghĩa của cấp, để người duyệt chọn đúng; bản tiếng Việt lấy từ hợp đồng để khớp bảng Leader đọc. */
export function tierMeaning(tier: TaskTier, lang: Lang): string {
  if (lang === "en") return TIER_EN[tier].meaning;
  return LEADER_TIER_GUIDE.find((entry) => entry.tier === tier)?.meaning ?? "";
}

export const isTier = (value: string): value is TaskTier => (TIERS as readonly string[]).includes(value);

/** Đề xuất có gắn cấp độ (chỉ task.create và run.dispatch); loại khác không hiện ô chọn cấp. */
export function hasTier(action: { type: string }): boolean {
  return action.type === "task.create" || action.type === "run.dispatch";
}

// ---- Lỗi ----

/** Lỗi xin vé mà thử lại cũng vô ích (phiên không còn, mất quyền): ngừng nối lại và hiện lý do. */
export function isFatalTicketError(error: unknown): boolean {
  return error instanceof ORPCError && [400, 403, 404, 409].includes(error.status);
}
