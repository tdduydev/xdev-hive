import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Pill } from "@xdev-hive/ui/pill";
import { Table, TableBody, TableHeader, TableRow, Td, Th } from "@xdev-hive/ui/table";
import { useEffect, useRef, useState } from "react";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import {
  numericReport,
  type OptimizerLevel,
  type OptimizerProfile,
  type OptimizerReport,
  type OptimizerStatus,
  optimizerDisable,
  optimizerEnable,
  optimizerProfiles,
  optimizerReport,
  optimizerRestore,
  optimizerStatus,
  reportSources,
  rtkNumbers,
  sourceMetrics,
} from "@/lib/optimizer.ts";
import { errorText } from "@/lib/tauri.ts";
import { formatTokens } from "@/lib/usage.ts";

const text: Dict<{
  title: string;
  lead: string;
  reload: string;
  loading: string;
  profile: string;
  version: string;
  level: string;
  balanced: string;
  aggressive: string;
  enabled: string;
  disabled: string;
  unsupported: string;
  enable: string;
  disable: string;
  apply: string;
  restore: string;
  backup: string;
  original: string;
  latest: string;
  aggressiveHint: string;
  restoreWarning: string;
  confirm: string;
  cancel: string;
  default: string;
  missing: string;
  modified: string;
  unknownVersion: string;
  rtk: string;
  changed: string;
  unchanged: string;
  comparison: string;
  reportProfile: string;
  period: string;
  noCutoff: string;
  noSessions: string;
  source: string;
  before: string;
  after: string;
  current: string;
  state: string;
  phase: string;
  samples: string;
  perCall: string;
  perSession: string;
  peak: string;
  over150k: string;
  over400k: string;
  cache: string;
  insufficient: string;
  trimmed: string;
  trimmedScope: string;
  noLedger: string;
  gain: string;
  gainScope: string;
  noRTK: string;
  copy: string;
  copied: string;
  copyFailed: string;
  since: string;
  sources: Record<string, string>;
  rtkLabels: Record<string, string>;
}> = {
  vi: {
    title: "Tối ưu token",
    lead: "Áp dụng theo từng gói trên máy, không cần đăng nhập. Thư mục mặc định chỉ bật khi bạn chọn riêng.",
    reload: "Đọc lại tối ưu",
    loading: "Đang đọc…",
    profile: "Gói / CLI",
    version: "Phiên bản",
    level: "Mức",
    balanced: "Cân bằng",
    aggressive: "Mạnh",
    enabled: "Đang bật",
    disabled: "Đang tắt",
    unsupported: "Chưa hỗ trợ",
    enable: "Bật",
    disable: "Tắt",
    apply: "Áp dụng mức",
    restore: "Khôi phục",
    backup: "Bản sao lưu",
    original: "Trước lần bật đầu",
    latest: "Bản sao lưu gần nhất",
    aggressiveHint: "Claude dùng Sonnet cho subagent ở mức Mạnh.",
    restoreWarning: "Khôi phục sẽ ghi đè cấu hình bằng bản sao lưu đã chọn, kể cả thay đổi bạn đã tự sửa.",
    confirm: "Xác nhận khôi phục",
    cancel: "Huỷ",
    default: "Thư mục mặc định",
    missing: "Gói không còn trong danh sách agent",
    modified: "Cấu hình đã được sửa sau lần Hive ghi",
    unknownVersion: "Chưa có số phiên bản",
    rtk: "Dùng RTK nếu đã cài",
    changed: "Đã cập nhật cấu hình.",
    unchanged: "Cấu hình không thay đổi.",
    comparison: "Trước và sau tối ưu",
    reportProfile: "Gói báo cáo",
    period: "Phiên trong 7 ngày gần nhất, chia theo ngày bật tối ưu của gói.",
    noCutoff: "Chưa có mốc bật tối ưu. Đang hiển thị số liệu hiện tại.",
    noSessions: "Chưa có phiên nào trong phạm vi báo cáo.",
    source: "Nguồn phiên",
    before: "Trước",
    after: "Sau",
    current: "Hiện tại",
    state: "Trạng thái",
    phase: "Giai đoạn",
    samples: "Số phiên",
    perCall: "Token quy đổi / lượt",
    perSession: "Token quy đổi / phiên",
    peak: "Ngữ cảnh đỉnh (trung vị)",
    over150k: "Phiên > 150k",
    over400k: "Phiên > 400k",
    cache: "Cache trúng",
    insufficient: "Chưa đủ dữ liệu (< 5 phiên)",
    trimmed: "Ký tự hook đã cắt",
    trimmedScope: "Tổng trên máy từ mốc bật, trong phạm vi báo cáo.",
    noLedger: "Chưa có số liệu hook.",
    gain: "RTK gain",
    gainScope: "Tổng RTK trên máy; không chia trước/sau hay theo gói.",
    noRTK: "Chưa có số liệu RTK.",
    copy: "Chép báo cáo",
    copied: "Đã chép báo cáo chỉ gồm số liệu.",
    copyFailed: "Không chép được báo cáo vào clipboard.",
    since: "Mốc bật",
    sources: { interactive: "Tương tác", headless: "Chạy -p", worker: "Worker", "hub-terminal": "Terminal hub" },
    rtkLabels: {
      total_saved: "Token đã tiết kiệm",
      saved_tokens: "Token đã tiết kiệm",
      total_saved_tokens: "Token đã tiết kiệm",
      total_tokens_saved: "Token đã tiết kiệm",
      total_commands: "Số lệnh",
      total_original_tokens: "Token gốc",
      total_filtered_tokens: "Token sau lọc",
      total_input_tokens: "Token vào",
      total_output_tokens: "Token ra",
      avg_savings_pct: "Tiết kiệm trung bình (%)",
      average_savings: "Tiết kiệm trung bình",
    },
  },
  en: {
    title: "Token optimizer",
    lead: "Apply to each local profile without signing in. Default directories are enabled only when selected individually.",
    reload: "Reload optimizer",
    loading: "Reading…",
    profile: "Profile / CLI",
    version: "Version",
    level: "Level",
    balanced: "Balanced",
    aggressive: "Aggressive",
    enabled: "Enabled",
    disabled: "Disabled",
    unsupported: "Not supported",
    enable: "Enable",
    disable: "Disable",
    apply: "Apply level",
    restore: "Restore",
    backup: "Backup",
    original: "Before first enable",
    latest: "Latest backup",
    aggressiveHint: "Claude uses Sonnet for subagents at the Aggressive level.",
    restoreWarning: "Restoring overwrites configuration with the selected backup, including your own later edits.",
    confirm: "Confirm restore",
    cancel: "Cancel",
    default: "Default directory",
    missing: "Profile no longer in agent list",
    modified: "Configuration changed since Hive last wrote it",
    unknownVersion: "Version unavailable",
    rtk: "Use RTK if installed",
    changed: "Configuration updated.",
    unchanged: "Configuration unchanged.",
    comparison: "Before and after optimization",
    reportProfile: "Report profile",
    period: "Sessions in the last 7 days, split by this profile's enable date.",
    noCutoff: "No enable date yet. Showing current figures.",
    noSessions: "No sessions in this report's range.",
    source: "Session source",
    before: "Before",
    after: "After",
    current: "Current",
    state: "Status",
    phase: "Period",
    samples: "Sessions",
    perCall: "Weighted tokens / call",
    perSession: "Weighted tokens / session",
    peak: "Peak context (median)",
    over150k: "Sessions > 150k",
    over400k: "Sessions > 400k",
    cache: "Cache hit",
    insufficient: "Insufficient data (< 5 sessions)",
    trimmed: "Characters trimmed by hook",
    trimmedScope: "Machine total since enable, within the report range.",
    noLedger: "No hook figures yet.",
    gain: "RTK gain",
    gainScope: "Machine RTK total; not split by period or profile.",
    noRTK: "No RTK figures yet.",
    copy: "Copy report",
    copied: "Copied the numeric report.",
    copyFailed: "Không chép được báo cáo vào clipboard.",
    since: "Enabled on",
    rtkLabels: {
      total_saved: "Tokens saved",
      saved_tokens: "Tokens saved",
      total_saved_tokens: "Tokens saved",
      total_tokens_saved: "Tokens saved",
      total_commands: "Commands",
      total_original_tokens: "Original tokens",
      total_filtered_tokens: "Filtered tokens",
      total_input_tokens: "Input tokens",
      total_output_tokens: "Output tokens",
      avg_savings_pct: "Average savings (%)",
      average_savings: "Average savings",
    },
    sources: {
      interactive: "Interactive",
      headless: "Headless (-p)",
      worker: "Worker",
      "hub-terminal": "Hub terminal",
    },
  },
};

