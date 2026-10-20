import { useState } from "react";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import { formatScore, type HistoryEntry, levelOf } from "@/lib/token-score.ts";
import { cn } from "@/lib/utils.ts";

const text: Dict<{
  title: string;
  empty: string;
  chartLabel: (days: number) => string;
  noScore: string;
  fixes: string;
  scale: string;
  scaleChanged: string;
  scaleNote: string;
  table: string;
  day: string;
  score: string;
  version: (n: number) => string;
  apply: string;
  undo: string;
  fixNames: Record<string, string>;
}> = {
  vi: {
    title: "Điểm máy 30 ngày",
    empty: "Chưa có lịch sử điểm. Mỗi ngày tính điểm ít nhất một lần thì biểu đồ mới có cột.",
    chartLabel: (days) => `Biểu đồ cột điểm máy theo ngày, ${days} ngày có điểm`,
    noScore: "chưa có điểm",
    fixes: "Sửa nhanh",
    scale: "Thang",
    scaleChanged: "Đổi thang điểm",
    scaleNote: "Hai bên vạch đứt dùng thang điểm khác nhau nên không so trực tiếp được.",
    table: "Xem dạng bảng",
    day: "Ngày",
    score: "Điểm máy",
    version: (n) => `thang ${n}`,
    apply: "áp dụng",
    undo: "hoàn tác",
    fixNames: {
      "optimizer.balanced": "Bật mức cân bằng",
      "optimizer.rtk": "Bật RTK",
      "optimizer.aggressive": "Bật mức mạnh",
      "tool.rtk": "Cài RTK",
      "tool.codegraph": "Cài CodeGraph",
      "codegraph.mcp": "Thêm MCP CodeGraph",
      "codegraph.init": "Khởi tạo CodeGraph",
    },
  },
  en: {
    title: "Machine score, 30 days",
    empty: "No score history yet. The chart gets a column for each day the score is calculated.",
    chartLabel: (days) => `Bar chart of the machine score per day, ${days} days with a score`,
    noScore: "no score",
    fixes: "Quick fixes",
    scale: "Scale",
    scaleChanged: "Scoring scale changed",
    scaleNote: "The two sides of the dashed line use different scoring scales, so they are not directly comparable.",
    table: "Show as table",
    day: "Day",
    score: "Machine score",
    version: (n) => `scale ${n}`,
    apply: "applied",
    undo: "undone",
    fixNames: {
      "optimizer.balanced": "Turn on balanced level",
      "optimizer.rtk": "Turn on RTK",
      "optimizer.aggressive": "Turn on aggressive level",
      "tool.rtk": "Install RTK",
      "tool.codegraph": "Install CodeGraph",
      "codegraph.mcp": "Add CodeGraph MCP",
      "codegraph.init": "Initialise CodeGraph",
    },
  },
};

const DAY_MS = 86_400_000;
/** Biểu đồ rộng đúng khoảng này; ngày không có dòng lịch sử là ô trống để khoảng cách giữa các cột đúng thời gian. */
const SPAN_DAYS = 30;

const LEVEL_BAR = { good: "bg-success", fair: "bg-warning", low: "bg-destructive" } as const;

const utc = (day: string) => Date.parse(`${day}T00:00:00Z`);
const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

interface Slot {
  day: string;
  entry: HistoryEntry | null;
  /** Cột đầu tiên của một thang điểm mới: vạch đứt nằm ngay trước cột này. */
  scaleStart: boolean;
}

/** 30 ngày kết thúc ở dòng cuối; mỗi ngày một dòng (Go chỉ ghi một dòng mỗi ngày), ngày thiếu là ô trống. */
export function slots(entries: readonly HistoryEntry[]): Slot[] {
  const byDay = new Map(entries.map((e) => [e.day, e]));
  const last = entries.reduce((max, e) => (e.day > max ? e.day : max), "");
  if (!last) return [];
  const end = utc(last);
  const out: Slot[] = [];
  let previousVersion: number | null = null;
  for (let i = SPAN_DAYS - 1; i >= 0; i--) {
    const day = dayKey(end - i * DAY_MS);
    const entry = byDay.get(day) ?? null;
    // Chỉ so với dòng có thật gần nhất, để ô trống ở giữa không che mất lúc đổi thang.
    const scaleStart = entry !== null && previousVersion !== null && entry.scoreVersion !== previousVersion;
    if (entry) previousVersion = entry.scoreVersion;
    out.push({ day, entry, scaleStart });
  }
  return out;
}

/**
 * Biểu đồ cột điểm máy 30 ngày (spec 025 US4, FR-018). Cột theo mức điểm như thẻ điểm; chấm dưới cột là ngày có sửa
 * nhanh; vạch đứt là lúc đổi thang điểm, và không có đường nối qua nó. Bảng thay thế cho người dùng trình đọc màn hình,
 * và các cột đi bằng phím mũi tên.
 */
