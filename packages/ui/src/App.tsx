import { WorkspaceAcceptance } from "#ui/pages/WorkspaceAcceptance.tsx";
import { WebTodayPage } from "#ui/pages/WorkspaceHome.tsx";
import { HistoryPage } from "#ui/pages/History.tsx";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import { TerminalProvider } from "#ui/components/RemoteTerminal.tsx";
import {
  Activity,
  BookOpen,
  Bot,
  Boxes,
  Brain,
  FileText,
  FolderGit2,
  GitPullRequestArrow,
  Inbox,
  KeyRound,
  Laptop,
  LayoutGrid,
  ListChecks,
  ListTodo,
  MessageSquare,
  Network,
  Server,
  Settings2,
  Workflow,
  ShieldCheck,
  SquareKanban,
  Terminal,
  WandSparkles,
} from "lucide-react";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { TooltipProvider } from "@xdev-hive/ui/components/ui/tooltip";
import { missingRequired, withSystemGrants, type Me, type ToolView } from "@xdev-hive/core";
import type { HiveClient } from "./client.ts";
import { ChangePasswordScreen } from "./components/Account.tsx";
import { ErrorNote } from "./components/common.tsx";
import { CrashCard, ErrorBoundary, PageBoundary } from "./components/ErrorBoundary.tsx";
import { HiveContext, hashParam, useProjectList, useQuery, usePoll, useRetiredProjects } from "./hooks.ts";
import { activeIntl, useT, type MessageKey } from "./i18n/index.tsx";
import { resolveHash } from "./lib/route.ts";
import { WEB_MENU, WEB_SHORTCUTS, webCaps, webPages } from "./lib/nav.ts";
import { readScope, resolveScope, scopeTitle, writeScope, type Scope } from "./lib/scope.ts";
import { useSystemTheme } from "./lib/theme.ts";
import { ClientShell, type NavEntry, type NavGroup } from "./shell/ClientShell.tsx";
import { InboxProvider, useInboxState } from "./shell/inbox.tsx";
import { ArtifactsPage } from "#ui/pages/Artifacts.tsx";
import { AgentsPage } from "./pages/Agents.tsx";
import { ChatPage } from "./pages/Chat.tsx";
import { DevicePage } from "./pages/Device.tsx";
import { DocsPage } from "./pages/Docs.tsx";
import { FeaturesPage } from "./pages/Features.tsx";
import { MemoryPage } from "./pages/Memory.tsx";
import { KnowledgePage } from "#ui/pages/Sections.tsx";
import { OverviewPage } from "./pages/Overview.tsx";
import { ProjectsPage } from "./pages/Projects.tsx";
import { ProposalsPage } from "./pages/Proposals.tsx";
import { AdminPage, MachinesAgentsPage, RunsWorkPage, SettingsPage } from "./pages/Sections.tsx";
import { SetupPage } from "./pages/Setup.tsx";

import { PipelinePage } from "./pages/Pipeline.tsx";
import { SpecsPage } from "./pages/Specs.tsx";
import { SystemsPage } from "./pages/Systems.tsx";
import { TaskWorkPage } from "./pages/Tasks.tsx";
import { TodayInboxPage as TodayPage } from "./pages/Today.tsx";
import { TokensPage } from "./pages/Tokens.tsx";
import { DocReaderPage } from "./pages/DocReader.tsx";
import { StartPage } from "#ui/pages/Start.tsx";
import { remainingSteps, shouldOpenStartGuide, startSteps } from "#ui/lib/start.ts";
const GraphPage = lazy(() => import("./pages/Graph.tsx").then((module) => ({ default: module.GraphPage })));

type PageId =
  | "start"
  | "today"
  | "overview"
  | "chat"
  | "runs"
  | "history"
  | "artifacts"
  | "docs"
  | "read"
  | "specs"
  | "features"
  | "skills"
  | "proposals"
  | "memory"
  | "tasks"
  | "graph"
  | "agents"
  | "machines"
  | "settings"
  | "pipeline"
  | "admin"
  | "tokens"
  | "setup"
  | "projects"
  | "systems"
  | "device";