type Mutation = () => Promise<OptimizerStatus>;

export function OptimizerPanel() {
  const t = useT(text);
  const [status, setStatus] = useState<OptimizerStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState("");
  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState<OptimizerStatus["result"]>();
  const locked = useRef(false);
  const alive = useRef(false);
  const profiles = status ? optimizerProfiles(status) : [];
  const reportProfile =
    profiles.find((p) => p.id === selected && p.supported)?.id ?? profiles.find((p) => p.supported)?.id ?? "";

  useEffect(() => {
    let current = true;
    alive.current = true;
    optimizerStatus().then(
      (data) => {
        if (current) {
          setStatus(data);
          setLoading(false);
        }
      },
      (e) => {
        if (current) {
          setError(errorText(e));
          setLoading(false);
        }
      },
    );
    return () => {
      current = false;
      alive.current = false;
    };
  }, []);

  async function run(action: Mutation, mutation = true) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    setNotice(undefined);
    try {
      const data = await action();
      if (!alive.current) return;
      setStatus(data);
      if (mutation) setNotice(data.result);
      setRevision((n) => n + 1);
    } catch (e) {
      if (alive.current) setError(errorText(e));
    } finally {
      locked.current = false;
      if (alive.current) setBusy(false);
    }
  }

  return (
    <section aria-label={t.title} className="flex flex-col gap-3 rounded-xl border bg-card p-4">
      <header className="flex flex-wrap items-center gap-3">
        <div className="min-w-60 flex-1">
          <h2 className="text-sm font-semibold">{t.title}</h2>
          <p className="text-sm text-muted-foreground">{t.lead}</p>
        </div>
        <Button variant="outline" size="sm" disabled={loading || busy} onClick={() => void run(optimizerStatus, false)}>
          {t.reload}
        </Button>
      </header>
      {loading && (
        <p role="status" className="text-sm text-muted-foreground">
          {t.loading}
        </p>
      )}
      {error && <Alert variant="destructive">{error}</Alert>}
      {notice && (
        <div role="status" className="text-sm">
          <p>
            {notice.profile}: {notice.changed ? t.changed : t.unchanged}
          </p>
          {notice.warnings?.map((warning) => (
            <p key={`${warning.key}/${warning.kind}`} className="text-warning">
              {warning.key}: {warning.message}
            </p>
          ))}
        </div>
      )}
      {status && (
        <>
          <Table aria-label={t.title}>
            <TableHeader>
              <TableRow>
                <Th>{t.profile}</Th>
                <Th>{t.version}</Th>
                <Th>{t.level}</Th>
                <Th>{t.state}</Th>
                <Th>{t.backup}</Th>
              </TableRow>
            </TableHeader>
            <TableBody>
              {profiles.map((profile) => (
                <ProfileRow
                  key={`${profile.id}/${profile.updatedAt ?? ""}/${profile.enabled}`}
                  profile={profile}
                  busy={busy}
                  run={run}
                />
              ))}
            </TableBody>
          </Table>
          <label className="flex flex-wrap items-center gap-2 text-sm">
            {t.reportProfile}
            <select
              className="rounded-md border bg-background px-2 py-1"
              value={reportProfile}
              disabled={busy}
              onChange={(e) => setSelected(e.target.value)}
            >
              {profiles
                .filter((p) => p.supported)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label ?? p.id}
                    {p.default ? ` (${t.default})` : ""}
                  </option>
                ))}
            </select>
          </label>
          {reportProfile && <ReportSection key={`${reportProfile}/${revision}`} profile={reportProfile} />}
        </>
      )}
    </section>
  );
}

