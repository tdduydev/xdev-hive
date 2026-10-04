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
import { may, missingRequired, withSystemGrants, type Me, type ToolView } from "@xdev-hive/core";
import type { HiveClient } from "./client.ts";
import { ChangePasswordScreen } from "./components/Account.tsx";
import { ErrorNote } from "./components/common.tsx";
import { CrashCard, ErrorBoundary, PageBoundary } from "./components/ErrorBoundary.tsx";
import { HiveContext, useProjectList, useQuery, usePoll } from "./hooks.ts";
import { activeIntl, useT, type MessageKey } from "./i18n/index.tsx";
import { resolveHash } from "./lib/route.ts";
import { readScope, resolveScope, writeScope, type Scope } from "./lib/scope.ts";
import { useSystemTheme } from "./lib/theme.ts";
import { ClientShell, type NavEntry, type NavGroup } from "./shell/ClientShell.tsx";
import { InboxProvider, useInboxState } from "./shell/inbox.tsx";
import { PolicyTab } from "./pages/Admin.tsx";
import { AgentsPage } from "./pages/Agents.tsx";
import { BatchesPage } from "./pages/Batches.tsx";
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
import { TaskWorkPage } from "./pages/Tasks.tsx";
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
  runs: { label: "nav.runs", sub: "navSub.runs", icon: Activity, render: () => <RunsPage /> },
  batches: { label: "nav.batches", sub: "navSub.batches", icon: Workflow, render: () => <BatchesPage /> },
  docs: { label: "nav.docs", sub: "navSub.docs", icon: FileText, render: () => <DocsPage /> },
  // Not in the sidebar: a doc's reading view (#/read?doc=…), under Tài liệu.
  read: { label: "nav.read", sub: "navSub.read", icon: BookOpen, render: () => <DocReaderPage /> },
  specs: { label: "nav.specs", sub: "navSub.specs", icon: ListChecks, render: () => <SpecsPage /> },
  skills: { label: "nav.skills", sub: "navSub.skills", icon: WandSparkles, render: () => <SkillsPage /> },
  proposals: { label: "nav.proposals", sub: "navSub.proposals", icon: GitPullRequestArrow, render: () => <ProposalsPage /> },
  memory: { label: "nav.memory", sub: "navSub.memory", icon: Brain, render: () => <MemoryPage /> },
  // The desktop app opens it on the Board of this machine (roadmap 39f); the web keeps the shared Kanban.
  tasks: { label: "nav.tasks", sub: "navSub.tasks", icon: ListTodo, render: () => <TaskWorkPage /> },
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

/**
 * The desktop app in local mode: the whole system on this machine. Twelve entries since roadmap 39f, so the menu
 * fits a 1440×900 window without scrolling. Only pages a machine on its own can have are listed: Chat, Đợt chạy,
 * Bản đồ agent, Người dùng, Thành viên and Token all need a hub (see `visible` below, which left them out of this
 * mode all along), Board is now the Task page and Tool a part of Dự án & công cụ.
 */