type Icon = ComponentType<{ className?: string }>;

const PAGES: Record<PageId, { label: MessageKey; sub: MessageKey; icon: Icon; render: () => ReactNode }> = {
  start: { label: "start.title", sub: "start.sub", icon: ListChecks, render: () => <StartPage /> },
  today: { label: "nav.today", sub: "navSub.today", icon: Inbox, render: () => <TodayPage /> },
  overview: { label: "nav.overview", sub: "navSub.overview", icon: LayoutGrid, render: () => <OverviewPage /> },
  chat: { label: "nav.chat", sub: "navSub.chat", icon: MessageSquare, render: () => <ChatPage /> },
  // On the web with Đợt chạy as a tab (roadmap 49b); the desktop app's own runs as they were.
  runs: { label: "nav.runs", sub: "navSub.runs", icon: Activity, render: () => <RunsWorkPage /> },
  history: { label: "history.title", sub: "history.sub", icon: Activity, render: () => <HistoryPage /> },
  artifacts: { label: "artifacts.page", sub: "artifacts.sub", icon: FileText, render: () => <ArtifactsPage /> },
  docs: { label: "nav.docs", sub: "navSub.docs", icon: FileText, render: () => <KnowledgePage page="docs" /> },
  // Not in the sidebar: a doc's reading view (#/read?doc=…), under Tài liệu.
  read: { label: "nav.read", sub: "navSub.read", icon: BookOpen, render: () => <DocReaderPage /> },
  // The desktop app's Spec page; on the web Tính năng took its place (roadmap 49d) and #/specs goes there.
  specs: { label: "nav.specs", sub: "navSub.specs", icon: ListChecks, render: () => <SpecsPage /> },
  features: { label: "nav.features", sub: "navSub.features", icon: ListChecks, render: () => <FeaturesPage /> },
  skills: { label: "nav.skills", sub: "navSub.skills", icon: WandSparkles, render: () => <KnowledgePage page="skills" /> },
  proposals: { label: "nav.proposals", sub: "navSub.proposals", icon: GitPullRequestArrow, render: () => <ProposalsPage /> },
  memory: { label: "nav.memory", sub: "navSub.memory", icon: Brain, render: () => <KnowledgePage page="memory" /> },
  // The desktop app opens it on the Board of this machine (roadmap 39f); the web keeps the shared Kanban.
  tasks: { label: "nav.tasks", sub: "navSub.tasks", icon: ListTodo, render: () => <TaskWorkPage /> },
  graph: { label: "nav.graph", sub: "navSub.graph", icon: Network, render: () => <Suspense fallback={null}><GraphPage /></Suspense> },
  agents: { label: "nav.agents", sub: "navSub.agents", icon: Bot, render: () => <AgentsPage /> },
  // The web's entries that hold tabs (roadmap 49b): the pages that were in Vận hành and Quản trị before.
  machines: { label: "nav.machines", sub: "navSub.machines", icon: Server, render: () => <MachinesAgentsPage /> },
  pipeline: { label: "nav.pipeline", sub: "navSub.pipeline", icon: Workflow, render: () => <PipelinePage /> },
  settings: { label: "nav.settings", sub: "navSub.settings", icon: Settings2, render: () => <SettingsPage /> },
  admin: { label: "nav.admin", sub: "navSub.admin", icon: ShieldCheck, render: () => <AdminPage /> },
  setup: { label: "nav.setup", sub: "navSub.setup", icon: Terminal, render: () => <SetupPage /> },
  // Not in the web's sidebar: the account menu opens it (roadmap 49b).
  tokens: { label: "nav.tokens", sub: "navSub.tokens", icon: KeyRound, render: () => <TokensPage /> },
  projects: { label: "nav.projects", sub: "navSub.projects", icon: FolderGit2, render: () => <ProjectsPage /> },
  systems: { label: "nav.systems", sub: "navSub.systems", icon: Boxes, render: () => <SystemsPage /> },
  // Not in the sidebar: the desktop app opens it (#/device?port=…).
  device: { label: "nav.device", sub: "navSub.device", icon: Laptop, render: () => <DevicePage /> },
};

