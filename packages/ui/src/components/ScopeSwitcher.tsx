import { Check, ChevronsUpDown, FolderGit2, Layers, Users } from "lucide-react";
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
import { ALL, projectScope, SHARED, sameScope, scopeLabel, type Scope } from "../lib/scope.ts";

const ICON = { all: Layers, shared: Users, project: FolderGit2 } as const;
const HINT = { all: "Mọi dự án và dữ liệu chung", shared: "Chỉ dữ liệu dùng cho mọi dự án", project: "Dữ liệu riêng + dữ liệu chung" } as const;

/** Picks the scope every page filters by: all projects, the team-wide data, or one project. */
export function ScopeSwitcher() {
  const { scope, setScope, projects } = useHive();
  const Icon = ICON[scope.kind];
  const item = (s: Scope, label: string, hint?: string) => {
    const I = ICON[s.kind];
    return (
      <DropdownMenuItem key={label} onSelect={() => setScope(s)} className="gap-2">
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
                <span className="truncate text-xs text-muted-foreground">{HINT[scope.kind]}</span>
              </div>
              <ChevronsUpDown className="ml-auto size-4 text-muted-foreground" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-(--radix-dropdown-menu-trigger-width) min-w-64" align="start">
            {item(ALL, "Tất cả dự án", HINT.all)}
            {item(SHARED, "Chung (cả team)", HINT.shared)}
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs text-muted-foreground">Dự án</DropdownMenuLabel>
            {projects.length === 0 ? <div className="px-2 py-1.5 text-xs text-muted-foreground">Chưa có dự án nào.</div> : null}
            {projects.map((p) => item(projectScope(p), p))}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
