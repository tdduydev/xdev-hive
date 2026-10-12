import { PersonAvatar } from "../components/person.tsx";
import { ThemeToggle } from "../components/theme-toggle.tsx";
import { useMe } from "./me-context.ts";
import { SignOutButton } from "./sign-out-button.tsx";

/** Chân sidebar: chọn giao diện, người đang đăng nhập, đăng xuất. Thu gọn còn ảnh đại diện. */
export function UserCard() {
  const me = useMe();
  return (
    <div className="grid gap-2 border-t border-sidebar-border pt-2">
      <ThemeToggle className="justify-self-start group-data-[collapsible=icon]:hidden" />
      <div className="flex items-center gap-2.5 px-0.5">
        <PersonAvatar person={me} />
        <span className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
          <b className="block truncate text-sm font-medium text-foreground">{me.name}</b>
          <span className="block truncate">
            <small className="text-xs text-muted-foreground">{me.email}</small>
          </span>
        </span>
        <span className="group-data-[collapsible=icon]:hidden">
          <SignOutButton />
        </span>
      </div>
    </div>
  );
}
