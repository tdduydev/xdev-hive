import { invoke } from "@/lib/tauri.ts";
import { formatTokens } from "@/lib/usage.ts";

/*
 * Kiểu khớp hợp đồng JSON của `hive-worker optimize score|fix --json` (specs/025-token-score/tasks.md). Go là nguồn
 * sự thật; số điểm trong JSON làm tròn 2 chữ số, giao diện làm tròn 1 chữ số khi hiện.
 */
export type Status = "ok" | "partial" | "low" | "unknown" | "unsupported";
export type Level = "good" | "fair" | "low";
export type Cli = "claude" | "codex" | "antigravity" | "gemini";
export type CriterionId =
  | "A1"
  | "A2"
  | "A3"
  | "A4"
  | "A5"
  | "A6"
  | "A7"
  | "A8"
  | "B1"
  | "B2"
  | "B3"
  | "B4"
  | "B5"
  | "B6"
  | "B7";
export type FixId =
  | "optimizer.balanced"
  | "optimizer.rtk"
  | "optimizer.aggressive"
  | "tool.rtk"
  | "tool.codegraph"
  | "codegraph.mcp"
  | "codegraph.init"
  | "open.memory"
  | "open.mcp"
  | "context.measure";

export interface CriterionItem {
  id: string;
  status: Status;
  value?: number;
  score?: number;
  reason?: string;
  file?: string;
}

export interface Criterion {
  id: CriterionId;
  group: "A" | "B";
  status: Status;
  value?: number;
  unit?: "tokens" | "ratio" | "count";
  good?: number;
  bad?: number;
  earned: number;
  max: number;
  source?: "settings" | "context" | "sessions" | "files" | "tools";
  reason?: string;
  userSet?: boolean;
  items?: CriterionItem[];
  warnings?: { code: string; file?: string }[];
  fixes?: FixId[];
}

export interface GroupScore {
  earned: number;
  max: number;
}

export interface ProfileScore {
  id: string;
  label?: string;
  cli: Cli;
  default?: boolean;
  /** false: không tính vào điểm máy (`reason`: `no_token_logs`, `unsupported_cli`). */
  counted: boolean;
  reason?: string;
  level?: "balanced" | "aggressive";
  weighted: number;
  sessions: number;
  share: number;
  score: number | null;
  coverage: number;
  groups: { A: GroupScore; B: GroupScore };
  criteria: Criterion[];
  /** `path` dạng `~/…`; `key` chỉ có nghĩa trong một lần tính. */
  projects: { key: string; path: string; share: number; codegraph: boolean }[];
  context?: { name: string; tokens: number }[];
}

export interface TokenScore {
  scoreVersion: 1;
  generatedAt: string;
  days: number;
  machine: { score: number | null; level: Level | null; coverage: number; provisional: boolean };
  previous?: { score: number | null; at: string };
  profiles: ProfileScore[];
}

export interface FixPreview {
  fixId: FixId;
  profile: string;
  changes: { file: string; key: string; before: string | null; after: string | null }[];
  /** Mã: `quality_may_change`, `context_grows`, `long_running`. */
  warnings: string[];
}

export interface FixResult {
  fixId: FixId;
  profile: string;
  backup?: string;
}

/**
 * Lệnh Rust (src-tauri/src/token_score.rs). Giao diện chỉ gửi id sửa nhanh, id gói và khoá dự án của lần tính gần
 * nhất; Rust không nhận chuỗi lệnh hay đường dẫn.
 */
/**
 * `fresh` chạy lại `claude -p /context` cho gói `profileId`: lệnh này gọi model nên chỉ dùng khi người dùng bấm đo
 * đúng gói đó.
 */
export const tokenScore = (fresh = false, profileId: string | null = null) =>
  invoke<TokenScore>("token_score", { fresh, profileId });
export const tokenScoreFixPreview = (fixId: FixId, profileId: string, projectKey?: string | null) =>
  invoke<FixPreview>("token_score_fix_preview", { fixId, profileId, projectKey: projectKey ?? null });
export const tokenScoreFix = (fixId: FixId, profileId: string, projectKey?: string | null) =>
  invoke<FixResult>("token_score_fix", { fixId, profileId, projectKey: projectKey ?? null });
export const tokenScoreUndo = (fixId: FixId, profileId: string, projectKey?: string | null, backup?: string | null) =>
  invoke<unknown>("token_score_undo", { fixId, profileId, projectKey: projectKey ?? null, backup: backup ?? null });

/** Tốt ≥ 80, Khá 60–79, Cần cải thiện < 60 (spec 025 "Thang điểm"). */
export function levelOf(score: number): Level {
  return score >= 80 ? "good" : score >= 60 ? "fair" : "low";
}

