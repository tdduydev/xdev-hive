import { useQuery } from "@tanstack/react-query";
import type { Machine, MachineTokenScore, TokenScoreReport } from "@xdev-hive/contracts";
import { Button } from "@xdev-hive/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@xdev-hive/ui/dialog";
import { Pill } from "@xdev-hive/ui/pill";
import { Table, Td, Th } from "@xdev-hive/ui/table";
import { useId } from "react";
import { EmptyState, LoadFailure, LoadingState } from "@/components/ui/query-state.tsx";
import { formatAgo, formatDay, formatDayTime } from "@/lib/format.ts";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import { CLI_LABEL } from "@/lib/run-view.ts";
import {
  formatCriterionValue,
  formatPoints,
  formatScore,
  levelTone,
  statusTone,
  type TokenScoreLevel,
  type TokenScoreStatus,
  trendPoints,
} from "@/lib/token-score.ts";
import { useOrg } from "@/shell/org-context.ts";

type Profile = TokenScoreReport["profiles"][number];

const text: Dict<{
  column: string;
  none: string;
  provisional: string;
  levels: Record<TokenScoreLevel, string>;
  statuses: Record<TokenScoreStatus, string>;
  reasons: Record<string, string>;
  open: (name: string, score: string, level: string | null) => string;
  title: (name: string) => string;
  lead: (at: string, days: number) => string;
  loading: string;
  empty: string;
  emptyHint: string;
  score: string;
  coverage: string;
  share: string;
  group: (key: string) => string;
  trend: string;
  trendLabel: (count: number, first: string, last: string) => string;
  trendEmpty: string;
  trendTable: string;
  day: string;
  criterion: string;
  status: string;
  points: string;
  value: string;
  criteriaLabel: (cli: string) => string;
}> = {
  vi: {
    column: "Điểm token",
    none: "Máy chưa bật gửi điểm",
    provisional: "tạm tính",
    levels: { good: "Tốt", fair: "Khá", low: "Thấp" },
    statuses: { ok: "Đạt", partial: "Một phần", low: "Thấp", unknown: "Chưa đo", unsupported: "Không hỗ trợ" },
    reasons: {
      not_enough_sessions: "Chưa đủ phiên",
      no_edit_sessions: "Chưa có phiên sửa code",
      no_token_logs: "Chưa có log token",
      context_unavailable: "Không đọc được context",
      context_not_measured: "Chưa đo context",
      config_unreadable: "Không đọc được cấu hình",
      cli_version_unknown: "Không rõ phiên bản CLI",
      unsupported_cli: "CLI không hỗ trợ",
      windows_rtk_unsupported: "RTK chưa chạy trên Windows",
    },
    open: (name, score, level) => `Xem điểm token của ${name}: ${score}${level ? `, ${level}` : ""}`,
    title: (name) => `Điểm token · ${name}`,
    lead: (at, days) => `Máy gửi lúc ${at}, tính trên ${days} ngày gần nhất.`,
    loading: "Đang tải điểm…",
    empty: "Máy chưa gửi điểm",
    emptyHint: "Bật “Gửi điểm lên hub” trong màn Token của app desktop trên máy này.",
    score: "Điểm",
    coverage: "Phạm vi đo",
    share: "Tỉ trọng",
    group: (key) => `Nhóm ${key}`,
    trend: "Điểm 90 ngày",
    trendLabel: (count, first, last) => `Điểm máy qua ${count} lần gửi, từ ${first} tới ${last}`,
    trendEmpty: "Chưa có lần gửi nào có điểm.",
    trendTable: "Xem dạng bảng",
    day: "Thời điểm",
    criterion: "Tiêu chí",
    status: "Trạng thái",
    points: "Điểm",
    value: "Giá trị",
    criteriaLabel: (cli) => `Tiêu chí của ${cli}`,
  },
  en: {
    column: "Token score",
    none: "This machine does not send its score",
    provisional: "provisional",
    levels: { good: "Good", fair: "Fair", low: "Low" },
    statuses: { ok: "Met", partial: "Partial", low: "Low", unknown: "Not measured", unsupported: "Not supported" },
    reasons: {
      not_enough_sessions: "Not enough sessions",
      no_edit_sessions: "No editing sessions yet",
      no_token_logs: "No token logs yet",
      context_unavailable: "Context could not be read",
      context_not_measured: "Context not measured",
      config_unreadable: "Config could not be read",
      cli_version_unknown: "Unknown CLI version",
      unsupported_cli: "CLI not supported",
      windows_rtk_unsupported: "RTK does not run on Windows",
    },
    open: (name, score, level) => `Token score of ${name}: ${score}${level ? `, ${level}` : ""}`,
    title: (name) => `Token score · ${name}`,
    lead: (at, days) => `Sent at ${at}, over the last ${days} days.`,
    loading: "Loading score…",
    empty: "No score sent yet",
    emptyHint: "Turn on “Send score to hub” in the desktop app’s Token screen on this machine.",
    score: "Score",
    coverage: "Coverage",
    share: "Share",
    group: (key) => `Group ${key}`,
    trend: "90-day score",
    trendLabel: (count, first, last) => `Machine score over ${count} reports, from ${first} to ${last}`,
    trendEmpty: "No report with a score yet.",
    trendTable: "Show as a table",
    day: "Time",
    criterion: "Criterion",
    status: "Status",
    points: "Points",
    value: "Value",
    criteriaLabel: (cli) => `Criteria for ${cli}`,
  },
};

