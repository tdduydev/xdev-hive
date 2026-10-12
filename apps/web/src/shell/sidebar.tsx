import { Link, type LinkProps, useLocation } from "@tanstack/react-router";
import {
  BellIcon,
  ChartColumnIcon,
  FolderIcon,
  KanbanSquareIcon,
  KeyRoundIcon,
  type LucideIcon,
  MessagesSquareIcon,
  MonitorIcon,
  NetworkIcon,
  PlayIcon,
  ShieldIcon,
  UsersIcon,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "../components/ui/sidebar.tsx";
import { orgStore } from "../lib/org-store.ts";
import { isOrgAdmin, ORG_ROLE_LABEL } from "../lib/roles.ts";
import { useOrgs } from "./org-context.ts";
import { OrgSwitcher } from "./org-switcher.tsx";
import { UserCard } from "./user-card.tsx";

interface NavEntry {
  label: string;
  icon: LucideIcon;
  to: NonNullable<LinkProps["to"]>;
  /** Đường dẫn bắt đầu bằng chuỗi này thì mục sáng lên, kể cả màn con (vd. /runs/<id>). */
  match?: string;
  /** Chỉ quản trị tổ chức dùng được; ẩn với người khác trong tổ chức. */
  adminOnly?: boolean;
}

/*
 * Route của Máy, Chi phí, Thông báo do task khác thêm (màn theo Machines/Costs/Notifications.dc.html). Ép kiểu tới khi
 * các route đó có trong routeTree; trước đó bấm vào sẽ ra trang "Không tìm thấy trang".
 */
const pending = (path: string) => path as NonNullable<LinkProps["to"]>;

const GROUPS: { title: string; entries: NavEntry[] }[] = [
  {
    title: "Làm việc hằng ngày",
    entries: [
      { label: "Bảng việc", icon: KanbanSquareIcon, to: "/tasks", match: "/tasks" },
      { label: "Lượt chạy", icon: PlayIcon, to: "/runs", match: "/runs" },
      { label: "Leader", icon: MessagesSquareIcon, to: "/leader", match: "/leader" },
      { label: "Máy", icon: MonitorIcon, to: pending("/machines"), match: "/machines" },
    ],
  },
  {
    title: "Dự án và quản trị",
    entries: [
      { label: "Dự án", icon: FolderIcon, to: "/projects", match: "/projects" },
      { label: "Thành viên", icon: UsersIcon, to: "/admin/members", match: "/admin/members" },
      { label: "Đội và hệ thống", icon: NetworkIcon, to: "/admin/teams", match: "/admin/teams" },
      { label: "Thông báo", icon: BellIcon, to: pending("/notifications"), match: "/notifications" },
      { label: "Chi phí và token", icon: ChartColumnIcon, to: pending("/admin/costs"), match: "/admin/costs" },
      { label: "Sandbox", icon: ShieldIcon, to: "/admin/sandbox", match: "/admin/sandbox", adminOnly: true },
      {
        label: "Cài đặt đăng nhập",
        icon: KeyRoundIcon,
        to: "/admin/sign-in-settings",
        match: "/admin/sign-in-settings",
        adminOnly: true,
      },
    ],
  },
];

function NavItem({ entry, hasOrg, pathname }: { entry: NavEntry; hasOrg: boolean; pathname: string }) {
  const active = entry.match !== undefined && pathname.startsWith(entry.match);
  const IconComponent = entry.icon;
  const body = (
    <>
      <IconComponent aria-hidden="true" />
      <span>{entry.label}</span>
    </>
  );
  // Mọi màn ở đây là dữ liệu của một tổ chức; chưa thuộc tổ chức nào thì chưa mở được.
  if (!hasOrg) {
    return (
      <SidebarMenuItem>
        <SidebarMenuButton
          render={<span />}
          isActive={active}
          aria-disabled={active ? undefined : "true"}
          aria-current={active ? "page" : undefined}
          title="Cần thuộc một tổ chức"
          className={active ? undefined : "cursor-not-allowed opacity-50 hover:bg-transparent"}
        >
          {body}
        </SidebarMenuButton>
      </SidebarMenuItem>
    );
  }
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        render={<Link to={entry.to} aria-current={active ? "page" : undefined} />}
        isActive={active}
        tooltip={entry.label}
      >
        {body}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/** Thanh bên: logo, ô chọn tổ chức, hai nhóm mục, giao diện và người đang đăng nhập. Thu gọn còn biểu tượng. */
export function AppSidebar() {
  const { orgs, current, canCreateOrg } = useOrgs();
  const { pathname } = useLocation();
  const hasOrg = current !== null;
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
        <nav aria-label="Điều hướng chính" className="contents">
          {GROUPS.map((group) => (
            <SidebarGroup key={group.title}>
              <SidebarGroupLabel className="text-2xs font-semibold tracking-caps uppercase">
                {group.title}
              </SidebarGroupLabel>
              <SidebarMenu>
                {group.entries
                  .filter((entry) => !entry.adminOnly || !current || isOrgAdmin(current.org.role))
                  .map((entry) => (
                    <NavItem key={entry.label} entry={entry} hasOrg={hasOrg} pathname={pathname} />
                  ))}
              </SidebarMenu>
            </SidebarGroup>
          ))}
        </nav>
      </SidebarContent>
      <SidebarFooter>
        <UserCard />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
