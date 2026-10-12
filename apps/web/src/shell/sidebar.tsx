import { Link, type LinkProps, useLocation } from "@tanstack/react-router";
import { Icon, type IconName } from "../components/icons.tsx";
import { cx } from "../lib/cx.ts";
import { orgStore } from "../lib/org-store.ts";
import { isOrgAdmin, ORG_ROLE_LABEL } from "../lib/roles.ts";
import { useOrgs } from "./org-context.ts";
import { OrgSwitcher } from "./org-switcher.tsx";
import { UserCard } from "./user-card.tsx";

interface NavEntry {
  label: string;
  icon: IconName;
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
      { label: "Bảng việc", icon: "columns", to: "/tasks", match: "/tasks" },
      { label: "Lượt chạy", icon: "play", to: "/runs", match: "/runs" },
      { label: "Leader", icon: "chat", to: "/leader", match: "/leader" },
      { label: "Máy", icon: "monitor", to: pending("/machines"), match: "/machines" },
    ],
  },
  {
    title: "Dự án và quản trị",
    entries: [
      { label: "Dự án", icon: "folder", to: "/projects", match: "/projects" },
      { label: "Thành viên", icon: "users", to: "/admin/members", match: "/admin/members" },
      { label: "Đội và hệ thống", icon: "network", to: "/admin/teams", match: "/admin/teams" },
      { label: "Thông báo", icon: "bell", to: pending("/notifications"), match: "/notifications" },
      { label: "Chi phí và token", icon: "chart", to: pending("/admin/costs"), match: "/admin/costs" },
      { label: "Sandbox", icon: "lock", to: "/admin/sandbox", match: "/admin/sandbox", adminOnly: true },
      {
        label: "Cài đặt đăng nhập",
        icon: "lock",
        to: "/admin/sign-in-settings",
        match: "/admin/sign-in-settings",
        adminOnly: true,
      },
    ],
  },
];

const item = "flex items-center gap-2.5 rounded-sm px-2.5 py-1.75 text-sm";
const on = "bg-accent font-semibold text-accent-foreground";
const off = "font-medium text-foreground";

function NavItem({ entry, hasOrg, pathname }: { entry: NavEntry; hasOrg: boolean; pathname: string }) {
  const active = entry.match !== undefined && pathname.startsWith(entry.match);
  const body = (
    <>
      <Icon name={entry.icon} />
      {entry.label}
    </>
  );
  // Mọi màn ở đây là dữ liệu của một tổ chức; chưa thuộc tổ chức nào thì chưa mở được.
  if (!hasOrg) {
    return (
      <span
        aria-disabled={active ? undefined : "true"}
        aria-current={active ? "page" : undefined}
        title="Cần thuộc một tổ chức"
        className={cx(item, active ? on : cx(off, "opacity-50"))}
      >
        {body}
      </span>
    );
  }
  return (
    <Link
      to={entry.to}
      aria-current={active ? "page" : undefined}
      className={cx(item, active ? on : cx(off, "hover:bg-muted"))}
    >
      {body}
    </Link>
  );
}

/** Thanh bên theo thiết kế Sidebar.dc.html: logo, ô chọn tổ chức, hai nhóm mục, người đang đăng nhập. */
export function Sidebar({ className }: { className?: string }) {
  const { orgs, current, canCreateOrg } = useOrgs();
  const { pathname } = useLocation();
  const hasOrg = current !== null;
  return (
    <aside
      className={cx(
        "sticky top-0 h-dvh flex-col gap-5 overflow-y-auto border-r border-border bg-card px-3 py-4",
        className,
      )}
    >
      <div className="flex items-center gap-2.5 px-1.5 py-1">
        <img src="/xdev-hive-icon.svg" alt="" className="size-7" />
        <span className="text-base font-semibold text-foreground">xDev Hive</span>
      </div>
      <OrgSwitcher
        orgs={orgs.map((o) => ({ id: o.id, name: o.name, role: ORG_ROLE_LABEL[o.role] }))}
        currentId={current?.org.id}
        onSelect={orgStore.set}
        canCreate={canCreateOrg}
      />
      <nav aria-label="Điều hướng chính" className="grid gap-5">
        {GROUPS.map((group) => (
          <div key={group.title} className="grid gap-0.5">
            <div className="px-2.5 pb-1.5 text-2xs font-semibold tracking-caps text-muted-foreground uppercase">
              {group.title}
            </div>
            {group.entries
              .filter((entry) => !entry.adminOnly || !current || isOrgAdmin(current.org.role))
              .map((entry) => (
                <NavItem key={entry.label} entry={entry} hasOrg={hasOrg} pathname={pathname} />
              ))}
          </div>
        ))}
      </nav>
      <UserCard />
    </aside>
  );
}
