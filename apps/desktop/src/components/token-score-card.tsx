import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Pill } from "@xdev-hive/ui/pill";
import { RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type AppliedFix,
  AppliedFixes,
  type ExtraHint,
  profileName,
  TokenScoreDetail,
} from "@/components/token-score-detail.tsx";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import { errorText } from "@/lib/tauri.ts";
import {
  copyReport,
  formatPoints,
  formatScore,
  groupTotals,
  type Level,
  levelOf,
  scoreDelta,
  type TokenScore,
  tokenScore,
} from "@/lib/token-score.ts";

const text: Dict<{
  title: string;
  recalc: string;
  copy: string;
  copied: string;
  copyFailed: string;
  showDetail: string;
  hideDetail: string;
  loading: string;
  level: Record<Level, string>;
  provisional: string;
  provisionalHint: string;
  coverage: (measured: string) => string;
  noScore: string;
  up: (points: string) => string;
  down: (points: string) => string;
  same: string;
  groupA: string;
  groupB: string;
  unmeasured: string;
  profiles: string;
  share: (percent: number) => string;
  excluded: string;
  excludedReasons: Record<string, string>;
  cli: Record<string, string>;
  tipsTitle: string;
  note: string;
}> = {
  vi: {
    title: "Điểm tối ưu token",
    recalc: "Tính lại",
    copy: "Chép báo cáo điểm",
    copied: "Đã chép báo cáo chỉ gồm số liệu.",
    copyFailed: "Không chép được báo cáo vào clipboard.",
    showDetail: "Xem chi tiết",
    hideDetail: "Ẩn chi tiết",
    loading: "Đang tính điểm…",
    level: { good: "Tốt", fair: "Khá", low: "Cần cải thiện" },
    provisional: "tạm tính",
    provisionalHint: "Mới đo được dưới 50 trên 100 điểm nên điểm có thể lệch.",
    coverage: (measured) => `Đo được ${measured}/100 điểm`,
    noScore: "Chưa có điểm máy: chưa gói Claude hay Codex nào chấm được.",
    up: (points) => `Tăng ${points} điểm so với lần tính trước`,
    down: (points) => `Giảm ${points} điểm so với lần tính trước`,
    same: "Không đổi so với lần tính trước",
    groupA: "Nhóm A · Cấu hình",
    groupB: "Nhóm B · Số liệu phiên",
    unmeasured: "chưa đo",
    profiles: "Điểm từng gói",
    share: (percent) => `${percent}% token 7 ngày`,
    excluded: "không tính vào điểm máy",
    excludedReasons: { no_token_logs: "không có log token", unsupported_cli: "CLI chưa được hỗ trợ" },
    cli: { claude: "Claude Code", codex: "Codex", antigravity: "Antigravity", gemini: "Gemini" },
    tipsTitle: "Gợi ý về cách dùng",
    note: "Điểm đo cấu hình và kích thước ngữ cảnh, không đo chất lượng kết quả của agent.",
  },
  en: {
    title: "Token optimization score",
    recalc: "Recalculate",
    copy: "Copy score report",
    copied: "Copied a report with figures only.",
    copyFailed: "Could not copy the report to the clipboard.",
    showDetail: "Show details",
    hideDetail: "Hide details",
    loading: "Calculating score…",
    level: { good: "Good", fair: "Fair", low: "Needs work" },
    provisional: "provisional",
    provisionalHint: "Only under 50 of 100 points could be measured, so the score may be off.",
    coverage: (measured) => `Measured ${measured}/100 points`,
    noScore: "No machine score yet: no Claude or Codex profile can be scored.",
    up: (points) => `Up ${points} points since the last calculation`,
    down: (points) => `Down ${points} points since the last calculation`,
    same: "Unchanged since the last calculation",
    groupA: "Group A · Configuration",
    groupB: "Group B · Session figures",
    unmeasured: "not measured",
    profiles: "Score per profile",
    share: (percent) => `${percent}% of 7-day tokens`,
    excluded: "not counted in the machine score",
    excludedReasons: { no_token_logs: "no token logs", unsupported_cli: "CLI not supported yet" },
    cli: { claude: "Claude Code", codex: "Codex", antigravity: "Antigravity", gemini: "Gemini" },
    tipsTitle: "Usage tips",
    note: "The score measures configuration and context size, not the quality of the agent's results.",
  },
};

