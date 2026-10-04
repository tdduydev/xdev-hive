// The five status columns of a board, in whatever width is left for them (roadmap 39g). Xong and Bị chặn shrink to a
// narrow rail with their count when they hold nothing or when five full columns no longer fit, so a 1100px window
// shows the whole board without scrolling sideways; a click opens one of them, a second click folds it back.
// Shared by the desktop Board and the web's Task page, which draw their own cards inside these columns.
import { useEffect, useLayoutEffect, useRef, useState, type ComponentType, type DragEvent, type ReactNode } from "react";
import { Ban, Circle, CircleCheck, GitPullRequest, LoaderCircle } from "lucide-react";
import { cn } from "cn";
import { TASK_STATUSES, type TaskStatus } from "@xdev-hive/core";
import { COLUMN_MIN, fitsEveryColumn, FOLDABLE, foldedColumns } from "#ui/lib/board.ts";
import { useT } from "#ui/i18n/index.tsx";

/** A folded column: wide enough for its icon, its count and its name read downwards. */
const RAIL_WIDTH = 40;

export const COLUMN_ICON: Record<TaskStatus, [ComponentType<{ className?: string }>, string]> = {
  todo: [Circle, "text-fg-muted"],
  doing: [LoaderCircle, "text-running"],
  review: [GitPullRequest, "text-warning"],
  blocked: [Ban, "text-danger"],
  done: [CircleCheck, "text-success"],
};

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

  const folded = foldedColumns(width, count, new Set(opened));
  const narrow = !fitsEveryColumn(width);
  // Narrow: the open columns share what is left, so the grid can never be wider than the board.
  const columns = TASK_STATUSES.map((status) => (folded.has(status) ? `${RAIL_WIDTH}px` : narrow ? "minmax(0,1fr)" : `minmax(${COLUMN_MIN}px,1fr)`)).join(" ");

  return (
    <div ref={box} className={cn("min-h-full", className)}>
      <div className="grid min-h-full gap-2.5" style={{ gridTemplateColumns: columns }} data-board-fit={narrow ? "narrow" : "wide"}>
        {TASK_STATUSES.map((status) => {
          const [Icon, iconCls] = COLUMN_ICON[status];
          const n = count(status);
          const rail = folded.has(status);
          const label = t(`taskStatus.${status}`);
          const title = t("board.column", { status: label, count: n });
          // Foldable while it would fold on its own: otherwise the reader could hide a column they cannot bring back.
          const foldable = FOLDABLE.includes(status) && (narrow || n === 0);
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
                "flex min-h-40 min-w-0 flex-col gap-1.5 rounded-[10px] border border-dashed",
                rail ? "p-1" : "p-2",
                over === status ? "border-line-selected bg-selected" : "border-transparent bg-subtle",
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
                  <div className="flex min-w-0 items-center gap-1.5 px-1 pt-0.5 pb-1">
                    {foldable ? (
                      <button
                        type="button"
                        onClick={fold}
                        title={title}
                        aria-label={t("board.foldColumn", { status: label })}
                        className="flex min-w-0 cursor-pointer items-center gap-1.5 rounded-sm outline-none hover:text-fg-strong focus-visible:focus-ring"
                      >
                        <Icon className={cn("size-3.5 shrink-0", iconCls)} />
                        <span className="truncate text-xs/none font-semibold text-fg-strong">{label}</span>
                        <span className="text-xs/none text-fg-muted">{n}</span>
                      </button>
                    ) : (
                      <span className="flex min-w-0 items-center gap-1.5" title={title}>
                        <Icon className={cn("size-3.5 shrink-0", iconCls)} />
                        <span className="truncate text-xs/none font-semibold text-fg-strong">{label}</span>
                        <span className="text-xs/none text-fg-muted">{n}</span>
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