/** Ô "Điểm token" ở danh sách máy và trang máy: điểm nguyên, mức, "tạm tính" và lúc gửi; bấm để xem chi tiết. */
export function TokenScoreCell({ machine, now, onOpen }: { machine: Machine; now: number; onOpen: () => void }) {
  const t = useT(text);
  const lang = useLang();
  const score = machine.tokenScore;
  if (!score) {
    return (
      <span title={t.none} className="text-muted-foreground">
        —
      </span>
    );
  }
  const level = score.level ? t.levels[score.level] : null;
  return (
    <span className="grid justify-items-start gap-0.5">
      <Button
        variant="ghost"
        size="sm"
        className="-mx-2 gap-1.5"
        aria-label={t.open(machine.name, formatScore(score.score), level)}
        onClick={onOpen}
      >
        <span className="font-semibold tabular-nums">{formatScore(score.score)}</span>
        {level && score.level && (
          <Pill tone={levelTone(score.level)} small>
            {level}
          </Pill>
        )}
      </Button>
      <span className="text-xs whitespace-nowrap text-muted-foreground" title={formatDayTime(score.reportedAt, lang)}>
        {score.provisional ? `${t.provisional} · ` : ""}
        {formatAgo(score.reportedAt, now, lang)}
      </span>
    </span>
  );
}

/** Hộp thoại điểm token của một máy; `machine` null là đóng. */
export function TokenScoreDialog({ machine, onClose }: { machine: Machine | null; onClose: () => void }) {
  return (
    <Dialog
      open={machine !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {machine && <TokenScoreContent machine={machine} />}
    </Dialog>
  );
}

function TokenScoreContent({ machine }: { machine: Machine }) {
  const t = useT(text);
  const lang = useLang();
  const { api } = useOrg();
  const query = useQuery(api.machines.tokenScore.queryOptions({ input: { machineId: machine.id } }));
  const latest = query.data?.latest ?? null;
  return (
    <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-2xl">
      <DialogTitle>{t.title(machine.name)}</DialogTitle>
      {latest && (
        <DialogDescription>{t.lead(formatDayTime(latest.reportedAt, lang), latest.report.days)}</DialogDescription>
      )}
      <div className="-mx-1 grid min-h-0 gap-5 overflow-y-auto overscroll-contain px-1">
        {query.isPending ? (
          <LoadingState label={t.loading} />
        ) : query.isError ? (
          <LoadFailure error={query.error} retry={query.refetch} />
        ) : !latest ? (
          <EmptyState compact title={t.empty} description={t.emptyHint} />
        ) : (
          <>
            <MachineSummary report={latest.report} />
            <ScoreTrend history={query.data.history} />
            {latest.report.profiles.map((profile) => (
              <ProfileSection key={profile.cli} profile={profile} />
            ))}
          </>
        )}
      </div>
    </DialogContent>
  );
}

function MachineSummary({ report }: { report: TokenScoreReport }) {
  const t = useT(text);
  const { score, level, coverage, provisional } = report.machine;
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
      <div className="grid gap-0.5">
        <span className="text-xs text-muted-foreground">{t.score}</span>
        <span className="flex items-center gap-2">
          <span className="text-2xl font-semibold tabular-nums">{formatScore(score)}</span>
          {level && <Pill tone={levelTone(level)}>{t.levels[level]}</Pill>}
          {provisional && <Pill>{t.provisional}</Pill>}
        </span>
      </div>
      <div className="grid gap-0.5">
        <span className="text-xs text-muted-foreground">{t.coverage}</span>
        <span className="text-lg font-medium tabular-nums">{Math.round(coverage)}%</span>
      </div>
    </div>
  );
}

const TREND_W = 320;
const TREND_H = 64;

/**
 * Đường điểm 90 ngày: một chuỗi nên một màu (primary), trục chỉ có mốc 0 và 100 vì điểm luôn trong khoảng đó. Người
 * dùng trình đọc màn hình đọc bảng bên dưới (FR-018, như biểu đồ ở trang Chi phí).
 */
