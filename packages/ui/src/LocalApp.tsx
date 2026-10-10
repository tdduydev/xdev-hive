import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import { TerminalProvider } from "#ui/components/RemoteTerminal.tsx";
import { BookOpen, Bot, Boxes, Brain, FolderGit2, GitPullRequestArrow, Inbox, LayoutGrid, ListChecks, MessagesSquare, Play, Sparkles, SquareKanban, SquareTerminal } from "lucide-react";
import { TooltipProvider } from "@xdev-hive/ui/components/ui/tooltip";
import { withSystemGrants, type Me } from "@xdev-hive/core";
import type { HiveClient } from "./client.ts";
import { PageBoundary } from "./components/ErrorBoundary.tsx";
import { HiveContext, useProjectList, useQuery, usePoll, useRetiredProjects } from "./hooks.ts";
import { activeIntl, useT, type MessageKey } from "./i18n/index.tsx";
import { resolveHash } from "./lib/route.ts";
import { readScope, resolveScope, scopeKey, scopeProject, scopeProjects, scopeTitle, writeScope, type Scope } from "./lib/scope.ts";
import { LocalShell, type NavEntry, type NavGroup } from "./shell/LocalShell.tsx";
import { AppBoot } from "./shell/boot.tsx";
import { InboxProvider, useInboxState } from "./shell/inbox.tsx";
import { AgentsPage } from "./pages/Agents.tsx";
import { ChatPage } from "./pages/Chat.tsx";
import { KnowledgePage } from "#ui/pages/Sections.tsx";
import { OverviewPage } from "./pages/Overview.tsx";
import { ProjectsPage } from "./pages/Projects.tsx";
import { ProposalsPage } from "./pages/Proposals.tsx";
import { RunsPage } from "./pages/Runs.tsx";
import { SetupPage } from "./pages/Setup.tsx";import { SpecsPage } from "./pages/Specs.tsx";
import { SystemsPage } from "./pages/Systems.tsx";
import { TaskWorkPage } from "./pages/Tasks.tsx";
import { TodayInboxPage as TodayPage } from "./pages/Today.tsx";
import { DocReaderPage } from "./pages/DocReader.tsx";
import { StartPage } from "#ui/pages/Start.tsx";
import { remainingSteps, shouldOpenStartGuide, startSteps } from "#ui/lib/start.ts";

/** The pages of this machine on its own; the web and the app on a hub have registries of their own. */
type PageId =
  | "start"
  | "today"
  | "overview"
  | "chat"
  | "runs"
  | "docs"
  | "read"
  | "specs"
  | "skills"
  | "proposals"
  | "memory"
  | "tasks"
  | "agents"
  | "setup"
  | "projects"
  | "systems";
type Icon = ComponentType<{ className?: string }>;

const PAGES: Record<PageId, { label: MessageKey; sub: MessageKey; icon: Icon; render: () => ReactNode }> = {
  start: { label: "start.title", sub: "start.sub", icon: ListChecks, render: () => <StartPage /> },
  today: { label: "nav.today", sub: "navSub.today", icon: Inbox, render: () => <TodayPage /> },
  overview: { label: "nav.overview", sub: "navSub.overview", icon: LayoutGrid, render: () => <OverviewPage /> },
  chat: { label: "nav.chat", sub: "navSub.chat", icon: MessagesSquare, render: () => <ChatPage /> },
  runs: { label: "nav.runs", sub: "navSub.runs", icon: Play, render: () => <RunsPage /> },
  docs: { label: "nav.docs", sub: "navSub.docs", icon: BookOpen, render: () => <KnowledgePage page="docs" /> },
  // Not in the sidebar: a doc's reading view (#/read?doc=…), under Tài liệu.
  read: { label: "nav.read", sub: "navSub.read", icon: BookOpen, render: () => <DocReaderPage /> },
  specs: { label: "nav.specs", sub: "navSub.specs", icon: ListChecks, render: () => <SpecsPage /> },
  skills: { label: "nav.skills", sub: "navSub.skills", icon: Sparkles, render: () => <KnowledgePage page="skills" /> },
  proposals: { label: "nav.proposals", sub: "navSub.proposals", icon: GitPullRequestArrow, render: () => <ProposalsPage /> },
  memory: { label: "nav.memory", sub: "navSub.memory", icon: Brain, render: () => <KnowledgePage page="memory" /> },
  tasks: { label: "nav.tasks", sub: "navSub.tasks", icon: SquareKanban, render: () => <TaskWorkPage /> },
  agents: { label: "nav.agents", sub: "navSub.agents", icon: Bot, render: () => <AgentsPage /> },
  setup: { label: "nav.setup", sub: "navSub.setup", icon: SquareTerminal, render: () => <SetupPage /> },
  projects: { label: "nav.projects", sub: "navSub.projects", icon: FolderGit2, render: () => <ProjectsPage /> },
  systems: { label: "nav.systems", sub: "navSub.systems", icon: Boxes, render: () => <SystemsPage /> },
};

