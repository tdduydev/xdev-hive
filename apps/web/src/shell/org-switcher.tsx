import { Menu } from "@base-ui/react/menu";
import { Link } from "@tanstack/react-router";
import { Icon } from "../components/icons.tsx";
import { cx } from "../lib/cx.ts";

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
  "flex cursor-pointer items-center gap-2.5 rounded-sm px-2.5 py-1.75 text-nav outline-none data-highlighted:bg-subtle";

/** Ô chọn tổ chức ở đầu sidebar. Chọn tổ chức khác thì mọi lời gọi API sau đó gửi header của tổ chức đó. */
export function OrgSwitcher({ orgs, currentId, onSelect, canCreate = false }: OrgSwitcherProps) {
  const current = orgs.find((o) => o.id === currentId) ?? orgs[0];
  return (
    <Menu.Root>
      <Menu.Trigger className="mb-2.5 flex w-full cursor-pointer items-center gap-2.5 rounded-lg border border-line p-2 text-left hover:bg-subtle data-popup-open:bg-subtle">
        <span
          className={cx(
            "grid size-7 shrink-0 place-items-center rounded-md text-label font-semibold text-white",
            current ? "bg-accent" : "bg-faint",
          )}
        >
          {current ? orgInitial(current.name) : "?"}
        </span>
        <span className="min-w-0">
          <b className="block truncate text-label leading-tight font-semibold text-ink">
            {current?.name ?? "Chưa có tổ chức"}
          </b>
          {/* `small` để inline trong khối cỡ chữ thân như mockup, nên dòng cao theo cỡ 14px. */}
          <span className="block truncate">
            <small className="text-xs text-muted">{current?.role ?? "Chờ lời mời"}</small>
          </span>
        </span>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={4} align="start" className="z-10">
          <Menu.Popup className="min-w-(--anchor-width) rounded-lg border border-line-strong bg-surface p-1 shadow-app outline-none">
            {orgs.length === 0 ? (
              <p className="px-2.5 py-1.75 text-label text-muted">Chưa thuộc tổ chức nào</p>
            ) : (
              <Menu.RadioGroup value={current?.id} onValueChange={(id: string) => onSelect?.(id)}>
                {orgs.map((org) => (
                  <Menu.RadioItem
                    key={org.id}
                    value={org.id}
                    className={cx(menuItem, "data-checked:font-medium data-checked:text-sel-fg")}
                  >
                    <span className="grid size-6 shrink-0 place-items-center rounded-md bg-accent text-xs font-semibold text-white">
                      {orgInitial(org.name)}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate">{org.name}</span>
                      <small className="block truncate text-xs font-normal text-muted">{org.role}</small>
                    </span>
                  </Menu.RadioItem>
                ))}
              </Menu.RadioGroup>
            )}
            {canCreate && (
              <Menu.LinkItem render={<Link to="/orgs/new" />} className={cx(menuItem, "mt-1 text-muted")}>
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