function ScoreTrend({ history }: { history: MachineTokenScore["history"] }) {
  const t = useT(text);
  const lang = useLang();
  const headingId = useId();
  const points = trendPoints(history, TREND_W, TREND_H);
  const first = points[0];
  const last = points.at(-1);
  return (
    <section aria-labelledby={headingId} className="grid gap-2">
      <h3 id={headingId} className="text-sm font-medium">
        {t.trend}
      </h3>
      {!first || !last ? (
        <p className="text-sm text-muted-foreground">{t.trendEmpty}</p>
      ) : (
        <>
          <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-2">
            <div className="flex flex-col justify-between text-right text-xs text-muted-foreground tabular-nums">
              <span>100</span>
              <span>0</span>
            </div>
            {/* Chấm điểm mới nhất vẽ bằng HTML: SVG kéo giãn (preserveAspectRatio none) làm hình tròn thành bầu dục. */}
            <div className="relative h-20 border-b border-border text-primary">
              <svg
                role="img"
                aria-label={t.trendLabel(points.length, formatScore(first.score), formatScore(last.score))}
                viewBox={`0 0 ${TREND_W} ${TREND_H}`}
                className="absolute inset-0 size-full overflow-visible"
                preserveAspectRatio="none"
              >
                <line
                  x1={0}
                  x2={TREND_W}
                  y1={TREND_H / 2}
                  y2={TREND_H / 2}
                  className="stroke-border"
                  strokeDasharray="4 4"
                  vectorEffect="non-scaling-stroke"
                />
                {points.length > 1 && (
                  <polyline
                    points={points.map((point) => `${point.x},${point.y}`).join(" ")}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    vectorEffect="non-scaling-stroke"
                  />
                )}
              </svg>
              <span
                aria-hidden="true"
                title={`${formatDayTime(last.at, lang)}: ${formatScore(last.score)}`}
                className="absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-current"
                style={{ left: `${(last.x / TREND_W) * 100}%`, top: `${(last.y / TREND_H) * 100}%` }}
              />
            </div>
            <span />
            <div className="flex justify-between text-xs text-muted-foreground tabular-nums">
              <span>{formatDay(first.at, lang)}</span>
              <span>{formatDay(last.at, lang)}</span>
            </div>
          </div>
          <details className="text-sm">
            <summary className="w-fit cursor-pointer text-muted-foreground hover:text-foreground">
              {t.trendTable}
            </summary>
            <div className="mt-2 max-h-48 overflow-auto rounded-lg border border-border">
              <Table>
                <thead>
                  <tr>
                    <Th variant="plain">{t.day}</Th>
                    <Th variant="plain" className="text-right">
                      {t.score}
                    </Th>
                    <Th variant="plain" className="text-right">
                      {t.coverage}
                    </Th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((point) => (
                    <tr key={point.reportedAt}>
                      <Td>{formatDayTime(point.reportedAt, lang)}</Td>
                      <Td className="text-right tabular-nums">{formatScore(point.score)}</Td>
                      <Td className="text-right tabular-nums">{Math.round(point.coverage)}%</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          </details>
        </>
      )}
    </section>
  );
}

function ProfileSection({ profile }: { profile: Profile }) {
  const t = useT(text);
  const headingId = useId();
  const cli = CLI_LABEL[profile.cli] ?? profile.cli;
  const groups = Object.entries(profile.groups).sort(([a], [b]) => a.localeCompare(b));
  return (
    <section aria-labelledby={headingId} className="grid gap-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 id={headingId} className="text-sm font-semibold">
          {cli}
        </h3>
        <span className="text-xs text-muted-foreground tabular-nums">
          {t.score} {formatScore(profile.score)} · {t.coverage} {Math.round(profile.coverage)}% · {t.share}{" "}
          {Math.round(profile.share * 100)}%
        </span>
      </div>
      {groups.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {groups.map(([key, group]) => (
            <li key={key}>
              <Pill small>
                {t.group(key)} · <span className="tabular-nums">{formatPoints(group.earned, group.max)}</span>
              </Pill>
            </li>
          ))}
        </ul>
      )}
      {/* Table tự cuộn ngang trong khung của nó, nên hộp thoại ở 360 px không tràn ra ngoài. */}
      <div className="overflow-hidden rounded-lg border border-border">
        <Table aria-label={t.criteriaLabel(cli)}>
          <thead>
            <tr>
              <Th variant="plain">{t.criterion}</Th>
              <Th variant="plain">{t.status}</Th>
              <Th variant="plain" className="text-right">
                {t.points}
              </Th>
              <Th variant="plain">{t.value}</Th>
            </tr>
          </thead>
          <tbody>
            {profile.criteria.map((criterion) => (
              <tr key={criterion.id}>
                <Td className="font-mono text-xs">{criterion.id}</Td>
                <Td>
                  <Pill tone={statusTone(criterion.status)} small>
                    {t.statuses[criterion.status]}
                  </Pill>
                </Td>
                <Td className="text-right tabular-nums">{formatPoints(criterion.earned, criterion.max)}</Td>
                <Td>
                  <span className="grid gap-0.5">
                    <span className="tabular-nums">{formatCriterionValue(criterion.value, criterion.unit)}</span>
                    {criterion.reason && (
                      <span className="text-xs text-muted-foreground">
                        {t.reasons[criterion.reason] ?? criterion.reason}
                      </span>
                    )}
                  </span>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
    </section>
  );
}