/**
 * TEMPORARY (roadmap 76h, until 76i embeds the hub): the desktop app without a hub keeps the whole former app, so a
 * machine on its own still has its Task, docs, memory and chat. The hub's modes never reach this file: DesktopApp
 * (apps/desktop) draws the machine's work and WebApp (apps/web) the rest.
 */
const LOCAL_GROUPS: Array<{ label: MessageKey | null; ids: PageId[] }> = [
  { label: "workspace.work", ids: ["today", "tasks", "chat", "runs"] },
  { label: "workspace.space", ids: ["docs", "specs", "skills", "memory", "proposals"] },
  { label: "workspace.operations", ids: ["agents", "setup", "projects", "systems"] },
];
/** On this machine ⌘1–6 are its first six entries. */
const LOCAL_SHORTCUTS: Partial<Record<PageId, string>> = { today: "1", tasks: "2", runs: "3", docs: "4", agents: "5", setup: "6" };
/** Not in the sidebar, still in the command palette. */
const PALETTE_ONLY: PageId[] = ["start", "overview"];

type Route = { kind: "client"; id: PageId };
const HOME: Route = { kind: "client", id: "today" };

/** The page the address bar means (lib/route.ts has the table), with an old address rewritten to the page it reaches. */
function readHash(): Route | null {
  const { id, hash } = resolveHash(window.location.hash, { local: true, isPage: (page) => page in PAGES });
  if (hash) window.history.replaceState(null, "", hash);
  return id ? { kind: "client", id: id as PageId } : null;
}

export function LocalApp(props: { client: HiveClient; onSignOut?: () => void }) {
  return <AppBoot client={props.client} onSignOut={props.onSignOut}>{(me) => <Shell client={props.client} me={me} onSignOut={props.onSignOut} />}</AppBoot>;
}