/** Điểm thiếu của tiêu chí; tiêu chí chưa đo hay chưa hỗ trợ không có điểm thiếu. */
export const missingPoints = (c: Criterion): number => (measured(c) ? Math.max(0, c.max - c.earned) : 0);

const measured = (c: Criterion) => c.status !== "unknown" && c.status !== "unsupported";

/** Xếp theo điểm thiếu nhiều nhất lên đầu; chưa đo và chưa hỗ trợ xuống cuối. Giữ thứ tự gốc khi bằng nhau. */
export function sortCriteria(criteria: readonly Criterion[]): Criterion[] {
  return criteria
    .map((c, i) => ({ c, i }))
    .sort((a, b) => {
      const ma = measured(a.c);
      const mb = measured(b.c);
      if (ma !== mb) return ma ? -1 : 1;
      return missingPoints(b.c) - missingPoints(a.c) || a.i - b.i;
    })
    .map((x) => x.c);
}

/** 47.83 → "47,8" (theo ngôn ngữ). */
export const formatScore = (n: number, locale: string): string =>
  n.toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** Điểm của tiêu chí và nhóm: bỏ số 0 thừa ở số nguyên (10, không phải 10,0). */
export const formatPoints = (n: number, locale: string): string =>
  n.toLocaleString(locale, { maximumFractionDigits: 1 });

/** Giá trị đo theo đơn vị của tiêu chí: token rút gọn như màn Token, tỉ lệ là %, đếm là số nguyên. */
export function formatValue(n: number, unit: Criterion["unit"], locale: string): string {
  if (unit === "tokens") return formatTokens(n, locale);
  if (unit === "ratio") return `${(n * 100).toLocaleString(locale, { maximumFractionDigits: 1 })}%`;
  return n.toLocaleString(locale, { maximumFractionDigits: 2 });
}

/**
 * Điểm nhóm A và B của cả máy: trung bình các gói được tính, trọng số theo tỉ trọng token (chia đều khi không gói
 * nào có token), cùng cách tính điểm máy.
 */
export function groupTotals(score: TokenScore): { A: GroupScore; B: GroupScore } {
  const counted = score.profiles.filter((p) => p.counted);
  const total = counted.reduce((sum, p) => sum + p.share, 0);
  const out = { A: { earned: 0, max: 0 }, B: { earned: 0, max: 0 } };
  for (const p of counted) {
    const weight = total > 0 ? p.share / total : 1 / counted.length;
    for (const g of ["A", "B"] as const) {
      out[g].earned += p.groups[g].earned * weight;
      out[g].max += p.groups[g].max * weight;
    }
  }
  return out;
}

/** Chênh lệch điểm máy so với lần tính trước; null khi một trong hai chưa có điểm. */
export function scoreDelta(score: TokenScore): number | null {
  const now = score.machine.score;
  const before = score.previous?.score;
  if (now === null || before === null || before === undefined) return null;
  return Math.round((now - before) * 10) / 10;
}

const CODE = /^[a-z][a-z0-9_]*$/i;
/** Mã lý do và id mục con là chữ cố định của sidecar; chuỗi lạ (có thể mang đường dẫn) không được chép đi. */
const code = (s: string | undefined) => (s !== undefined && CODE.test(s) ? s : undefined);

/**
 * Báo cáo để chép: chỉ số, id tiêu chí, trạng thái, mã lý do và tên CLI. Không có id gói, nhãn, đường dẫn, khoá dự án
 * hay tên nhóm `/context` (FR-015).
 */
export function copyReport(score: TokenScore): string {
  const pick = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
  return JSON.stringify(
    {
      scoreVersion: score.scoreVersion,
      generatedAt: score.generatedAt,
      days: score.days,
      machine: score.machine,
      ...(score.previous ? { previous: { score: score.previous.score } } : {}),
      profiles: score.profiles.map((p) =>
        pick({
          cli: p.cli,
          counted: p.counted,
          reason: code(p.reason),
          level: p.level,
          weighted: p.weighted,
          sessions: p.sessions,
          share: p.share,
          score: p.score,
          coverage: p.coverage,
          groups: p.groups,
          criteria: p.criteria.map((c) =>
            pick({
              id: c.id,
              status: c.status,
              value: c.value,
              unit: c.unit,
              earned: c.earned,
              max: c.max,
              source: c.source,
              reason: code(c.reason),
              userSet: c.userSet,
              items: c.items?.map((i) =>
                pick({ id: code(i.id), status: i.status, value: i.value, score: i.score, reason: code(i.reason) }),
              ),
              warnings: c.warnings?.map((w) => code(w.code)).filter((w) => w !== undefined),
            }),
          ),
        }),
      ),
    },
    null,
    2,
  );
}
