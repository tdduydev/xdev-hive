import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
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
  ListChecks,
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
  Workflow,
  Wrench,
} from "lucide-react";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { TooltipProvider } from "@xdev-hive/ui/components/ui/tooltip";
import { may, missingRequired, withSystemGrants, type Me } from "@xdev-hive/core";
import type { HiveClient } from "./client.ts";
import { ChangePasswordScreen } from "./components/Account.tsx";
import { ErrorNote } from "./components/common.tsx";
import { HiveContext, useProjectList, useQuery, usePoll } from "./hooks.ts";
import { activeIntl, useT, type MessageKey } from "./i18n/index.tsx";
import { readScope, resolveScope, writeScope, type Scope } from "./lib/scope.ts";
import { useSystemTheme } from "./lib/theme.ts";
import { ClientShell, type NavEntry, type NavGroup } from "./shell/ClientShell.tsx";
import { InboxProvider, useInboxState } from "./shell/inbox.tsx";
import { PolicyTab } from "./pages/Admin.tsx";
import { AgentsPage } from "./pages/Agents.tsx";
import { BatchesPage } from "./pages/Batches.tsx";
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
import { SpecsPage } from "./pages/Specs.tsx";
import { SystemsPage } from "./pages/Systems.tsx";
import { TasksPage } from "./pages/Tasks.tsx";
import { TodayPage } from "./pages/Today.tsx";
import { TokensPage } from "./pages/Tokens.tsx";
import { ToolsPage } from "./pages/Tools.tsx";
import { UsersPage } from "./pages/Users.tsx";
import { MembersPage } from "./pages/Members.tsx";
import { WebhooksTab } from "./pages/Webhooks.tsx";
import { OpsAudit, OpsCosts, OpsFleet, OpsQueue } from "./pages/admin/Ops.tsx";
import { OpsPage, OverviewWithRange } from "./pages/admin/frame.tsx";
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
  | "batches"
  | "docs"
  | "read"
  | "specs"
  | "skills"
  | "proposals"
  | "memory"
  | "tasks"
  | "agents"
  | "machines"
  | "ops"
  | "fleet"
  | "queue"
  | "costs"
  | "alerts"
  | "policy"
  | "context"
  | "webhooks"
  | "audit"
  | "versions"
  | "hub"
  | "users"
  | "members"
  | "tokens"
  | "setup"
  | "tools"
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
  batches: { label: "nav.batches", sub: "navSub.batches", icon: Workflow, render: () => <BatchesPage /> },
  docs: { label: "nav.docs", sub: "navSub.docs", icon: FileText, render: () => <DocsPage /> },
  // Not in the sidebar: a doc's reading view (#/read?doc=…), under Tài liệu.
  read: { label: "nav.read", sub: "navSub.read", icon: BookOpen, render: () => <DocReaderPage /> },
  specs: { label: "nav.specs", sub: "navSub.specs", icon: ListChecks, render: () => <SpecsPage /> },
  skills: { label: "nav.skills", sub: "navSub.skills", icon: WandSparkles, render: () => <SkillsPage /> },
  proposals: { label: "nav.proposals", sub: "navSub.proposals", icon: GitPullRequestArrow, render: () => <ProposalsPage /> },
  memory: { label: "nav.memory", sub: "navSub.memory", icon: Brain, render: () => <MemoryPage /> },
  tasks: { label: "nav.tasks", sub: "navSub.tasks", icon: ListTodo, render: () => <TasksPage /> },
  agents: { label: "nav.agents", sub: "navSub.agents", icon: Bot, render: () => <AgentsPage /> },
  machines: { label: "nav.machines", sub: "navSub.machines", icon: Server, render: () => <MachinesPage /> },
  setup: { label: "nav.setup", sub: "navSub.setup", icon: Terminal, render: () => <SetupPage /> },
  tools: { label: "nav.tools", sub: "navSub.tools", icon: Wrench, render: () => <ToolsPage /> },
  // Operations and administration of the hub (roadmap 35b): what the Web Admin had, in the one web shell.
  ops: { label: "ops.nav.overview", sub: "ops.hint.overview", icon: LayoutDashboard, render: () => <OverviewWithRange /> },
  fleet: { label: "ops.nav.fleet", sub: "ops.hint.fleet", icon: Gauge, render: () => <OpsPage><OpsFleet /></OpsPage> },
  queue: { label: "ops.nav.queue", sub: "ops.hint.queue", icon: ListOrdered, render: () => <OpsPage><OpsQueue /></OpsPage> },
  costs: { label: "ops.nav.costs", sub: "ops.hint.costs", icon: DollarSign, render: () => <OpsPage><OpsCosts /></OpsPage> },
  alerts: { label: "ops.nav.alerts", sub: "ops.hint.alerts", icon: BellRing, render: () => <OpsPage><OpsAlerts /></OpsPage> },
  policy: { label: "ops.nav.policy", sub: "ops.hint.policy", icon: ShieldCheck, render: () => <OpsPage><PolicyTab /></OpsPage> },
  context: { label: "ops.nav.context", sub: "ops.hint.context", icon: FileCode2, render: () => <OpsPage><OpsContext /></OpsPage> },
  webhooks: { label: "ops.nav.webhooks", sub: "ops.hint.webhooks", icon: Send, render: () => <OpsPage><WebhooksTab /></OpsPage> },
  audit: { label: "ops.nav.audit", sub: "ops.hint.audit", icon: ScrollText, render: () => <OpsPage><OpsAudit /></OpsPage> },
  versions: { label: "ops.nav.versions", sub: "ops.hint.versions", icon: Package, render: () => <OpsPage><OpsVersions /></OpsPage> },
  hub: { label: "ops.nav.hub", sub: "ops.hint.hub", icon: HardDrive, render: () => <OpsPage><OpsHub /></OpsPage> },
  users: { label: "nav.users", sub: "navSub.users", icon: UsersRound, render: () => <UsersPage /> },
  members: { label: "nav.members", sub: "navSub.members", icon: UserCog, render: () => <MembersPage /> },
  tokens: { label: "nav.tokens", sub: "navSub.tokens", icon: KeyRound, render: () => <TokensPage /> },
  projects: { label: "nav.projects", sub: "navSub.projects", icon: FolderGit2, render: () => <ProjectsPage /> },
  systems: { label: "nav.systems", sub: "navSub.systems", icon: Boxes, render: () => <SystemsPage /> },
  // Not in the sidebar: the desktop app opens it (#/device?port=…).
  device: { label: "nav.device", sub: "navSub.device", icon: Laptop, render: () => <DevicePage /> },
};

