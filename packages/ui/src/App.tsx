import { useCallback, useEffect, useMemo, useState, type ComponentType, type ReactNode } from "react";
import {
  Activity,
  Bot,
  BookMarked,
  Boxes,
  FileText,
  Laptop,
  FolderGit2,
  GitPullRequestArrow,
  KeyRound,
  LayoutDashboard,
  LayoutGrid,
  ListTodo,
  MessagesSquare,
  Server,
  ShieldCheck,
  Sparkles,
  UsersRound,
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
import type { Me } from "@xdev-hive/core";
import type { HiveClient } from "./client.ts";
import { AccountMenu, ChangePasswordScreen } from "./components/Account.tsx";
import { ErrorNote, HiveLogo } from "./components/common.tsx";
import { ScopeSwitcher } from "./components/ScopeSwitcher.tsx";
import { HiveContext, useProjectList, useQuery } from "./hooks.ts";
import { useT, type MessageKey } from "./i18n/index.tsx";
import { readScope, resolveScope, writeScope, type Scope } from "./lib/scope.ts";
import { useSystemTheme } from "./lib/theme.ts";
import { AdminPage } from "./pages/Admin.tsx";
import { AgentsPage } from "./pages/Agents.tsx";
import { BoardPage } from "./pages/Board.tsx";
import { ChatPage } from "./pages/Chat.tsx";
import { DevicePage } from "./pages/Device.tsx";
import { DocsPage } from "./pages/Docs.tsx";
import { MachinesPage } from "./pages/Machines.tsx";
import { MemoryPage } from "./pages/Memory.tsx";
import { OverviewPage } from "./pages/Overview.tsx";
import { ProjectsPage } from "./pages/Projects.tsx";
import { ProposalsPage } from "./pages/Proposals.tsx";
import { RunsPage } from "./pages/Runs.tsx";
import { SetupPage } from "./pages/Setup.tsx";
import { SkillsPage } from "./pages/Skills.tsx";
import { SystemsPage } from "./pages/Systems.tsx";
import { TasksPage } from "./pages/Tasks.tsx";
import { TokensPage } from "./pages/Tokens.tsx";
import { UsersPage } from "./pages/Users.tsx";

type PageId =
  | "overview"
  | "chat"
  | "board"
  | "runs"
  | "docs"
  | "skills"
  | "proposals"
  | "memory"
  | "tasks"
  | "agents"
  | "machines"
  | "admin"
  | "users"
  | "tokens"
  | "setup"
  | "projects"
  | "systems"
  | "device";
type Icon = ComponentType<{ className?: string }>;

const PAGES: Record<PageId, { label: MessageKey; icon: Icon; render: () => ReactNode }> = {
  overview: { label: "nav.overview", icon: LayoutGrid, render: () => <OverviewPage /> },
  chat: { label: "nav.chat", icon: MessagesSquare, render: () => <ChatPage /> },
  board: { label: "nav.board", icon: LayoutDashboard, render: () => <BoardPage /> },
  runs: { label: "nav.runs", icon: Activity, render: () => <RunsPage /> },
  docs: { label: "nav.docs", icon: FileText, render: () => <DocsPage /> },
  skills: { label: "nav.skills", icon: BookMarked, render: () => <SkillsPage /> },
  proposals: { label: "nav.proposals", icon: GitPullRequestArrow, render: () => <ProposalsPage /> },
  memory: { label: "nav.memory", icon: Sparkles, render: () => <MemoryPage /> },
  tasks: { label: "nav.tasks", icon: ListTodo, render: () => <TasksPage /> },
  agents: { label: "nav.agents", icon: Bot, render: () => <AgentsPage /> },
  machines: { label: "nav.machines", icon: Server, render: () => <MachinesPage /> },
  setup: { label: "nav.setup", icon: Wrench, render: () => <SetupPage /> },
  admin: { label: "nav.admin", icon: ShieldCheck, render: () => <AdminPage /> },
  users: { label: "nav.users", icon: UsersRound, render: () => <UsersPage /> },
  tokens: { label: "nav.tokens", icon: KeyRound, render: () => <TokensPage /> },
  projects: { label: "nav.projects", icon: FolderGit2, render: () => <ProjectsPage /> },
  systems: { label: "nav.systems", icon: Boxes, render: () => <SystemsPage /> },
  // Not in the sidebar: the desktop app opens it (#/device?port=…).
  device: { label: "nav.device", icon: Laptop, render: () => <DevicePage /> },
};

const GROUPS: Array<{ label: MessageKey; ids: PageId[] }> = [
  { label: "nav.groupWork", ids: ["overview", "chat", "board", "runs", "docs", "skills", "proposals", "memory", "tasks"] },
  { label: "nav.groupAgents", ids: ["agents", "machines", "setup"] },
  { label: "nav.groupAdmin", ids: ["admin", "users", "tokens", "systems", "projects"] },
];

function readHash(): PageId | null {
  const id = window.location.hash.replace(/^#\/?/, "").split("?")[0]!;
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
  const t = useT();
  const me = useQuery(() => client.me(), [client]);
  if (me.error) {
    return (
      <Centered>
        <ErrorNote error={me.error} />
        {onSignOut ? (
          <Button variant="outline" onClick={onSignOut}>
            {t("app.signInAgain")}
          </Button>
        ) : null}
      </Centered>
    );
  }
  if (!me.data) return <Centered>{t("app.connecting")}</Centered>;
  if (me.data.user?.mustChangePassword && client.account) {
    return <ChangePasswordScreen client={client} me={me.data} onSignOut={onSignOut} onDone={me.reload} />;
  }
  return <Shell client={client} me={me.data} onSignOut={onSignOut} />;
}

/** The signed-in app: nothing here loads until the hub accepted the session (and its password is not temporary). */
function Shell({ client, me, onSignOut }: { client: HiveClient; me: Me; onSignOut?: () => void }) {
  const t = useT();
  const home: PageId = "overview";
  const [page, setPage] = useState<PageId>(() => readHash() ?? home);
  const [tick, setTick] = useState(0);
  const bump = useCallback(() => setTick((t) => t + 1), []);
  const seen = useProjectList(client, tick);
  // A hub from before systems (roadmap 19b) has no such method: there are none then.
  const systemList = useQuery(() => client.call("systems.list", {}).catch(() => []), [client, tick]);
  const systems = useMemo(() => systemList.data ?? [], [systemList.data]);
  // Granted projects show in the switcher even before they have any data, and so do a system's.
  const projects = useMemo(
    () => [...new Set([...seen, ...Object.keys(me.access?.projects ?? {}), ...systems.flatMap((s) => s.projects)])].sort(),
    [seen, me.access, systems],
  );
  const [picked, setScopeState] = useState<Scope>(readScope);
  // A system picked in the sidebar gets its projects once the list is in.
  const scope = useMemo(() => resolveScope(picked, systemList.data), [picked, systemList.data]);
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
    const ids = new Set<PageId>(["overview", "docs", "skills", "proposals", "memory", "tasks", "systems"]);
    if (client.desktop) for (const id of ["board", "agents", "setup", "projects"] as const) ids.add(id);
    // Machines only report to a hub (and push their runs to it); a local database never has any. The leader chat
    // runs on a machine the hub hands it to.
    if (me.mode === "hub") for (const id of ["machines", "runs", "chat"] as const) ids.add(id);
    // The admin portal reads what every machine reported to the hub: hub admins only.
    const hubAdmin = me.mode === "hub" && me.role === "admin" && !me.access;
    if (hubAdmin) ids.add("admin");
    if (hubAdmin && client.users) ids.add("users");
    // Everyone with an account manages their own tokens (machines, CI); admins see all.
    if (client.tokens && (hubAdmin || me.user)) ids.add("tokens");
    if (client.device && me.user) ids.add("device");
    return ids;
  }, [client, me]);

  const current = visible.has(page) ? page : home;
  const counts: Partial<Record<PageId, number>> = {
    proposals: pending.data?.length ?? 0,
    setup: setup.data ? [...setup.data.machine, ...setup.data.projects.flatMap((p) => p.items)].filter((i) => i.state !== "installed").length : 0,
  };
  // macOS desktop: the title bar is hidden, so the header doubles as the window drag area.
  const desktop = Boolean(client.desktop);

  return (
    <HiveContext.Provider value={{ client, me: me, bump, scope, setScope, projects, systems }}>
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
                    <SidebarGroupLabel>{t(g.label)}</SidebarGroupLabel>
                    <SidebarGroupContent>
                      <SidebarMenu>
                        {ids.map((id) => {
                          const { icon: Icon } = PAGES[id];
                          const label = t(PAGES[id].label);
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
              <AccountMenu client={client} me={me} onSignOut={onSignOut} />
            </SidebarFooter>
          </Sidebar>
          <SidebarInset className="min-w-0">
            <TopBar title={t(PAGES[current].label)} desktop={desktop} />
            <main className="min-w-0 flex-1">{PAGES[current].render()}</main>
          </SidebarInset>
        </SidebarProvider>
      </TooltipProvider>
    </HiveContext.Provider>
  );
}
