// The hub's web (roadmap 76h): the workspace people use every day and, by permission, Quản trị. The desktop app is
// DesktopApp, a root of its own, so nothing here asks whether it runs in the app; a machine's own work is the app's.
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import {
  BookOpen,
  Brain,
  Cpu,
  GitMerge,
  GitPullRequestArrow,
  History,
  Inbox,
  KeyRound,
  Laptop,
  Layers,
  LayoutGrid,
  ListChecks,
  MessagesSquare,
  Network,
  Package,
  Play,
  Settings2,
  Shield,
  Sparkles,
  SquareKanban,
} from "lucide-react";
import { TooltipProvider } from "@xdev-hive/ui/components/ui/tooltip";
import { missingRequired, withSystemGrants, type Me, type ToolView } from "@xdev-hive/core";
import { useT, type HiveClient, type MessageKey } from "@xdev-hive/ui";
import { PageBoundary } from "@xdev-hive/ui/components/ErrorBoundary";
import { TerminalProvider } from "@xdev-hive/ui/components/RemoteTerminal";
import { HiveContext, hashParam, usePoll, useProjectList, useQuery, useRetiredProjects } from "@xdev-hive/ui/hooks";
import { resolveHash } from "@xdev-hive/ui/lib/route";
import { WEB_MENU, WEB_SHORTCUTS, webCaps, webPages } from "@xdev-hive/ui/lib/nav";
import { readScope, resolveScope, scopeKey, scopeProject, scopeProjects, scopeTitle, writeScope, type Scope } from "@xdev-hive/ui/lib/scope";
import { AppBoot } from "@xdev-hive/ui/shell/boot";
import { ClientShell, type NavEntry, type NavGroup } from "@xdev-hive/ui/shell/ClientShell";
import { InboxProvider, useInboxState } from "@xdev-hive/ui/shell/inbox";
import { ArtifactsPage } from "@xdev-hive/ui/pages/Artifacts";
import { DevicePage } from "@xdev-hive/ui/pages/Device";
import { DocReaderPage } from "@xdev-hive/ui/pages/DocReader";
import { FeaturesPage } from "@xdev-hive/ui/pages/Features";
import { HistoryPage } from "@xdev-hive/ui/pages/History";
import { ChatPage } from "@xdev-hive/ui/pages/Chat";
import { OverviewPage } from "@xdev-hive/ui/pages/Overview";
import { AdminPage, KnowledgePage, MachinesAgentsPage, RunsWorkPage, SettingsPage } from "@xdev-hive/ui/pages/Sections";
import { ProposalsPage } from "@xdev-hive/ui/pages/Proposals";
import { StartPage } from "@xdev-hive/ui/pages/Start";
import { TaskWorkPage } from "@xdev-hive/ui/pages/Tasks";
import { TodayInboxPage } from "@xdev-hive/ui/pages/Today";
import { TokensPage } from "@xdev-hive/ui/pages/Tokens";
import { WorkspaceAcceptance } from "@xdev-hive/ui/pages/WorkspaceAcceptance";
import { WebTodayPage } from "@xdev-hive/ui/pages/WorkspaceHome";
const GraphPage = lazy(() => import("@xdev-hive/ui/pages/Graph").then((module) => ({ default: module.GraphPage })));

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
  | "features"
  | "skills"
  | "proposals"
  | "memory"
  | "tasks"
  | "graph"
  | "machines"
  | "settings"
  | "pipeline"
  | "admin"
  | "tokens"
  | "device";
type Icon = ComponentType<{ className?: string }>;

