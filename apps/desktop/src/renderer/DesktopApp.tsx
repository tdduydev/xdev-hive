// The desktop app's root (roadmap 76h): on a hub it is the machine's work and nothing else; the rest is the hub's web.
// Without a hub it is still the whole former app (LocalApp), for now: that goes when 76i embeds the hub.
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { TooltipProvider } from "@xdev-hive/ui/components/ui/tooltip";
import { PageBoundary } from "@xdev-hive/ui/components/ErrorBoundary";
import type { Me } from "@xdev-hive/core";
import { useT, type HiveClient } from "@xdev-hive/ui";
import { HiveContext, useProjectList, usePoll, useQuery } from "@xdev-hive/ui/hooks";
import { ALL } from "@xdev-hive/ui/lib/scope";
import { remainingSteps, shouldOpenStartGuide, startSteps } from "@xdev-hive/ui/lib/start";
import { AppBoot, Centered } from "@xdev-hive/ui/shell/boot";
import { AgentsPage } from "@xdev-hive/ui/pages/Agents";
import { RunsPage } from "@xdev-hive/ui/pages/Runs";
import { SetupPage } from "@xdev-hive/ui/pages/Setup";
import { ProjectsPage } from "@xdev-hive/ui/pages/Projects";
import { StartPage } from "@xdev-hive/ui/pages/Start";
import { DesktopShell } from "./DesktopShell.tsx";
import { DESK_HOME, DESK_LABEL, DESK_SUB, resolveDeskHash, webTarget, type DeskPage } from "./desk-nav.ts";
import { MachinePage } from "./pages/MachinePage.tsx";
import { WorktreesPage } from "./pages/WorktreesPage.tsx";

// TEMPORARY (until 76i): the app without a hub. A chunk of its own, so the app on a hub bundles none of it, nor the
// web's pages (Quản trị and the rest) it carries.
const LocalApp = lazy(() => import("@xdev-hive/ui/local").then((m) => ({ default: m.LocalApp })));

const PAGES: Record<DeskPage, () => ReactNode> = {
  start: () => <StartPage />,
  machine: () => <MachinePage />,
  agents: () => <AgentsPage />,
  runs: () => <RunsPage />,
  worktrees: () => <WorktreesPage />,
  setup: () => <SetupPage />,
  settings: () => <ProjectsPage />,
};

export function DesktopApp({ client }: { client: HiveClient }) {
  return (
    <AppBoot client={client}>
      {(me) =>
        me.mode === "hub" ? (
          <Machine client={client} me={me} />
        ) : (
          <Suspense fallback={<LocalFallback />}>
            <LocalApp client={client} />
          </Suspense>
        )
      }
    </AppBoot>
  );
}

function LocalFallback() {
  const t = useT();
  return <Centered>{t("app.connecting")}</Centered>;
}

/** The page the address bar means, with an old address rewritten to the page it reaches (desk-nav.ts has the table). */
function readHash(): DeskPage {
  const hash = window.location.hash;
  const page = resolveDeskHash(hash);
  if (!page) return DESK_HOME;
  const wanted = hash.replace(/^#\/?/, "").split(/[?/]/)[0]!;
  if (wanted !== page) window.history.replaceState(null, "", `#/${page}${hash.includes("?") ? hash.slice(hash.indexOf("?")) : ""}`);
  return page;
}

function Machine({ client, me }: { client: HiveClient; me: Me }) {
  const t = useT();
  const desktop = client.desktop!;
  const initialHash = useRef(window.location.hash);
  const [page, setPage] = useState<DeskPage>(readHash);
  const [tick, setTick] = useState(0);
  const bump = useCallback(() => setTick((n) => n + 1), []);
  const projects = useProjectList(client, tick);
  const webUrl = useQuery(async () => (await desktop.settings()).hubUrl.replace(/\/+$/, "") || null, [desktop]).data ?? null;
  // Checked when the app opens (and after leaving Công cụ & setup), so the menu says what is missing.
  const setup = useQuery(() => desktop.setupStatus(), [desktop, page === "setup"]);
  const runTick = usePoll(4000);
  const runs = useQuery(async () => desktop.runsCount?.() ?? null, [desktop, runTick, tick]);

  // A first run opens the guide, unless the address already names a place (a browser sign-in comes back to one).
  const initialStart = useQuery(async () => {
    const [settings, report, profiles] = await Promise.all([desktop.settings(), desktop.setupStatus(), desktop.profiles()]);
    return remainingSteps(startSteps(settings, report, profiles)) > 0;
  }, [desktop]);
  const startChecked = useRef(false);
  useEffect(() => {
    if (initialStart.data === undefined || startChecked.current) return;
    startChecked.current = true;
    if (initialStart.data && shouldOpenStartGuide(initialHash.current, window.location.hash)) window.location.hash = "/start";
  }, [initialStart.data]);

  // An address that is the hub's web (a link inside a page, #/tasks…) opens there instead of here.
  const away = useRef(webUrl);
  away.current = webUrl;
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const href = (e.target as HTMLElement | null)?.closest?.("a[href^='#/']")?.getAttribute("href");
      const url = href ? webTarget(away.current, href) : null;
      if (!url) return;
      e.preventDefault();
      window.open(url, "_blank");
    };
    let last = window.location.hash;
    const onHash = () => {
      const hash = window.location.hash;
      const url = webTarget(away.current, hash);
      if (url) {
        window.open(url, "_blank");
        window.history.replaceState(null, "", last || `#/${DESK_HOME}`);
        return;
      }
      last = hash;
      setPage(readHash());
    };
    document.addEventListener("click", onClick, true);
    window.addEventListener("hashchange", onHash);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("hashchange", onHash);
    };
  }, []);

  const counts: Partial<Record<DeskPage, number>> = {
    setup: setup.data ? [...setup.data.machine, ...setup.data.projects.flatMap((p) => p.items)].filter((i) => i.state !== "installed").length : 0,
    runs: runs.data?.running ?? 0,
  };
  // The machine's pages read a scope and a project list through the context; the hub's systems and scope switcher are the web's.
  const context = useMemo(() => ({ client, me, bump, scope: ALL, setScope: () => undefined, projects, systems: [] }), [client, me, bump, projects]);

  return (
    <HiveContext.Provider value={context}>
      <TooltipProvider>
        <DesktopShell client={client} me={me} current={page} title={t(DESK_LABEL[page])} subtitle={t(DESK_SUB[page])} webUrl={webUrl} counts={counts}>
          <PageBoundary page={page}>{PAGES[page]()}</PageBoundary>
        </DesktopShell>
      </TooltipProvider>
    </HiveContext.Provider>
  );
}