/** The desktop app in local mode: the whole system on this machine (hub-only pages drop out by visibility). */
const LOCAL_GROUPS: Array<{ label: MessageKey | null; ids: PageId[] }> = [
  { label: null, ids: ["today", "chat"] },
  { label: "nav.groupWork", ids: ["board", "runs", "batches", "tasks"] },
  { label: "nav.groupKnowledge", ids: ["docs", "specs", "skills", "memory", "proposals"] },
  { label: "nav.groupAgents", ids: ["agents", "setup", "tools", "projects"] },
  { label: "nav.groupAdmin", ids: ["machines", "users", "members", "tokens", "systems"] },
];
/**
 * The web (roadmap 35b): one shell for everyone, each group showing what the person may use. Work and knowledge for
 * every member; operations and administration for those who run projects or the hub.
 */
const WEB_GROUPS: Array<{ label: MessageKey | null; ids: PageId[] }> = [
  { label: null, ids: ["today", "chat"] },
  { label: "nav.groupWork", ids: ["tasks", "specs", "batches", "runs"] },
  { label: "nav.groupKnowledge", ids: ["docs", "skills", "memory", "proposals"] },
  { label: "ops.group.ops", ids: ["ops", "machines", "fleet", "queue", "costs", "alerts"] },
  { label: "nav.groupAdmin", ids: ["systems", "members", "users", "policy", "tools", "context", "tokens", "webhooks", "audit", "versions", "hub"] },
];
/** ⌘1–6 go to Hôm nay, Chat, Board, Lượt chạy, Tài liệu, Agent (those that are shown). */
const SHORTCUTS: Partial<Record<PageId, string>> = { today: "1", chat: "2", board: "3", runs: "4", docs: "5", agents: "6" };

/**
 * The desktop app connected to a hub (roadmap 35a): this machine's work only. Tasks, docs, policies, members and the
 * rest are the web's; links to them open the hub in the browser. In local mode the app is the whole system and keeps
 * every page.
 */
const DESK_PAGES = new Set<PageId>(["today", "runs", "agents", "setup", "projects", "device"]);
const DESK_GROUPS: Array<{ label: MessageKey | null; ids: PageId[] }> = [
  { label: null, ids: ["today", "runs"] },
  { label: "nav.groupAgents", ids: ["agents", "setup", "projects"] },
];
/** What the machine's Hôm nay shows: its runs' CI, its own setup, install requests for it. */
const DESK_INBOX = new Set(["ci", "machine", "request"]);
/** Not in the sidebar, still in the command palette. */
const PALETTE_ONLY: PageId[] = ["overview"];

type Route = { kind: "client"; id: PageId };
const HOME: Route = { kind: "client", id: "today" };

