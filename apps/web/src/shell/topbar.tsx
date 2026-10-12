import { useQuery } from "@tanstack/react-query";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { BellIcon, MonitorIcon, MoonIcon, SearchIcon, SunIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { LangToggle } from "@/components/lang-toggle.tsx";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb.tsx";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import { SidebarTrigger } from "@/components/ui/sidebar.tsx";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import { activeNavItem, NAV_HOME, visibleGroups } from "@/lib/nav.ts";
import { usePermissions } from "@/lib/permissions.ts";
import { isOrgAdmin } from "@/lib/roles.ts";
import { readTheme, setTheme, type ThemeChoice } from "@/lib/theme.ts";
import { cn } from "@/lib/utils.ts";
import { type CurrentOrg, useOrgs } from "@/shell/org-context.ts";

const text: Dict<{
  crumb: string;
  search: string;
  palette: string;
  paletteHint: string;
  empty: string;
  theme: string;
  themes: Record<ThemeChoice, string>;
  inbox: string;
  inboxUnread: (n: number) => string;
}> = {
  vi: {
    crumb: "Đường dẫn",
    search: "Tìm việc, run, dự án…",
    palette: "Đi tới",
    paletteHint: "Gõ tên màn để đi tới.",
    empty: "Không có màn nào khớp.",
    theme: "Giao diện",
    themes: { system: "Theo hệ thống", light: "Sáng", dark: "Tối" },
    inbox: "Thông báo",
    inboxUnread: (n) => `Thông báo, ${n} chưa đọc`,
  },
  en: {
    crumb: "Breadcrumb",
    search: "Search tasks, runs, projects…",
    palette: "Go to",
    paletteHint: "Type a screen name to go there.",
    empty: "No matching screen.",
    theme: "Theme",
    themes: { system: "System", light: "Light", dark: "Dark" },
    inbox: "Notifications",
    inboxUnread: (n) => `Notifications, ${n} unread`,
  },
};

const THEME_ICON = { system: MonitorIcon, light: SunIcon, dark: MoonIcon } as const;

function ThemeMenu() {
  const t = useT(text);
  const [choice, setChoice] = useState<ThemeChoice>(readTheme);
  const IconComponent = THEME_ICON[choice];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" size="icon" aria-label={t.theme} title={t.theme} />}>
        <IconComponent aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup
          value={choice}
          onValueChange={(value) => {
            setTheme(value as ThemeChoice);
            setChoice(value as ThemeChoice);
          }}
        >
          {(["system", "light", "dark"] as const).map((value) => (
            <DropdownMenuRadioItem key={value} value={value}>
              {t.themes[value]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Chuông thông báo: chấm đỏ khi còn thông báo chưa đọc trong tổ chức đang chọn. */
function InboxBell({ current }: { current: CurrentOrg }) {
  const t = useT(text);
  const count = useQuery(current.api.inbox.unreadCount.queryOptions({ refetchInterval: 30_000 }));
  const unread = count.data?.count ?? 0;
  const label = unread > 0 ? t.inboxUnread(unread) : t.inbox;
  return (
    <Link
      to={"/notifications" as "/"}
      aria-label={label}
      title={label}
      className={cn(buttonVariants({ variant: "outline", size: "icon" }), "relative")}
    >
      <BellIcon aria-hidden="true" />
      {unread > 0 && (
        <span className="absolute top-1 right-1.5 size-2 rounded-full border-2 border-background bg-destructive" />
      )}
    </Link>
  );
}

/** Bảng lệnh ⌘K: tìm và đi tới các màn trong sidebar mà người dùng được thấy. */
function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useT(text);
  const lang = useLang();
  const navigate = useNavigate();
  const { current } = useOrgs();
  const can = usePermissions();
  const groups = current ? visibleGroups(isOrgAdmin(current.org.role), can) : [];
  const go = (to: string) => {
    onOpenChange(false);
    void navigate({ to });
  };
  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title={t.palette} description={t.paletteHint}>
      <Command>
        <CommandInput placeholder={t.search} />
        <CommandList>
          <CommandEmpty>{t.empty}</CommandEmpty>
          <CommandGroup heading={NAV_HOME.label[lang]}>
            <CommandItem onSelect={() => go(NAV_HOME.to as string)}>
              <NAV_HOME.icon aria-hidden="true" />
              {NAV_HOME.label[lang]}
            </CommandItem>
          </CommandGroup>
          {groups.map((group) => (
            <CommandGroup key={group.id} heading={group.label[lang]}>
              {group.items.map((item) => (
                <CommandItem
                  key={item.id}
                  value={`${item.label.vi} ${item.label.en}`}
                  onSelect={() => go(item.to as string)}
                >
                  <item.icon aria-hidden="true" />
                  {item.label[lang]}
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}

/** Thanh trên theo Topbar.dc.html: đường dẫn, tìm kiếm ⌘K, VI/EN, sáng/tối, thông báo. */
export function Topbar() {
  const t = useT(text);
  const lang = useLang();
  const { current } = useOrgs();
  const { pathname } = useLocation();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const active = activeNavItem(pathname);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="sticky top-0 z-10 flex h-13 items-center gap-2 border-b border-border bg-background/95 px-3 backdrop-blur md:gap-3 md:px-5">
      <SidebarTrigger className="-ml-1" />
      <Breadcrumb aria-label={t.crumb} className="min-w-0 flex-1">
        <BreadcrumbList className="flex-nowrap">
          {current && (
            <>
              <BreadcrumbItem className="hidden truncate sm:inline-flex">{current.org.name}</BreadcrumbItem>
              <BreadcrumbSeparator className="hidden sm:inline-flex" />
            </>
          )}
          <BreadcrumbItem className="min-w-0">
            <BreadcrumbPage className="truncate font-medium">{active ? active.label[lang] : ""}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      {current && (
        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          className="hidden h-8 w-72 max-w-[40%] cursor-pointer items-center gap-2 rounded-lg bg-muted px-2.5 text-left text-xs text-muted-foreground hover:text-foreground md:flex"
        >
          <SearchIcon className="size-4" aria-hidden="true" />
          <span className="flex-1 truncate">{t.search}</span>
          <Kbd>⌘K</Kbd>
        </button>
      )}
      <LangToggle />
      <ThemeMenu />
      {current && <InboxBell current={current} />}
      {current && <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />}
    </div>
  );
}