export function TokenScoreHistory({ entries }: { entries: HistoryEntry[] }) {
  const t = useT(text);
  const lang = useLang();
  const all = slots(entries);
  const withScore = entries.filter((e) => e.machine !== null).length;
  const [active, setActive] = useState<number | null>(null);
  if (all.length === 0) {
    return (
      <section aria-label={t.title} className="flex flex-col gap-1.5">
        <h3 className="text-sm font-semibold">{t.title}</h3>
        <p className="text-sm text-muted-foreground">{t.empty}</p>
      </section>
    );
  }

  const dayText = (day: string, long = false) =>
    new Date(utc(day)).toLocaleDateString(lang, { timeZone: "UTC", day: "numeric", month: long ? "long" : "numeric" });
  const fixText = (entry: HistoryEntry) =>
    (entry.fixes ?? [])
      .map((f) => `${t.fixNames[f.id] ?? f.id} (${f.action === "undo" ? t.undo : t.apply})`)
      .join(", ");
  const describe = (slot: Slot) => {
    if (!slot.entry) return `${dayText(slot.day, true)}: ${t.noScore}`;
    const score = slot.entry.machine === null ? t.noScore : formatScore(slot.entry.machine, lang);
    const fixes = fixText(slot.entry);
    return `${dayText(slot.day, true)}: ${score}${fixes ? ` · ${t.fixes}: ${fixes}` : ""}`;
  };

  const lastIndex = all.length - 1;
  // Tab vào nhóm cột rơi vào ngày đang xem, hoặc ngày mới nhất khi chưa chọn gì.
  const stop = active ?? lastIndex;
  const hasScaleChange = all.some((s) => s.scaleStart);
  const first = all[0];
  const last = all[lastIndex];

  function move(event: React.KeyboardEvent<HTMLElement>) {
    const next =
      event.key === "ArrowRight"
        ? Math.min(lastIndex, stop + 1)
        : event.key === "ArrowLeft"
          ? Math.max(0, stop - 1)
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? lastIndex
              : null;
    if (next === null) return;
    event.preventDefault();
    setActive(next);
    (event.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus();
  }

  const shown = active === null ? null : all[active];

  return (
    <section aria-label={t.title} className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">{t.title}</h3>
      <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1">
        <div
          aria-hidden="true"
          className="flex h-36 flex-col justify-between text-right text-xs text-muted-foreground tabular-nums"
        >
          <span>100</span>
          <span>50</span>
          <span>0</span>
        </div>
        <div className="relative h-36 border-b border-border">
          <span aria-hidden="true" className="absolute inset-x-0 top-0 border-t border-dashed border-border" />
          <span aria-hidden="true" className="absolute inset-x-0 top-1/2 border-t border-dashed border-border" />
          {/* Nhóm cột là một điểm dừng Tab; mũi tên đi giữa các ngày (roving tabindex). */}
          {/* biome-ignore lint/a11y/useSemanticElements: nhóm nút của biểu đồ, không phải ô nhập của form như fieldset */}
          <div role="group" aria-label={t.chartLabel(withScore)} className="absolute inset-0 flex items-end gap-[2px]">
            {all.map((slot, i) => {
              const score = slot.entry?.machine ?? null;
              return (
                <button
                  key={slot.day}
                  type="button"
                  tabIndex={i === stop ? 0 : -1}
                  aria-label={describe(slot)}
                  data-day={slot.day}
                  data-scale-start={slot.scaleStart || undefined}
                  onKeyDown={move}
                  onFocus={() => setActive(i)}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => setActive(i)}
                  className={cn(
                    "relative flex h-full min-w-px flex-1 cursor-default items-end rounded-sm border-0 bg-transparent p-0",
                    "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
                    slot.scaleStart && "ml-1 border-l border-dashed border-foreground/60",
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "block w-full rounded-t-sm",
                      score === null ? "bg-border" : LEVEL_BAR[levelOf(score)],
                      // Cột của thang cũ nhạt hơn một chút: cùng màu mức nhưng không cùng thước đo với cột mới.
                      slot.entry && hasScaleChange && slot.entry.scoreVersion !== last?.entry?.scoreVersion
                        ? "opacity-50"
                        : undefined,
                    )}
                    style={{ height: score === null ? "1px" : `max(2px, ${Math.min(100, score)}%)` }}
                  />
                  {slot.entry?.fixes?.length ? (
                    <span
                      aria-hidden="true"
                      data-marker="fix"
                      className="absolute -bottom-2.5 left-1/2 size-1.5 -translate-x-1/2 rounded-full bg-primary"
                    />
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
        <span />
        <div className="mt-2 flex justify-between text-xs text-muted-foreground tabular-nums">
          <span>{first ? dayText(first.day) : ""}</span>
          <span>{last ? dayText(last.day) : ""}</span>
        </div>
      </div>

      {/* Người dùng bàn phím và con trỏ đọc cùng một dòng; trình đọc màn hình đọc cả tên nút lẫn dòng này. */}
      <p role="status" className="min-h-5 text-sm text-muted-foreground">
        {shown ? describe(shown) : ""}
      </p>
      {hasScaleChange && (
        <p className="text-xs text-muted-foreground">
          <strong className="font-medium text-foreground">{t.scaleChanged}.</strong> {t.scaleNote}
        </p>
      )}

      <details className="text-sm">
        <summary className="w-fit cursor-pointer rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
          {t.table}
        </summary>
        <div className="mt-2 max-h-64 overflow-auto rounded-lg border border-border">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 bg-card text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="px-2 py-1.5 font-medium">
                  {t.day}
                </th>
                <th scope="col" className="px-2 py-1.5 text-right font-medium">
                  {t.score}
                </th>
                <th scope="col" className="px-2 py-1.5 font-medium">
                  {t.scale}
                </th>
                <th scope="col" className="px-2 py-1.5 font-medium">
                  {t.fixes}
                </th>
              </tr>
            </thead>
            <tbody>
              {[...all]
                .reverse()
                .filter((s) => s.entry)
                .map((s) => (
                  <tr key={s.day} className="border-t border-border">
                    <td className="px-2 py-1.5">{dayText(s.day, true)}</td>
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums">
                      {s.entry?.machine == null ? "—" : formatScore(s.entry.machine, lang)}
                    </td>
                    <td className="px-2 py-1.5 text-muted-foreground">{t.version(s.entry?.scoreVersion ?? 0)}</td>
                    <td className="px-2 py-1.5 text-muted-foreground">{s.entry ? fixText(s.entry) : ""}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
