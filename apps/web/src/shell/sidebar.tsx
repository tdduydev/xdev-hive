import { Link, type LinkProps } from "@tanstack/react-router";
import { Icon, type IconName } from "../components/icons.tsx";
import { Pill } from "../components/ui/pill.tsx";
import { cx } from "../lib/cx.ts";
import { orgStore } from "../lib/org-store.ts";
import { isOrgAdmin, ORG_ROLE_LABEL } from "../lib/roles.ts";
import { useOrgs } from "./org-context.ts";
import { OrgSwitcher } from "./org-switcher.tsx";
import { UserCard } from "./user-card.tsx";

interface NavEntry {
  label: string;
  icon: IconName;
  /** Chưa có thì mục bị mờ, không bấm được. */
  to?: LinkProps["to"];
  /** Mốc sẽ làm màn này (docs/architecture.md mục 12). */
  milestone?: string;
  /** Chỉ mở được khi đã thuộc một tổ chức. */
  needsOrg?: boolean;
  /** Chỉ quản trị tổ chức dùng được; ẩn với người khác trong tổ chức. */
  adminOnly?: boolean;
}

const WORK: NavEntry[] = [
  { label: "Việc", icon: "board", milestone: "M3" },
  { label: "Dự án", icon: "grid", milestone: "M2" },
  { label: "Máy", icon: "server", milestone: "M3" },
  { label: "Tri thức", icon: "book", milestone: "M4" },
];

const ADMIN: NavEntry[] = [
  { label: "Đội và hệ thống", icon: "users", to: "/quan-tri/doi", needsOrg: true },
  { label: "Thành viên", icon: "mail", to: "/quan-tri/thanh-vien", needsOrg: true },
  { label: "Đăng nhập", icon: "key", to: "/quan-tri/dang-nhap", needsOrg: true, adminOnly: true },
  { label: "Cài đặt tổ chức", icon: "gear" },
];

const item = "flex items-center gap-2.5 rounded-sm px-2.5 py-1.75 text-nav text-muted";

function NavItem({ entry, hasOrg }: { entry: NavEntry; hasOrg: boolean }) {
  const body = (
    <>
      <Icon name={entry.icon} />
      {entry.label}
      {entry.milestone && (
        <Pill small className="ml-auto">
          {entry.milestone}
        </Pill>
      )}
    </>
  );
  if (!entry.to || (entry.needsOrg && !hasOrg)) {
    const reason = entry.milestone
      ? `Có từ mốc ${entry.milestone}`
      : entry.needsOrg
        ? "Cần thuộc một tổ chức"
        : "Chưa có";
    return (
      <span aria-disabled="true" title={reason} className={cx(item, "opacity-50")}>
        {body}
      </span>
    );
  }
  return (
    <Link
      to={entry.to}
      className={cx(item, "hover:bg-subtle")}
      activeProps={{ className: "bg-sel font-medium text-sel-fg hover:bg-sel" }}
    >
      {body}
    </Link>
  );
}

export function Sidebar({ className }: { className?: string }) {
  const { orgs, current, canCreateOrg } = useOrgs();
  return (
    <aside
      className={cx(
        "sticky top-0 h-dvh flex-col gap-0.5 overflow-y-auto border-r border-line bg-surface px-2.5 py-3",
        className,
      )}
    >
      <OrgSwitcher
        orgs={orgs.map((o) => ({ id: o.id, name: o.name, role: ORG_ROLE_LABEL[o.role] }))}
        currentId={current?.org.id}
        onSelect={orgStore.set}
        canCreate={canCreateOrg}
      />
      <nav aria-label="Điều hướng chính">
        {WORK.map((entry) => (
          <NavItem key={entry.label} entry={entry} hasOrg={current !== null} />
        ))}
        <div className="px-2.5 pt-3 pb-1 text-2xs font-semibold tracking-caps text-faint uppercase">Quản trị</div>
        {ADMIN.filter((entry) => !entry.adminOnly || !current || isOrgAdmin(current.org.role)).map((entry) => (
          <NavItem key={entry.label} entry={entry} hasOrg={current !== null} />
        ))}
      </nav>
      <UserCard />
    </aside>
  );
}
