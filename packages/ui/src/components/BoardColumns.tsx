// The five status columns of a board, in whatever width is left for them (roadmap 39g). Xong and Bị chặn shrink to a
// narrow rail with their count when five full columns no longer fit, so a 1100px window
// shows the whole board without scrolling sideways; a click opens one of them, a second click folds it back.
// Shared by the desktop Board and the web's Task page, which draw their own cards inside these columns.
import { useEffect, useLayoutEffect, useRef, useState, type ComponentType, type DragEvent, type ReactNode } from "react";
import { Ban, Circle, CircleCheck, GitPullRequest, LoaderCircle } from "lucide-react";
import { cn } from "cn";
import { type TaskStatus } from "@xdev-hive/core";
import { BOARD_ORDER, COLUMN_MIN, fitsEveryColumn, FOLDABLE, foldedColumns } from "#ui/lib/board.ts";
import { useT } from "#ui/i18n/index.tsx";

/** A folded column: wide enough for its icon, its count and its name read downwards. */
const RAIL_WIDTH = 40;
/** Template column width: wider than COLUMN_MIN (which only decides when to fold), so a 1440px window scrolls sideways like the design. */
const COLUMN_DESIGN = 230;

export const COLUMN_ICON: Record<TaskStatus, [ComponentType<{ className?: string }>, string]> = {
  todo: [Circle, "text-fg-muted"],
  doing: [LoaderCircle, "text-running"],
  review: [GitPullRequest, "text-warning"],
  blocked: [Ban, "text-danger"],
  done: [CircleCheck, "text-success"],
};

/** Status dot of a column header: template colours, glowing with the same colour. */
export const COLUMN_DOT: Record<TaskStatus, string> = {
  todo: "var(--text-muted)",
  doing: "var(--accent-blue)",
  review: "var(--accent-violet)",
  blocked: "var(--accent-red)",
  done: "var(--accent-green)",
};

function ColumnDot({ status }: { status: TaskStatus }) {
  return <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ background: COLUMN_DOT[status], boxShadow: `0 0 8px ${COLUMN_DOT[status]}` }} />;
}

