import { Link, useLocation } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/ui/collapsible.tsx";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
} from "../components/ui/sidebar.tsx";
import { type Dict, useLang, useT } from "../lib/i18n.ts";
import { activeNavItem, NAV_HOME, type NavGroup, type NavItem, visibleGroups } from "../lib/nav.ts";
import { orgStore } from "../lib/org-store.ts";
import { isOrgAdmin, ORG_ROLE_LABEL } from "../lib/roles.ts";
import { useOrgs } from "./org-context.ts";
import { OrgSwitcher } from "./org-switcher.tsx";
import { UserCard } from "./user-card.tsx";

const text: Dict<{ nav: string; needsOrg: string }> = {
  vi: { nav: "Điều hướng chính", needsOrg: "Cần thuộc một tổ chức" },
  en: { nav: "Main navigation", needsOrg: "Join an organization first" },
};

const OPEN_KEY = "hive.nav.open";

/** Nhóm người dùng đã tự mở hoặc đóng, nhớ qua lần tải lại. */
function readOpen(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(OPEN_KEY);
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function ItemBody({ item }: { item: NavItem }) {
  const lang = useLang();
  const IconComponent = item.icon;
  return (
    <>
      <IconComponent aria-hidden="true" />
      <span>{item.label[lang]}</span>
    </>
  );
}

/** Mục không bấm được khi chưa thuộc tổ chức nào: mọi màn ở đây là dữ liệu của một tổ chức. */
function DisabledItem({ item, sub }: { item: NavItem; sub?: boolean }) {
  const t = useT(text);
  const Button = sub ? SidebarMenuSubButton : SidebarMenuButton;
  return (
    <Button
      render={<span />}
      aria-disabled="true"
      title={t.needsOrg}
      className="cursor-not-allowed opacity-50 hover:bg-transparent"
    >
      <ItemBody item={item} />
    </Button>
  );
}

function Group({
  group,
  hasOrg,
  activeId,
  open,
  onOpenChange,
}: {
  group: NavGroup;
  hasOrg: boolean;
  activeId: string | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const lang = useLang();
  const IconComponent = group.icon;
  const hasActive = group.items.some((i) => i.id === activeId);
  return (
    <Collapsible open={open} onOpenChange={onOpenChange} render={<SidebarMenuItem />}>
      <CollapsibleTrigger
        render={
          <SidebarMenuButton
            tooltip={group.label[lang]}
            isActive={hasActive && !open}
            className={hasActive ? "group/collapsible font-semibold" : "group/collapsible"}
          />
        }
      >
        <IconComponent aria-hidden="true" />
        <span>{group.label[lang]}</span>
        <ChevronRightIcon
          aria-hidden="true"
          className="ml-auto text-muted-foreground transition-transform duration-200 group-data-[panel-open]/collapsible:rotate-90"
        />
      </CollapsibleTrigger>
      <CollapsibleContent keepMounted>
        <SidebarMenuSub>
          {group.items.map((item) => (
            <SidebarMenuSubItem key={item.id}>
              {hasOrg ? (
                <SidebarMenuSubButton
                  render={<Link to={item.to} aria-current={item.id === activeId ? "page" : undefined} />}
                  isActive={item.id === activeId}
                >
                  <ItemBody item={item} />
                </SidebarMenuSubButton>
              ) : (
                <DisabledItem item={item} sub />
              )}
            </SidebarMenuSubItem>
          ))}
        </SidebarMenuSub>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * Thanh bên theo Sidebar.dc.html: logo, ô chọn tổ chức, mục Tổng quan, sáu nhóm thu gọn được, người đang đăng nhập.
 * Nhóm chứa màn đang mở tự mở; nhóm người dùng tự mở hay đóng thì nhớ. Chưa thuộc tổ chức nào thì mở hết để thấy có gì.
 */
export function AppSidebar() {
  const { orgs, current, canCreateOrg } = useOrgs();
  const { pathname } = useLocation();
  const t = useT(text);
  const lang = useLang();
  const hasOrg = current !== null;
  const active = activeNavItem(pathname);
  const groups = visibleGroups(!current || isOrgAdmin(current.org.role));
  const [userOpen, setUserOpen] = useState<Record<string, boolean>>(readOpen);
  const setOpen = (id: string, open: boolean) => {
    const next = { ...userOpen, [id]: open };
    setUserOpen(next);
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify(next));
    } catch {
      /* Không nhớ được thì vẫn mở/đóng trong phiên này. */
    }
  };
  const isOpen = (g: NavGroup) => !hasOrg || (userOpen[g.id] ?? g.items.some((i) => i.id === active?.id));

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="gap-3">
        <div className="flex items-center gap-2.5 px-1.5 py-1 group-data-[collapsible=icon]:px-0">
          <img src="/xdev-hive-icon.svg" alt="" className="size-7 shrink-0" />
          <span className="truncate font-heading text-base font-semibold text-foreground group-data-[collapsible=icon]:hidden">
            xDev Hive
          </span>
        </div>
        <OrgSwitcher
          orgs={orgs.map((o) => ({ id: o.id, name: o.name, role: ORG_ROLE_LABEL[o.role] }))}
          currentId={current?.org.id}
          onSelect={orgStore.set}
          canCreate={canCreateOrg}
        />
      </SidebarHeader>
      <SidebarContent>
        <nav aria-label={t.nav} className="contents">
          <SidebarGroup>
            <SidebarMenu>
              {/* Tổng quan mở được cả khi chưa thuộc tổ chức: đó là nơi hướng dẫn nhận lời mời. */}
              <SidebarMenuItem>
                <SidebarMenuButton
                  render={<Link to={NAV_HOME.to} aria-current={active?.id === "home" ? "page" : undefined} />}
                  isActive={active?.id === "home"}
                  tooltip={NAV_HOME.label[lang]}
                >
                  <ItemBody item={NAV_HOME} />
                </SidebarMenuButton>
              </SidebarMenuItem>
              {groups.map((group) => (
                <Group
                  key={group.id}
                  group={group}
                  hasOrg={hasOrg}
                  activeId={active?.id}
                  open={isOpen(group)}
                  onOpenChange={(open) => setOpen(group.id, open)}
                />
              ))}
            </SidebarMenu>
          </SidebarGroup>
        </nav>
      </SidebarContent>
      <SidebarFooter>
        <UserCard />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
