import { useCallback, useEffect, useMemo, useState, type ComponentType, type ReactNode } from "react";
import {
  Activity,
  Bot,
  BookMarked,
  Boxes,
  Brain,
  FileText,
  FolderGit2,
  FolderKanban,
  GitPullRequestArrow,
  Inbox,
  KeyRound,
  LayoutGrid,
  Laptop,
  ListTodo,
  MessageSquare,
  Server,
  ShieldCheck,
  Terminal,
  UsersRound,
  WandSparkles,
} from "lucide-react";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { TooltipProvider } from "@xdev-hive/ui/components/ui/tooltip";
import type { Me } from "@xdev-hive/core";
import type { HiveClient } from "./client.ts";
import { ChangePasswordScreen } from "./components/Account.tsx";
import { ErrorNote } from "./components/common.tsx";
import { HiveContext, useProjectList, useQuery } from "./hooks.ts";
import { activeIntl, useT, type MessageKey } from "./i18n/index.tsx";
import { readScope, resolveScope, writeScope, type Scope } from "./lib/scope.ts";
import { useSystemTheme } from "./lib/theme.ts";
import { ClientShell, type NavEntry, type NavGroup } from "./shell/ClientShell.tsx";
import { InboxProvider, useInboxState } from "./shell/inbox.tsx";
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
import { TodayPage } from "./pages/Today.tsx";
import { TokensPage } from "./pages/Tokens.tsx";
import { UsersPage } from "./pages/Users.tsx";

type PageId =
  | "today"
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

const PAGES: Record<PageId, { label: MessageKey; sub: MessageKey; icon: Icon; render: () => ReactNode }> = {
  today: { label: "nav.today", sub: "navSub.today", icon: Inbox, render: () => <TodayPage /> },
  overview: { label: "nav.overview", sub: "navSub.overview", icon: LayoutGrid, render: () => <OverviewPage /> },
  chat: { label: "nav.chat", sub: "navSub.chat", icon: MessageSquare, render: () => <ChatPage /> },
  board: { label: "nav.board", sub: "navSub.board", icon: FolderKanban, render: () => <BoardPage /> },
  runs: { label: "nav.runs", sub: "navSub.runs", icon: Activity, render: () => <RunsPage /> },
  docs: { label: "nav.docs", sub: "navSub.docs", icon: FileText, render: () => <DocsPage /> },
  skills: { label: "nav.skills", sub: "navSub.skills", icon: WandSparkles, render: () => <SkillsPage /> },
  proposals: { label: "nav.proposals", sub: "navSub.proposals", icon: GitPullRequestArrow, render: () => <ProposalsPage /> },
  memory: { label: "nav.memory", sub: "navSub.memory", icon: Brain, render: () => <MemoryPage /> },
  tasks: { label: "nav.tasks", sub: "navSub.tasks", icon: ListTodo, render: () => <TasksPage /> },
  agents: { label: "nav.agents", sub: "navSub.agents", icon: Bot, render: () => <AgentsPage /> },
  machines: { label: "nav.machines", sub: "navSub.machines", icon: Server, render: () => <MachinesPage /> },
  setup: { label: "nav.setup", sub: "navSub.setup", icon: Terminal, render: () => <SetupPage /> },
  admin: { label: "nav.admin", sub: "navSub.admin", icon: ShieldCheck, render: () => <AdminPage /> },
  users: { label: "nav.users", sub: "navSub.users", icon: UsersRound, render: () => <UsersPage /> },
  tokens: { label: "nav.tokens", sub: "navSub.tokens", icon: KeyRound, render: () => <TokensPage /> },
  projects: { label: "nav.projects", sub: "navSub.projects", icon: FolderGit2, render: () => <ProjectsPage /> },
  systems: { label: "nav.systems", sub: "navSub.systems", icon: Boxes, render: () => <SystemsPage /> },
  // Not in the sidebar: the desktop app opens it (#/device?port=…).
  device: { label: "nav.device", sub: "navSub.device", icon: Laptop, render: () => <DevicePage /> },
};

/** The design's groups; ⌘1–6 go to Hôm nay, Chat, Board, Lượt chạy, Tài liệu, Agent (those that are shown). */
const GROUPS: Array<{ label: MessageKey | null; ids: PageId[] }> = [
  { label: null, ids: ["today", "chat"] },
  { label: "nav.groupWork", ids: ["board", "runs", "tasks"] },
  { label: "nav.groupKnowledge", ids: ["docs", "skills", "memory", "proposals"] },
  { label: "nav.groupAgents", ids: ["agents", "setup", "projects"] },
  { label: "nav.groupAdmin", ids: ["admin", "machines", "users", "tokens", "systems"] },
];
const SHORTCUTS: Partial<Record<PageId, string>> = { today: "1", chat: "2", board: "3", runs: "4", docs: "5", agents: "6" };
/** Not in the sidebar, still in the command palette. */
const PALETTE_ONLY: PageId[] = ["overview"];

function readHash(): PageId | null {
  const id = window.location.hash.replace(/^#\/?/, "").split("?")[0]!;
  return id in PAGES ? (id as PageId) : null;
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
  const home: PageId = "today";
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
    const ids = new Set<PageId>(["today", "overview", "docs", "skills", "proposals", "memory", "tasks", "systems"]);
    if (client.desktop) for (const id of ["board", "agents", "setup", "projects"] as const) ids.add(id);
    // Machines only report to a hub (and push their runs to it); a local database never has any. The leader chat
    // runs on a machine the hub hands it to.
    if (me.mode === "hub") for (const id of ["machines", "runs", "chat"] as const) ids.add(id);
    // The desktop's own runs (local mode too) are on Lượt chạy.
    if (client.desktop) ids.add("runs");
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
  // The machine's name in the subtitles of Lượt chạy and Agent (desktop).
  const machine = useQuery(async () => (client.desktop ? (await client.desktop.settings()).machine : null), [client]).data;

  const inbox = useInboxState(client, me, scope, tick);
  counts.today = inbox.items.length;

  const groups: NavGroup[] = GROUPS.map((g) => ({
    label: g.label ? t(g.label) : null,
    items: g.ids
      .filter((id) => visible.has(id))
      .map((id) => ({
        id,
        label: t(PAGES[id].label),
        icon: PAGES[id].icon,
        shortcut: SHORTCUTS[id],
        badge: counts[id] ? { count: counts[id]!, strong: id === "today" } : undefined,
      })),
  })).filter((g) => g.items.length > 0);
  const extraPages: NavEntry[] = PALETTE_ONLY.filter((id) => visible.has(id)).map((id) => ({ id, label: t(PAGES[id].label), icon: PAGES[id].icon }));
  const today = new Date().toLocaleDateString(activeIntl(), { weekday: "long", day: "numeric", month: "long" });
  const subtitle = current === "today" ? t("inbox.subtitle", { date: today.charAt(0).toUpperCase() + today.slice(1) }) :
    machine && current === "runs" ? t("navSub.runsOn", { machine }) : machine && current === "agents" ? t("navSub.agentsOn", { machine }) : t(PAGES[current].sub);

  return (
    <HiveContext.Provider value={{ client, me: me, bump, scope, setScope, projects, systems }}>
      <TooltipProvider>
        <InboxProvider value={inbox}>
          <ClientShell
            client={client}
            me={me}
            onSignOut={onSignOut}
            groups={groups}
            extraPages={extraPages}
            current={current}
            title={t(PAGES[current].label)}
            subtitle={subtitle}
          >
            {PAGES[current].render()}
          </ClientShell>
        </InboxProvider>
      </TooltipProvider>
    </HiveContext.Provider>
  );
}
