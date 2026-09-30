// The Web Admin frame (docs/design/2026-09-redesign, xDev Hive Web Admin): a top bar (logo, Admin, hub, health, time
// range, clock, theme, account), a 232px sidebar grouped as Vận hành · Theo dõi · Kiến thức · Quản trị, and the page
// under its group name and title. Below 900px the sidebar becomes a row of pills.
import { createContext, useContext, useEffect, useState, type ComponentType, type ReactNode } from "react";
import { LayoutGrid, Moon, Sun } from "lucide-react";
import { cn } from "cn";
import type { Me } from "@xdev-hive/core";
import type { HiveClient } from "../client.ts";
import { AccountMenu } from "../components/Account.tsx";
import { HiveWordmark } from "../components/Brand.tsx";
import { useT } from "../i18n/index.tsx";
import { toggleTheme, useTheme } from "../lib/theme.ts";
import { InShellContext } from "./frame.ts";
import { ToastProvider } from "./toast.tsx";

type Icon = ComponentType<{ className?: string }>;

export type AdminRange = "d1" | "d7" | "d30";
export const RANGE_HOURS: Record<AdminRange, number> = { d1: 24, d7: 24 * 7, d30: 24 * 30 };

const AdminContext = createContext<{ range: AdminRange }>({ range: "d1" });
/** The time range picked in the admin top bar (24h / 7d / 30d). */
export const useAdminRange = (): AdminRange => useContext(AdminContext).range;

export interface AdminNavItem {
  id: string;
  label: string;
  icon: Icon;
  count?: { value: number; tone?: "danger" | "accent" };
}

export interface AdminNavGroup {
  label: string;
  items: AdminNavItem[];
}

function useNarrow(): boolean {
  const q = "(max-width: 899px)";
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return narrow;
}

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  const zone = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" }).formatToParts(now).find((p) => p.type === "timeZoneName")?.value ?? "";
  return (
    <span className="hidden font-mono text-xs/none text-fg-secondary tabular-nums md:inline">
      {now.toLocaleTimeString(undefined, { hour12: false })} {zone}
    </span>
  );
}

