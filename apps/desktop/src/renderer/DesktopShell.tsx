// The desktop app's frame on a hub (roadmap 76h): the machine's menu, an "Mở trên web" group for everything the hub's
// web owns, the update and the hub's state. Same design system as the web shell (hive-* classes, ui-kit tokens), but
// plain: a 1100×720 window has no scope switcher, chat panel or phone drawer to carry.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Download, ExternalLink, LogOut, Moon, Search, Sun } from "lucide-react";
import { cn } from "@xdev-hive/ui-kit/lib/utils";
import type { Me } from "@xdev-hive/core";
import { useT, type HiveClient } from "@xdev-hive/ui";
import darkWordmark from "@xdev-hive/ui/assets/cosmic/xdev-hive-dark.svg";
import { AccountMenu } from "@xdev-hive/ui/components/Account";
import { HiveWordmark } from "@xdev-hive/ui/components/Brand";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { usePoll, useQuery } from "@xdev-hive/ui/hooks";
import { toggleTheme, useTheme } from "@xdev-hive/ui/lib/theme";
import { CommandPalette, type PaletteCommand } from "@xdev-hive/ui/shell/CommandPalette";
import { useHubConnection } from "@xdev-hive/ui/shell/connection";
import { InShellContext } from "@xdev-hive/ui/shell/frame";
import { ToastProvider } from "@xdev-hive/ui/shell/toast";
import { DESK_LABEL, DESK_MENU, DESK_SHORTCUTS, WEB_ENTRIES, type DeskPage } from "./desk-nav.ts";
import { DESK_ICONS } from "./desk-icons.ts";

export function DesktopShell(props: {
  client: HiveClient;
  me: Me;
  onSignOut?: () => void;
  current: DeskPage;
  title: string;
  subtitle: string;
  /** The hub's address, to open its web; null before the machine knows it. */
  webUrl: string | null;
  /** Counts on menu entries (what is missing in Công cụ & setup, runs going). */
  counts?: Partial<Record<DeskPage, number>>;
  children: ReactNode;
}) {
  return (
    <ToastProvider>
      <Frame {...props} />
    </ToastProvider>
  );
}

const openWeb = (webUrl: string | null, hash: string) => {
  if (webUrl) window.open(`${webUrl}/${hash}`, "_blank");
};

