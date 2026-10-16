import { Menu } from "@base-ui/react/menu";
import { Link } from "@tanstack/react-router";
import { HexAvatar } from "@xdev-hive/ui/hex-avatar";
import { ChevronsUpDownIcon } from "lucide-react";
import { Icon } from "@/components/icons.tsx";
import { cx } from "@/lib/cx.ts";

export interface OrgOption {
  id: string;
  name: string;
  /** Vai trò của người dùng trong tổ chức, đã dịch: "Chủ sở hữu", "Quản trị", "Thành viên". */
  role: string;
}

export interface OrgSwitcherProps {
  orgs: OrgOption[];
  currentId?: string | undefined;
  onSelect?: ((id: string) => void) | undefined;
  /** Hiện mục "Tạo tổ chức" (người đầu tiên của hub hoặc người được quản trị hub cho phép). */
  canCreate?: boolean | undefined;
}

const orgInitial = (name: string) => (Array.from(name.trim())[0] ?? "?").toUpperCase();

const menuItem =
  "flex cursor-pointer items-center gap-2.5 rounded-sm px-2.5 py-1.75 text-sm outline-none data-highlighted:bg-muted";

/**
 * Ô chọn tổ chức ở đầu sidebar, trên một ô navy sáng hơn nền. Chọn tổ chức khác thì mọi lời gọi API sau đó gửi header
 * của tổ chức đó.
 */
export function OrgSwitcher({ orgs, currentId, onSelect, canCreate = false }: OrgSwitcherProps) {
  const current = orgs.find((o) => o.id === currentId) ?? orgs[0];
  return (
    <Menu.Root>
      <Menu.Trigger className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg bg-sidebar-accent p-2 text-left hover:bg-sidebar-border data-popup-open:bg-sidebar-border group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:bg-transparent group-data-[collapsible=icon]:p-0.5">
        <HexAvatar aria-hidden="true" size="sm" tone={current ? "sky" : "muted"}>
          {current ? orgInitial(current.name) : "?"}
        </HexAvatar>
        <span className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
          <b className="block truncate text-sm leading-tight font-semibold text-sidebar-accent-foreground">
            {current?.name ?? "Chưa có tổ chức"}
          </b>
          {/* `small` để inline trong khối cỡ chữ thân như mockup, nên dòng cao theo cỡ 14px. */}
          <span className="block truncate">
            <small className="text-xs text-sidebar-foreground">{current?.role ?? "Chờ lời mời"}</small>
          </span>
        </span>
        <ChevronsUpDownIcon aria-hidden="true" className="size-4 shrink-0 group-data-[collapsible=icon]:hidden" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={4} align="start" className="z-50">
          <Menu.Popup className="min-w-(--anchor-width) rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none">
            {orgs.length === 0 ? (
              <p className="px-2.5 py-1.75 text-sm text-muted-foreground">Chưa thuộc tổ chức nào</p>
            ) : (
              <Menu.RadioGroup value={current?.id} onValueChange={(id: string) => onSelect?.(id)}>
                {orgs.map((org) => (
                  <Menu.RadioItem
                    key={org.id}
                    value={org.id}
                    className={cx(menuItem, "data-checked:font-medium data-checked:text-accent-foreground")}
                  >
                    <HexAvatar aria-hidden="true" size="sm" tone="accent">
                      {orgInitial(org.name)}
                    </HexAvatar>
                    <span className="min-w-0">
                      <span className="block truncate">{org.name}</span>
                      <small className="block truncate text-xs font-normal text-muted-foreground">{org.role}</small>
                    </span>
                  </Menu.RadioItem>
                ))}
              </Menu.RadioGroup>
            )}
            {canCreate && (
              <Menu.LinkItem render={<Link to="/orgs/new" />} className={cx(menuItem, "mt-1 text-muted-foreground")}>
                <span className="grid size-6 shrink-0 place-items-center">
                  <Icon name="plus" />
                </span>
                Tạo tổ chức
              </Menu.LinkItem>
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
