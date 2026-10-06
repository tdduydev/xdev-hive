import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Check, ChevronRight, ChevronsUpDown, Search } from "lucide-react";
import { cn } from "cn";
import type { HiveSystem } from "@xdev-hive/core";
import { Popover, PopoverContent, PopoverTrigger } from "@xdev-hive/ui/components/ui/popover";
import { useT } from "#ui/i18n/index.tsx";
import { pickerGroups, readRecent, rememberRecent, scopeRows, type ScopeRow } from "#ui/lib/project-picker.ts";
import { sameScope, scopeId, scopeTitle, systemsOfProject, type Scope } from "#ui/lib/scope.ts";

type Common = {
  projects: string[];
  systems: HiveSystem[];
  includeShared?: boolean;
  trigger?: ReactNode;
  triggerTitle?: string;
  manageSystems?: () => void;
};
type Props = Common & (
  | { mode: "scope"; value: Scope; onChange: (value: Scope) => void }
  | { mode: "project"; value: string | null; onChange: (value: string | null) => void }
);

/** Browser-only searchable picker shared by the sidebar and project fields. The sidebar's (scope) lists systems first
 *  (roadmap 40a), a repo in no system as a system of its own; a system's services show when opened or found. */
export function ProjectPicker(props: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [recent, setRecent] = useState(readRecent);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const labels = useMemo(() => ({ all: t("common.allProjects"), shared: t("common.sharedTeam") }), [t]);
  const scoped = props.mode === "scope";
  const rows = useMemo(() => scoped ? scopeRows(props.projects, props.systems, query, recent, expanded, labels) : null, [scoped, props.projects, props.systems, query, recent, expanded, labels]);
  const groups = useMemo(() => scoped ? [] : pickerGroups(props.projects, props.systems, "project", query, recent, props.includeShared, labels), [scoped, props.projects, props.systems, props.includeShared, query, recent, labels]);
  const items = rows ? rows.map((row) => row.scope) : groups.flatMap((group) => group.items);
  const label = (item: Scope) => item.kind === "all" ? labels.all : item.kind === "shared" ? labels.shared : item.kind === "system" ? item.system : item.project;
  const selected = (item: Scope) => props.mode === "scope" ? sameScope(props.value, item) : item.kind === "shared" ? props.value === null : item.kind === "project" && item.project === props.value;
  const choose = (item: Scope) => {
    if (props.mode === "scope") props.onChange(item);
    else if (item.kind === "project" || item.kind === "shared") props.onChange(item.kind === "project" ? item.project : null);
    setRecent(rememberRecent(scopeId(item)));
    setOpen(false);
  };
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    // Open on the systems of the service in scope, so it shows where it sits.
    setExpanded(new Set(props.mode === "scope" && props.value.kind === "project" ? systemsOfProject(props.value.project, props.systems).map((system) => system.name) : []));
    requestAnimationFrame(() => input.current?.focus());
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps -- only on opening, not while the lists refresh
  // While searching, start on the first row that matched by its own name rather than the system shown around it.
  useEffect(() => { setActive(query.trim() && rows ? Math.max(0, rows.findIndex((row) => row.match)) : 0); }, [query]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (name: string, open?: boolean) => setExpanded((was) => {
    const next = new Set(was);
    if (open ?? !was.has(name)) next.add(name); else next.delete(name);
    return next;
  });
  useEffect(() => { list.current?.querySelector(`[data-picker-index="${active}"]`)?.scrollIntoView({ block: "nearest" }); }, [active, open]);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => items.length ? (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length : 0);
    } else if ((event.key === "ArrowRight" || event.key === "ArrowLeft") && rows?.[active]?.root && !query.trim()) {
      // Open or close the active system; from a service, Left goes back to its system.
      const row = rows[active]!;
      if (row.root!.virtual) return;
      event.preventDefault();
      toggle(row.root!.name, event.key === "ArrowRight");
      if (event.key === "ArrowLeft" && row.depth === 1) setActive(rows.findIndex((other) => other.depth === 0 && other.root === row.root));
    } else if (event.key === "Enter" && items[active]) {
      event.preventDefault();
      choose(items[active]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    }
  };
  let index = -1;
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild>
      <button type="button" data-project-picker-trigger title={props.triggerTitle} aria-label={props.triggerTitle ?? t("scope.selectProject")} className={cn("flex h-[34px] w-full cursor-pointer items-center gap-2 rounded-md border border-line-default bg-surface px-2 text-left text-fg-strong outline-none hover:border-line-strong focus-visible:focus-ring data-[state=open]:border-line-strong")}>
        {props.trigger ?? <><span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{props.mode === "scope" ? scopeTitle(props.value, props.systems) : props.value ?? (props.includeShared ? t("common.sharedTeam") : t("scope.selectProject"))}</span><ChevronsUpDown className="size-3.5 shrink-0 text-fg-muted" /></>}
      </button>
    </PopoverTrigger>
    <PopoverContent align="start" sideOffset={4} className="w-(--radix-popover-trigger-width) min-w-64 p-1" onOpenAutoFocus={(event) => { event.preventDefault(); input.current?.focus(); }}>
      <div className="flex items-center gap-2 border-b border-line-default px-2 py-1">
        <Search className="size-4 shrink-0 text-fg-muted" />
        <input ref={input} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={onKeyDown} aria-label={t("scope.searchProjects")} placeholder={t("scope.searchProjects")} className="h-8 min-w-0 flex-1 bg-transparent text-sm text-fg-strong outline-none placeholder:text-fg-muted" />
      </div>
      <div ref={list} role="listbox" aria-label={t("scope.selectProject")} className="max-h-[60vh] overflow-y-auto py-1">
        {rows?.map((row, current) => <ScopeOption key={`${row.section}:${scopeId(row.scope)}:${current}`} row={row} heading={row.section !== rows[current - 1]?.section ? row.section : null} index={current} active={active === current} selected={selected(row.scope)} open={query.trim() ? row.depth === 1 || rows[current + 1]?.depth === 1 : expanded.has(row.root?.name ?? "")} searching={!!query.trim()} onHover={() => setActive(current)} onChoose={() => choose(row.scope)} onToggle={() => row.root && toggle(row.root.name)} />)}
        {groups.map((group, groupIndex) => <div key={`${group.kind}:${group.name ?? groupIndex}`}>
          {(group.kind === "recent" || group.kind === "system" || group.name) && <div className="px-2 pt-2 pb-1 text-xs font-semibold text-fg-muted">{group.kind === "recent" ? t("scope.recent") : group.kind === "system" ? group.name : t("scope.otherProjects")}</div>}
          {group.items.map((item, itemIndex) => {
            const current = ++index;
            const indented = group.kind === "system" && (props.mode === "project" || itemIndex > 0);
            return <button key={`${group.kind}:${group.name ?? ""}:${scopeId(item)}`} type="button" role="option" aria-selected={selected(item)} data-picker-index={current} onMouseEnter={() => setActive(current)} onClick={() => choose(item)} className={cn("flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-fg-primary outline-none hover:bg-hover", active === current && "bg-hover", indented && "pl-6", item.kind === "project" && "font-mono text-xs")}>
              <span className="w-4 shrink-0 text-fg-brand">{selected(item) && <Check className="size-4" />}</span><span className="min-w-0 flex-1 truncate">{label(item)}</span>
            </button>;
          })}
        </div>)}
        {!items.length && <div className="px-2 py-3 text-sm text-fg-muted">{query ? t("scope.noMatches") : t("scope.noProjects")}</div>}
      </div>
      {props.manageSystems && <button type="button" onClick={() => { setOpen(false); props.manageSystems?.(); }} className="w-full cursor-pointer border-t border-line-default px-2 py-2 text-left text-sm text-fg-secondary hover:bg-hover">{t(props.systems.length ? "scope.manageSystems" : "scope.newSystem")}</button>}
    </PopoverContent>
  </Popover>;
}