/** The Web Admin's addresses before roadmap 35b (alerts, webhooks and old links still use them): its page here. */
const ADMIN_ALIASES: Record<string, PageId> = {
  "": "ops",
  overview: "ops",
  chat: "chat",
  runs: "runs",
  queue: "queue",
  batches: "batches",
  fleet: "fleet",
  quota: "machines",
  costs: "costs",
  alerts: "alerts",
  review: "proposals",
  docs: "docs",
  read: "read",
  specs: "specs",
  context: "context",
  memory: "memory",
  skills: "skills",
  users: "users",
  projects: "systems",
  policy: "policy",
  tools: "tools",
  versions: "versions",
  tokens: "tokens",
  webhooks: "webhooks",
  audit: "audit",
  hub: "hub",
};

function readHash(): Route | null {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const id = raw.split("?")[0]!;
  // #/admin, #/admin/<page>?…: the page's own address now, with the same query.
  if (id === "admin" || id.startsWith("admin/")) {
    const page = ADMIN_ALIASES[id.slice("admin/".length)] ?? "ops";
    const query = raw.includes("?") ? raw.slice(raw.indexOf("?")) : "";
    window.history.replaceState(null, "", `#/${page}${query}`);
    return { kind: "client", id: page };
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
  // Operations and administration read what every machine reported to the hub: hub admins only, on the web.
  const hubAdmin = me.mode === "hub" && me.role === "admin" && !me.access;
  const webAdmin = hubAdmin && !client.desktop;
  const [route, setRoute] = useState<Route>(() => readHash() ?? HOME);
  const [tick, setTick] = useState(0);
  const bump = useCallback(() => setTick((t) => t + 1), []);
  const seen = useProjectList(client, tick);
  // A hub from before systems (roadmap 19b) has no such method: there are none then.
  const systemList = useQuery(() => client.call("systems.list", {}).catch(() => []), [client, tick]);
  const systems = useMemo(() => systemList.data ?? [], [systemList.data]);
  // What the hub derives for each system from the account's services (roadmap 19c), so controls show as the hub decides.
  const withSystems = useMemo(() => (me.access ? { ...me, access: withSystemGrants(me.access, systems) } : me), [me, systems]);
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
  const page = route.id;
  // The desktop app on a hub shows this machine's work; the rest is on the hub's web (roadmap 35a).
  const deskHub = !!client.desktop && me.mode === "hub";
  const webUrl = useQuery(async () => (deskHub ? (await client.desktop!.settings()).hubUrl.replace(/\/+$/, "") : null), [client, deskHub]).data ?? null;
  const pending = useQuery(() => client.call("proposals.list", { status: "pending" }), [client, tick, route]);
  // Checked when the app opens (and after leaving the setup page), so the sidebar shows what is missing.
  const setup = useQuery(async () => (client.desktop ? client.desktop.setupStatus() : null), [client, page === "setup"]);

  useEffect(() => {
    const onHash = () => setRoute(readHash() ?? HOME);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const visible = useMemo(() => {
    if (deskHub) return new Set<PageId>([...DESK_PAGES].filter((id) => id !== "device" || (client.device && me.user)));
    // Tool: the catalog is the hub's, and project managers on the web turn tools on for their project there too.
    const ids = new Set<PageId>(["today", "overview", "docs", "read", "specs", "skills", "proposals", "memory", "tasks", "systems", "tools"]);
    if (client.desktop) for (const id of ["board", "agents", "setup", "projects"] as const) ids.add(id);
    // Machines only report to a hub (and push their runs to it); a local database never has any. The leader chat
    // runs on a machine the hub hands it to.
    if (me.mode === "hub") for (const id of ["machines", "runs", "batches", "chat"] as const) ids.add(id);
    // The desktop's own runs (local mode too) are on Lượt chạy.
    if (client.desktop) ids.add("runs");
    if (webAdmin) {
      for (const id of ["ops", "fleet", "queue", "costs", "policy", "context", "audit"] as const) ids.add(id);
      if (client.alerts) ids.add("alerts");
      if (client.webhooks) ids.add("webhooks");
      if (client.releases) ids.add("versions");
      if (client.hub) ids.add("hub");
      // Vận hành › Tổng quan is the same picture for every project; the members' one stays for the others.
      ids.delete("overview");
    }
    if (hubAdmin && client.users) ids.add("users");
    // Thành viên (roadmap 25): a project lead sets roles in their project; hub admins have Người dùng & quyền too.
    if (me.mode === "hub" && client.members && (hubAdmin || may(me, null, "membersManage") || projects.some((p) => may(me, p, "membersManage")))) ids.add("members");
    // Everyone with an account manages their own tokens (machines, CI); admins see all.
    if (client.tokens && (hubAdmin || me.user)) ids.add("tokens");
    if (client.device && me.user) ids.add("device");
    return ids;
  }, [client, me, hubAdmin, webAdmin, projects, deskHub]);

  // A link or a jump to a page the desktop app does not have opens it on the hub's web instead.
  const away = useRef({ deskHub, webUrl, visible });
  away.current = { deskHub, webUrl, visible };
  useEffect(() => {
    const elsewhere = (hash: string) => {
      const { deskHub: on, webUrl: web, visible: here } = away.current;
      if (!on || !web) return false;
      const id = hash.replace(/^#\/?/, "").split(/[?/]/)[0]!;
      return hash.startsWith("#/") && !here.has(id as PageId);
    };
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement | null)?.closest?.("a[href^='#/']");
      const href = a?.getAttribute("href");
      if (!href || !elsewhere(href)) return;
      e.preventDefault();
      window.open(`${away.current.webUrl}/${href}`, "_blank");
    };
    let last = window.location.hash;
    const onHash = () => {
      const hash = window.location.hash;
      if (elsewhere(hash)) {
        window.open(`${away.current.webUrl}/${hash}`, "_blank");
        window.history.replaceState(null, "", last || "#/today");
        return;
      }
      last = hash;
    };
    document.addEventListener("click", onClick, true);
    window.addEventListener("hashchange", onHash);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("hashchange", onHash);
    };
  }, []);

  const fullInbox = useInboxState(client, me, scope, tick);
  const inbox = useMemo(
    () => (deskHub ? { ...fullInbox, items: fullInbox.items.filter((i) => DESK_INBOX.has(i.kind)), done: fullInbox.done.filter((d) => DESK_INBOX.has(d.kind)) } : fullInbox),
    [deskHub, fullInbox],
  );
  // The machine's name in the subtitles of Lượt chạy and Agent (desktop).
  const machine = useQuery(async () => (client.desktop ? (await client.desktop.settings()).machine : null), [client]).data;

  // What the operations entries count: only loaded for hub admins on the web.
  const poll = usePoll(webAdmin ? 30_000 : null);
  const adminRequests = useQuery(async () => (webAdmin ? client.call("runs.requests", { limit: 200 }) : []), [client, webAdmin, poll]);
  const adminMachines = useQuery(async () => (webAdmin ? client.call("admin.machines", {}) : []), [client, webAdmin, poll]);
  const adminPolicy = useQuery(async () => (webAdmin ? client.call("policy.get", {}) : null), [client, webAdmin]);
  const adminAlerts = useQuery(async () => (webAdmin && client.alerts ? client.alerts.list().catch(() => null) : null), [client, webAdmin, poll]);
  const adminMemory = useQuery(async () => (webAdmin ? client.call("memory.list", { limit: 500 }) : []), [client, webAdmin, poll, tick]);

  const current: PageId = visible.has(route.id) ? route.id : "today";
  const lacking = adminPolicy.data ? (adminMachines.data ?? []).filter((m) => m.setup && missingRequired(adminPolicy.data!, m.setup).length > 0).length : 0;
  const openAlerts = adminAlerts.data?.open ?? [];
  const counts: Partial<Record<PageId, number>> = {
    today: inbox.items.length,
    proposals: pending.data?.length ?? 0,
    setup: setup.data ? [...setup.data.machine, ...setup.data.projects.flatMap((p) => p.items)].filter((i) => i.state !== "installed").length : 0,
    queue: (adminRequests.data ?? []).filter((r) => r.status === "pending").length,
    fleet: lacking + (adminMachines.data ?? []).filter((m) => m.duplicate).length,
    alerts: openAlerts.length,
    memory: webAdmin ? (adminMemory.data ?? []).filter((m) => m.status === "pending" || m.conflictsWith.length || m.review).length : 0,
  };
  // Filled: what waits for you, and alerts the hub rates high.
  const strong = (id: PageId) => id === "today" || (id === "alerts" && openAlerts.some((a) => a.severity === "high"));
  const groups: NavGroup[] = (deskHub ? DESK_GROUPS : client.desktop ? LOCAL_GROUPS : WEB_GROUPS)
    .map((g) => ({
      label: g.label ? t(g.label) : null,
      items: g.ids
        .filter((id) => visible.has(id))
        .map((id) => ({
          id,
          label: t(PAGES[id].label),
          icon: PAGES[id].icon,
          shortcut: SHORTCUTS[id],
          badge: counts[id] ? { count: counts[id]!, strong: strong(id) } : undefined,
        })),
    }))
    .filter((g) => g.items.length > 0);
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
  const frame = (
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
        webUrl={webUrl}
      >
        {PAGES[current].render()}
      </ClientShell>
    </InboxProvider>
  );

  return (
    <HiveContext.Provider value={{ client, me: withSystems, bump, scope, setScope, projects, systems }}>
      <TooltipProvider>{frame}</TooltipProvider>
    </HiveContext.Provider>
  );
}
