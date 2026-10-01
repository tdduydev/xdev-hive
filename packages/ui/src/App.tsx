import { useCallback, useEffect, useMemo, useState, type ComponentType, type ReactNode } from "react";
import {
  Activity,
  BellRing,
  BookOpen,
  FileCode2,
  HardDrive,
  Bot,
  Boxes,
  Brain,
  DollarSign,
  FileText,
  FolderGit2,
  FolderKanban,
  Gauge,
  GitPullRequestArrow,
  Inbox,
  KeyRound,
  Laptop,
  Layers,
  LayoutDashboard,
  LayoutGrid,
  ListOrdered,
  ListTodo,
  MessageSquare,
  Package,
  ScrollText,
  Send,
  Server,
  ShieldCheck,
  SquareCheck,
  Terminal,
  UserCog,
  UsersRound,
  WandSparkles,
} from "lucide-react";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { TooltipProvider } from "@xdev-hive/ui/components/ui/tooltip";
import { may, missingRequired, type Me } from "@xdev-hive/core";
import type { HiveClient } from "./client.ts";
import { ChangePasswordScreen } from "./components/Account.tsx";
import { ErrorNote } from "./components/common.tsx";
import { HiveContext, useProjectList, useQuery, usePoll } from "./hooks.ts";
import { activeIntl, useT, type MessageKey } from "./i18n/index.tsx";
import { ALL, readScope, resolveScope, writeScope, type Scope } from "./lib/scope.ts";
import { useSystemTheme } from "./lib/theme.ts";
import { AdminShell, type AdminNavGroup } from "./shell/AdminShell.tsx";
import { ClientShell, type NavEntry, type NavGroup } from "./shell/ClientShell.tsx";
import { InboxProvider, useInboxState } from "./shell/inbox.tsx";
import { AdminPage, PolicyTab } from "./pages/Admin.tsx";
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
import { MembersPage } from "./pages/Members.tsx";
import { WebhooksTab } from "./pages/Webhooks.tsx";
import { OpsAudit, OpsCosts, OpsFleet, OpsOverview, OpsQueue, OpsQuota, OpsRuns } from "./pages/admin/Ops.tsx";
import { OpsVersions } from "./pages/admin/Versions.tsx";
import { OpsAlerts } from "./pages/admin/Alerts.tsx";
import { OpsContext, OpsHub } from "./pages/admin/HubOps.tsx";
import { DocReaderPage } from "./pages/DocReader.tsx";

type PageId =
  | "today"
  | "overview"
  | "chat"
  | "board"
  | "runs"
  | "docs"
  | "read"
  | "skills"
  | "proposals"
  | "memory"
  | "tasks"
  | "agents"
  | "machines"
  | "admin"
  | "users"
  | "members"
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
  // Not in the sidebar: a doc's reading view (#/read?doc=…), under Tài liệu.
  read: { label: "nav.read", sub: "navSub.read", icon: BookOpen, render: () => <DocReaderPage /> },
  skills: { label: "nav.skills", sub: "navSub.skills", icon: WandSparkles, render: () => <SkillsPage /> },
  proposals: { label: "nav.proposals", sub: "navSub.proposals", icon: GitPullRequestArrow, render: () => <ProposalsPage /> },
  memory: { label: "nav.memory", sub: "navSub.memory", icon: Brain, render: () => <MemoryPage /> },
  tasks: { label: "nav.tasks", sub: "navSub.tasks", icon: ListTodo, render: () => <TasksPage /> },
  agents: { label: "nav.agents", sub: "navSub.agents", icon: Bot, render: () => <AgentsPage /> },
  machines: { label: "nav.machines", sub: "navSub.machines", icon: Server, render: () => <MachinesPage /> },
  setup: { label: "nav.setup", sub: "navSub.setup", icon: Terminal, render: () => <SetupPage /> },
  admin: { label: "nav.admin", sub: "navSub.admin", icon: ShieldCheck, render: () => <AdminPage /> },
  users: { label: "nav.users", sub: "navSub.users", icon: UsersRound, render: () => <UsersPage /> },
  members: { label: "nav.members", sub: "navSub.members", icon: UserCog, render: () => <MembersPage /> },
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
  { label: "nav.groupAdmin", ids: ["admin", "machines", "users", "members", "tokens", "systems"] },
];
const SHORTCUTS: Partial<Record<PageId, string>> = { today: "1", chat: "2", board: "3", runs: "4", docs: "5", agents: "6" };
/** Not in the sidebar, still in the command palette. */
const PALETTE_ONLY: PageId[] = ["overview"];