function ProfileRow({
  profile: p,
  busy,
  run,
}: {
  profile: OptimizerProfile;
  busy: boolean;
  run: (action: Mutation) => Promise<void>;
}) {
  const t = useT(text);
  const [level, setLevel] = useState<OptimizerLevel>(p.level ?? "balanced");
  const [rtk, setRTK] = useState(p.rtk ?? false);
  const [backup, setBackup] = useState("");
  const [confirm, setConfirm] = useState(false);
  const unavailable = busy || !p.supported;
  return (
    <TableRow>
      <Td>
        <div className="flex flex-col gap-1">
          <span className="font-medium">{p.label ?? p.id}</span>
          <span className="text-xs text-muted-foreground">
            {p.cli} · {p.id}
          </span>
          {p.default && <Pill small>{t.default}</Pill>}
          {!p.inAccounts && !p.default && <span className="text-xs text-warning">{t.missing}</span>}
        </div>
      </Td>
      <Td>
        <span className="text-muted-foreground">{p.version || t.unknownVersion}</span>
      </Td>
      <Td>
        <div className="flex flex-col gap-2">
          <select
            aria-label={`${t.level} ${p.id}`}
            value={level}
            disabled={unavailable}
            className="rounded-md border bg-background px-2 py-1"
            onChange={(e) => setLevel(e.target.value as OptimizerLevel)}
          >
            <option value="balanced">{t.balanced}</option>
            <option value="aggressive">{t.aggressive}</option>
          </select>
          {p.cli === "claude" && p.supported && (
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={rtk} disabled={busy} onChange={(e) => setRTK(e.target.checked)} />
              {t.rtk}
            </label>
          )}
          {p.cli === "claude" && level === "aggressive" && (
            <p className="max-w-48 whitespace-normal text-xs text-warning">{t.aggressiveHint}</p>
          )}
        </div>
      </Td>
      <Td>
        <div className="flex flex-col items-start gap-2 whitespace-normal">
          <Pill tone={!p.supported ? "neutral" : p.enabled ? "ok" : "warn"}>
            {!p.supported ? t.unsupported : p.enabled ? t.enabled : t.disabled}
          </Pill>
          {p.modified && <p className="text-xs text-warning">{t.modified}</p>}
          {p.reason && <p className="text-xs text-muted-foreground">{p.reason}</p>}
          {p.skipped?.map((skip) => (
            <p key={skip.key} className="text-xs text-warning">
              {skip.key}: {skip.reason}
            </p>
          ))}
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={unavailable}
              onClick={() => void run(() => optimizerEnable(p.id, level, p.cli === "claude" && rtk))}
            >
              {p.enabled ? t.apply : t.enable}
            </Button>
            {p.enabled && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void run(() => optimizerDisable(p.id))}
              >
                {t.disable}
              </Button>
            )}
          </div>
        </div>
      </Td>
      <Td>
        <div className="flex max-w-64 flex-col items-start gap-2 whitespace-normal">
          <select
            aria-label={`${t.backup} ${p.id}`}
            className="max-w-full rounded-md border bg-background px-2 py-1"
            value={backup}
            disabled={unavailable || !p.backups?.length}
            onChange={(e) => {
              setBackup(e.target.value);
              setConfirm(false);
            }}
          >
            <option value="">{p.enabled ? t.original : t.latest}</option>
            {p.backups?.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            variant="outline"
            disabled={unavailable || !p.backups?.length}
            onClick={() => setConfirm(true)}
          >
            {t.restore}
          </Button>
          {confirm && (
            <>
              <p className="text-xs text-warning">{t.restoreWarning}</p>
              <Button
                size="sm"
                variant="destructive"
                disabled={busy}
                onClick={() => {
                  setConfirm(false);
                  void run(() => optimizerRestore(p.id, backup || null));
                }}
              >
                {t.confirm}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirm(false)}>
                {t.cancel}
              </Button>
            </>
          )}
        </div>
      </Td>
    </TableRow>
  );
}