const count = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1).replace(".", ",")}k` : String(n));

export function AdminShell({
  client,
  me,
  onSignOut,
  groups,
  current,
  group,
  title,
  hint,
  health,
  fill,
  children,
}: {
  client: HiveClient;
  me: Me;
  onSignOut?: () => void;
  groups: AdminNavGroup[];
  current: string;
  /** The page's group, shown above its title. */
  group: string;
  title: string;
  hint?: string;
  /** Warnings the health pill counts (0: all steady). */
  health: number;
  /** The page fills the area itself (lists with a detail pane) instead of scrolling in the padded column. */
  fill?: boolean;
  children: ReactNode;
}) {
  const t = useT();
  const { theme } = useTheme();
  const narrow = useNarrow();
  const [range, setRange] = useState<AdminRange>(() => {
    try {
      const v = localStorage.getItem("hive-admin-range");
      return v === "d7" || v === "d30" ? v : "d1";
    } catch {
      return "d1";
    }
  });
  const pickRange = (r: AdminRange) => {
    setRange(r);
    try {
      localStorage.setItem("hive-admin-range", r);
    } catch {
      // Not remembered.
    }
  };
  const items = groups.flatMap((g) => g.items);

  return (
    <ToastProvider>
      <AdminContext.Provider value={{ range }}>
        <div className="fixed inset-0 flex flex-col bg-canvas text-fg-primary">
          <header className="flex h-[52px] shrink-0 items-center gap-3 border-b border-line-subtle bg-subtle px-4">
            <a href="#/admin/overview" className="flex shrink-0 items-center" aria-label={t("ops.nav.overview")}>
              <HiveWordmark height={34} />
            </a>
            <span className="rounded-[5px] bg-fg-strong px-1.5 py-[3px] text-[11px]/none font-bold tracking-[0.08em] text-canvas uppercase">{t("ops.badge")}</span>
            <span className="hidden rounded-sm border border-line-default px-2 py-1 font-mono text-xs/none text-fg-secondary lg:inline">{window.location.host}</span>
            <a
              href="#/admin/fleet"
              title={t("ops.healthTip")}
              className={cn(
                "inline-flex h-[30px] items-center gap-2 rounded-md border px-2.5 text-xs/none font-semibold whitespace-nowrap",
                health ? "border-warning-line bg-warning-soft text-warning" : "border-success-line bg-success-soft text-success",
              )}
            >
              <span className={cn("size-2 animate-xd-pulse rounded-full motion-reduce:animate-none", health ? "bg-warning-solid" : "bg-success-solid")} />
              {health ? t("ops.healthWarn", { count: health }) : t("ops.healthOk")}
            </a>
            <span className="flex-1" />
            <div role="radiogroup" aria-label={t("ops.rangeLabel")} className="hidden gap-0.5 rounded-[7px] bg-sunken p-0.5 lg:flex">
              {(["d1", "d7", "d30"] as const).map((r) => (
                <button
                  key={r}
                  type="button"
                  role="radio"
                  aria-checked={range === r}
                  onClick={() => pickRange(r)}
                  className={cn("h-[26px] cursor-pointer rounded-[5px] px-2.5 font-mono text-xs/none outline-none focus-visible:focus-ring", range === r ? "bg-surface font-semibold text-fg-strong shadow-e1" : "text-fg-secondary")}
                >
                  {t(`ops.range.${r}`)}
                </button>
              ))}
            </div>
            <Clock />
            <a href="#/today" className="hidden items-center gap-1.5 rounded-md px-2 py-1.5 text-xs/none font-semibold text-fg-secondary hover:bg-hover hover:text-fg-strong sm:inline-flex">
              <LayoutGrid className="size-3.5" />
              {t("ops.workspace")}
            </a>
            <button
              type="button"
              onClick={() => toggleTheme(theme)}
              aria-label={t("theme.toggle")}
              title={t("theme.toggle")}
              className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-md text-fg-secondary outline-none hover:bg-hover hover:text-fg-strong focus-visible:focus-ring"
            >
              {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
            </button>
            <div className="w-[200px] shrink-0">
              <AccountMenu client={client} me={me} onSignOut={onSignOut} />
            </div>
          </header>
          {narrow ? (
            <nav aria-label={t("shell.nav")} className="flex shrink-0 gap-1 overflow-x-auto border-b border-line-subtle bg-subtle px-3 py-2">
              {items.map((i) => (
                <a
                  key={i.id}
                  href={`#/${i.id}`}
                  aria-current={i.id === current ? "page" : undefined}
                  className={cn("inline-flex h-[30px] shrink-0 items-center rounded-[7px] px-3 text-[13px] whitespace-nowrap", i.id === current ? "bg-fg-strong font-semibold text-canvas" : "text-fg-secondary hover:bg-hover")}
                >
                  {i.label}
                </a>
              ))}
            </nav>
          ) : null}
          <div className="flex min-h-0 flex-1">
            {narrow ? null : (
              <nav aria-label={t("shell.nav")} className="flex w-[232px] shrink-0 flex-col gap-3.5 overflow-y-auto border-r border-line-subtle bg-subtle px-2.5 py-3.5">
                {groups.map((g) => (
                  <div key={g.label} className="flex flex-col gap-0.5">
                    <div className="px-2.5 pb-1.5 text-[11px]/none font-bold tracking-[0.08em] text-fg-muted uppercase">{g.label}</div>
                    {g.items.map((i) => {
                      const on = i.id === current;
                      const Icon = i.icon;
                      return (
                        <a
                          key={i.id}
                          href={`#/${i.id}`}
                          aria-current={on ? "page" : undefined}
                          className={cn(
                            "flex h-[34px] items-center gap-2.5 rounded-md px-2.5 text-sm/none outline-none focus-visible:focus-ring",
                            on ? "bg-surface font-semibold text-fg-strong shadow-[0_0_0_1px_var(--border-default)]" : "text-fg-secondary hover:bg-surface hover:text-fg-strong",
                          )}
                        >
                          <Icon className={cn("size-[17px] shrink-0", on ? "text-fg-brand" : "text-fg-muted")} />
                          <span className="min-w-0 flex-1 truncate">{i.label}</span>
                          {i.count && i.count.value > 0 ? (
                            <span
                              className={cn(
                                "rounded-full px-1.5 py-0.5 font-mono text-[11px]/none font-semibold",
                                i.count.tone === "danger" ? "bg-danger-soft text-danger" : i.count.tone === "accent" ? "bg-primary text-primary-foreground" : "bg-sunken text-fg-muted",
                              )}
                            >
                              {count(i.count.value)}
                            </span>
                          ) : null}
                        </a>
                      );
                    })}
                  </div>
                ))}
              </nav>
            )}
            <main className={cn("min-w-0 flex-1", fill ? "flex flex-col" : "overflow-y-auto")}>
              <InShellContext.Provider value={true}>
                <div className={cn("mx-auto flex w-full max-w-[1440px] flex-col gap-4 px-[clamp(14px,2.2vw,24px)] pt-[clamp(14px,2.2vw,24px)]", fill ? "min-h-0 flex-1 pb-3" : "pb-8")}>
                  <div className="flex shrink-0 flex-wrap items-end gap-3">
                    <div className="flex min-w-0 flex-col gap-1">
                      <span className="text-xs/none font-semibold tracking-[0.06em] text-fg-muted uppercase">{group}</span>
                      <h1 className="m-0 text-2xl/8 font-bold tracking-[-0.02em] text-fg-strong">{title}</h1>
                    </div>
                    {hint ? <span className="ml-auto text-xs text-fg-muted">{hint}</span> : null}
                  </div>
                  {fill ? <div className="flex min-h-0 flex-1 overflow-hidden rounded-lg border border-line-default bg-surface">{children}</div> : children}
                </div>
              </InShellContext.Provider>
            </main>
          </div>
        </div>
      </AdminContext.Provider>
    </ToastProvider>
  );
}
