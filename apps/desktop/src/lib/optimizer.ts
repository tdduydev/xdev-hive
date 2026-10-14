import { invoke } from "@/lib/tauri.ts";

export type OptimizerLevel = "balanced" | "aggressive";

export interface OptimizerProfile {
  id: string;
  label?: string;
  cli: string;
  configDir: string;
  default?: boolean;
  supported: boolean;
  reason?: string;
  version?: string;
  enabled: boolean;
  level?: OptimizerLevel;
  inAccounts: boolean;
  enabledAt?: string;
  updatedAt?: string;
  modified?: boolean;
  rtk?: boolean;
  skipped?: { key: string; reason: string }[];
  backups?: string[];
}

export interface OptimizerStatus {
  profiles: OptimizerProfile[];
  result?: {
    profile: string;
    changed: boolean;
    warnings?: { key: string; kind: string; message: string }[];
  };
}

export interface SourceStats {
  sessions: number;
  calls: number;
  weighted: number;
  medianPeakContext: number;
  peakOver150k: number;
  peakOver400k: number;
  cacheHit: number;
}

export interface OptimizerAggregate {
  bySource: Record<string, SourceStats>;
}

export interface OptimizerReport extends OptimizerAggregate {
  days: number | "all";
  sessions: number;
  split?: {
    cutoff: string;
    before: OptimizerAggregate;
    after: OptimizerAggregate;
    sessionsBefore: number;
    sessionsAfter: number;
  };
  trimmed?: { entries: number; charsBefore: number; charsAfter: number; charsCut: number };
  rtkGain?: unknown;
}

export const optimizerStatus = () => invoke<OptimizerStatus>("optimizer_status");
export const optimizerEnable = (profile: string, level: OptimizerLevel, rtk: boolean) =>
  invoke<OptimizerStatus>("optimizer_enable", { profile, level, rtk });
export const optimizerDisable = (profile: string) => invoke<OptimizerStatus>("optimizer_disable", { profile });
export const optimizerRestore = (profile: string, backup: string | null) =>
  invoke<OptimizerStatus>("optimizer_restore", { profile, backup });
export const optimizerReport = (profile: string) => invoke<OptimizerReport>("optimizer_report", { profile, days: 7 });

export function optimizerProfiles(status: OptimizerStatus): OptimizerProfile[] {
  const profiles = [...status.profiles];
  // Sidecar chỉ liệt kê gói đã đăng ký hoặc đã bật; thư mục mặc định cần có lựa chọn riêng cả trước lần bật đầu.
  for (const cli of ["claude", "codex"]) {
    if (!profiles.some((p) => p.id === cli)) {
      profiles.push({ id: cli, cli, configDir: "", default: true, supported: true, enabled: false, inAccounts: false });
    }
  }
  return profiles;
}

export function sourceMetrics(stats: SourceStats | undefined) {
  return {
    sessions: stats?.sessions ?? 0,
    perCall: stats && stats.calls > 0 ? stats.weighted / stats.calls : null,
    perSession: stats && stats.sessions > 0 ? stats.weighted / stats.sessions : null,
    peak: stats && stats.calls > 0 ? stats.medianPeakContext : null,
    over150k: stats?.peakOver150k ?? 0,
    over400k: stats?.peakOver400k ?? 0,
    cacheHit: stats && stats.calls > 0 ? stats.cacheHit * 100 : null,
  };
}

const sourceKeys = ["claude", "codex"].flatMap((cli) =>
  ["interactive", "headless", "worker", "hub-terminal"].map((source) => `${cli}/${source}`),
);

export function reportSources(report: OptimizerReport): string[] {
  return sourceKeys.filter(
    (key) => report.bySource[key] || report.split?.before.bySource[key] || report.split?.after.bySource[key],
  );
}

export function rtkNumbers(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  const keys = [
    "total_saved",
    "saved_tokens",
    "total_saved_tokens",
    "total_commands",
    "total_original_tokens",
    "total_filtered_tokens",
    "avg_savings_pct",
    "total_input_tokens",
    "total_output_tokens",
    "total_tokens_saved",
    "average_savings",
  ];
  return Object.fromEntries(
    keys.flatMap((key) => {
      const n = record[key];
      return typeof n === "number" && Number.isFinite(n) ? [[key, n]] : [];
    }),
  );
}

export function numericReport(report: OptimizerReport): string {
  const aggregate = (part: OptimizerAggregate) =>
    Object.fromEntries(
      sourceKeys.filter((key) => part.bySource[key]).map((key) => [key, sourceMetrics(part.bySource[key])]),
    );
  // Báo cáo sidecar còn có tên file memory và lệnh Bash; clipboard chỉ nhận danh sách trường số đã chọn.
  return JSON.stringify(
    {
      days: report.days,
      sessions: report.sessions,
      bySource: aggregate(report),
      ...(report.split
        ? {
            split: {
              before: aggregate(report.split.before),
              after: aggregate(report.split.after),
              sessionsBefore: report.split.sessionsBefore,
              sessionsAfter: report.split.sessionsAfter,
            },
          }
        : {}),
      ...(report.trimmed
        ? {
            trimmed: {
              entries: report.trimmed.entries,
              charsBefore: report.trimmed.charsBefore,
              charsAfter: report.trimmed.charsAfter,
              charsCut: report.trimmed.charsCut,
            },
          }
        : {}),
      rtkGain: rtkNumbers(report.rtkGain),
    },
    null,
    2,
  );
}