// ── The Web Admin (hub admins on the web) ──

type AdminId = "overview" | "chat" | "runs" | "queue" | "fleet" | "quota" | "costs" | "alerts" | "review" | "docs" | "read" | "context" | "memory" | "skills" | "users" | "projects" | "policy" | "versions" | "tokens" | "webhooks" | "audit" | "hub";
type AdminGroup = "ops" | "watch" | "knowledge" | "admin";

const ADMIN: Record<AdminId, { group: AdminGroup; icon: Icon; render: () => ReactNode; fill?: boolean }> = {
  overview: { group: "ops", icon: LayoutDashboard, render: () => <OpsOverview /> },
  // The projects' leader agents (roadmap 17): a hub admin talks to them from the Web Admin too.
  chat: { group: "ops", icon: MessageSquare, render: () => <ChatPage />, fill: true },
  runs: { group: "ops", icon: Activity, render: () => <OpsRuns /> },
  queue: { group: "ops", icon: ListOrdered, render: () => <OpsQueue /> },
  fleet: { group: "watch", icon: Server, render: () => <OpsFleet /> },
  quota: { group: "watch", icon: Gauge, render: () => <OpsQuota /> },
  costs: { group: "watch", icon: DollarSign, render: () => <OpsCosts /> },
  alerts: { group: "watch", icon: BellRing, render: () => <OpsAlerts /> },
  review: { group: "knowledge", icon: SquareCheck, render: () => <ProposalsPage /> },
  docs: { group: "knowledge", icon: BookOpen, render: () => <DocsPage />, fill: true },
  read: { group: "knowledge", icon: BookOpen, render: () => <DocReaderPage />, fill: true },
  context: { group: "knowledge", icon: FileCode2, render: () => <OpsContext /> },
  memory: { group: "knowledge", icon: Brain, render: () => <MemoryPage />, fill: true },
  skills: { group: "knowledge", icon: WandSparkles, render: () => <SkillsPage />, fill: true },
  users: { group: "admin", icon: UsersRound, render: () => <UsersPage /> },
  projects: { group: "admin", icon: Layers, render: () => <SystemsPage /> },
  policy: { group: "admin", icon: ShieldCheck, render: () => <PolicyTab /> },
  versions: { group: "admin", icon: Package, render: () => <OpsVersions /> },
  tokens: { group: "admin", icon: KeyRound, render: () => <TokensPage /> },
  webhooks: { group: "admin", icon: Send, render: () => <WebhooksTab /> },
  audit: { group: "admin", icon: ScrollText, render: () => <OpsAudit /> },
  hub: { group: "admin", icon: HardDrive, render: () => <OpsHub /> },
};
const ADMIN_GROUPS: AdminGroup[] = ["ops", "watch", "knowledge", "admin"];

type Route = { kind: "client"; id: PageId } | { kind: "admin"; id: AdminId };

