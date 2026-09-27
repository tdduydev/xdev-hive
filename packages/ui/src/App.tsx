import { useCallback, useEffect, useMemo, useState, type ComponentType, type ReactNode } from "react";
import {
  Bot,
  FileText,
  FolderGit2,
  GitPullRequestArrow,
  KeyRound,
  LayoutDashboard,
  LayoutGrid,
  ListTodo,
  LogOut,
  Server,
  ShieldCheck,
  Sparkles,
  Wrench,
} from "lucide-react";
import { Button } from "@xdev-hive/ui/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@xdev-hive/ui/components/ui/sidebar";
import { cn } from "cn";
import { TooltipProvider } from "@xdev-hive/ui/components/ui/tooltip";
import type { HiveClient } from "./client.ts";
import { Badge, ErrorNote, HiveLogo, STATUS_TONE } from "./components/common.tsx";
import { ScopeSwitcher } from "./components/ScopeSwitcher.tsx";
import { HiveContext, useProjectList, useQuery } from "./hooks.ts";
import { readScope, writeScope, type Scope } from "./lib/scope.ts";
import { useSystemTheme } from "./lib/theme.ts";
import { AdminPage } from "./pages/Admin.tsx";
import { AgentsPage } from "./pages/Agents.tsx";
import { BoardPage } from "./pages/Board.tsx";
import { DocsPage } from "./pages/Docs.tsx";
import { MachinesPage } from "./pages/Machines.tsx";
import { MemoryPage } from "./pages/Memory.tsx";
import { OverviewPage } from "./pages/Overview.tsx";
import { ProjectsPage } from "./pages/Projects.tsx";
import { ProposalsPage } from "./pages/Proposals.tsx";
import { SetupPage } from "./pages/Setup.tsx";
import { TasksPage } from "./pages/Tasks.tsx";
import { TokensPage } from "./pages/Tokens.tsx";

type PageId = "overview" | "board" | "docs" | "proposals" | "memory" | "tasks" | "agents" | "machines" | "admin" | "tokens" | "setup" | "projects";
type Icon = ComponentType<{ className?: string }>;

const PAGES: Record<PageId, { label: string; icon: Icon; render: () => ReactNode }> = {
  overview: { label: "Tổng quan", icon: LayoutGrid, render: () => <OverviewPage /> },
  board: { label: "Board", icon: LayoutDashboard, render: () => <BoardPage /> },
  docs: { label: "Tài liệu", icon: FileText, render: () => <DocsPage /> },
  proposals: { label: "Đề xuất", icon: GitPullRequestArrow, render: () => <ProposalsPage /> },
  memory: { label: "Memory", icon: Sparkles, render: () => <MemoryPage /> },
  tasks: { label: "Task", icon: ListTodo, render: () => <TasksPage /> },
  agents: { label: "Gói sub & agent", icon: Bot, render: () => <AgentsPage /> },
  machines: { label: "Máy & run", icon: Server, render: () => <MachinesPage /> },
  setup: { label: "Cài đặt máy", icon: Wrench, render: () => <SetupPage /> },
  admin: { label: "Quản trị", icon: ShieldCheck, render: () => <AdminPage /> },
  tokens: { label: "Token", icon: KeyRound, render: () => <TokensPage /> },
  projects: { label: "Dự án & cài đặt", icon: FolderGit2, render: () => <ProjectsPage /> },
};

const GROUPS: Array<{ label: string; ids: PageId[] }> = [
  { label: "Làm việc", ids: ["overview", "board", "docs", "proposals", "memory", "tasks"] },
  { label: "Agent & máy", ids: ["agents", "machines", "setup"] },
  { label: "Quản trị", ids: ["admin", "tokens", "projects"] },
];

