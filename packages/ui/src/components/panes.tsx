// The design's knowledge layout (docs/design/2026-09-redesign, xDev Hive Client: Skill, Memory): a 320px list on the
// left, the selected item on the right with a header, a body and a bar of actions.
import type { ReactNode } from "react";
import { cn } from "cn";

export type ChipKind = "danger" | "warning" | "info" | "success" | "neutral" | "running";

const CHIP: Record<ChipKind, string> = {
  danger: "bg-danger-soft text-danger",
  warning: "bg-warning-soft text-warning",
  info: "bg-info-soft text-info",
  success: "bg-success-soft text-success",
  neutral: "bg-neutral-soft text-neutral",
  running: "bg-running-soft text-running",
};

export function Chip({ kind, small, title, children }: { kind: ChipKind; small?: boolean; title?: string; children: ReactNode }) {
  return (
    <span
      title={title}
      className={cn("inline-flex shrink-0 items-center rounded-xs font-semibold whitespace-nowrap", small ? "h-[18px] px-1.5 text-[10px]/none" : "h-5 px-[7px] text-[11px]/none", CHIP[kind])}
    >
      {children}
    </span>
  );
}

/** Filter pills above a list ("Chờ duyệt 3"). */
export function FilterChips<T extends string>({ value, options, onChange }: { value: T; options: Array<{ id: T; label: string; count?: number }>; onChange: (v: T) => void }) {
  return (
    <div className="flex flex-wrap gap-1">
      {options.map((o) => {
        const on = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.id)}
            className={cn(
              "h-[22px] cursor-pointer rounded-full border px-2 text-[11px]/none font-medium outline-none focus-visible:focus-ring",
              on ? "border-line-selected bg-selected text-selected-fg" : "border-line-default bg-surface text-fg-secondary hover:text-fg-strong",
            )}
          >
            {o.label}
            {o.count !== undefined ? ` ${o.count}` : ""}
          </button>
        );
      })}
    </div>
  );
}

export function ListPane({ head, children, label, className }: { head: ReactNode; children: ReactNode; label: string; className?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-1 flex-col border-r border-line-subtle bg-subtle md:min-w-[260px] md:flex-none md:shrink md:basis-[320px]", className)}>
      <div className="flex shrink-0 flex-col gap-2 border-b border-line-subtle px-3 py-2.5">{head}</div>
      <div role="listbox" aria-label={label} className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto p-1.5">
        {children}
      </div>
    </div>
  );
}

export function ListItem({
  title,
  sub,
  meta,
  chip,
  selected,
  mono,
  dim,
  pick,
  onClick,
}: {
  title: ReactNode;
  sub?: ReactNode;
  meta?: ReactNode;
  chip?: ReactNode;
  selected: boolean;
  mono?: boolean;
  dim?: boolean;
  /** A checkbox before the title for bulk actions; its clicks and keys do not open the item. */
  pick?: ReactNode;
  onClick: () => void;
}) {
  return (
    <div
      role="option"
      tabIndex={0}
      aria-selected={selected}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      className={cn(
        "flex shrink-0 cursor-pointer flex-col gap-[3px] rounded-sm px-2.5 py-2 outline-none focus-visible:focus-ring",
        selected ? "bg-surface shadow-e1" : "hover:bg-hover",
        dim && "opacity-70",
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        {pick ? (
          <span className="flex" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
            {pick}
          </span>
        ) : null}
        <span className={cn("min-w-0 flex-1 truncate text-[13px]/[18px] font-semibold text-fg-strong", mono && "font-mono")}>{title}</span>
        {chip}
      </div>
      {sub ? <span className="line-clamp-2 text-xs/[17px] text-fg-secondary">{sub}</span> : null}
      {meta ? <span className="truncate font-mono text-[11px]/[14px] text-fg-muted">{meta}</span> : null}
    </div>
  );
}

export function DetailHeader({ chips, scope, when, title, mono }: { chips?: ReactNode; scope?: string; when?: string; title: ReactNode; mono?: boolean }) {
  return (
    <div className="flex shrink-0 flex-col gap-1.5 border-b border-line-subtle px-6 pt-4 pb-3.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {chips}
        {scope ? <span className="font-mono text-xs/none font-medium text-fg-muted">{scope}</span> : null}
        {when ? <span className="text-xs/none text-fg-muted">{when}</span> : null}
      </div>
      <h2 className={cn("m-0 text-lg/[26px] font-semibold text-pretty text-fg-strong", mono ? "font-mono [overflow-wrap:anywhere]" : "font-display")}>{title}</h2>
    </div>
  );
}

export function DetailBody({ children }: { children: ReactNode }) {
  return (
    <div tabIndex={0} className="min-h-0 flex-1 overflow-y-auto outline-none focus-visible:focus-ring">
      <div className="flex max-w-[760px] flex-col gap-3 px-6 pt-[18px] pb-6">{children}</div>
    </div>
  );
}

export function DetailFooter({ children, foot }: { children?: ReactNode; foot?: ReactNode }) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-line-subtle bg-subtle px-6 py-[11px]">
      {children}
      {foot ? <span className="ml-auto min-w-0 text-xs/4 text-fg-muted">{foot}</span> : null}
    </div>
  );
}

/**
 * A list (or the pane beside it) with nothing to show: one sentence, then the one button that fills it.
 * `action` stays out when the person may not create anything, or when a search or a filter is what hides the rows —
 * then the way out is to widen it, not to write something new.
 */
export function PaneEmpty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex shrink-0 flex-col items-center gap-2.5 px-3 py-8 text-center">
      <p className="m-0 max-w-[420px] text-xs/5 text-pretty text-fg-muted">{children}</p>
      {action}
    </div>
  );
}

/** Label / value rows (Loại, Phạm vi, Ghi bởi…). */
export function KvRows({ rows }: { rows: Array<[string, ReactNode, boolean?]> }) {
  return (
    <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px]/5">
      {rows.map(([k, v, mono]) => (
        <div key={k} className="contents">
          <span className="text-fg-muted">{k}</span>
          <span className={cn("text-fg-strong [overflow-wrap:anywhere]", mono && "font-mono text-xs/5")}>{v}</span>
        </div>
      ))}
    </div>
  );
}