const PAGES: Record<PageId, { label: MessageKey; sub: MessageKey; icon: Icon; render: () => ReactNode }> = {
  start: { label: "start.title", sub: "start.sub", icon: ListChecks, render: () => <StartPage /> },
  today: { label: "nav.today", sub: "navSub.today", icon: Inbox, render: () => <TodayInboxPage /> },
  overview: { label: "nav.overview", sub: "navSub.overview", icon: LayoutGrid, render: () => <OverviewPage /> },
  chat: { label: "nav.chat", sub: "navSub.chat", icon: MessagesSquare, render: () => <ChatPage /> },
  runs: { label: "nav.runs", sub: "navSub.runs", icon: Play, render: () => <RunsWorkPage /> },
  history: { label: "history.title", sub: "history.sub", icon: History, render: () => <HistoryPage /> },
  artifacts: { label: "artifacts.page", sub: "artifacts.sub", icon: Package, render: () => <ArtifactsPage /> },
  docs: { label: "nav.docs", sub: "navSub.docs", icon: BookOpen, render: () => <KnowledgePage page="docs" /> },
  // Not in the sidebar: a doc's reading view (#/read?doc=…), under Tài liệu.
  read: { label: "nav.read", sub: "navSub.read", icon: BookOpen, render: () => <DocReaderPage /> },
  features: { label: "nav.features", sub: "navSub.features", icon: Layers, render: () => <FeaturesPage /> },
  skills: { label: "nav.skills", sub: "navSub.skills", icon: Sparkles, render: () => <KnowledgePage page="skills" /> },
  // #/proposals leads to the pending tab of Tài liệu or Skill (lib/route.ts); the page stays for the type of the menu.
  proposals: { label: "nav.proposals", sub: "navSub.proposals", icon: GitPullRequestArrow, render: () => <ProposalsPage /> },
  memory: { label: "nav.memory", sub: "navSub.memory", icon: Brain, render: () => <KnowledgePage page="memory" /> },
  tasks: { label: "nav.tasks", sub: "navSub.tasks", icon: SquareKanban, render: () => <TaskWorkPage /> },
  graph: { label: "nav.graph", sub: "navSub.graph", icon: Network, render: () => <Suspense fallback={null}><GraphPage /></Suspense> },
  machines: { label: "nav.machines", sub: "navSub.machines", icon: Cpu, render: () => <MachinesAgentsPage /> },
  pipeline: { label: "nav.pipeline", sub: "navSub.pipeline", icon: GitMerge, render: () => <WorkspaceAcceptance /> },
  settings: { label: "nav.settings", sub: "navSub.settings", icon: Settings2, render: () => <SettingsPage /> },
  admin: { label: "nav.admin", sub: "navSub.admin", icon: Shield, render: () => <AdminPage /> },
  // Not in the sidebar: the account menu opens it (roadmap 49b).
  tokens: { label: "nav.tokens", sub: "navSub.tokens", icon: KeyRound, render: () => <TokensPage /> },
  // The desktop app opens it (#/device?port=…) to get a token for its machine.
  device: { label: "nav.device", sub: "navSub.device", icon: Laptop, render: () => <DevicePage /> },
};

/** One shell for everyone, its menu by job since 49b (lib/nav.ts has it, with who sees what). */
const GROUPS = WEB_MENU as Array<{ label: MessageKey | null; ids: PageId[] }>;
const SHORTCUTS = WEB_SHORTCUTS as Partial<Record<PageId, string>>;
/** Not in the sidebar, still in the command palette: Token moved to the account menu on the web (roadmap 49b). */
const PALETTE_ONLY: PageId[] = ["start", "overview", "tokens"];

const HOME: PageId = "today";

/** The page the address bar means (lib/route.ts has the table), with an old address rewritten to the page it reaches. */
function readHash(): PageId | null {
  const { id, hash } = resolveHash(window.location.hash, { local: false, web: true, isPage: (page) => page in PAGES });
  if (hash) window.history.replaceState(null, "", hash);
  return (id as PageId | null) ?? null;
}

export function WebApp(props: { client: HiveClient; onSignOut?: () => void }) {
  return (
    <AppBoot client={props.client} onSignOut={props.onSignOut}>
      {(me) => <Workspace client={props.client} me={me} onSignOut={props.onSignOut} />}
    </AppBoot>
  );
}

