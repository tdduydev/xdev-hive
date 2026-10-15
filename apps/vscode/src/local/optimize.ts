import { lang, t } from "@/lib/i18n.ts";
import { runWorker } from "@/local/worker.ts";
import "@/local/strings.ts";

export type OptimizeProfile = {
  id: string;
  label?: string;
  cli: string;
  supported: boolean;
  reason?: string;
  enabled: boolean;
  level?: string;
  version?: string;
};

export type SourceStats = {
  sessions: number;
  calls: number;
  weighted: number;
  medianPeakContext: number;
  cacheHit: number;
};

type Aggregate = { bySource: Record<string, SourceStats> };

export type OptimizeReport = Aggregate & {
  days: number | "all";
  sessions: number;
  split?: {
    cutoff: string;
    before: Aggregate;
    after: Aggregate;
    sessionsBefore: number;
    sessionsAfter: number;
  };
  trimmed?: { entries: number; charsCut: number };
};

export const REPORT_DAYS = 7;

export async function optimizeStatus(): Promise<OptimizeProfile[]> {
  const view = await runWorker<{ profiles?: OptimizeProfile[] }>(["optimize", "status"]);
  return view.profiles ?? [];
}

export async function optimizeSet(profile: string, enable: boolean): Promise<void> {
  await runWorker(["optimize", enable ? "enable" : "disable", "--profile", profile]);
}

export async function optimizeReport(profile: string): Promise<OptimizeReport> {
  return runWorker<OptimizeReport>(["optimize", "report", "--profile", profile, "--days", String(REPORT_DAYS)]);
}

function group(n: number): string {
  const sep = lang() === "vi" ? "." : ",";
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, sep);
}

function rows(title: string, aggregate: Aggregate): string[] {
  const lines = [
    `### ${title}`,
    "",
    `| ${t("optimize.report.source")} | ${t("optimize.report.sessions")} | ${t("optimize.report.perCall")} | ${t("optimize.report.peak")} | ${t("optimize.report.cache")} |`,
    "|---|---:|---:|---:|---:|",
  ];
  for (const [source, s] of Object.entries(aggregate.bySource).sort(([a], [b]) => a.localeCompare(b))) {
    const perCall = s.calls > 0 ? group(s.weighted / s.calls) : "–";
    const peak = s.calls > 0 ? group(s.medianPeakContext) : "–";
    const cache = s.calls > 0 ? `${Math.round(s.cacheHit * 100)}%` : "–";
    lines.push(`| ${source} | ${s.sessions} | ${perCall} | ${peak} | ${cache} |`);
  }
  return [...lines, ""];
}

/** Hai bảng trước/sau mốc bật nếu hive-worker có mốc; không thì một bảng chung. */
export function formatReport(profile: string, report: OptimizeReport): string {
  const days = report.days === "all" ? t("optimize.report.all") : String(report.days);
  const out = [`# ${t("optimize.report.title", { profile, days })}`, ""];
  if (report.sessions === 0) {
    out.push(t("optimize.report.empty"), "");
  } else if (report.split) {
    const date = report.split.cutoff.slice(0, 10);
    out.push(
      ...rows(`${t("optimize.report.before", { date })} · ${report.split.sessionsBefore}`, report.split.before),
      ...rows(`${t("optimize.report.after")} · ${report.split.sessionsAfter}`, report.split.after),
    );
  } else {
    out.push(...rows(t("optimize.report.all"), report));
  }
  if (report.trimmed && report.trimmed.charsCut > 0) {
    out.push(
      t("optimize.report.trimmed", { chars: group(report.trimmed.charsCut), entries: report.trimmed.entries }),
      "",
    );
  }
  return out.join("\n");
}
