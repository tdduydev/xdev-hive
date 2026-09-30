import { Check, ChevronsUpDown, Plus } from "lucide-react";
import { cn } from "cn";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@xdev-hive/ui/components/ui/dropdown-menu";
import { useHive } from "../hooks.ts";
import { useT, type MessageKey } from "../i18n/index.tsx";
import { ALL, projectScope, SHARED, sameScope, scopeId, scopeLabel, systemScope, type Scope } from "../lib/scope.ts";

const HINT: Record<Exclude<Scope["kind"], "system">, MessageKey> = { all: "scope.allHint", shared: "scope.sharedHint", project: "scope.projectHint" };

/** The 22px tile in the switcher: ALL, or the first letters of the project / system / "Chung". */
const badge = (s: Scope) => (s.kind === "all" ? "ALL" : scopeLabel(s).replace(/[^\p{L}\p{N}]/gu, "").slice(0, 2).toUpperCase());

/** Picks the scope every page filters by: all projects, the team-wide data, a system, or one project. */
export function ScopeSwitcher() {
  const { scope, setScope, projects, systems } = useHive();
  const t = useT();
  const hint = (s: Scope) => (s.kind === "system" ? t("scope.systemHint", { count: s.projects.length }) : t(HINT[s.kind]));
  const item = (s: Scope, label: string, mono: boolean) => {
    const on = sameScope(scope, s);
    return (
      <DropdownMenuItem key={scopeId(s)} onSelect={() => setScope(s)} className="gap-1.5 pl-1" title={hint(s)}>
        <span className="w-4 text-center text-fg-brand">{on ? <Check className="mx-auto size-3.5 text-fg-brand" /> : null}</span>
        <span className={cn("min-w-0 flex-1 truncate", mono && "font-mono text-xs")}>{label}</span>
      </DropdownMenuItem>
    );
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={hint(scope)}
          className="flex h-[34px] w-full cursor-pointer items-center gap-2 rounded-md border border-line-default bg-surface px-2 text-left text-fg-strong outline-none hover:border-line-strong focus-visible:focus-ring data-[state=open]:border-line-strong"
        >
          <span className="grid size-[22px] shrink-0 place-items-center rounded-[5px] bg-selected font-mono text-[9px]/none font-bold text-selected-fg">
            {badge(scope)}
          </span>
          <span className={cn("min-w-0 flex-1 truncate text-[13px]/none font-semibold", scope.kind === "project" && "font-mono text-xs")}>
            {scopeLabel(scope)}
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-fg-muted" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="max-h-[70vh] w-(--radix-dropdown-menu-trigger-width) min-w-56 overflow-y-auto" align="start" sideOffset={4}>
        {item(ALL, t("common.allProjects"), false)}
        {item(SHARED, t("common.sharedTeam"), false)}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t("scope.systems")}</DropdownMenuLabel>
        {systems.map((s) => item(systemScope(s.name, s.projects), s.name, false))}
        <DropdownMenuItem onSelect={() => (window.location.hash = "#/systems")} className="gap-1.5 pl-1 text-fg-secondary">
          <span className="w-4">
            <Plus className="mx-auto size-3.5" />
          </span>
          {t(systems.length ? "scope.manageSystems" : "scope.newSystem")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t("scope.projects")}</DropdownMenuLabel>
        {projects.length === 0 ? <div className="px-2 py-1.5 text-xs text-fg-muted">{t("scope.noProjects")}</div> : null}
        {projects.map((p) => item(projectScope(p), p, true))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