function readHash(): Route | null {
  const id = window.location.hash.replace(/^#\/?/, "").split("?")[0]!;
  if (id.startsWith("admin/")) {
    const a = id.slice("admin/".length);
    return a in ADMIN ? { kind: "admin", id: a as AdminId } : { kind: "admin", id: "overview" };
  }
  return id in PAGES ? { kind: "client", id: id as PageId } : null;
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
  // The admin portal reads what every machine reported to the hub: hub admins only. On the web it has its own frame.
  const hubAdmin = me.mode === "hub" && me.role === "admin" && !me.access;
  const webAdmin = hubAdmin && !client.desktop;
  const home: Route = webAdmin ? { kind: "admin", id: "overview" } : { kind: "client", id: "today" };
  const [route, setRoute] = useState<Route>(() => readHash() ?? home);
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
  const page = route.kind === "client" ? route.id : null;
  const pending = useQuery(() => client.call("proposals.list", { status: "pending" }), [client, tick, route]);
  // Checked when the app opens (and after leaving the setup page), so the sidebar shows what is missing.
  const setup = useQuery(async () => (client.desktop ? client.desktop.setupStatus() : null), [client, page === "setup"]);

  useEffect(() => {
    const onHash = () => setRoute(readHash() ?? home);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [webAdmin]);

  const visible = useMemo(() => {
    const ids = new Set<PageId>(["today", "overview", "docs", "read", "skills", "proposals", "memory", "tasks", "systems"]);
    if (client.desktop) for (const id of ["board", "agents", "setup", "projects"] as const) ids.add(id);
    // Machines only report to a hub (and push their runs to it); a local database never has any. The leader chat
    // runs on a machine the hub hands it to.
    if (me.mode === "hub") for (const id of ["machines", "runs", "chat"] as const) ids.add(id);
    // The desktop's own runs (local mode too) are on Lượt chạy.
    if (client.desktop) ids.add("runs");
    if (hubAdmin) ids.add("admin");
    if (hubAdmin && client.users) ids.add("users");
    // Thành viên (roadmap 25): a project lead sets roles in their project; hub admins have Người dùng & quyền too.
    if (me.mode === "hub" && client.members && (hubAdmin || may(me, null, "membersManage") || projects.some((p) => may(me, p, "membersManage")))) ids.add("members");
    // Everyone with an account manages their own tokens (machines, CI); admins see all.
    if (client.tokens && (hubAdmin || me.user)) ids.add("tokens");
    if (client.device && me.user) ids.add("device");
    return ids;
  }, [client, me, hubAdmin, projects]);

  const inbox = useInboxState(client, me, scope, tick);
  // The machine's name in the subtitles of Lượt chạy and Agent (desktop).
  const machine = useQuery(async () => (client.desktop ? (await client.desktop.settings()).machine : null), [client]).data;

  // What the admin sidebar counts, and the health pill: only loaded for the Web Admin.
  const inAdmin = webAdmin && route.kind === "admin";
  const poll = usePoll(inAdmin ? 30_000 : null);
  const adminRuns = useQuery(async () => (inAdmin ? client.call("runs.list", { limit: 200 }) : []), [client, inAdmin, poll]);
  const adminRequests = useQuery(async () => (inAdmin ? client.call("runs.requests", { limit: 200 }) : []), [client, inAdmin, poll]);
  const adminMachines = useQuery(async () => (inAdmin ? client.call("admin.machines", {}) : []), [client, inAdmin, poll]);
  const adminPolicy = useQuery(async () => (inAdmin ? client.call("policy.get", {}) : null), [client, inAdmin]);
  // The health pill: the hub's open alerts (roadmap 22m); a hub without them counts machines missing a required tool.
  const adminAlerts = useQuery(async () => (inAdmin && client.alerts ? client.alerts.list().catch(() => null) : null), [client, inAdmin, poll]);
  const adminMemory = useQuery(async () => (inAdmin ? client.call("memory.list", { limit: 500 }) : []), [client, inAdmin, poll, tick]);

  let frame: ReactNode;
  if (webAdmin && route.kind === "admin") {
    const lacking = adminPolicy.data ? (adminMachines.data ?? []).filter((m) => m.setup && missingRequired(adminPolicy.data!, m.setup).length > 0).length : 0;
    const openAlerts = adminAlerts.data?.open;
    const health = openAlerts ? openAlerts.length : lacking + (adminMachines.data ?? []).filter((m) => m.duplicate).length;
    const healthHigh = openAlerts ? openAlerts.filter((a) => a.severity === "high").length : undefined;
    const memoryOpen = (adminMemory.data ?? []).filter((m) => m.status === "pending" || m.conflictsWith.length || m.review).length;
    const counts: Partial<Record<AdminId, { value: number; tone?: "danger" | "accent" }>> = {
      runs: { value: (adminRuns.data ?? []).filter((r) => r.status === "running").length },
      queue: { value: (adminRequests.data ?? []).filter((r) => r.status === "pending").length },
      fleet: { value: lacking },
      review: { value: pending.data?.length ?? 0, tone: "accent" },
      memory: { value: memoryOpen },
    };
    const groups: AdminNavGroup[] = ADMIN_GROUPS.map((g) => ({
      label: t(`ops.group.${g}`),
      items: (Object.keys(ADMIN) as AdminId[])
        .filter((id) => ADMIN[id].group === g && id !== "read" && (id !== "alerts" || client.alerts) && (id !== "hub" || client.hub) && (id !== "users" || client.users) && (id !== "tokens" || client.tokens) && (id !== "webhooks" || client.webhooks) && (id !== "versions" || client.releases))
        .map((id) => ({ id: `admin/${id}`, label: t(`ops.nav.${id}`), icon: ADMIN[id].icon, count: counts[id] })),
    }));
    const a = ADMIN[route.id];
    frame = (
      <AdminShell
        client={client}
        me={me}
        onSignOut={onSignOut}
        groups={groups}
        current={`admin/${route.id === "read" ? "docs" : route.id}`}
        group={t(`ops.group.${a.group}`)}
        title={t(`ops.nav.${route.id}`)}
        hint={t(`ops.hint.${route.id}`)}
        health={health}
        healthHigh={healthHigh}
        fill={a.fill}
      >
        {a.render()}
      </AdminShell>
    );
  } else {
    const current: PageId = route.kind === "client" && visible.has(route.id) ? route.id : "today";
    const counts: Partial<Record<PageId, number>> = {
      today: inbox.items.length,
      proposals: pending.data?.length ?? 0,
      setup: setup.data ? [...setup.data.machine, ...setup.data.projects.flatMap((p) => p.items)].filter((i) => i.state !== "installed").length : 0,
    };
    const groups: NavGroup[] = GROUPS.map((g) => ({
      label: g.label ? t(g.label) : null,
      // On the web, a hub admin's admin pages are in the Web Admin: one entry leads there.
      items:
        webAdmin && g.label === "nav.groupAdmin"
          ? [{ id: "admin/overview", label: t("nav.admin"), icon: ShieldCheck }]
          : g.ids
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
    const subtitle =
      current === "today"
        ? t("inbox.subtitle", { date: today.charAt(0).toUpperCase() + today.slice(1) })
        : machine && current === "runs"
          ? t("navSub.runsOn", { machine })
          : machine && current === "agents"
            ? t("navSub.agentsOn", { machine })
            : t(PAGES[current].sub);
    frame = (
      <InboxProvider value={inbox}>
        <ClientShell
          client={client}
          me={me}
          onSignOut={onSignOut}
          groups={groups}
          extraPages={extraPages}
          current={current === "read" ? "docs" : current}
          title={t(PAGES[current].label)}
          subtitle={subtitle}
        >
          {PAGES[current].render()}
        </ClientShell>
      </InboxProvider>
    );
  }

  // The Web Admin looks at every project: its pages get the "all projects" scope, whatever the workspace picked.
  const adminScope = webAdmin && route.kind === "admin";
  return (
    <HiveContext.Provider value={{ client, me: me, bump, scope: adminScope ? ALL : scope, setScope, projects, systems }}>
      <TooltipProvider>{frame}</TooltipProvider>
    </HiveContext.Provider>
  );
}
