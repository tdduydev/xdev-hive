import { Boxes, Check, ChevronsUpDown, FolderGit2, Layers, Plus, Users } from "lucide-react";
import { cn } from "cn";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@xdev-hive/ui/components/ui/dropdown-menu";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@xdev-hive/ui/components/ui/sidebar";
import { useHive } from "../hooks.ts";
import { useT, type MessageKey } from "../i18n/index.tsx";
import { ALL, projectScope, SHARED, sameScope, scopeId, scopeLabel, systemScope, type Scope } from "../lib/scope.ts";

const ICON = { all: Layers, shared: Users, project: FolderGit2, system: Boxes } as const;
const HINT: Record<Exclude<Scope["kind"], "system">, MessageKey> = { all: "scope.allHint", shared: "scope.sharedHint", project: "scope.projectHint" };

/** Picks the scope every page filters by: all projects, the team-wide data, a system, or one project. */
export function ScopeSwitcher() {
  const { scope, setScope, projects, systems } = useHive();
  const t = useT();
  const Icon = ICON[scope.kind];
  const hint = (s: Scope) => (s.kind === "system" ? t("scope.systemHint", { count: s.projects.length }) : t(HINT[s.kind]));
  const item = (s: Scope, label: string, hint?: string) => {
    const I = ICON[s.kind];
    return (
      <DropdownMenuItem key={scopeId(s)} onSelect={() => setScope(s)} className="gap-2">
        <I className="size-4 text-muted-foreground" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate">{label}</span>
          {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
        </div>
        <Check className={cn("size-4", sameScope(scope, s) ? "opacity-100" : "opacity-0")} />
      </DropdownMenuItem>
    );
  };
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton size="lg" className="border bg-background data-[state=open]:bg-sidebar-accent" tooltip={scopeLabel(scope)}>
              <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-brand-soft text-brand-soft-foreground">
                <Icon className="size-4" />
              </div>
              <div className="grid min-w-0 flex-1 text-left leading-tight">
                <span className="truncate text-sm font-medium">{scopeLabel(scope)}</span>
                <span className="truncate text-xs text-muted-foreground">{hint(scope)}</span>
              </div>
              <ChevronsUpDown className="ml-auto size-4 text-muted-foreground" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="max-h-[70vh] w-(--radix-dropdown-menu-trigger-width) min-w-64 overflow-y-auto" align="start">
            {item(ALL, t("common.allProjects"), hint(ALL))}
            {item(SHARED, t("common.sharedTeam"), hint(SHARED))}
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs text-muted-foreground">{t("scope.systems")}</DropdownMenuLabel>
            {systems.map((s) => item(systemScope(s.name, s.projects), s.name, t("scope.systemHint", { count: s.projects.length })))}
            <DropdownMenuItem onSelect={() => (window.location.hash = "#/systems")} className="gap-2 text-muted-foreground">
              <Plus className="size-4" />
              {t(systems.length ? "scope.manageSystems" : "scope.newSystem")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs text-muted-foreground">{t("scope.projects")}</DropdownMenuLabel>
            {projects.length === 0 ? <div className="px-2 py-1.5 text-xs text-muted-foreground">{t("scope.noProjects")}</div> : null}
            {projects.map((p) => item(projectScope(p), p))}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