function readHash(): PageId | null {
  const id = window.location.hash.replace(/^#\/?/, "");
  return id in PAGES ? (id as PageId) : null;
}

/** On the macOS desktop app the bar is also the window's drag area, and clears the traffic lights when the sidebar is closed. */
function TopBar({ title, desktop }: { title: string; desktop: boolean }) {
  const { state, isMobile } = useSidebar();
  const clearLights = desktop && (state === "collapsed" || isMobile);
  return (
    <header
      className={cn(
        "sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2 border-b bg-background/85 px-3 backdrop-blur",
        desktop && "[-webkit-app-region:drag]",
        clearLights && "pl-20",
      )}
    >
      <SidebarTrigger className="[-webkit-app-region:no-drag]" />
      <span className="text-sm font-medium">{title}</span>
    </header>
  );
}

/** Full-window message (connecting, or a failed sign-in). */
function Centered({ children }: { children: ReactNode }) {
  return <div className="flex min-h-svh flex-col items-center justify-center gap-4 p-6 text-sm text-muted-foreground">{children}</div>;
}

export function HiveApp({ client, onSignOut }: { client: HiveClient; onSignOut?: () => void }) {
  useSystemTheme();
  const me = useQuery(() => client.me(), [client]);
  const home: PageId = "overview";
  const [page, setPage] = useState<PageId>(() => readHash() ?? home);
  const [tick, setTick] = useState(0);
  const bump = useCallback(() => setTick((t) => t + 1), []);
  const projects = useProjectList(client, tick);
  const [scope, setScopeState] = useState<Scope>(readScope);
  const setScope = useCallback((next: Scope) => {
    writeScope(next);
    setScopeState(next);
  }, []);
  const pending = useQuery(() => client.call("proposals.list", { status: "pending" }), [client, tick, page]);
  // Checked when the app opens (and after leaving the setup page), so the sidebar shows what is missing.
  const setup = useQuery(async () => (client.desktop ? client.desktop.setupStatus() : null), [client, page === "setup"]);

  useEffect(() => {
    const onHash = () => setPage(readHash() ?? home);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [home]);

  const visible = useMemo(() => {
    const ids = new Set<PageId>(["overview", "docs", "proposals", "memory", "tasks"]);
    if (client.desktop) for (const id of ["board", "agents", "setup", "projects"] as const) ids.add(id);
    // Machines only report to a hub; a local database never has any.
    if (me.data?.mode === "hub") ids.add("machines");
    // The admin portal reads what every machine reported to the hub: hub admins only.
    if (me.data?.mode === "hub" && me.data.role === "admin") ids.add("admin");
    if (client.tokens && me.data?.role === "admin") ids.add("tokens");
    return ids;
  }, [client, me.data?.role, me.data?.mode]);

  if (me.error) {
    return (
      <Centered>
        <ErrorNote error={me.error} />
        {onSignOut ? (
          <Button variant="outline" onClick={onSignOut}>
            Đăng nhập lại
          </Button>
        ) : null}
      </Centered>
    );
  }
  if (!me.data) return <Centered>Đang kết nối…</Centered>;

  const current = visible.has(page) ? page : home;
  const counts: Partial<Record<PageId, number>> = {
    proposals: pending.data?.length ?? 0,
    setup: setup.data ? [...setup.data.machine, ...setup.data.projects.flatMap((p) => p.items)].filter((i) => i.state !== "installed").length : 0,
  };
  // macOS desktop: the title bar is hidden, so the header doubles as the window drag area.
  const desktop = Boolean(client.desktop);

  return (
    <HiveContext.Provider value={{ client, me: me.data, bump, scope, setScope, projects }}>
      <TooltipProvider>
        <SidebarProvider>
          {/* Icon-only collapse would sit under the macOS traffic lights; the desktop hides the sidebar instead. */}
          <Sidebar collapsible={desktop ? "offcanvas" : "icon"}>
            <SidebarHeader className={desktop ? "pt-10 [-webkit-app-region:drag]" : undefined}>
              <div className="flex items-center gap-2 px-2 py-1.5 font-semibold group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
                <HiveLogo className="shrink-0" />
                <span className="truncate group-data-[collapsible=icon]:hidden">xDev Hive</span>
              </div>
              <div className="[-webkit-app-region:no-drag]">
                <ScopeSwitcher />
              </div>
            </SidebarHeader>
            <SidebarContent>
              {GROUPS.map((g) => {
                const ids = g.ids.filter((id) => visible.has(id));
                if (!ids.length) return null;
                return (
                  <SidebarGroup key={g.label}>
                    <SidebarGroupLabel>{g.label}</SidebarGroupLabel>
                    <SidebarGroupContent>
                      <SidebarMenu>
                        {ids.map((id) => {
                          const { label, icon: Icon } = PAGES[id];
                          const count = counts[id] ?? 0;
                          return (
                            <SidebarMenuItem key={id}>
                              <SidebarMenuButton asChild isActive={current === id} tooltip={label}>
                                <a href={`#/${id}`} aria-current={current === id ? "page" : undefined}>
                                  <Icon />
                                  <span>{label}</span>
                                </a>
                              </SidebarMenuButton>
                              {count > 0 ? <SidebarMenuBadge className="bg-brand-soft text-brand-soft-foreground">{count}</SidebarMenuBadge> : null}
                            </SidebarMenuItem>
                          );
                        })}
                      </SidebarMenu>
                    </SidebarGroupContent>
                  </SidebarGroup>
                );
              })}
            </SidebarContent>
            <SidebarFooter>
              <div className="flex flex-col gap-1 rounded-md px-2 py-1.5 text-sm group-data-[collapsible=icon]:hidden">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-medium">{me.data.name}</span>
                  <Badge tone={STATUS_TONE[me.data.role]}>{me.data.role}</Badge>
                </div>
                <span className="text-xs text-muted-foreground">{me.data.mode === "hub" ? "Hub dùng chung" : "Cục bộ trên máy này"}</span>
              </div>
              {onSignOut ? (
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton onClick={onSignOut} tooltip="Đăng xuất">
                      <LogOut />
                      <span>Đăng xuất</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              ) : null}
            </SidebarFooter>
          </Sidebar>
          <SidebarInset className="min-w-0">
            <TopBar title={PAGES[current].label} desktop={desktop} />
            <main className="min-w-0 flex-1">{PAGES[current].render()}</main>
          </SidebarInset>
        </SidebarProvider>
      </TooltipProvider>
    </HiveContext.Provider>
  );
}