function Frame({ client, me, onSignOut, current, title, subtitle, webUrl, counts = {}, children }: Parameters<typeof DesktopShell>[0]) {
  const t = useT();
  const desktop = client.desktop!;
  const { theme } = useTheme();
  const mainRef = useRef<HTMLElement>(null);
  const [palette, setPalette] = useState(false);
  const info = useQuery(() => desktop.appInfo(), [desktop]).data;
  const settings = useQuery(() => desktop.settings(), [desktop]).data;
  const link = useHubConnection(client, me);
  const updateTick = usePoll(5000);
  const up = useQuery(async () => desktop.updateStatus().catch(() => null), [desktop, updateTick]).data;
  const [installing, setInstalling] = useState(false);
  const mac = info?.platform === "darwin";
  const drag = mac ? "[-webkit-app-region:drag]" : "";
  const noDrag = mac ? "[-webkit-app-region:no-drag]" : "";
  const version = info?.version;
  const hubHost = link.host || (settings?.hubUrl ? safeHost(settings.hubUrl) : "");

  const install = () => {
    setInstalling(true);
    // Other kinds quit and relaunch; a deb only opens the system installer, which the person may also cancel.
    void desktop.installUpdate().then(() => { if (up?.updateKind === "deb") setInstalling(false); }, () => setInstalling(false));
  };

  // ⌘K palette · ⌘1–6 the machine's pages.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      } else if (/^[1-6]$/.test(k)) {
        const hit = DESK_MENU.find((id) => DESK_SHORTCUTS[id] === k);
        if (hit) {
          e.preventDefault();
          window.location.hash = `#/${hit}`;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const commands = useMemo<PaletteCommand[]>(
    () => [
      ...(webUrl ? [{ id: "open-web", label: t("shell.openWeb"), icon: ExternalLink, run: () => openWeb(webUrl, "#/today") }] : []),
      { id: "theme", label: t("palette.toggleTheme"), icon: theme === "dark" ? Sun : Moon, run: () => toggleTheme(theme) },
    ],
    [t, theme, webUrl],
  );
  const pages = useMemo<PaletteCommand[]>(
    () => [
      ...DESK_MENU.map((id) => ({ id, label: t("palette.goToPage", { page: t(DESK_LABEL[id]) }), icon: DESK_ICONS[id], hint: `⌘${DESK_SHORTCUTS[id]}`, run: () => { window.location.hash = `#/${id}`; } })),
      ...(webUrl ? WEB_ENTRIES.map((e) => ({ id: `web-${e.id}`, label: t("desk.webItem", { page: t(e.label) }), icon: ExternalLink, run: () => openWeb(webUrl, e.hash) })) : []),
    ],
    [t, webUrl],
  );

  const offline = link.state === "offline" || link.state === "refused";

  return (
    <>
      <div data-desktop-shell data-workspace-page={current} className="hive-shell fixed inset-0 flex flex-col bg-surface text-fg-primary">
        <a href="#hive-main" onClick={(event) => { event.preventDefault(); mainRef.current?.focus(); }} className="hive-skip-link">{t("shell.skipToContent")}</a>
        <div className="flex min-h-0 flex-1">
          <nav id="hive-navigation" aria-label={t("shell.nav")} className="hive-sidebar flex shrink-0 flex-col">
            <div className={cn("hive-sidebar-brand flex shrink-0 items-center", mac && "hive-sidebar-brand-mac", drag)}>
              {theme === "dark" ? <img src={darkWordmark} alt="xDev Hive" className="h-[30px] w-auto" /> : <HiveWordmark height={30} />}
              <div className={cn("ml-auto flex items-center", noDrag)}>
                <Button variant="ghost" size="icon" aria-label={t("theme.toggle")} title={t("theme.toggle")} onClick={() => toggleTheme(theme)}>
                  {theme === "dark" ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
                </Button>
              </div>
            </div>
            {/* data-nav-list: the smoke shot of the menu checks this is not scrolling. */}
            <div data-nav-list className="hive-sidebar-list flex min-h-0 flex-1 flex-col overflow-y-auto">
              <div className="hive-nav-group flex flex-col">
                <div className="hive-nav-heading">{t("desk.group.machine")}</div>
                {DESK_MENU.map((id) => {
                  const on = id === current;
                  const Icon = DESK_ICONS[id];
                  const count = counts[id];
                  const label = t(DESK_LABEL[id]);
                  return (
                    <a
                      key={id}
                      href={`#/${id}`}
                      aria-current={on ? "page" : undefined}
                      title={t("shell.shortcut", { label, key: DESK_SHORTCUTS[id]! })}
                      className={cn("hive-nav-item flex shrink-0 items-center outline-none focus-visible:focus-ring active:bg-pressed", on ? "hive-nav-active" : "text-fg-secondary hover:bg-hover")}
                    >
                      <Icon aria-hidden="true" className={cn("size-4 shrink-0", on ? "text-fg-brand" : "text-fg-muted")} />
                      <span className="min-w-0 flex-1 truncate">{label}</span>
                      {count ? <span className="hive-nav-count inline-grid place-items-center rounded-full text-fg-muted">{count}</span> : null}
                      <kbd className="hive-nav-shortcut">⌘{DESK_SHORTCUTS[id]}</kbd>
                    </a>
                  );
                })}
              </div>
              <div className="hive-nav-group flex flex-col" data-web-group>
                <div className="hive-nav-heading">{t("desk.group.web")}</div>
                {WEB_ENTRIES.map((e) => (
                  <a
                    key={e.id}
                    href={webUrl ? `${webUrl}/${e.hash}` : undefined}
                    target="_blank"
                    rel="noreferrer"
                    data-open-web={e.id}
                    aria-disabled={webUrl ? undefined : true}
                    title={webUrl ? t("shell.openWebHint") : t("desk.webOff")}
                    className="hive-nav-item flex shrink-0 items-center text-fg-secondary outline-none hover:bg-hover focus-visible:focus-ring active:bg-pressed aria-disabled:opacity-50"
                  >
                    <ExternalLink aria-hidden="true" className="size-4 shrink-0 text-fg-muted" />
                    <span className="min-w-0 flex-1 truncate">{t(e.label)}</span>
                  </a>
                ))}
              </div>
            </div>
            <div className={cn("hive-sidebar-account flex shrink-0 items-center gap-1", noDrag)}>
              <AccountMenu client={client} me={me} onSignOut={onSignOut} subtitle={settings ? `${settings.machine}${version ? ` · v${version}` : ""}` : undefined} connected={link.state === "ok"} />
              {onSignOut ? <Button variant="ghost" size="icon" onClick={onSignOut} aria-label={t("account.signOut")} title={t("account.signOut")}><LogOut className="size-[15px]" aria-hidden="true" /></Button> : null}
            </div>
          </nav>
          <div className="relative flex min-w-0 flex-1 flex-col">
            <header className={cn("hive-topbar hive-main-topbar flex min-w-0 shrink-0 items-center", drag)}>
              <div className="hive-topbar-title flex min-w-0 flex-1 flex-col">
                <h1 className="truncate text-fg-strong" data-shell-title>{title}</h1>
                <span className="sr-only">{subtitle}</span>
              </div>
              <button
                type="button"
                onClick={() => setPalette(true)}
                className={cn("hive-topbar-search flex min-w-[120px] shrink cursor-pointer items-center text-fg-muted outline-none focus-visible:focus-ring", noDrag)}
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
              {webUrl ? (
                <a
                  href={`${webUrl}/#/today`}
                  target="_blank"
                  rel="noreferrer"
                  title={t("shell.openWebHint")}
                  data-open-web="hub"
                  className={cn(
                    "flex h-[30px] shrink-0 cursor-pointer items-center gap-1.5 rounded-sm bg-primary pr-3 pl-2.5 text-xs/none font-semibold whitespace-nowrap text-primary-foreground no-underline outline-none hover:bg-primary-hover focus-visible:focus-ring",
                    noDrag,
                  )}
                >
                  <ExternalLink className="size-3.5" strokeWidth={2} />
                  {t("shell.openWeb")}
                </a>
              ) : null}
            </header>
            {offline ? (
              <div role="status" className="flex shrink-0 items-center gap-2 border-b border-warning-line bg-warning-soft px-3.5 py-1.5 text-xs/4 font-medium text-fg-strong">
                <span className="min-w-0 flex-1">{link.state === "refused" ? t("shell.hubRefused", { host: hubHost, error: link.error ?? "" }) : t("shell.offlineBanner", { host: hubHost })}</span>
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
            <main id="hive-main" ref={mainRef} tabIndex={-1} aria-label={title} className="min-h-0 min-w-0 flex-1 overflow-y-auto">
              <InShellContext.Provider value={true}>{children}</InShellContext.Provider>
            </main>
          </div>
        </div>
        <footer className="hive-status-footer flex h-[26px] shrink-0 items-center gap-0.5 border-t border-line-subtle bg-subtle px-2">
          <span className="inline-flex h-5 min-w-0 items-center gap-[5px] rounded-xs px-1.5 text-[11px]/none whitespace-nowrap text-fg-secondary" title={link.error ?? t("shell.hubTip", { host: hubHost })}>
            <span className={cn("size-[7px] shrink-0 rounded-full", link.state === "ok" ? "bg-success-solid" : link.state === "unknown" ? "bg-neutral-solid" : "bg-warning-solid")} />
            <span className="truncate">{offline ? t("shell.hubOffline") : hubHost}</span>
          </span>
          <span className="flex-1" />
          {up?.state === "downloading" && up.version ? (
            <span className="px-1.5 font-mono text-[11px]/none text-fg-secondary">{t("shell.updateDownloading", { version: up.version, percent: up.percent ?? 0 })}</span>
          ) : up?.state === "failed" ? (
            <span className="px-1.5 font-mono text-[11px]/none text-fg-secondary" title={up.error ?? undefined}>{`v${version ?? "?"} · ${t("shell.updateFailed")}`}</span>
          ) : version ? (
            <span className="px-1.5 font-mono text-[11px]/none text-fg-secondary" title={t("shell.version")}>{`v${version}`}</span>
          ) : null}
        </footer>
      </div>
      <CommandPalette open={palette} onOpenChange={setPalette} commands={commands} pages={pages} />
    </>
  );
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
