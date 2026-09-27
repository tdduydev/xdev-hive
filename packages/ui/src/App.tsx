import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { HiveClient } from "./client.ts";
import { Badge, ErrorNote, HiveLogo, STATUS_TONE } from "./components/ui.tsx";
import { HiveContext, useQuery } from "./hooks.ts";
import { AgentsPage } from "./pages/Agents.tsx";
import { BoardPage } from "./pages/Board.tsx";
import { DocsPage } from "./pages/Docs.tsx";
import { MachinesPage } from "./pages/Machines.tsx";
import { MemoryPage } from "./pages/Memory.tsx";
import { ProjectsPage } from "./pages/Projects.tsx";
import { ProposalsPage } from "./pages/Proposals.tsx";
import { SetupPage } from "./pages/Setup.tsx";
import { TasksPage } from "./pages/Tasks.tsx";
import { TokensPage } from "./pages/Tokens.tsx";

type PageId = "board" | "docs" | "proposals" | "memory" | "tasks" | "agents" | "machines" | "tokens" | "setup" | "projects";

const PAGES: Record<PageId, { label: string; render: () => ReactNode }> = {
  board: { label: "Board", render: () => <BoardPage /> },
  agents: { label: "Gói sub & agent", render: () => <AgentsPage /> },
  docs: { label: "Tài liệu", render: () => <DocsPage /> },
  proposals: { label: "Đề xuất", render: () => <ProposalsPage /> },
  memory: { label: "Memory", render: () => <MemoryPage /> },
  tasks: { label: "Task", render: () => <TasksPage /> },
  machines: { label: "Máy & run", render: () => <MachinesPage /> },
  tokens: { label: "Token", render: () => <TokensPage /> },
  setup: { label: "Cài đặt máy", render: () => <SetupPage /> },
  projects: { label: "Dự án & cài đặt", render: () => <ProjectsPage /> },
};

function readHash(): PageId | null {
  const id = window.location.hash.replace(/^#\/?/, "");
  return id in PAGES ? (id as PageId) : null;
}

export function HiveApp({ client, onSignOut }: { client: HiveClient; onSignOut?: () => void }) {
  const me = useQuery(() => client.me(), [client]);
  const home: PageId = client.desktop ? "board" : "docs";
  const [page, setPage] = useState<PageId>(() => readHash() ?? home);
  const [tick, setTick] = useState(0);
  const bump = useCallback(() => setTick((t) => t + 1), []);
  const pending = useQuery(() => client.call("proposals.list", { status: "pending" }), [client, tick, page]);
  // Checked when the app opens (and after leaving the setup page), so the sidebar shows what is missing.
  const setup = useQuery(async () => (client.desktop ? client.desktop.setupStatus() : null), [client, page === "setup"]);

  useEffect(() => {
    const onHash = () => setPage(readHash() ?? home);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [home]);

  const nav = useMemo(() => {
    const ids: PageId[] = client.desktop ? ["board", "docs", "proposals", "memory", "tasks", "agents"] : ["docs", "proposals", "memory", "tasks"];
    // Machines only report to a hub; a local database never has any.
    if (me.data?.mode === "hub") ids.push("machines");
    if (client.tokens && me.data?.role === "admin") ids.push("tokens");
    if (client.desktop) ids.push("setup", "projects");
    return ids;
  }, [client, me.data?.role, me.data?.mode]);

  if (me.error) {
    return (
      <div className="center-screen">
        <ErrorNote error={me.error} />
        {onSignOut ? (
          <button className="btn" onClick={onSignOut}>
            Đăng nhập lại
          </button>
        ) : null}
      </div>
    );
  }
  if (!me.data) return <div className="center-screen muted">Đang kết nối…</div>;

  const current = nav.includes(page) ? page : home;
  const pendingCount = pending.data?.length ?? 0;
  const setupCount = setup.data ? [...setup.data.machine, ...setup.data.projects.flatMap((p) => p.items)].filter((i) => i.state !== "installed").length : 0;

  return (
    <HiveContext.Provider value={{ client, me: me.data, bump }}>
      <div className="shell">
        <aside className="sidebar">
          <div className="brand">
            <HiveLogo />
            <span>xDev Hive</span>
          </div>
          <nav className="nav" aria-label="Điều hướng">
            {nav.map((id) => (
              <a
                key={id}
                href={`#/${id}`}
                className={`nav-item ${current === id ? "active" : ""}`}
                aria-current={current === id ? "page" : undefined}
              >
                <span className="grow">{PAGES[id].label}</span>
                {id === "proposals" && pendingCount > 0 ? <span className="count">{pendingCount}</span> : null}
                {id === "setup" && setupCount > 0 ? <span className="count">{setupCount}</span> : null}
              </a>
            ))}
          </nav>
          <div className="whoami">
            <div className="row gap-s">
              <span className="grow ellipsis">{me.data.name}</span>
              <Badge tone={STATUS_TONE[me.data.role]}>{me.data.role}</Badge>
            </div>
            <div className="muted small">{me.data.mode === "hub" ? "Hub dùng chung" : "Cục bộ trên máy này"}</div>
            {onSignOut ? (
              <button className="btn btn-small btn-ghost" onClick={onSignOut}>
                Đăng xuất
              </button>
            ) : null}
          </div>
        </aside>
        <main className="main">{PAGES[current].render()}</main>
      </div>
    </HiveContext.Provider>
  );
}
