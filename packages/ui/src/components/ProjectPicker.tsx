import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Check, ChevronsUpDown, Search } from "lucide-react";
import { cn } from "cn";
import type { HiveSystem } from "@xdev-hive/core";
import { Popover, PopoverContent, PopoverTrigger } from "@xdev-hive/ui/components/ui/popover";
import { useT } from "#ui/i18n/index.tsx";
import { pickerGroups, readRecent, rememberRecent } from "#ui/lib/project-picker.ts";
import { sameScope, scopeId, type Scope } from "#ui/lib/scope.ts";

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

/** Browser-only searchable picker shared by the sidebar and project fields. */
export function ProjectPicker(props: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [recent, setRecent] = useState(readRecent);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const groups = useMemo(() => pickerGroups(props.projects, props.systems, props.mode, query, recent, props.includeShared, { all: t("common.allProjects"), shared: t("common.sharedTeam") }), [props.projects, props.systems, props.mode, props.includeShared, query, recent, t]);
  const items = groups.flatMap((group) => group.items);
  const label = (item: Scope) => item.kind === "all" ? t("common.allProjects") : item.kind === "shared" ? t("common.sharedTeam") : item.kind === "system" ? item.system : item.project;
  const selected = (item: Scope) => props.mode === "scope" ? sameScope(props.value, item) : item.kind === "shared" ? props.value === null : item.kind === "project" && item.project === props.value;
  const choose = (item: Scope) => {
    if (props.mode === "scope") props.onChange(item);
    else if (item.kind === "project" || item.kind === "shared") props.onChange(item.kind === "project" ? item.project : null);
    setRecent(rememberRecent(scopeId(item)));
    setOpen(false);
  };
  useEffect(() => { if (open) { setQuery(""); setActive(0); requestAnimationFrame(() => input.current?.focus()); } }, [open]);
  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => { list.current?.querySelector(`[data-picker-index="${active}"]`)?.scrollIntoView({ block: "nearest" }); }, [active, open]);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => items.length ? (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length : 0);
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
        {props.trigger ?? <><span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{props.mode === "scope" ? label(props.value) : props.value ?? (props.includeShared ? t("common.sharedTeam") : t("scope.selectProject"))}</span><ChevronsUpDown className="size-3.5 shrink-0 text-fg-muted" /></>}
      </button>
    </PopoverTrigger>
    <PopoverContent align="start" sideOffset={4} className="w-(--radix-popover-trigger-width) min-w-64 p-1" onOpenAutoFocus={(event) => { event.preventDefault(); input.current?.focus(); }}>
      <div className="flex items-center gap-2 border-b border-line-default px-2 py-1">
        <Search className="size-4 shrink-0 text-fg-muted" />
        <input ref={input} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={onKeyDown} aria-label={t("scope.searchProjects")} placeholder={t("scope.searchProjects")} className="h-8 min-w-0 flex-1 bg-transparent text-sm text-fg-strong outline-none placeholder:text-fg-muted" />
      </div>
      <div ref={list} role="listbox" aria-label={t("scope.selectProject")} className="max-h-[60vh] overflow-y-auto py-1">
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
