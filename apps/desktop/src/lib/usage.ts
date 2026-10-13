import { invoke } from "@/lib/tauri.ts";

/** Kiểu khớp với src-tauri/src/usage.rs (serde camelCase). */
export type Engine = "claude" | "codex";

export interface ContextReport {
  model: string | null;
  used: number | null;
  window: number | null;
  categories: { name: string; tokens: number }[];
}

export interface Limit {
  percent: number;
  /** Claude: chữ "resets …" nguyên văn; Codex: giây Unix. */
  resets: string | null;
}

export interface UsageReport {
  session: Limit | null;
  week: Limit | null;
  drivers: { percent: number; text: string }[];
  topSubagents: string | null;
}

export interface Session {
  id: string;
  at: string;
  cwd: string;
  model: string | null;
  input: number;
  cached: number;
  output: number;
  contextUsed: number | null;
  contextWindow: number | null;
}

export interface SessionStats {
  totals: { sessions: number; input: number; cached: number; output: number };
  sessions: Session[];
  primary: Limit | null;
  secondary: Limit | null;
}

const folderArg = (folder: string) => (folder.trim() ? folder.trim() : null);

/**
 * `claude -p /context` và `/usage` mất vài giây: Rust dùng lại kết quả dưới một phút và gộp các lời gọi trùng nhau.
 * `fresh` bỏ qua kết quả đó (nút tải lại).
 */
export const claudeContext = (folder: string, fresh = false) =>
  invoke<ContextReport>("claude_context", { folder: folderArg(folder), fresh });
export const claudeUsage = (fresh = false) => invoke<UsageReport>("claude_usage", { fresh });
export const sessionStats = (engine: Engine, folder: string) =>
  invoke<SessionStats>("session_stats", { engine, folder: folderArg(folder) });

/** 12700 → "12,7k", 5194645838 → "5,2B" (theo ngôn ngữ). */
export function formatTokens(n: number, locale: string): string {
  const fmt = (v: number, unit: string) =>
    `${v.toLocaleString(locale, { maximumFractionDigits: v < 100 ? 1 : 0 })}${unit}`;
  if (n >= 1e9) return fmt(n / 1e9, "B");
  if (n >= 1e6) return fmt(n / 1e6, "M");
  if (n >= 1e3) return fmt(n / 1e3, "k");
  return n.toLocaleString(locale);
}

/** Tỉ lệ token vào được đọc từ cache; null khi chưa có token nào. */
export const cacheRate = (input: number, cached: number): number | null =>
  input > 0 ? Math.round((cached / input) * 100) : null;

/** Nhóm của `/context` vẽ trên thanh: bỏ "Free space" (phần còn trống không chiếm gì). */
export const usedCategories = (report: ContextReport) =>
  report.categories.filter((c) => c.name.toLowerCase() !== "free space" && c.tokens > 0);

/** Phần ngữ cảnh đang dùng ở lượt cuối của phiên Codex mới nhất. */
export function latestContext(stats: SessionStats): { used: number; window: number } | null {
  const s = stats.sessions.find((x) => x.contextUsed && x.contextWindow);
  return s?.contextUsed && s.contextWindow ? { used: s.contextUsed, window: s.contextWindow } : null;
}

export type TipId = "compact" | "subagents" | "cache" | "codexCompact";

/**
 * Gợi ý rút từ chính số liệu trên màn (không đoán): /usage cho Claude, tỉ lệ cache và ngữ cảnh lượt cuối.
 * Chỉ hiển thị; app không tự đổi cấu hình của người dùng.
 */
export function tips(engine: Engine, usage: UsageReport | null, stats: SessionStats | null): TipId[] {
  const out: TipId[] = [];
  const driver = (needle: string) => usage?.drivers.find((d) => d.text.includes(needle))?.percent ?? 0;
  if (engine === "claude" && driver(">150k context") >= 50) out.push("compact");
  if (engine === "claude" && driver("subagent-heavy") >= 50) out.push("subagents");
  const rate = stats ? cacheRate(stats.totals.input, stats.totals.cached) : null;
  if (rate !== null && rate < 60) out.push("cache");
  const ctx = stats && engine === "codex" ? latestContext(stats) : null;
  if (ctx && ctx.used / ctx.window >= 0.7) out.push("codexCompact");
  return out;
}