function Shell({ client, me, onSignOut }: { client: HiveClient; me: Me; onSignOut?: () => void }) {
  const t = useT();
  const initialHash = useRef(window.location.hash);
  const [route, setRoute] = useState<Route>(() => readHash() ?? HOME);
  const [tick, setTick] = useState(0);
  const bump = useCallback(() => setTick((t) => t + 1), []);
  const seen = useProjectList(client, tick);
  const systemList = useQuery(() => client.call("systems.list", {}).catch(() => []), [client, tick]);
  const retired = useRetiredProjects(client, tick);
  const systems = useMemo(
    () => (systemList.data ?? []).map((s) => ({ ...s, projects: s.projects.filter((p) => !retired.has(p)) })).filter((s) => s.projects.length > 0),
    [systemList.data, retired],
  );
  const withSystems = useMemo(() => (me.access ? { ...me, access: withSystemGrants(me.access, systems) } : me), [me, systems]);
  const projects = useMemo(
    () => [...new Set([...seen, ...Object.keys(me.access?.projects ?? {}), ...systems.flatMap((s) => s.projects)])].filter((p) => !retired.has(p)).sort(),
    [seen, me.access, systems, retired],
  );
  const [picked, setScopeState] = useState<Scope>(readScope);
  const scope = useMemo(() => resolveScope(picked, systemList.data), [picked, systemList.data]);
  const setScope = useCallback((next: Scope) => {
    writeScope(next);
    setScopeState(next);
  }, []);
  const page = route.id;
  const pending = useQuery(async () => client.call("proposals.list", { status: "pending" }), [client, tick, route]);
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

  useEffect(() => {
    const onHash = () => setRoute(readHash() ?? HOME);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const visible = useMemo(() => {
    const ids = new Set<PageId>(["start", "today", "overview", "docs", "read", "specs", "skills", "proposals", "memory", "tasks", "systems", "agents", "setup", "projects", "runs"]);
    // An app before 48 has no bridge for its own leader chat.
    if (client.desktop?.chatMachine) ids.add("chat");
    return ids;
  }, [client]);

  const inbox = useInboxState(client, me, scope, tick);
  const machine = useQuery(async () => (client.desktop ? (await client.desktop.settings()).machine : null), [client]).data;

  const current: PageId = visible.has(route.id) ? route.id : "today";
  const counts: Partial<Record<PageId, number>> = {
    today: inbox.items.length,
    proposals: pending.data?.length ?? 0,
    setup: setup.data ? [...setup.data.machine, ...setup.data.projects.flatMap((p) => p.items)].filter((i) => i.state !== "installed").length : 0,
  };
  const runTick = usePoll(4000);
  const activeRuns = useQuery(async () => {
    if (scope.kind === "shared") return null;
    const result = await client.desktop?.runsCount?.({ project: scopeProject(scope) ?? undefined, projects: scopeProjects(scope) ?? undefined });
    return result ? { scope: scopeKey(scope), ...result } : null;
  }, [client, scopeKey(scope), runTick, tick]);
  counts.runs = !activeRuns.error && activeRuns.data?.scope === scopeKey(scope) ? activeRuns.data.running : 0;
  const groups: NavGroup[] = LOCAL_GROUPS.map((g) => ({
    label: g.label ? t(g.label) : null,
    items: g.ids
      .filter((id) => visible.has(id))
      .map((id) => ({
        id,
        label: t(PAGES[id].label),
        icon: PAGES[id].icon,
        shortcut: LOCAL_SHORTCUTS[id],
        badge: counts[id] ? { count: counts[id]!, strong: id === "today" } : undefined,
      })),
  })).filter((g) => g.items.length > 0);
  const extraPages: NavEntry[] = PALETTE_ONLY.filter((id) => visible.has(id)).map((id) => ({ id, label: t(PAGES[id].label), icon: PAGES[id].icon }));
  const today = new Date().toLocaleDateString(activeIntl(), { weekday: "long", day: "numeric", month: "long" });
  const subtitle =
    current === "today"
      ? t("inbox.subtitle", { date: today.charAt(0).toUpperCase() + today.slice(1) })
      : current === "runs"
        ? t("navSub.runsOn")
        : machine && current === "agents"
          ? t("navSub.agentsOn", { machine })
          : t(PAGES[current].sub);

  return (
    <HiveContext.Provider value={{ client, me: withSystems, bump, scope, setScope, projects, systems }}>
      <TooltipProvider>
        <TerminalProvider>
          <InboxProvider value={inbox}>
            <LocalShell
              client={client}
              me={me}
              onSignOut={onSignOut}
              groups={groups}
              extraPages={extraPages}
              current={current === "read" ? "docs" : current}
              title={t(PAGES[current].label)}
              scopeName={scope.kind === "system" || scope.kind === "project" ? scopeTitle(scope, systems) : null}
              subtitle={subtitle}
            >
              <PageBoundary page={current}>{PAGES[current].render()}</PageBoundary>
            </LocalShell>
          </InboxProvider>
        </TerminalProvider>
      </TooltipProvider>
    </HiveContext.Provider>
  );
}