/** One row of the sidebar's picker: the choice itself, and next to it (not inside it) a system's open/close button. */
function ScopeOption({ row, heading, index, active, selected, open, searching, onHover, onChoose, onToggle }: { row: ScopeRow; heading: ScopeRow["section"] | null; index: number; active: boolean; selected: boolean; open: boolean; searching: boolean; onHover: () => void; onChoose: () => void; onToggle: () => void }) {
  const t = useT();
  const system = row.depth === 0 && row.root && !row.root.virtual ? row.root : null;
  return <>
    {heading === "recent" || heading === "systems" ? <div className="px-2 pt-2 pb-1 text-xs font-semibold text-fg-muted">{t(heading === "recent" ? "scope.recent" : "scope.systems")}</div> : null}
    <div className={cn("flex items-center rounded-sm hover:bg-hover", active && "bg-hover")} data-scope-row={row.root ? (row.depth === 0 ? "root" : "service") : undefined} data-scope-root={row.root?.name} data-scope-virtual={row.root?.virtual ? "" : undefined} onMouseEnter={onHover}>
      <button type="button" role="option" aria-selected={selected} data-picker-index={index} onClick={onChoose} className={cn("flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-2 py-1.5 text-left text-sm text-fg-primary outline-none", row.depth === 1 && "pl-8", row.scope.kind === "project" && "font-mono text-xs")}>
        <span className="w-4 shrink-0 text-fg-brand">{selected && <Check className="size-4" />}</span><span className="min-w-0 flex-1 truncate">{row.label}</span>
      </button>
      {system ? <button type="button" tabIndex={-1} aria-expanded={open} disabled={searching} aria-label={t(open ? "scope.collapse" : "scope.expand", { system: system.name })} title={t(open ? "scope.collapse" : "scope.expand", { system: system.name })} onClick={onToggle} data-scope-toggle={system.name} className="mr-1 flex h-6 shrink-0 cursor-pointer items-center justify-center gap-1 rounded-xs max-md:min-w-11 px-1.5 font-mono text-[11px]/none text-fg-muted hover:bg-selected hover:text-fg-strong disabled:cursor-default disabled:hover:bg-transparent">
        {system.services.length}<ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
      </button> : null}
    </div>
  </>;
}