function Workspace({ client, me, onSignOut }: { client: HiveClient; me: Me; onSignOut?: () => void }) {
  const t = useT();
  // Operations and administration read what every machine reported to the hub: hub admins only.
  const hubAdmin = me.mode === "hub" && me.role === "admin" && !me.access;
  const [page, setPage] = useState<PageId>(() => readHash() ?? HOME);
  const [tick, setTick] = useState(0);
  const bump = useCallback(() => setTick((n) => n + 1), []);
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
  // Archived and deleted projects (roadmap 47): a grant outlives the project it was given on.
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

  useEffect(() => {
    const onHash = () => setPage(readHash() ?? HOME);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const visible = useMemo(() => {
    // Quản trị › Tổng quan vận hành is the same picture for every project; the members' Tổng quan stays for the others.
    const ids = new Set<PageId>([...webPages(me, projects, webCaps(client)), "read", "start", "overview"]);
    // Everyone with an account manages their own tokens (machines, CI), from the account menu; admins see all.
    if (client.tokens && (hubAdmin || me.user)) ids.add("tokens");
    if (client.device && me.user) ids.add("device");
    return ids;
  }, [client, me, hubAdmin, projects]);

  const inbox = useInboxState(client, me, scope, tick);

  // What the operations entries count: only loaded for hub admins.
  const poll = usePoll(hubAdmin ? 30_000 : null);
  const adminRequests = useQuery(async () => (hubAdmin ? client.call("runs.requests", { limit: 200 }) : []), [client, hubAdmin, poll]);
  const adminMachines = useQuery(async () => (hubAdmin ? client.call("admin.machines", {}) : []), [client, hubAdmin, poll]);
  const adminPolicy = useQuery(async () => (hubAdmin ? client.call("policy.get", {}) : null), [client, hubAdmin]);
  const adminAlerts = useQuery(async () => (hubAdmin && client.alerts ? client.alerts.list().catch(() => null) : null), [client, hubAdmin, poll]);
  // Tools a project requires count as missing items too (roadmap 28b-2); a hub before the catalog has no tools.list.
  const adminTools = useQuery(async () => (hubAdmin ? client.call("tools.list", {}).catch((): ToolView[] => []) : []), [client, hubAdmin]);

  // History readers may open a thread without permission to start a chat; chat.get still checks its project.
  const readingThread = page === "chat" && visible.has("history") && /^\d+$/.test(hashParam("thread") ?? "");
  const current: PageId = visible.has(page) || readingThread ? page : HOME;
  const lacking = adminPolicy.data ? (adminMachines.data ?? []).filter((m) => m.setup && missingRequired(adminPolicy.data!, m.setup, adminTools.data ?? []).length > 0).length : 0;
  const openAlerts = adminAlerts.data?.open ?? [];
  const counts: Partial<Record<PageId, number>> = {
    today: inbox.items.length,
    // Máy & agent counts requests waiting, machines lacking something or twice; Quản trị the open alerts (49b).
    machines: (adminRequests.data ?? []).filter((r) => r.status === "pending").length + lacking + (adminMachines.data ?? []).filter((m) => m.duplicate).length,
    admin: openAlerts.length,
  };
  // Filled: what waits for you, and alerts the hub rates high.
  const strong = (id: PageId) => id === "today" || (id === "admin" && openAlerts.some((a) => a.severity === "high"));
  const runTick = usePoll(visible.has("runs") ? 4000 : null);
  const activeRuns = useQuery(async () => {
    if (!visible.has("runs") || scope.kind === "shared") return null;
    const result = await client.call("runs.count", { project: scopeProject(scope) ?? undefined, projects: scopeProjects(scope) ?? undefined });
    return { scope: scopeKey(scope), ...result };
  }, [client, visible.has("runs"), scopeKey(scope), runTick, tick]);
  counts.runs = !activeRuns.error && activeRuns.data?.scope === scopeKey(scope) ? activeRuns.data.running : 0;
  const label = (id: PageId): MessageKey => (id === "artifacts" ? "shell.artifacts" : PAGES[id].label);
  const groups: NavGroup[] = GROUPS.map((g) => ({
    label: g.label ? t(g.label) : null,
    items: g.ids
      .filter((id) => visible.has(id))
      .map((id) => ({
        id,
        label: t(label(id)),
        icon: PAGES[id].icon,
        shortcut: SHORTCUTS[id],
        badge: counts[id] ? { count: counts[id]!, strong: strong(id) } : undefined,
      })),
  })).filter((g) => g.items.length > 0);
  const extraPages: NavEntry[] = PALETTE_ONLY.filter((id) => visible.has(id)).map((id) => ({ id, label: t(PAGES[id].label), icon: PAGES[id].icon }));
  const subtitle = current === "runs" ? t("navSub.running") : t(PAGES[current].sub);
  const hashQuery = new URLSearchParams(window.location.hash.split("?")[1]);

  return (
    <HiveContext.Provider value={{ client, me: withSystems, bump, scope, setScope, projects, systems }}>
      <TooltipProvider>
        <TerminalProvider>
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
            >
              <PageBoundary page={current}>
                {current === "today" ? <WebTodayPage inboxView={hashQuery.has("item") || hashQuery.get("section") === "inbox"} /> : PAGES[current].render()}
              </PageBoundary>
            </ClientShell>
          </InboxProvider>
        </TerminalProvider>
      </TooltipProvider>
    </HiveContext.Provider>
  );
}
