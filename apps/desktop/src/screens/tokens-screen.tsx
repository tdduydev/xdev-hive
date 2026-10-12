import { LoaderCircleIcon, RefreshCwIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { FolderForm } from "@/components/folder-form.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Pill } from "@/components/ui/pill.tsx";
import { Table, TableBody, TableHeader, TableRow, Td, Th } from "@/components/ui/table.tsx";
import { useFolder } from "@/lib/folder.ts";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import { errorText } from "@/lib/tauri.ts";
import {
  type ContextReport,
  cacheRate,
  claudeContext,
  claudeUsage,
  type Engine,
  formatTokens,
  latestContext,
  sessionStats,
  type TipId,
  tips,
  usedCategories,
} from "@/lib/usage.ts";
import { cn } from "@/lib/utils.ts";

const text: Dict<{
  lead: string;
  engine: string;
  refresh: string;
  folderHint: string;
  loading: string;
  input7d: string;
  sessions: (n: number) => string;
  cacheHit: string;
  higherBetter: string;
  ctxStart: string;
  ofWindow: (window: string, model: string) => string;
  ctxLatest: string;
  codexCtxNote: string;
  plan: string;
  planWeek: (pct: number, resets: string) => string;
  codexLimit: string;
  codexWeek: (pct: number) => string;
  ctxTitle: string;
  codexCtxTitle: string;
  codexNoCategories: string;
  drivers: string;
  driverText: Record<string, string>;
  topSubagents: string;
  tipsTitle: string;
  tipsSub: string;
  noTips: string;
  tips: Record<TipId, { title: string; why: string }>;
  sessionsTitle: string;
  noSessions: string;
  when: string;
  model: string;
  folder: string;
  inputCol: string;
  outputCol: string;
  cache: string;
  ago: (minutes: number) => string;
  unknown: string;
}> = {
  vi: {
    lead: "Ngữ cảnh mỗi phiên bị chiếm bởi gì và cách giảm. Số liệu đọc từ CLI và phiên trên máy bạn, 7 ngày gần nhất.",
    engine: "CLI",
    refresh: "Đọc lại",
    folderHint: "Để trống thì tính mọi phiên trên máy; ngữ cảnh lúc mở phiên đo ở thư mục nhà.",
    loading: "Đang đọc…",
    input7d: "Token vào 7 ngày",
    sessions: (n) => `${n} phiên`,
    cacheHit: "Cache trúng",
    higherBetter: "cao là tốt",
    ctxStart: "Ngữ cảnh lúc mở phiên",
    ofWindow: (window, model) => `trên ${window} của ${model}`,
    ctxLatest: "Ngữ cảnh lượt gần nhất",
    codexCtxNote: "Codex chỉ ghi ngữ cảnh theo lượt",
    plan: "Phiên gói đã dùng",
    planWeek: (pct, resets) => `tuần: đã dùng ${pct}%${resets ? ` · làm mới ${resets}` : ""}`,
    codexLimit: "Hạn mức 5 giờ đã dùng",
    codexWeek: (pct) => `tuần: đã dùng ${pct}%`,
    ctxTitle: "Ngữ cảnh lúc mở phiên, trước khi bạn hỏi",
    codexCtxTitle: "Ngữ cảnh ở lượt gần nhất",
    codexNoCategories: "Codex không báo ngữ cảnh theo nhóm; đây là phần đã dùng ở lượt cuối của phiên mới nhất.",
    drivers: "Thứ đang tiêu hạn mức",
    driverText: {
      "of your usage was at >150k context": "hạn mức tiêu ở mức ngữ cảnh trên 150k",
      "of your usage came from subagent-heavy sessions": "đến từ phiên dùng nhiều subagent",
      "of your usage came from sessions active for 8+ hours": "từ phiên chạy liên tục 8 giờ trở lên",
    },
    topSubagents: "Subagent dùng nhiều:",
    tipsTitle: "Gợi ý tối ưu",
    tipsSub: "Rút từ số liệu ở trên",
    noTips: "Chưa thấy gì cần tối ưu trong 7 ngày qua.",
    tips: {
      compact: {
        title: "Gọn ngữ cảnh sớm hơn",
        why: "Phần lớn hạn mức tiêu khi ngữ cảnh đã trên 150k: dùng /compact giữa các việc, hoặc mở phiên mới cho việc mới.",
      },
      subagents: {
        title: "Bớt subagent cho việc nhỏ",
        why: "Phiên dùng nhiều subagent chiếm phần lớn hạn mức; việc đọc vài file thì để phiên chính làm.",
      },
      cache: {
        title: "Giữ phiên liền mạch để trúng cache",
        why: "Dưới 60% token vào đọc từ cache: tránh sửa CLAUDE.md, AGENTS.md hay đổi MCP giữa phiên.",
      },
      codexCompact: {
        title: "Dùng /compact trong Codex",
        why: "Lượt gần nhất đã dùng trên 70% cửa sổ ngữ cảnh.",
      },
    },
    sessionsTitle: "Phiên 7 ngày gần nhất",
    noSessions: "Chưa có phiên nào trong 7 ngày qua.",
    when: "Phiên",
    model: "Model",
    folder: "Thư mục",
    inputCol: "Token vào",
    outputCol: "Token ra",
    cache: "Cache",
    ago: (m) =>
      m < 60 ? `${m} phút trước` : m < 1440 ? `${Math.floor(m / 60)} giờ trước` : `${Math.floor(m / 1440)} ngày trước`,
    unknown: "—",
  },
  en: {
    lead: "What fills each session's context, and how to cut it. Figures come from the CLIs and sessions on this machine, last 7 days.",
    engine: "CLI",
    refresh: "Reload",
    folderHint: "Leave empty to count every session on this machine; context at start is measured in the home folder.",
    loading: "Reading…",
    input7d: "Input tokens, 7d",
    sessions: (n) => `${n} sessions`,
    cacheHit: "Cache hit rate",
    higherBetter: "higher is better",
    ctxStart: "Context at start",
    ofWindow: (window, model) => `of ${model}'s ${window}`,
    ctxLatest: "Context, latest turn",
    codexCtxNote: "Codex only records context per turn",
    plan: "Plan session used",
    planWeek: (pct, resets) => `week: ${pct}% used${resets ? ` · resets ${resets}` : ""}`,
    codexLimit: "5-hour limit used",
    codexWeek: (pct) => `week: ${pct}% used`,
    ctxTitle: "Context at session start, before you ask anything",
    codexCtxTitle: "Context at the latest turn",
    codexNoCategories:
      "Codex does not break context down by group; this is the share used at the last turn of the newest session.",
    drivers: "What drives your limits",
    driverText: {},
    topSubagents: "Top subagents:",
    tipsTitle: "Optimization tips",
    tipsSub: "Drawn from the figures above",
    noTips: "Nothing to optimize in the last 7 days.",
    tips: {
      compact: {
        title: "Compact context earlier",
        why: "Most of your usage happens above 150k context: use /compact between tasks, or start a new session for a new task.",
      },
      subagents: {
        title: "Use fewer subagents for small tasks",
        why: "Subagent-heavy sessions drive most of your usage; let the main session read a few files itself.",
      },
      cache: {
        title: "Keep sessions steady to hit the cache",
        why: "Under 60% of input tokens came from cache: avoid editing CLAUDE.md, AGENTS.md or changing MCP mid-session.",
      },
      codexCompact: {
        title: "Use /compact in Codex",
        why: "The latest turn used over 70% of the context window.",
      },
    },
    sessionsTitle: "Sessions in the last 7 days",
    noSessions: "No sessions in the last 7 days.",
    when: "Session",
    model: "Model",
    folder: "Folder",
    inputCol: "Input",
    outputCol: "Output",
    cache: "Cache",
    ago: (m) => (m < 60 ? `${m} min ago` : m < 1440 ? `${Math.floor(m / 60)} h ago` : `${Math.floor(m / 1440)} d ago`),
    unknown: "—",
  },
};

// Màu theo token chung (không mã màu cứng); nhóm thứ n lấy màu thứ n.
const SEGMENT_COLORS = [
  "bg-muted-foreground",
  "bg-brand-navy dark:bg-brand-sky",
  "bg-brand-blue",
  "bg-warning",
  "bg-accent-foreground",
  "bg-success",
  "bg-primary",
  "bg-destructive",
];

type Load<T> = { data: T | null; error: string | null; loading: boolean };

/** Gọi một lệnh Rust theo `key`; kết quả của lần gọi cũ bị bỏ khi đã có lần gọi mới. */
function useLoad<T>(key: string, load: () => Promise<T>): Load<T> {
  const [state, setState] = useState<Load<T>>({ data: null, error: null, loading: true });
  const latest = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` gói đủ tham số của `load`; hàm mới mỗi lần vẽ.
  useEffect(() => {
    const id = ++latest.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    load().then(
      (data) => id === latest.current && setState({ data, error: null, loading: false }),
      (e) => id === latest.current && setState({ data: null, error: errorText(e), loading: false }),
    );
  }, [key]);
  return state;
}

function Card({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-xl border bg-card text-card-foreground">
      <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
        <h2 className="text-[14.5px] font-semibold">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function LoadState({ load, children }: { load: Load<unknown>; children: ReactNode }) {
  const t = useT(text);
  if (load.error) return <p className="px-4 py-3 text-[13px] text-destructive">{load.error}</p>;
  if (load.loading && !load.data)
    return (
      <p role="status" className="flex items-center gap-2 px-4 py-3 text-[13px] text-muted-foreground">
        <LoaderCircleIcon aria-hidden="true" className="size-4 animate-spin" />
        {t.loading}
      </p>
    );
  return <>{children}</>;
}

function Tile({ label, value, note }: { label: string; value: string; note?: string | undefined }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border bg-card px-3.5 py-3 text-card-foreground">
      <span className="text-[12.5px] text-muted-foreground">{label}</span>
      <span className="font-mono text-2xl font-semibold tracking-tight">{value}</span>
      {note && <span className="text-xs text-muted-foreground">{note}</span>}
    </div>
  );
}

function ContextBar({ report }: { report: ContextReport }) {
  const lang = useLang();
  const parts = usedCategories(report);
  const total = parts.reduce((a, c) => a + c.tokens, 0) || 1;
  return (
    <div className="flex flex-col gap-3 px-4 py-3.5">
      <div className="flex h-5.5 overflow-hidden rounded-md bg-muted" aria-hidden="true">
        {parts.map((c, i) => (
          <span
            key={c.name}
            title={`${c.name} · ${formatTokens(c.tokens, lang)}`}
            className={SEGMENT_COLORS[i % SEGMENT_COLORS.length]}
            style={{ width: `${(c.tokens / total) * 100}%` }}
          />
        ))}
      </div>
      <ul className="grid grid-cols-1 gap-x-4 gap-y-2 text-[12.5px] sm:grid-cols-2 min-[1000px]:grid-cols-3">
        {parts.map((c, i) => (
          <li key={c.name} className="flex items-center gap-2">
            <span className={cn("size-2.5 shrink-0 rounded-[3px]", SEGMENT_COLORS[i % SEGMENT_COLORS.length])} />
            <span className="flex-1">{c.name}</span>
            <span className="font-mono">{formatTokens(c.tokens, lang)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Màn Token và ngữ cảnh (AppTokens.dc.html), số liệu thật từ CLI và file phiên trên máy. */
export function TokensScreen() {
  const t = useT(text);
  const lang = useLang();
  const [engine, setEngine] = useState<Engine>("claude");
  const [applied, setApplied] = useFolder();
  const [folder, setFolder] = useState(applied);
  useEffect(() => setFolder(applied), [applied]);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  const stats = useLoad(`${engine}|${applied}|${nonce}`, () => sessionStats(engine, applied));
  const context = useLoad(`ctx|${engine}|${applied}|${nonce}`, () =>
    engine === "claude" ? claudeContext(applied) : Promise.resolve(null),
  );
  const usage = useLoad(`usage|${engine}|${nonce}`, () =>
    engine === "claude" ? claudeUsage() : Promise.resolve(null),
  );

  const s = stats.data;
  const rate = s ? cacheRate(s.totals.input, s.totals.cached) : null;
  const codexCtx = s && engine === "codex" ? latestContext(s) : null;
  const tipIds = tips(engine, usage.data, s);
  const now = Date.now();
  const fmt = (n: number) => formatTokens(n, lang);
  const codexResets = (sec: string | null) =>
    sec
      ? new Date(Number(sec) * 1000).toLocaleString(lang, { weekday: "short", hour: "numeric", minute: "2-digit" })
      : "";

  return (
    <div className="flex flex-col gap-3.5">
      <header className="flex flex-wrap items-center gap-3">
        <p className="min-w-60 flex-1 text-[13px] text-muted-foreground">{t.lead}</p>
        <fieldset className="inline-flex gap-0.5 rounded-lg bg-muted p-0.5">
          <legend className="sr-only">{t.engine}</legend>
          {(["claude", "codex"] as const).map((e) => (
            <button
              key={e}
              type="button"
              aria-pressed={engine === e}
              onClick={() => setEngine(e)}
              className="h-7 cursor-pointer rounded-md px-2.5 text-[12.5px] text-muted-foreground aria-pressed:bg-card aria-pressed:font-semibold aria-pressed:text-foreground aria-pressed:shadow-sm"
            >
              {e === "claude" ? "Claude Code" : "Codex"}
            </button>
          ))}
        </fieldset>
        <Button variant="outline" size="sm" onClick={reload}>
          <RefreshCwIcon aria-hidden="true" className={cn(stats.loading && "animate-spin")} />
          {t.refresh}
        </Button>
      </header>

      <FolderForm
        value={folder}
        onChange={setFolder}
        onSubmit={(dir) => setApplied(dir.trim())}
        submitLabel={t.refresh}
        hint={t.folderHint}
        busy={stats.loading}
      />

      <section className="grid grid-cols-2 gap-3 min-[1000px]:grid-cols-4">
        <Tile
          label={t.input7d}
          value={s ? fmt(s.totals.input) : t.unknown}
          note={s ? t.sessions(s.totals.sessions) : undefined}
        />
        <Tile label={t.cacheHit} value={rate === null ? t.unknown : `${rate}%`} note={t.higherBetter} />
        {engine === "claude" ? (
          <Tile
            label={t.ctxStart}
            value={context.data?.used ? fmt(context.data.used) : t.unknown}
            note={
              context.data?.window && context.data.model
                ? t.ofWindow(fmt(context.data.window), context.data.model)
                : undefined
            }
          />
        ) : (
          <Tile
            label={t.ctxLatest}
            value={codexCtx ? `${Math.round((codexCtx.used / codexCtx.window) * 100)}%` : t.unknown}
            note={t.codexCtxNote}
          />
        )}
        {engine === "claude" ? (
          <Tile
            label={t.plan}
            value={usage.data?.session ? `${usage.data.session.percent}%` : t.unknown}
            note={usage.data?.week ? t.planWeek(usage.data.week.percent, usage.data.week.resets ?? "") : undefined}
          />
        ) : (
          <Tile
            label={t.codexLimit}
            value={s?.primary ? `${s.primary.percent}%` : t.unknown}
            note={s?.secondary ? `${t.codexWeek(s.secondary.percent)} · ${codexResets(s.secondary.resets)}` : undefined}
          />
        )}
      </section>

      {engine === "claude" ? (
        <Card
          title={t.ctxTitle}
          aside={
            context.data?.used ? (
              <span className="font-mono text-xs text-muted-foreground">{fmt(context.data.used)}</span>
            ) : null
          }
        >
          <LoadState load={context}>{context.data && <ContextBar report={context.data} />}</LoadState>
        </Card>
      ) : (
        <Card title={t.codexCtxTitle}>
          <LoadState load={stats}>
            <div className="flex flex-col gap-2 px-4 py-3.5">
              <div className="flex h-5.5 overflow-hidden rounded-md bg-muted" aria-hidden="true">
                <span
                  className="bg-primary"
                  style={{ width: `${codexCtx ? (codexCtx.used / codexCtx.window) * 100 : 0}%` }}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {codexCtx ? `${fmt(codexCtx.used)} / ${fmt(codexCtx.window)} · ` : ""}
                {t.codexNoCategories}
              </p>
            </div>
          </LoadState>
        </Card>
      )}

      {engine === "claude" && (
        <Card title={t.drivers} aside={<span className="font-mono text-xs text-muted-foreground">/usage · 7d</span>}>
          <LoadState load={usage}>
            <ul className="grid grid-cols-1 gap-x-5 gap-y-2 px-4 py-2.5 text-[13px] sm:grid-cols-2">
              {usage.data?.drivers.map((d) => (
                <li key={d.text} className="flex items-center gap-2.5">
                  <span className="w-11 text-right font-mono font-semibold">{d.percent}%</span>
                  <span className="flex-1">{t.driverText[d.text] ?? d.text}</span>
                </li>
              ))}
              {usage.data?.topSubagents && (
                <li className="text-muted-foreground sm:col-span-2">
                  {t.topSubagents} <span className="font-mono">{usage.data.topSubagents}</span>
                </li>
              )}
            </ul>
          </LoadState>
        </Card>
      )}

      <Card title={t.tipsTitle} aside={<span className="text-xs text-muted-foreground">{t.tipsSub}</span>}>
        {tipIds.length === 0 ? (
          <p className="px-4 py-3 text-[13px] text-muted-foreground">{t.noTips}</p>
        ) : (
          <ul>
            {tipIds.map((id) => (
              <li key={id} className="flex flex-col border-b px-4 py-2.5 last:border-b-0">
                <strong className="text-[13.5px] font-semibold">{t.tips[id].title}</strong>
                <span className="text-[12.5px] text-muted-foreground">{t.tips[id].why}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title={t.sessionsTitle}
        aside={s ? <span className="text-xs text-muted-foreground">{t.sessions(s.totals.sessions)}</span> : null}
      >
        <LoadState load={stats}>
          {s && s.sessions.length === 0 ? (
            <p className="px-4 py-3 text-[13px] text-muted-foreground">{t.noSessions}</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <Th>{t.when}</Th>
                    <Th>{t.folder}</Th>
                    <Th>{t.model}</Th>
                    <Th className="text-right">{t.inputCol}</Th>
                    <Th className="text-right">{t.outputCol}</Th>
                    <Th>{t.cache}</Th>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {s?.sessions.slice(0, 50).map((x) => {
                    const r = cacheRate(x.input, x.cached);
                    return (
                      <TableRow key={x.id}>
                        <Td className="whitespace-nowrap text-muted-foreground">
                          {t.ago(Math.max(0, Math.round((now - Date.parse(x.at)) / 60_000)))}
                        </Td>
                        <Td className="max-w-48 truncate font-mono text-xs" title={x.cwd}>
                          {x.cwd.split("/").filter(Boolean).at(-1) ?? x.cwd}
                        </Td>
                        <Td className="font-mono text-xs whitespace-nowrap">{x.model ?? t.unknown}</Td>
                        <Td className="text-right font-mono text-xs">{fmt(x.input)}</Td>
                        <Td className="text-right font-mono text-xs">{fmt(x.output)}</Td>
                        <Td>{r === null ? t.unknown : <Pill tone={r < 60 ? "warn" : "ok"}>{r}%</Pill>}</Td>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </LoadState>
      </Card>
    </div>
  );
}