function ReportSection({ profile }: { profile: string }) {
  const t = useT(text);
  const lang = useLang();
  const [report, setReport] = useState<OptimizerReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"copied" | "failed" | null>(null);
  useEffect(() => {
    let current = true;
    optimizerReport(profile).then(
      (data) => {
        if (current) setReport(data);
      },
      (e) => {
        if (current) setError(errorText(e));
      },
    );
    return () => {
      current = false;
    };
  }, [profile]);
  const fmt = (n: number | null) => (n === null ? "—" : formatTokens(n, lang));
  const sources = report ? reportSources(report) : [];
  const gain = rtkNumbers(report?.rtkGain);
  async function copy() {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(numericReport(report));
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }
  return (
    <section aria-label={t.comparison} className="flex flex-col gap-3 border-t pt-3">
      <header className="flex flex-wrap items-center gap-2">
        <div className="flex-1">
          <h3 className="text-sm font-semibold">{t.comparison}</h3>
          <p className="text-xs text-muted-foreground">{t.period}</p>
        </div>
        <Button variant="outline" size="sm" disabled={!report} onClick={() => void copy()}>
          {t.copy}
        </Button>
      </header>
      {copyState && (
        <p role={copyState === "failed" ? "alert" : "status"} className="text-sm">
          {copyState === "failed" ? t.copyFailed : t.copied}
        </p>
      )}
      {error ? (
        <Alert variant="destructive">{error}</Alert>
      ) : !report ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t.loading}
        </p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            {report.split ? `${t.since}: ${new Date(report.split.cutoff).toLocaleString(lang)}` : t.noCutoff}
          </p>
          {sources.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t.noSessions}</p>
          ) : (
            <Table aria-label={t.comparison}>
              <TableHeader>
                <TableRow>
                  <Th>{t.source}</Th>
                  <Th>{t.phase}</Th>
                  <Th>{t.samples}</Th>
                  <Th>{t.perCall}</Th>
                  <Th>{t.perSession}</Th>
                  <Th>{t.peak}</Th>
                  <Th>{t.over150k}</Th>
                  <Th>{t.over400k}</Th>
                  <Th>{t.cache}</Th>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sources.flatMap((source) => {
                  const parts = report.split
                    ? ([
                        ["before", report.split.before],
                        ["after", report.split.after],
                      ] as const)
                    : ([["current", report]] as const);
                  return parts.map(([period, aggregate]) => {
                    const m = sourceMetrics(aggregate.bySource[source]);
                    const [cli, origin] = source.split("/");
                    return (
                      <TableRow key={`${source}/${period}`}>
                        <Td>
                          {cli} · {t.sources[origin ?? ""] ?? origin}
                        </Td>
                        <Td>{t[period]}</Td>
                        <Td>
                          <span>{m.sessions}</span>
                          {m.sessions < 5 && <p className="text-xs text-warning">{t.insufficient}</p>}
                        </Td>
                        <Td>{fmt(m.perCall)}</Td>
                        <Td>{fmt(m.perSession)}</Td>
                        <Td>{fmt(m.peak)}</Td>
                        <Td>{m.over150k}</Td>
                        <Td>{m.over400k}</Td>
                        <Td>
                          {m.cacheHit === null
                            ? "—"
                            : `${m.cacheHit.toLocaleString(lang, { maximumFractionDigits: 1 })}%`}
                        </Td>
                      </TableRow>
                    );
                  });
                })}
              </TableBody>
            </Table>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg bg-muted p-3">
              <h4 className="text-sm font-medium">{t.trimmed}</h4>
              <p className="text-sm">{report.trimmed ? report.trimmed.charsCut.toLocaleString(lang) : t.noLedger}</p>
              <p className="text-xs text-muted-foreground">{t.trimmedScope}</p>
            </div>
            <div className="rounded-lg bg-muted p-3">
              <h4 className="text-sm font-medium">{t.gain}</h4>
              {Object.keys(gain).length ? (
                <dl className="text-sm">
                  {Object.entries(gain).map(([key, n]) => (
                    <div key={key} className="flex flex-wrap gap-2">
                      <dt>{t.rtkLabels[key]}</dt>
                      <dd>{n.toLocaleString(lang)}</dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p className="text-sm">{t.noRTK}</p>
              )}
              <p className="text-xs text-muted-foreground">{t.gainScope}</p>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