/**
 * The desktop app in local mode: the whole system on this machine. Twelve entries since roadmap 39f, so the menu
 * fits a 1440×900 window without scrolling, and Chat since 48 (this machine's own leader, in its database). Only
 * pages a machine on its own can have are listed: Đợt chạy, Bản đồ agent, Người dùng, Thành viên and Token all need a
 * hub (see `visible` below, which leaves them out of this mode), Board is now the Task page and Tool a part of Dự án
 * & công cụ.
 */
const LOCAL_GROUPS: Array<{ label: MessageKey | null; ids: PageId[] }> = [
  { label: null, ids: ["today"] },
  { label: "nav.groupWork", ids: ["tasks", "chat", "runs"] },
  { label: "nav.groupKnowledge", ids: ["docs", "specs", "skills", "memory", "proposals"] },
  { label: "nav.groupAgents", ids: ["agents", "setup", "projects"] },
  { label: "nav.groupAdmin", ids: ["systems"] },
];
/**
 * The web: one shell for everyone (roadmap 35b), its menu by job since 49b (lib/nav.ts has it, with who sees what):
 * Hôm nay and Chat, the work, the knowledge, then the project's settings, the machines and the hub's administration.
 */
const WEB_GROUPS = WEB_MENU as Array<{ label: MessageKey | null; ids: PageId[] }>;
const SHORTCUTS = WEB_SHORTCUTS as Partial<Record<PageId, string>>;
/**
 * ⌘1–6 on a machine connected to a hub: Hôm nay, its Board (roadmap 44, on the key the Board has in local mode), Chat
 * (48), Lượt chạy, Tài liệu, Agent. Written out since 49b gave the web keys of its own, and the app's stay.
 */
const DESK_SHORTCUTS: Partial<Record<PageId, string>> = { today: "1", tasks: "2", chat: "3", runs: "4", docs: "5", agents: "6" };
/** On this machine the menu is another one (roadmap 39f), so ⌘1–6 follow it: its first six entries. */
const LOCAL_SHORTCUTS: Partial<Record<PageId, string>> = { today: "1", tasks: "2", runs: "3", docs: "4", agents: "5", setup: "6" };

/**
 * The desktop app connected to a hub (roadmap 35a): this machine's work only. Docs, policies, members and the rest
 * are the web's; links to them open the hub in the browser. Task is back as the Board of the projects with a repo
 * here (roadmap 44: a client could not see its own tasks), the list and every other project stay on the web. Chat
 * is the hub's leader chat, the same threads as on the web (roadmap 48), its replies written on this machine by
 * default. In local mode the app is the whole system and keeps every page.
 */
const DESK_PAGES = new Set<PageId>(["start", "today", "tasks", "chat", "runs", "agents", "setup", "projects", "device"]);
const DESK_GROUPS: Array<{ label: MessageKey | null; ids: PageId[] }> = [
  { label: null, ids: ["today", "tasks", "chat", "runs"] },
  { label: "nav.groupAgents", ids: ["agents", "setup", "projects"] },
];
/** What the machine's Hôm nay shows: its runs' CI, its own setup, install requests for it. */
const DESK_INBOX = new Set(["ci", "machine", "request"]);
/** Not in the sidebar, still in the command palette: Token moved to the account menu on the web (roadmap 49b). */
const PALETTE_ONLY: PageId[] = ["start", "overview", "tokens"];

type Route = { kind: "client"; id: PageId };
const HOME: Route = { kind: "client", id: "today" };