export function BoardColumns({
  count,
  dragging,
  onDropTask,
  children,
  className,
}: {
  /** How many cards the column holds, folded or not: the rail shows this number. */
  count: (status: TaskStatus) => number;
  /** A card is on the move, so the columns take a drop. */
  dragging: boolean;
  onDropTask: (status: TaskStatus, e: DragEvent) => void;
  /** The cards of an open column; a folded one draws none. */
  children: (status: TaskStatus) => ReactNode;
  className?: string;
}) {
  const t = useT();
  // Measured on the box around the grid, never on the grid itself: an overflowing grid would report its own width
  // and keep the board wide for ever.
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [opened, setOpened] = useState<TaskStatus[]>([]);
  const [over, setOver] = useState<TaskStatus | null>(null);
  const [mobile, setMobile] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches);
  const [active, setActive] = useState<TaskStatus>("todo");
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const update = () => setMobile(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(() => setWidth(el.clientWidth));
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  // A drag that ended anywhere else (Esc, outside the window) leaves no column lit.
  useEffect(() => {
    if (!dragging) setOver(null);
  }, [dragging]);

  const folded = mobile ? new Set<TaskStatus>() : foldedColumns(width, count, new Set(opened));
  const narrow = !fitsEveryColumn(width);
  // Narrow: the open columns share what is left, so the grid can never be wider than the board.
  const columns = BOARD_ORDER.map((status) => (folded.has(status) ? `${RAIL_WIDTH}px` : narrow ? "minmax(0,1fr)" : `minmax(${COLUMN_DESIGN}px,1fr)`)).join(" ");

  return (
    <div ref={box} className={cn("min-h-full min-w-0", className)}>
      {mobile ? (
        <div role="tablist" aria-label={t("board.board")} className="mb-2 flex gap-1 overflow-x-auto pb-1">
          {BOARD_ORDER.map((status) => (
            <button key={status} type="button" role="tab" aria-selected={active === status}
              onClick={() => {
                setActive(status);
                scroller.current?.querySelector(`[data-column="${status}"]`)?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "start" });
              }}
              className={cn("min-h-10 shrink-0 rounded-md px-3 text-xs font-semibold outline-none focus-visible:focus-ring", active === status ? "bg-selected text-fg-strong" : "bg-subtle text-fg-secondary")}
            >{t(`taskStatus.${status}`)} · {count(status)}</button>
          ))}
        </div>
      ) : null}
      <div ref={scroller} className={cn("min-h-full gap-3", mobile ? "flex snap-x snap-mandatory overflow-x-auto overscroll-x-contain pb-2" : "grid items-start overflow-x-auto pb-2")}
        style={mobile ? undefined : { gridTemplateColumns: columns }} data-board-fit={mobile ? "mobile" : narrow ? "narrow" : "wide"}
        onScroll={mobile ? (e) => {
          const left = e.currentTarget.scrollLeft;
          const nearest = BOARD_ORDER.reduce((best, status) => {
            const el = e.currentTarget.querySelector<HTMLElement>(`[data-column="${status}"]`);
            const distance = Math.abs((el?.offsetLeft ?? 0) - left - e.currentTarget.offsetLeft);
            return distance < best.distance ? { status, distance } : best;
          }, { status: active, distance: Infinity });
          if (nearest.status !== active) setActive(nearest.status);
        } : undefined}>
        {BOARD_ORDER.map((status) => {
          const [Icon, iconCls] = COLUMN_ICON[status];
          const n = count(status);
          const rail = folded.has(status);
          const label = t(`taskStatus.${status}`);
          const title = t("board.column", { status: label, count: n });
          // Foldable while it would fold on its own: otherwise the reader could hide a column they cannot bring back.
          const foldable = FOLDABLE.includes(status) && narrow;
          const fold = () => setOpened((o) => (o.includes(status) ? o.filter((s) => s !== status) : [...o, status]));
          return (
            <section
              key={status}
              aria-label={label}
              data-column={status}
              data-column-rail={rail ? status : undefined}
              onDragOver={(e) => {
                if (!dragging) return;
                e.preventDefault();
                if (over !== status) setOver(status);
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver((o) => (o === status ? null : o));
              }}
              onDrop={(e) => {
                e.preventDefault();
                setOver(null);
                onDropTask(status, e);
              }}
              className={cn(
                "flex min-h-[360px] min-w-0 flex-col gap-2 rounded-[22px] bg-[var(--board-column-bg)] shadow-[var(--ring-glass)] items-stretch self-start",
                mobile && "w-[85vw] max-w-[85%] shrink-0 snap-start",
                rail ? "p-1" : "p-3",
                over === status && "shadow-[inset_0_0_0_1px_var(--border-selected)]",
              )}
            >
              {rail ? (
                <button
                  type="button"
                  onClick={fold}
                  title={title}
                  aria-label={t("board.openColumn", { status: label, count: n })}
                  className="flex flex-1 cursor-pointer flex-col items-center gap-2 rounded-sm py-1.5 outline-none hover:bg-hover focus-visible:focus-ring"
                >
                  <Icon className={cn("size-3.5 shrink-0", iconCls)} />
                  <span className="text-xs/none font-semibold text-fg-strong">{n}</span>
                  <span className="text-xs/none font-semibold text-fg-muted [writing-mode:vertical-rl]">{label}</span>
                </button>
              ) : (
                <>
                  <div className="flex min-w-0 items-center gap-2 px-1.5 pt-1 pb-2">
                    {foldable ? (
                      <button
                        type="button"
                        onClick={fold}
                        title={title}
                        aria-label={t("board.foldColumn", { status: label })}
                        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-sm outline-none hover:text-fg-strong focus-visible:focus-ring"
                      >
                        <ColumnDot status={status} />
                        <span className="flex-1 truncate text-left text-[13px]/[18px] font-semibold text-fg-strong">{label}</span>
                        <span className="text-[11px]/4 font-semibold text-fg-muted">{n}</span>
                      </button>
                    ) : (
                      <span className="flex min-w-0 flex-1 items-center gap-2" title={title}>
                        <ColumnDot status={status} />
                        <span className="flex-1 truncate text-[13px]/[18px] font-semibold text-fg-strong">{label}</span>
                        <span className="text-[11px]/4 font-semibold text-fg-muted">{n}</span>
                      </span>
                    )}
                  </div>
                  {children(status)}
                </>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
