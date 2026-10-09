import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import { Download, ExternalLink, Layers3, LogOut, Menu, MessageSquare, Moon, PanelLeft, Plus, Search, Sun, UserRound, X } from "lucide-react";
import { cn } from "cn";
import type { AgentRun, Me } from "@xdev-hive/core";
import type { HiveClient } from "#ui/client.ts";
import { AccountMenu } from "#ui/components/Account.tsx";
import { HiveWordmark, XMark } from "#ui/components/Brand.tsx";
import darkWordmark from "#ui/assets/cosmic/xdev-hive-dark.svg";
import { ScopeSwitcher } from "#ui/components/ScopeSwitcher.tsx";
import { scopeId } from "#ui/lib/scope.ts";
import { Button } from "#ui/components/ui/button.tsx";
import { Sheet, SheetContent, SheetTitle } from "#ui/components/ui/sheet.tsx";
import { ChatSessionProvider, useChatSession } from "#ui/components/ChatSession.tsx";
import { LeaderChatPanel } from "#ui/shell/LeaderChatPanel.tsx";
import { useHive, usePoll, useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import { toggleTheme, useTheme } from "#ui/lib/theme.ts";
import { CommandPalette, type PaletteCommand } from "#ui/shell/CommandPalette.tsx";
import { NewTaskDialog } from "#ui/shell/NewTaskDialog.tsx";
import { NewWorkDialog } from "#ui/shell/NewWorkDialog.tsx";
import { InShellContext } from "#ui/shell/frame.ts";
import { useDocOutbox, useHubConnection } from "#ui/shell/connection.tsx";
import { ToastProvider } from "#ui/shell/toast.tsx";

type Icon = ComponentType<{ className?: string }>;

export interface NavEntry {
  id: string;
  label: string;
  icon: Icon;
  /** ⌘1–⌘6. */
  shortcut?: string;
  /** A count next to the label; `strong` fills it with the primary colour (things waiting for you). */
  badge?: { count: number; strong?: boolean };
}

export interface NavGroup {
  /** null: the first items, above any heading. */
  label: string | null;
  items: NavEntry[];
}

const SIDEBAR_KEY = "hive-sidebar";

function readSidebar(): boolean {
  try {
    const v = localStorage.getItem(SIDEBAR_KEY);
    if (v === "open") return true;
    if (v === "closed") return false;
  } catch {
    // Storage blocked: decide by width.
  }
  return typeof window === "undefined" || window.innerWidth >= 1024;
}

function useMedia(query: string): boolean {
  const [match, setMatch] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return match;
}

const mmss = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

export function ClientShell(props: Parameters<typeof ClientFrame>[0]) {
  return (
    <ToastProvider>
      <ChatSessionProvider><ClientFrame {...props} /></ChatSessionProvider>
    </ToastProvider>
  );
}

function ClientFrame({
  client,
  me,
  onSignOut,
  groups,
  extraPages = [],
  current,
  title,
  scopeName = null,
  subtitle,
  webUrl = null,
  children,
}: {
  client: HiveClient;
  me: Me;
  onSignOut?: () => void;
  groups: NavGroup[];
  /** Pages the palette can open that the sidebar does not list. */
  extraPages?: NavEntry[];
  current: string;
  title: string;
  /** The system (or `system › service`) in scope, before the page's name; null for all and shared (roadmap 40a). */
  scopeName?: string | null;
  subtitle: string;
  /** The hub's web, for the desktop app on a hub (roadmap 35a): new tasks and the rest of the work happen there. */
  webUrl?: string | null;
  children: ReactNode;
}) {
  const t = useT();
  const chat = useChatSession();
  const { scope } = useHive();
  const { theme } = useTheme();
  const narrow = useMedia("(max-width: 767px)");
  const [sidebar, setSidebarState] = useState(() => narrow ? false : readSidebar());
  const rail = !narrow && !sidebar;
  const mainRef = useRef<HTMLElement>(null);
  const sidebarTrigger = useRef<HTMLButtonElement>(null);
  const drawerReturnFocus = useRef<HTMLButtonElement>(null);
  const [palette, setPalette] = useState(false);
  const [newTask, setNewTask] = useState(false);
  useEffect(() => {
    setSidebarState(narrow ? false : readSidebar());
  }, [narrow]);
  const setSidebar = useCallback((open: boolean | ((was: boolean) => boolean)) => {
    setSidebarState((was) => {
      const next = typeof open === "function" ? open(was) : open;
      try {
        // Closing a phone drawer must not overwrite the desktop layout preference.
        if (!narrow) localStorage.setItem(SIDEBAR_KEY, next ? "open" : "closed");
      } catch {
        // Not remembered.
      }
      return next;
    });
  }, [narrow]);

  const desktop = client.desktop;
  const info = useQuery(async () => (desktop ? desktop.appInfo() : null), [desktop]);
  const settings = useQuery(async () => (desktop ? desktop.settings() : null), [desktop]);
  const mac = info.data?.platform === "darwin";

  // This machine's runs (sidebar card, status bar) and its subscriptions' usage (status bar).
  const fast = usePoll(desktop ? 4000 : null);
  const slow = usePoll(desktop ? 60_000 : null);
  const runs = useQuery(async () => (desktop ? desktop.runs({ limit: 50 }) : []), [desktop, fast]);
  const profiles = useQuery(async () => (desktop ? desktop.profiles() : []), [desktop, slow]);
  const running = useMemo(() => (runs.data ?? []).filter((r: AgentRun) => r.status === "running"), [runs.data]);
  const tick = usePoll(running.length ? 1000 : null);
  const now = useMemo(() => Date.now(), [tick, runs.data]); // eslint-disable-line react-hooks/exhaustive-deps

  // Is the hub answering (the web app is served by the hub, the desktop may be local), and the saves made without it.
  const hubMode = me.mode === "hub";
  const link = useHubConnection(client, me);
  useDocOutbox(client, !hubMode || link.state === "ok");
  const hubHost = link.host || (desktop ? hostOf(settings.data?.hubUrl ?? "") : window.location.host);

  // The app's own update (roadmap 22i): the hub offers a build, the main process downloads it.
  const updateTick = usePoll(desktop ? 5000 : null);
  const update = useQuery(async () => (desktop ? desktop.updateStatus().catch(() => null) : null), [desktop, updateTick]);
  const up = update.data;
  const [installing, setInstalling] = useState(false);
  const install = () => {
    if (!desktop) return;
    setInstalling(true);
    // Other kinds quit and relaunch; a deb only opens the system installer, which the person may also cancel.
    void desktop.installUpdate().then(() => { if (up?.updateKind === "deb") setInstalling(false); }, () => setInstalling(false));
  };

  const quota = useMemo(() => {
    let top: { id: string; percent: number; week: boolean } | null = null;
    for (const p of profiles.data ?? []) {
      const s = p.usage?.session?.percent;
      const w = p.usage?.week?.percent;
      for (const [percent, week] of [
        [s, false],
        [w, true],
      ] as const) {
        if (typeof percent === "number" && (!top || percent > top.percent)) top = { id: p.id, percent: Math.round(percent), week };
      }
    }
    return top;
  }, [profiles.data]);

  const items = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const go = useCallback(
    (id: string) => {
      window.location.hash = `#/${id}`;
      if (narrow) setSidebar(false);
    },
    [narrow, setSidebar],
  );

  const mobileItems = (desktop ? ["today", "tasks", "chat", "runs", "agents"] : ["today", "tasks", "chat", "pipeline"])
    .map((id) => items.find((item) => item.id === id))
    .filter((item): item is NavEntry => !!item)
    .slice(0, 4);

  // ⌘K palette · ⌘⇧L leader · ⌘B sidebar · ⌘N new task · ⌘1–6 pages.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      } else if (k === "l" && e.shiftKey) {
        e.preventDefault();
        chat.setPanelOpen((was) => !was);
      } else if (k === "b") {
        e.preventDefault();
        setSidebar((s) => !s);
      } else if (k === "n" && !e.shiftKey) {
        e.preventDefault();
        if (webUrl) window.open(`${webUrl}/#/tasks`, "_blank");
        else setNewTask(true);
      } else if (/^[1-6]$/.test(k)) {
        const hit = items.find((i) => i.shortcut === k);
        if (hit) {
          e.preventDefault();
          go(hit.id);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items, go, setSidebar, webUrl, chat.setPanelOpen]);

  const commands = useMemo<PaletteCommand[]>(
    () => [
      webUrl
        ? { id: "open-web", label: t("shell.openWeb"), icon: ExternalLink, run: () => void window.open(`${webUrl}/#/today`, "_blank") }
        : { id: "new-task", label: t(client.desktop ? "palette.newTask" : "newWork.title"), icon: Plus, hint: "⌘N", run: () => setNewTask(true) },
      { id: "chat-new", label: t("chat.new"), icon: MessageSquare, run: () => { chat.select(scopeId(scope), { kind: "new" }); go("chat?thread=new"); } },
      ...(current === "chat" || chat.panelOpen ? [{ id: "chat-find", label: t("chat.findLoaded"), icon: Search, run: () => { const id = chat.selections[scopeId(scope)]; if (id?.kind === "thread") { const key = `searchOpen:${id.id}`; chat.drafts.values.set(key, true); for (const listener of chat.drafts.listeners.get(key) ?? []) listener(); } } }] : []),
      { id: "ask-leader", label: t("chat.askLeader"), icon: MessageSquare, hint: "⌘⇧L", run: () => chat.setPanelOpen(true) },
      { id: "theme", label: t("palette.toggleTheme"), icon: theme === "dark" ? Sun : Moon, run: () => toggleTheme(theme) },
    ],
    [t, theme, webUrl, chat, scope, current, go],
  );
  const pages = useMemo<PaletteCommand[]>(
    () =>
      [...items, ...extraPages].map((i) => ({ id: i.id, label: t("palette.goToPage", { page: i.label }), icon: i.icon, hint: i.shortcut ? `⌘${i.shortcut}` : undefined, run: () => go(i.id) })),
    [items, extraPages, t, go],
  );

  const drag = mac ? "[-webkit-app-region:drag]" : "";
  const noDrag = mac ? "[-webkit-app-region:no-drag]" : "";
  const version = info.data?.version;
  const account = desktop && settings.data ? `${settings.data.machine}${version ? ` · v${version}` : ""}` : undefined;

  const sidebarToggle = (
    <button
      ref={sidebarTrigger}
      type="button"
      onClick={(event) => { drawerReturnFocus.current = event.currentTarget; setSidebar((s) => !s); }}
      aria-label={t("shell.toggleSidebar")}
      aria-expanded={sidebar}
      aria-controls="hive-navigation"
      title={t("shell.sidebarShortcut")}
      className={cn(
        "hive-sidebar-toggle grid size-8 max-md:size-11 shrink-0 cursor-pointer place-items-center rounded-sm text-fg-secondary outline-none hover:bg-hover hover:text-fg-strong focus-visible:focus-ring",
        noDrag,
      )}
    >
      <PanelLeft className="size-4" aria-hidden="true" />
    </button>
  );

  const nav = (
    <nav
      id="hive-navigation"
      aria-label={t("shell.nav")}
      className={cn(
        "hive-sidebar flex shrink-0 flex-col",
        rail && "hive-sidebar-rail",
        narrow && "h-full w-full border-r-0",
      )}
    >
      <div className={cn("hive-sidebar-brand flex shrink-0 items-center", rail && "justify-center px-0", mac && !rail && "hive-sidebar-brand-mac", drag)}>
        {rail ? (!mac ? <XMark size={24} /> : null) : theme === "dark" ? <img src={darkWordmark} alt="xDev Hive" className="h-[30px] w-auto" /> : <HiveWordmark height={30} />}
        {!narrow && !rail ? <div className={cn("ml-auto flex items-center", noDrag)}><Button variant="ghost" size="icon" aria-label={t("theme.toggle")} title={t("theme.toggle")} onClick={() => toggleTheme(theme)}>{theme === "dark" ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}</Button>{sidebarToggle}</div> : null}
        {narrow ? <button type="button" aria-label={t("shell.closeSidebar")} onClick={() => setSidebar(false)} className="ml-auto grid size-11 place-items-center rounded-sm text-fg-secondary"><X className="size-4" /></button> : null}
      </div>
      <div className={cn("hive-sidebar-scope shrink-0", noDrag)}>
        {rail ? <button type="button" onClick={() => setSidebar(true)} aria-label={t("shell.chooseScope")} title={scopeName ?? t("shell.chooseScope")} className="grid size-10 place-items-center rounded-md text-fg-secondary hover:bg-hover focus-visible:focus-ring"><Layers3 className="size-4" aria-hidden="true" /></button> : <ScopeSwitcher />}
      </div>
      {!rail ? <div className="workspace-new-work"><Button variant="solid" size="md" type="button" data-new-work-open={!narrow || undefined} onClick={() => setNewTask(true)} className="w-full">{t("shell.assignAgent")}</Button></div> : null}
      {/* data-nav-list: the smoke shot of the menu checks this is not scrolling (roadmap 39f). */}
      <div data-nav-list className="hive-sidebar-list flex min-h-0 flex-1 flex-col overflow-y-auto">
        {groups.map((g, gi) => (
          <div key={g.label ?? `g${gi}`} className="hive-nav-group flex flex-col">
            {g.label && !rail ? <div className="hive-nav-heading">{g.label}</div> : null}
            {g.items.map((item) => {
              const on = item.id === current;
              const Icon = item.icon;
              return (
                <a
                  key={item.id}
                  href={`#/${item.id}`}
                  onClick={() => narrow && setSidebar(false)}
                  aria-current={on ? "page" : undefined}
                  title={item.shortcut ? t("shell.shortcut", { label: item.label, key: item.shortcut }) : item.label}
                  className={cn(
                    "hive-nav-item flex max-md:min-h-11 shrink-0 items-center outline-none focus-visible:focus-ring active:bg-pressed",
                    rail && "relative justify-center px-0",
                    on ? "hive-nav-active" : "text-fg-secondary hover:bg-hover",
                  )}
                >
                  <Icon aria-hidden="true" className={cn("size-4 shrink-0", on ? "text-fg-brand" : "text-fg-muted")} />
                  <span className={rail ? "sr-only" : "min-w-0 flex-1 truncate"}>{item.label}</span>
                  {item.badge && item.badge.count > 0 ? (
                    <span
                      className={cn(
                        "hive-nav-count inline-grid place-items-center rounded-full",
                        rail && "absolute right-0 top-0",
                        item.badge.strong ? "bg-primary text-primary-foreground" : "text-fg-muted",
                      )}
                    >{item.badge.count}</span>
                  ) : null}
                  {!rail && item.shortcut ? <kbd className="hive-nav-shortcut">⌘{item.shortcut}</kbd> : null}
                </a>
              );
            })}
          </div>
        ))}
      </div>
      {desktop && !rail ? (
        <div className="mx-2.5 mb-2.5 flex shrink-0 flex-col gap-px rounded-md border border-line-subtle bg-surface px-1.5 pt-2 pb-1.5">
          <a
            href="#/runs"
            className="flex max-md:min-h-11 items-center gap-1.5 px-1 pb-1 text-xs/4 font-semibold text-fg-strong outline-none focus-visible:focus-ring"
          >
            <span className={cn("size-[7px] rounded-full", running.length ? "bg-success-solid" : "bg-neutral-solid")} />
            {running.length ? t("shell.runsHere", { count: running.length }) : t("shell.noRunsHere")}
          </a>
          {running.slice(0, 4).map((r) => (
            <a
              key={r.id}
              href={`#/runs?run=${encodeURIComponent(r.id)}`}
              title={r.activity ?? r.taskTitle}
              className="grid h-6 max-md:h-11 grid-cols-[44px_minmax(0,1fr)_auto] items-center gap-1.5 rounded-xs px-1 text-xs/none text-fg-secondary hover:bg-hover"
            >
              <span className="truncate font-mono text-[11px]/none font-medium text-fg-brand">{r.taskId}</span>
              <span className="truncate">{r.profileId ?? "—"}</span>
              <span className="font-mono text-[11px]/none text-fg-muted">{r.startedAt ? mmss(now - Date.parse(r.startedAt)) : ""}</span>
            </a>
          ))}
        </div>
      ) : null}
      <div className={cn("hive-sidebar-account flex shrink-0 items-center gap-1", rail && "flex-col", noDrag)}>
        {rail ? <button type="button" onClick={() => setSidebar(true)} aria-label={t("shell.account")} title={t("shell.account")} className="grid size-10 place-items-center rounded-md text-fg-secondary hover:bg-hover focus-visible:focus-ring"><UserRound className="size-4" aria-hidden="true" /></button> : <AccountMenu client={client} me={me} onSignOut={onSignOut} subtitle={account} connected={hubMode ? link.state === "ok" : undefined} onNavigate={() => narrow && setSidebar(false)} />}
        {narrow || rail ? <Button variant="ghost" size="icon" className="max-md:size-11" onClick={() => toggleTheme(theme)} aria-label={t("theme.toggle")} title={t("theme.toggle")}>
          {theme === "dark" ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
        </Button> : null}
        {!rail && onSignOut ? <Button variant="ghost" size="icon" className="max-md:size-11" onClick={onSignOut} aria-label={t("account.signOut")} title={t("account.signOut")}><LogOut className="size-[15px]" aria-hidden="true" /></Button> : null}
      </div>
    </nav>
  );

  const statusItem = (key: string, label: string, dot: string | null, opts: { href?: string; title?: string; mono?: boolean } = {}) => {
    const body = (
      <>
        {dot ? <span className={cn("size-[7px] shrink-0 rounded-full", dot)} /> : null}
        <span className="truncate">{label}</span>
      </>
    );
    const cls = cn(
      "inline-flex h-5 min-w-0 items-center gap-[5px] rounded-xs px-1.5 whitespace-nowrap text-fg-secondary",
      opts.mono ? "font-mono text-[11px]/none" : "text-[11px]/none",
      opts.href && "hover:bg-hover",
    );
    return opts.href ? (
      <a key={key} href={opts.href} title={opts.title} className={cls}>
        {body}
      </a>
    ) : (
      <span key={key} title={opts.title} className={cls}>
        {body}
      </span>
    );
  };

  return (
    <>
      <div data-workspace-web={!desktop || undefined} data-workspace-page={current} inert={narrow && sidebar} className="hive-shell fixed inset-0 flex flex-col bg-surface text-fg-primary">
        <a href="#hive-main" onClick={(event) => { event.preventDefault(); mainRef.current?.focus(); }} className="hive-skip-link">{t("shell.skipToContent")}</a>
        <div className="flex min-h-0 flex-1">
          {!narrow ? nav : null}
          <div className="relative flex min-w-0 flex-1 flex-col">
            <header className={cn("hive-topbar hive-main-topbar flex min-w-0 shrink-0 items-center", drag, mac && rail && "pl-4")}>
              {narrow || rail ? sidebarToggle : null}
              <div className="hive-topbar-title flex min-w-0 flex-1 flex-col">
                {scopeName ? <span className="truncate text-fg-muted">{scopeName}</span> : null}
                <h1 className="truncate text-fg-strong" data-shell-title>{title}</h1>
              </div>
              <button type="button" onClick={() => setPalette(true)} aria-label={t("shell.search")} className={cn("ml-auto grid size-11 shrink-0 place-items-center rounded-sm text-fg-secondary md:hidden", noDrag)}>
                <Search className="size-4" />
              </button>
              <button
                type="button"
                onClick={() => setPalette(true)}
                className={cn(
                  "hive-topbar-search hidden min-w-[120px] shrink cursor-pointer items-center text-fg-muted outline-none focus-visible:focus-ring md:flex",
                  noDrag,
                )}
              >
                <Search className="size-[15px] shrink-0" />
                <span className="min-w-0 flex-1 truncate text-left">{t("shell.search")}</span>
                <kbd className="hive-search-key">⌘K</kbd>
              </button>
              {up?.state === "ready" && up.version ? (
                <button
                  type="button"
                  onClick={install}
                  disabled={installing || up.idleState === "waiting"}
                  title={up.notes ?? undefined}
                  className={cn(
                    "mr-1.5 flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-success-line bg-success-soft px-2.5 text-xs/none font-semibold whitespace-nowrap text-success outline-none focus-visible:focus-ring disabled:opacity-70",
                    noDrag,
                  )}
                >
                  <Download className="size-3.5" />
                  {installing ? t("shell.updateInstalling", { version: up.version }) : up.idleState === "waiting" ? t("shell.updateWaiting", { version: up.version }) : t(up.updateKind === "deb" ? "shell.updateReadyDeb" : "shell.updateReady", { version: up.version })}
                </button>
              ) : null}
              <Button
                variant="glass"
                size="md"
                type="button"
                data-ask-leader
                aria-expanded={chat.panelOpen}
                title={t("chat.askShortcut")}
                onClick={() => chat.setPanelOpen(true)}
                className={cn("hive-topbar-chat max-md:size-11 max-md:p-0", noDrag)}
              >
                <MessageSquare className="size-4 md:hidden" aria-hidden />
                <span className="max-md:sr-only">{t("shell.chatLeader")}</span>
              </Button>
              {webUrl ? (
                <a
                  href={`${webUrl}/#/today`}
                  target="_blank"
                  rel="noreferrer"
                  title={t("shell.openWebHint")}
                  data-open-web
                  className={cn(
                    "flex h-[30px] max-md:size-11 shrink-0 cursor-pointer items-center gap-1.5 rounded-sm bg-primary pr-3 pl-2.5 max-md:justify-center max-md:p-0 text-xs/none font-semibold whitespace-nowrap text-primary-foreground no-underline outline-none hover:bg-primary-hover focus-visible:focus-ring",
                    noDrag,
                  )}
                >
                  <ExternalLink className="size-3.5" strokeWidth={2} />
                  <span className="max-md:sr-only">{t("shell.openWeb")}</span>
                </a>
              ) : narrow ? (
                <Button
                  variant="solid"
                  size="icon"
                  type="button"
                  data-new-work-open
                  onClick={() => setNewTask(true)}
                  aria-label={t("shell.assignAgent")}
                  className="size-11"
                >
                  <Plus className="size-4" aria-hidden="true" />
                </Button>
              ) : null}
            </header>
            {link.state === "offline" || link.state === "refused" ? (
              <div role="status" className="flex shrink-0 items-center gap-2 border-b border-warning-line bg-warning-soft px-3.5 py-1.5 text-xs/4 font-medium text-fg-strong">
                <span className="min-w-0 flex-1">
                  {link.state === "refused"
                    ? t("shell.hubRefused", { host: hubHost, error: link.error ?? "" })
                    : desktop
                      ? t("shell.offlineBanner", { host: hubHost })
                      : t("shell.offlineBannerWeb", { host: hubHost })}
                </span>
                <button
                  type="button"
                  disabled={link.retrying}
                  onClick={link.retry}
                  className="h-6 shrink-0 cursor-pointer rounded-[5px] border border-warning-line bg-surface px-2.5 text-xs/none font-semibold text-fg-strong outline-none focus-visible:focus-ring disabled:opacity-70"
                >
                  {link.retrying ? t("shell.retrying") : t("shell.retry")}
                </button>
              </div>
            ) : null}
            <main id="hive-main" ref={mainRef} tabIndex={-1} aria-label={title} className="min-h-0 min-w-0 flex-1 overflow-y-auto max-md:overflow-x-hidden">
              <InShellContext.Provider value={true}>{children}</InShellContext.Provider>
            </main>
          </div>
        </div>
        {narrow ? <nav aria-label={t("shell.quickNav")} className="hive-mobile-nav flex shrink-0 border-t border-line-subtle bg-surface">
          {mobileItems.map((item) => {
            const Icon = item.icon;
            return <a key={item.id} href={`#/${item.id}`} aria-current={current === item.id ? "page" : undefined} className={cn("flex min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-md px-1 py-2 text-xs/4 focus-visible:focus-ring active:bg-pressed", current === item.id ? "font-semibold text-fg-brand bg-selected" : "text-fg-secondary")}>
              <Icon className="size-5" aria-hidden="true" /><span className="max-w-full truncate">{item.label}</span>
            </a>;
          })}
          <button type="button" onClick={(event) => { drawerReturnFocus.current = event.currentTarget; setSidebar(true); }} aria-expanded={sidebar} aria-controls="hive-navigation" className={cn("flex min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-md px-1 py-2 text-xs/4 focus-visible:focus-ring active:bg-pressed", !mobileItems.some((item) => item.id === current) ? "font-semibold text-fg-brand bg-selected" : "text-fg-secondary")}><Menu className="size-5" aria-hidden="true" /><span>{t("shell.menu")}</span></button>
        </nav> : null}
        <footer className="hive-status-footer flex h-[26px] shrink-0 items-center gap-0.5 border-t border-line-subtle bg-subtle px-2 max-md:hidden">
          {hubMode
            ? statusItem(
                "hub",
                link.state === "offline" || link.state === "refused" ? t("shell.hubOffline") : hubHost,
                link.state === "ok" ? "bg-success-solid" : link.state === "unknown" ? "bg-neutral-solid" : "bg-warning-solid",
                { title: link.error ?? t("shell.hubTip", { host: hubHost }) },
              )
            : statusItem("hub", t("shell.local"), "bg-neutral-solid")}
          {desktop
            ? statusItem("runs", t("shell.runsHereShort", { count: running.length }), running.length ? "bg-info-solid" : "bg-neutral-solid", {
                href: "#/runs",
                title: t("shell.openRuns"),
              })
            : null}
          <span className="flex-1" />
          {quota
            ? statusItem(
                "quota",
                t(quota.week ? "shell.quotaWeek" : "shell.quota", { profile: quota.id, percent: quota.percent }),
                quota.percent >= 85 ? "bg-warning-solid" : "bg-success-solid",
                { href: "#/agents", title: t("shell.openAgents"), mono: true },
              )
            : null}
          {up?.state === "downloading" && up.version
            ? statusItem("version", t("shell.updateDownloading", { version: up.version, percent: up.percent ?? 0 }), null, { title: t("shell.version"), mono: true })
            : up?.state === "ready" && up.version
              ? statusItem("version", t(up.idleState === "waiting" ? "shell.updateWaiting" : up.idleState === "retry" ? "shell.updateRetry" : "shell.updateReadyShort", { version: up.version }), "bg-success-solid", { title: up.notes ?? t("shell.version"), mono: true })
              : up?.state === "failed"
                ? statusItem("version", `v${version ?? "?"} · ${t("shell.updateFailed")}`, "bg-danger-solid", { title: up.error ?? undefined, mono: true })
                : version
                  ? statusItem("version", `v${version}`, null, { title: t("shell.version"), mono: true })
                  : null}
        </footer>
      </div>
      {narrow ? (
        <Sheet open={sidebar} onOpenChange={setSidebar}>
          <SheetContent
            side="left"
            showCloseButton={false}
            aria-describedby={undefined}
            className="hive-navigation-drawer gap-0"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              (drawerReturnFocus.current ?? sidebarTrigger.current)?.focus();
            }}
          >
            <SheetTitle className="sr-only">{t("shell.nav")}</SheetTitle>
            {nav}
          </SheetContent>
        </Sheet>
      ) : null}
      <LeaderChatPanel />
      <CommandPalette open={palette} onOpenChange={setPalette} commands={commands} pages={pages} />
      {client.desktop ? <NewTaskDialog open={newTask} onOpenChange={setNewTask} /> : newTask ? <NewWorkDialog open onOpenChange={setNewTask} /> : null}
    </>
  );
}