/** The page the address bar means (lib/route.ts has the table), with an old address rewritten to the page it reaches. */
function readHash(local: boolean, web: boolean): Route | null {
  const { id, hash } = resolveHash(window.location.hash, { local, web, isPage: (page) => page in PAGES });
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
  useEffect(() => {
    const changed = () => me.reload();
    window.addEventListener("xdev-hive:connection-changed", changed);
    return () => window.removeEventListener("xdev-hive:connection-changed", changed);
  }, [me.reload]);
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
  // The hub's web, whose menu folded pages into tabs (roadmap 49b), so its old addresses lead to those tabs.
  const web = !client.desktop;
  const initialHash = useRef(window.location.hash);
  const [route, setRoute] = useState<Route>(() => readHash(local, web) ?? HOME);
  const [tick, setTick] = useState(0);
  const bump = useCallback(() => setTick((t) => t + 1), []);
  const seen = useProjectList(client, tick);
  // A hub from before systems (roadmap 19b) has no such method: there are none then.
  const systemList = useQuery(() => client.call("systems.list", {}).catch(() => []), [client, tick]);
  // Keys put to rest with nothing left on them are out of the switcher, of their system's group and of every list (38g).
  const retired = useRetiredProjects(client, tick);
  const systems = useMemo(
    () => (systemList.data ?? []).map((s) => ({ ...s, projects: s.projects.filter((p) => !retired.has(p)) })).filter((s) => s.projects.length > 0),
    [systemList.data, retired],
  );
  // What the hub derives for each system from the account's services (roadmap 19c), so controls show as the hub decides.
  const withSystems = useMemo(() => (me.access ? { ...me, access: withSystemGrants(me.access, systems) } : me), [me, systems]);
  // Archived and deleted projects (roadmap 47). The hub already leaves them out of every list, so this is only about
  // the names that come from the account's own grants: a grant outlives the project it was given on.
  const archived = useQuery(async () => (me.mode === "hub" ? client.call("projects.list", {}).catch(() => []) : []), [client, me.mode, tick]);
  const hidden = useMemo(() => new Set((archived.data ?? []).filter((p) => p.state !== null).map((p) => p.project)), [archived.data]);
  // Granted projects show in the switcher even before they have any data, and so do a system's.
  const projects = useMemo(
    () => [...new Set([...seen, ...Object.keys(me.access?.projects ?? {}), ...systems.flatMap((s) => s.projects)])].filter((p) => !hidden.has(p) && !retired.has(p)).sort(),
    [seen, me.access, systems, hidden, retired],
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

  const initialStart = useQuery(async () => {
    if (!client.desktop) return false;
    const [settings, report, profiles] = await Promise.all([client.desktop.settings(), client.desktop.setupStatus(), client.desktop.profiles()]);
    return remainingSteps(startSteps(settings, report, profiles)) > 0;
  }, [client]);
  const startChecked = useRef(false);
  useEffect(() => {
    if (initialStart.data === undefined || startChecked.current) return;
    startChecked.current = true;
    // Explicit deep links (including a browser connection callback) keep their destination.
    if (initialStart.data && shouldOpenStartGuide(initialHash.current, window.location.hash)) window.location.hash = "/start";
  }, [initialStart.data]);

  // The listener is set once, so the mode it reads an address in comes from a ref, as the one below does.
  const localRef = useRef(local);
  localRef.current = local;
  useEffect(() => {
    const onHash = () => setRoute(readHash(localRef.current, web) ?? HOME);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const visible = useMemo(() => {
    if (deskHub) return new Set<PageId>([...DESK_PAGES].filter((id) => id !== "device" || (client.device && me.user)));
    // Everyone with an account manages their own tokens (machines, CI), from the account menu; admins see all.
    const account = (ids: Set<PageId>) => {
      if (client.tokens && (hubAdmin || me.user)) ids.add("tokens");
      if (client.device && me.user) ids.add("device");
      return ids;
    };
    if (!client.desktop) {
      // Quản trị › Tổng quan vận hành is the same picture for every project; the members' Tổng quan stays for the others.
      const ids = new Set<PageId>([...webPages(me, projects, webCaps(client)), "read", "start"]);
      // Keep system overview deep links and palette access for hub admins too.
      ids.add("overview");
      return account(ids);
    }
    // The desktop app on its own machine (roadmap 39f): its runs and, from 48, its own leader chat, which an app
    // before it has no bridge for. Machines, batches, members and the rest need a hub.
    const ids = new Set<PageId>(["start", "today", "overview", "docs", "read", "specs", "skills", "proposals", "memory", "tasks", "systems", "agents", "setup", "projects", "runs"]);
    if (client.desktop.chatMachine) ids.add("chat");
    return account(ids);
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

  // History readers may open a thread without permission to start a chat; chat.get still checks its project.
  const readingThread = route.id === "chat" && visible.has("history") && /^\d+$/.test(hashParam("thread") ?? "");
  const current: PageId = visible.has(route.id) || readingThread ? route.id : "today";
  const lacking = adminPolicy.data ? (adminMachines.data ?? []).filter((m) => m.setup && missingRequired(adminPolicy.data!, m.setup, adminTools.data ?? []).length > 0).length : 0;
  const openAlerts = adminAlerts.data?.open ?? [];
  const counts: Partial<Record<PageId, number>> = {
    today: inbox.items.length,
    proposals: pending.data?.length ?? 0,
    setup: setup.data ? [...setup.data.machine, ...setup.data.projects.flatMap((p) => p.items)].filter((i) => i.state !== "installed").length : 0,
    // Máy & agent counts what Hàng đợi and Đội máy counted (requests waiting, machines lacking something or twice);
    // Quản trị the open alerts (roadmap 49b).
    machines: (adminRequests.data ?? []).filter((r) => r.status === "pending").length + lacking + (adminMachines.data ?? []).filter((m) => m.duplicate).length,
    admin: openAlerts.length,
  };
  // Filled: what waits for you, and alerts the hub rates high.
  const strong = (id: PageId) => id === "today" || (id === "admin" && openAlerts.some((a) => a.severity === "high"));
  const shortcuts = local ? LOCAL_SHORTCUTS : deskHub ? DESK_SHORTCUTS : SHORTCUTS;
  // There Task is the Board alone, over this machine's projects, so it says so. The web names two entries by the job
  // they are for (roadmap 49b) until 49e gives Agent đang chạy a page of its own (49d did Tính năng); the app keeps
  // Lượt chạy.
  const label = (id: PageId): MessageKey => (deskHub && id === "tasks" ? "nav.board" : web && id === "runs" ? "nav.running" : web && id === "pipeline" ? "workspace.acceptance" : web && id === "features" ? "workspace.project" : PAGES[id].label);
  const groups: NavGroup[] = (deskHub ? DESK_GROUPS : local ? LOCAL_GROUPS : WEB_GROUPS)
    .map((g) => ({
      label: g.label ? t(g.label) : null,
      items: g.ids
        .filter((id) => visible.has(id))
        .map((id) => ({
          id,
          label: t(label(id)),
          icon: deskHub && id === "tasks" ? SquareKanban : PAGES[id].icon,
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
          : deskHub && current === "tasks"
            ? t("navSub.boardOn")
            : web && current === "runs"
              ? t("navSub.running")
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
        title={t(label(current))}
        scopeName={scope.kind === "system" || scope.kind === "project" ? scopeTitle(scope, systems) : null}
        subtitle={subtitle}
        webUrl={webUrl}
      >
        <PageBoundary page={current}>{web && current === "today" ? <WebTodayPage inboxView={new URLSearchParams(window.location.hash.split("?")[1]).has("item") || new URLSearchParams(window.location.hash.split("?")[1]).get("section") === "inbox"} /> : web && current === "pipeline" ? <WorkspaceAcceptance /> : PAGES[current].render()}</PageBoundary>
      </ClientShell>
    </InboxProvider>
  );

  return (
    <HiveContext.Provider value={{ client, me: withSystems, bump, scope, setScope, projects, systems }}>
      <TooltipProvider><TerminalProvider>{frame}</TerminalProvider></TooltipProvider>
    </HiveContext.Provider>
  );
}