const LOCAL_GROUPS: Array<{ label: MessageKey | null; ids: PageId[] }> = [
  { label: null, ids: ["today"] },
  { label: "nav.groupWork", ids: ["tasks", "runs"] },
  { label: "nav.groupKnowledge", ids: ["docs", "specs", "skills", "memory", "proposals"] },
  { label: "nav.groupAgents", ids: ["agents", "setup", "projects"] },
  { label: "nav.groupAdmin", ids: ["systems"] },
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
/**
 * ⌘1–6 on the web and on a machine connected to a hub: Hôm nay, Chat, Lượt chạy, Tài liệu, Agent, of those the mode
 * shows. ⌘3 was the Board, which is the Task page now (roadmap 39f); the others keep the key they had, since this
 * roadmap item only changes the menu of the local mode.
 */
const SHORTCUTS: Partial<Record<PageId, string>> = { today: "1", chat: "2", runs: "4", docs: "5", agents: "6" };
/** On this machine the menu is another one (roadmap 39f), so ⌘1–6 follow it: its first six entries. */
const LOCAL_SHORTCUTS: Partial<Record<PageId, string>> = { today: "1", tasks: "2", runs: "3", docs: "4", agents: "5", setup: "6" };

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

/** The page the address bar means (lib/route.ts has the table), with an old address rewritten to the page it reaches. */
function readHash(local: boolean): Route | null {
  const { id, hash } = resolveHash(window.location.hash, { local, isPage: (page) => page in PAGES });
  if (hash) window.history.replaceState(null, "", hash);
  return id ? { kind: "client", id: id as PageId } : null;
}

/** Full-window message (connecting, or a failed sign-in). */
function Centered({ children }: { children: ReactNode }) {
  return <div className="flex min-h-svh flex-col items-center justify-center gap-4 p-6 text-sm text-muted-foreground">{children}</div>;
}

export function HiveApp(props: { client: HiveClient; onSignOut?: () => void }) {
  // The last resort, for an error in the frame itself: a page's own is caught closer, with the frame kept.
  return (
    <ErrorBoundary
      onError={(text) => void props.client.desktop?.logError?.(text).catch(() => undefined)}
      fallback={(error, retry) => <CrashCard error={error} retry={retry} whole />}
    >
      <HiveAppInner {...props} />
    </ErrorBoundary>
  );
}

function HiveAppInner({ client, onSignOut }: { client: HiveClient; onSignOut?: () => void }) {
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
  // This machine on its own: fewer pages, so a few addresses lead elsewhere (roadmap 39f) and ⌘1–6 follow its menu.
  const local = !!client.desktop && me.mode !== "hub";
  const [route, setRoute] = useState<Route>(() => readHash(local) ?? HOME);
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
  // The web counts what waits for review once, on Hôm nay (roadmap 35c); the desktop's own pages keep their count.
  const pending = useQuery(async () => (local ? client.call("proposals.list", { status: "pending" }) : []), [client, local, tick, route]);
  // Checked when the app opens (and after leaving the setup page), so the sidebar shows what is missing.
  const setup = useQuery(async () => (client.desktop ? client.desktop.setupStatus() : null), [client, page === "setup"]);

  // The listener is set once, so the mode it reads an address in comes from a ref, as the one below does.
  const localRef = useRef(local);
  localRef.current = local;
  useEffect(() => {
    const onHash = () => setRoute(readHash(localRef.current) ?? HOME);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const visible = useMemo(() => {
    if (deskHub) return new Set<PageId>([...DESK_PAGES].filter((id) => id !== "device" || (client.device && me.user)));
    // Tool: the catalog is the hub's, and project managers on the web turn tools on for their project there too.
    const ids = new Set<PageId>(["today", "overview", "docs", "read", "specs", "skills", "proposals", "memory", "tasks", "systems", "tools"]);
    if (client.desktop) for (const id of ["agents", "setup", "projects"] as const) ids.add(id);
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
  // Tools a project requires count as missing items too (roadmap 28b-2); a hub before the catalog has no tools.list.
  const adminTools = useQuery(async () => (webAdmin ? client.call("tools.list", {}).catch((): ToolView[] => []) : []), [client, webAdmin]);

  const current: PageId = visible.has(route.id) ? route.id : "today";
  const lacking = adminPolicy.data ? (adminMachines.data ?? []).filter((m) => m.setup && missingRequired(adminPolicy.data!, m.setup, adminTools.data ?? []).length > 0).length : 0;
  const openAlerts = adminAlerts.data?.open ?? [];
  const counts: Partial<Record<PageId, number>> = {
    today: inbox.items.length,
    proposals: pending.data?.length ?? 0,
    setup: setup.data ? [...setup.data.machine, ...setup.data.projects.flatMap((p) => p.items)].filter((i) => i.state !== "installed").length : 0,
    queue: (adminRequests.data ?? []).filter((r) => r.status === "pending").length,
    fleet: lacking + (adminMachines.data ?? []).filter((m) => m.duplicate).length,
    alerts: openAlerts.length,
  };
  // Filled: what waits for you, and alerts the hub rates high.
  const strong = (id: PageId) => id === "today" || (id === "alerts" && openAlerts.some((a) => a.severity === "high"));
  const shortcuts = local ? LOCAL_SHORTCUTS : SHORTCUTS;
  const groups: NavGroup[] = (deskHub ? DESK_GROUPS : local ? LOCAL_GROUPS : WEB_GROUPS)
    .map((g) => ({
      label: g.label ? t(g.label) : null,
      items: g.ids
        .filter((id) => visible.has(id))
        .map((id) => ({
          id,
          label: t(PAGES[id].label),
          icon: PAGES[id].icon,
          shortcut: shortcuts[id],
          badge: counts[id] ? { count: counts[id]!, strong: strong(id) } : undefined,
        })),
    }))
    .filter((g) => g.items.length > 0);
  const extraPages: NavEntry[] = PALETTE_ONLY.filter((id) => visible.has(id)).map((id) => ({ id, label: t(PAGES[id].label), icon: PAGES[id].icon }));
  const today = new Date().toLocaleDateString(activeIntl(), { weekday: "long", day: "numeric", month: "long" });
  const subtitle =
    current === "today"
      ? t("inbox.subtitle", { date: today.charAt(0).toUpperCase() + today.slice(1) })
      : // The app lists this machine's runs in both modes (roadmap 35a); the web lists the team's, so it keeps navSub.runs.
        client.desktop && current === "runs"
        ? t("navSub.runsOn")
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
        <PageBoundary page={current}>{PAGES[current].render()}</PageBoundary>
      </ClientShell>
    </InboxProvider>
  );

  return (
    <HiveContext.Provider value={{ client, me: withSystems, bump, scope, setScope, projects, systems }}>
      <TooltipProvider>{frame}</TooltipProvider>
    </HiveContext.Provider>
  );
}