const LEVEL_TONE = { good: "ok", fair: "warn", low: "bad" } as const;

interface State {
  score: TokenScore | null;
  error: string | null;
  loading: boolean;
}

interface Props {
  /** Gợi ý của màn Token đặt dưới tiêu chí liên quan; gợi ý không có tiêu chí nào để đặt thì hiện ở thẻ. */
  hints?: ExtraHint[];
  /** Gợi ý chung, không gắn với tiêu chí nào (vd. subagent). */
  tips?: { title: string; why: string }[];
}

/** Thẻ đầu màn Token: điểm máy, hai nhóm, điểm từng gói và chi tiết có sửa nhanh (spec 025 US1–US3). */
export function TokenScoreCard({ hints = [], tips = [] }: Props) {
  const t = useT(text);
  const lang = useLang();
  const [state, setState] = useState<State>({ score: null, error: null, loading: true });
  const [open, setOpen] = useState(false);
  const [applied, setApplied] = useState<AppliedFix[]>([]);
  const [copy, setCopy] = useState<"copied" | "failed" | null>(null);
  const latest = useRef(0);

  const load = useCallback(async (fresh: boolean) => {
    const id = ++latest.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const score = await tokenScore(fresh);
      if (id === latest.current) setState({ score, error: null, loading: false });
    } catch (e) {
      // Giữ điểm cũ trên màn: lần tính lại lỗi không làm mất số đang xem.
      if (id === latest.current) setState((s) => ({ ...s, error: errorText(e), loading: false }));
    }
  }, []);

  useEffect(() => {
    void load(false);
    return () => {
      latest.current++;
    };
  }, [load]);

  const { score, error, loading } = state;

  async function copyScore() {
    if (!score) return;
    try {
      await navigator.clipboard.writeText(copyReport(score));
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
  }

  const fmt = (n: number) => formatScore(n, lang);
  const pts = (n: number) => formatPoints(n, lang);
  const machine = score?.machine;
  const level = machine && machine.score !== null ? (machine.level ?? levelOf(machine.score)) : null;
  const delta = score ? scoreDelta(score) : null;
  const groups = score ? groupTotals(score) : null;
  const general = [
    ...tips,
    ...hints.filter(
      (h) => !score?.profiles.some((p) => p.cli === h.cli && p.criteria.some((c) => c.id === h.criterion)),
    ),
  ];

  return (
    <section aria-label={t.title} className="overflow-hidden rounded-xl border bg-card text-card-foreground">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <h2 className="min-w-40 flex-1 text-[15px] font-semibold">{t.title}</h2>
        <Button variant="outline" size="sm" disabled={loading} onClick={() => void load(false)}>
          <RefreshCwIcon aria-hidden="true" className={loading ? "animate-spin" : undefined} />
          {t.recalc}
        </Button>
        <Button variant="outline" size="sm" disabled={!score} onClick={() => void copyScore()}>
          {t.copy}
        </Button>
        <Button variant="outline" size="sm" disabled={!score} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? t.hideDetail : t.showDetail}
        </Button>
      </div>

      {loading && !score && (
        <p role="status" className="px-4 py-3 text-sm text-muted-foreground">
          {t.loading}
        </p>
      )}
      {error && (
        <div className="px-4 pt-3">
          <Alert variant="destructive">{error}</Alert>
        </div>
      )}

      {score && machine && groups && (
        <div className="flex flex-col gap-4 px-4 py-4">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
            <div className="flex items-baseline gap-1.5">
              <span className="font-mono text-4xl font-semibold tracking-tight">
                {machine.score === null ? "—" : fmt(machine.score)}
              </span>
              <span className="text-sm text-muted-foreground">/100</span>
            </div>
            <div className="flex min-w-48 flex-1 flex-col gap-1">
              <div className="flex flex-wrap items-center gap-1.5">
                {level && <Pill tone={LEVEL_TONE[level]}>{t.level[level]}</Pill>}
                {machine.provisional && (
                  <Pill tone="warn" title={t.provisionalHint}>
                    {t.provisional}
                  </Pill>
                )}
              </div>
              {machine.score === null ? (
                <p className="text-sm text-muted-foreground">{t.noScore}</p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {t.coverage(machine.coverage.toLocaleString(lang, { maximumFractionDigits: 1 }))}
                </p>
              )}
              {delta !== null && (
                <p className={delta > 0 ? "text-sm text-success" : delta < 0 ? "text-sm text-destructive" : "text-sm"}>
                  {delta > 0 ? t.up(fmt(delta)) : delta < 0 ? t.down(fmt(-delta)) : t.same}
                </p>
              )}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <GroupBar label={t.groupA} earned={groups.A.earned} max={groups.A.max} none={t.unmeasured} fmt={pts} />
            <GroupBar label={t.groupB} earned={groups.B.earned} max={groups.B.max} none={t.unmeasured} fmt={pts} />
          </div>

          <div className="flex flex-col gap-1.5">
            <h3 className="text-sm font-semibold">{t.profiles}</h3>
            <ul className="flex flex-col divide-y">
              {score.profiles.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 py-1.5 text-sm">
                  <span className="font-medium">{t.cli[p.cli] ?? p.cli}</span>
                  <span className="max-w-48 truncate text-muted-foreground" title={profileName(p)}>
                    {profileName(p)}
                  </span>
                  {p.counted ? (
                    <span className="text-xs text-muted-foreground">{t.share(Math.round(p.share * 100))}</span>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      {t.excluded}
                      {p.reason ? ` · ${t.excludedReasons[p.reason] ?? p.reason}` : ""}
                    </span>
                  )}
                  <span className="ml-auto font-mono">{p.score === null ? "—" : fmt(p.score)}</span>
                </li>
              ))}
            </ul>
          </div>

          {general.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <h3 className="text-sm font-semibold">{t.tipsTitle}</h3>
              <ul className="flex flex-col">
                {general.map((tip) => (
                  <li key={tip.title} className="flex flex-col border-b py-2 last:border-b-0">
                    <strong className="text-sm font-semibold">{tip.title}</strong>
                    <span className="text-sm text-muted-foreground">{tip.why}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {copy && (
            <p role={copy === "failed" ? "alert" : "status"} className="text-sm">
              {copy === "failed" ? t.copyFailed : t.copied}
            </p>
          )}
          <AppliedFixes score={score} applied={applied} setApplied={setApplied} onChanged={() => load(false)} />
          <p className="text-xs text-muted-foreground">{t.note}</p>
        </div>
      )}

      {score && open && (
        <TokenScoreDetail
          score={score}
          hints={hints}
          onChanged={() => load(false)}
          onApplied={(fix) => setApplied((list) => [...list, fix])}
          onMeasureContext={() => void load(true)}
        />
      )}
    </section>
  );
}

function GroupBar({
  label,
  earned,
  max,
  none,
  fmt,
}: {
  label: string;
  earned: number;
  max: number;
  none: string;
  fmt: (n: number) => string;
}) {
  const percent = max > 0 ? Math.min(100, Math.round((earned / max) * 100)) : 0;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span>{label}</span>
        <span className="font-mono text-xs text-muted-foreground">{max > 0 ? `${fmt(earned)}/${fmt(max)}` : none}</span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-2 overflow-hidden rounded-full bg-muted"
      >
        <div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}
