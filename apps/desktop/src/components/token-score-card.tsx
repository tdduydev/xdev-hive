import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Pill } from "@xdev-hive/ui/pill";
import { RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { OptimizeAllButton } from "@/components/optimize-all-button.tsx";
import { Toggle } from "@/components/toggle.tsx";
import {
  type AppliedFix,
  AppliedFixes,
  type ExtraHint,
  profileName,
  TokenScoreDetail,
} from "@/components/token-score-detail.tsx";
import { TokenScoreHistory } from "@/components/token-score-history.tsx";
import { type DriftItem, type PolicyDrift, policyDrift } from "@/lib/hub-context.ts";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import { type OptimizePolicies, optimizeAllPreview } from "@/lib/optimize-all.ts";
import { appSettings, setAppSetting } from "@/lib/settings.ts";
import { errorText, onTauriEvent } from "@/lib/tauri.ts";
import {
  announceTokenScore,
  copyReport,
  formatPoints,
  formatScore,
  groupTotals,
  type HistoryEntry,
  type Level,
  levelOf,
  needsSessionTip,
  type ScoreReportStatus,
  scoreDelta,
  setTokenScoreReport,
  TOKEN_SCORE_UPDATED,
  type TokenScore,
  tokenScore,
  tokenScoreHistory,
  tokenScoreReportStatus,
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
  sessionTip: { title: string; why: string };
  daily: string;
  dailyHint: string;
  dailyFailed: string;
  report: string;
  reportHint: string;
  reportUnregistered: string;
  reportFailed: string;
  driftTitle: string;
  driftItems: Record<DriftItem, string>;
  driftOk: string;
  policyUnread: (n: number) => string;
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
    sessionTip: {
      title: "Tách việc thành phiên ngắn, /clear giữa các việc không liên quan",
      why: "Cấu hình đã đủ điểm mà phần lớn token vẫn nằm ở phiên rất dài: ngữ cảnh cũ bị gửi lại ở mọi lượt.",
    },
    daily: "Tự tính lại điểm mỗi ngày khi mở app",
    dailyHint:
      "Chạy ngầm sau khi mở app 2 phút nếu điểm đã quá 24 giờ. Không chạy /context nên không gọi model, không tốn token.",
    dailyFailed: "Không lưu được cài đặt tự tính lại điểm.",
    report: "Gửi điểm lên hub",
    reportHint: "Chỉ gửi số điểm, không gửi đường dẫn hay tên dự án; tối đa mỗi giờ một lần.",
    reportUnregistered: "Máy chưa đăng ký với hub nên chưa gửi điểm được.",
    reportFailed: "Không lưu được cài đặt gửi điểm lên hub.",
    driftTitle: "Lệch chính sách",
    driftItems: { level: "Mức tối ưu", compact: "Trần nén ngữ cảnh", rtk: "RTK", codegraph: "Codegraph" },
    driftOk: "Máy khớp chính sách tối ưu của các dự án đã gắn.",
    policyUnread: (n) => `Chưa đọc được chính sách của ${n} dự án đã gắn nên chưa so được với dự án đó.`,
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
    sessionTip: {
      title: "Split work into short sessions, /clear between unrelated tasks",
      why: "The configuration already scores in full, yet most tokens are still in very long sessions: old context is resent on every turn.",
    },
    daily: "Recalculate the score daily when the app opens",
    dailyHint:
      "Runs in the background 2 minutes after the app opens if the score is over 24 hours old. It does not run /context, so it does not call the model or spend tokens.",
    dailyFailed: "Could not save the daily recalculation setting.",
    report: "Send the score to the hub",
    reportHint: "Sends only the score figures, never paths or project names; at most once an hour.",
    reportUnregistered: "This machine is not registered with a hub, so the score cannot be sent.",
    reportFailed: "Could not save the setting for sending the score to the hub.",
    driftTitle: "Policy drift",
    driftItems: {
      level: "Optimization level",
      compact: "Context compaction limit",
      rtk: "RTK",
      codegraph: "Codegraph",
    },
    driftOk: "This machine matches the optimization policy of the linked projects.",
    policyUnread: (n) =>
      `Could not read the policy of ${n} linked project(s), so this machine is not compared with it.`,
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
  /** Chính sách tối ưu của các dự án đã gắn (T018): làm đích của nút "Tối ưu" và để báo máy lệch ở mục nào. */
  policies?: OptimizePolicies | null;
  /** Số dự án đã gắn mà chưa đọc được chính sách. */
  policiesUnread?: number;
}

/** Thẻ đầu màn Token: điểm máy, hai nhóm, điểm từng gói và chi tiết có sửa nhanh (spec 025 US1–US3). */
export function TokenScoreCard({ hints = [], tips = [], policies = null, policiesUnread = 0 }: Props) {
  const t = useT(text);
  const lang = useLang();
  const [state, setState] = useState<State>({ score: null, error: null, loading: true });
  const [open, setOpen] = useState(false);
  const [applied, setApplied] = useState<AppliedFix[]>([]);
  const [copy, setCopy] = useState<"copied" | "failed" | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  // null: chưa đọc được cài đặt (ngoài Tauri, hay đang đọc), công tắc chưa hiện.
  const [daily, setDaily] = useState<boolean | null>(null);
  const [dailyError, setDailyError] = useState(false);
  // null: chưa đọc được (ngoài Tauri, hay worker cũ chưa có `optimize report on|off`), công tắc gửi điểm chưa hiện.
  const [report, setReport] = useState<ScoreReportStatus | null>(null);
  const [reportError, setReportError] = useState(false);
  // null: không có chính sách để so, hoặc chưa dựng được bản xem trước.
  const [drift, setDrift] = useState<PolicyDrift[] | null>(null);
  const latest = useRef(0);
  const policiesRef = useRef(policies);
  policiesRef.current = policies;
  // Cha truyền object mới mỗi lần vẽ: so theo nội dung để không dựng lại bản xem trước vô ích.
  const policiesKey = policies && Object.keys(policies).length > 0 ? JSON.stringify(policies) : "";

  const load = useCallback(async (fresh: boolean, profileId: string | null = null) => {
    const id = ++latest.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const score = await tokenScore(fresh, profileId);
      if (id === latest.current) {
        setState({ score, error: null, loading: false });
        // Lần tính vừa ghi một dòng lịch sử: huy hiệu ở menu đọc lại số này.
        announceTokenScore();
      }
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

  // Lần tính nền hằng ngày của Rust xong thì đọc lại điểm (không `--fresh`, không gọi model). Chỉ nghe sự kiện của
  // Rust, không nghe thông báo nội bộ của chính thẻ này: `load` tự thông báo nên nghe cả hai sẽ lặp vô hạn.
  useEffect(() => onTauriEvent(TOKEN_SCORE_UPDATED, () => void load(false)), [load]);

  const { score, error, loading } = state;
  const generatedAt = score?.generatedAt;

  // Lịch sử đổi khi có lần tính mới; lỗi đọc lịch sử chỉ làm biểu đồ trống, không báo lỗi lên thẻ điểm.
  // biome-ignore lint/correctness/useExhaustiveDependencies: đọc lại mỗi khi có lần tính mới (generatedAt đổi)
  useEffect(() => {
    let live = true;
    tokenScoreHistory(30).then(
      (entries) => live && setHistory(entries),
      () => live && setHistory([]),
    );
    return () => {
      live = false;
    };
  }, [generatedAt]);

  // Lệch chính sách lấy từ bản xem trước của nút "Tối ưu" (không ghi gì), và dựng lại mỗi khi điểm được tính lại.
  // biome-ignore lint/correctness/useExhaustiveDependencies: dựng lại khi chính sách đổi hay có lần tính mới (generatedAt đổi)
  useEffect(() => {
    if (!policiesKey) {
      setDrift(null);
      return;
    }
    let live = true;
    optimizeAllPreview(policiesRef.current).then(
      (plan) => live && setDrift(policyDrift(plan)),
      // Sidecar bận hay lỗi: không báo lệch thay vì báo sai.
      () => live && setDrift(null),
    );
    return () => {
      live = false;
    };
  }, [policiesKey, generatedAt]);

  useEffect(() => {
    let live = true;
    appSettings().then(
      (s) => live && setDaily(s.tokenScoreDaily),
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    let live = true;
    tokenScoreReportStatus().then(
      (s) => live && setReport(s),
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);

  async function toggleReport(next: boolean) {
    if (!report) return;
    const before = report;
    setReportError(false);
    setReport({ ...report, enabled: next });
    try {
      setReport(await setTokenScoreReport(next));
    } catch {
      setReport(before);
      setReportError(true);
    }
  }

  async function toggleDaily(next: boolean) {
    setDailyError(false);
    setDaily(next);
    try {
      const saved = await setAppSetting("tokenScoreDaily", next);
      setDaily(saved.tokenScoreDaily);
    } catch {
      setDaily(!next);
      setDailyError(true);
    }
  }

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
  // Gợi ý hành vi: phần đo được nằm ở tiêu chí, còn thói quen dùng thì không có nút sửa (T008).
  const general = [
    ...tips,
    ...(score && needsSessionTip(score) ? [t.sessionTip] : []),
    ...hints.filter(
      (h) => !score?.profiles.some((p) => p.cli === h.cli && p.criteria.some((c) => c.id === h.criterion)),
    ),
  ];

  return (
    <section aria-label={t.title} className="overflow-hidden rounded-xl border bg-card text-card-foreground">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <h2 className="min-w-40 flex-1 text-[15px] font-semibold">{t.title}</h2>
        <OptimizeAllButton policy={policies} onDone={() => void load(false)} />
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

          {(drift !== null || policiesUnread > 0) && (
            <div className="flex flex-col gap-1.5">
              {drift !== null && drift.length > 0 && (
                <section aria-label={t.driftTitle} className="rounded-lg border bg-muted/40 px-3 py-2">
                  <h3 className="text-sm font-semibold">{t.driftTitle}</h3>
                  <ul className="mt-1 flex flex-col gap-0.5 text-sm">
                    {drift.map((d) => (
                      <li key={`${d.item}|${d.reason}`} className="flex flex-wrap gap-x-2">
                        <strong className="font-medium">{t.driftItems[d.item]}</strong>
                        <span className="text-muted-foreground">{d.reason}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {drift !== null && drift.length === 0 && (
                <p role="status" className="text-sm text-muted-foreground">
                  {t.driftOk}
                </p>
              )}
              {policiesUnread > 0 && <p className="text-xs text-muted-foreground">{t.policyUnread(policiesUnread)}</p>}
            </div>
          )}

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

          <TokenScoreHistory entries={history} />

          {copy && (
            <p role={copy === "failed" ? "alert" : "status"} className="text-sm">
              {copy === "failed" ? t.copyFailed : t.copied}
            </p>
          )}
          <AppliedFixes score={score} applied={applied} setApplied={setApplied} onChanged={() => load(false)} />
          {daily !== null && (
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2 text-sm">
                <Toggle on={daily} label={t.daily} onChange={(next) => void toggleDaily(next)} />
                <span aria-hidden="true">{t.daily}</span>
              </div>
              <p className="text-xs text-muted-foreground">{t.dailyHint}</p>
              {dailyError && (
                <p role="alert" className="text-xs text-destructive">
                  {t.dailyFailed}
                </p>
              )}
            </div>
          )}
          {report && (
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2 text-sm">
                <Toggle
                  on={report.enabled}
                  label={t.report}
                  disabled={!report.registered}
                  onChange={(next) => void toggleReport(next)}
                />
                <span aria-hidden="true">{t.report}</span>
              </div>
              <p className="text-xs text-muted-foreground">{t.reportHint}</p>
              {!report.registered && <p className="text-xs text-muted-foreground">{t.reportUnregistered}</p>}
              {reportError && (
                <p role="alert" className="text-xs text-destructive">
                  {t.reportFailed}
                </p>
              )}
            </div>
          )}
          <p className="text-xs text-muted-foreground">{t.note}</p>
        </div>
      )}

      {score && open && (
        <TokenScoreDetail
          score={score}
          hints={hints}
          onChanged={() => load(false)}
          onApplied={(fix) => setApplied((list) => [...list, fix])}
          onMeasureContext={(profileId) => void load(true, profileId)}
          refreshing={loading}
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
