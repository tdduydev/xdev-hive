import { PersonAvatar } from "../components/person.tsx";
import { ThemeToggle } from "../components/theme-toggle.tsx";
import { useMe } from "./me-context.ts";
import { SignOutButton } from "./sign-out-button.tsx";

/** Hồ sơ người dùng ở chân sidebar. */
export function UserCard() {
  const me = useMe();
  return (
    <div className="mt-auto grid gap-2 border-t border-border pt-2.5">
      <ThemeToggle className="justify-self-start" />
      <div className="flex items-center gap-2.5 px-0.5">
        <PersonAvatar person={me} />
        <span className="min-w-0 flex-1">
          <b className="block truncate text-sm font-medium text-foreground">{me.name}</b>
          <span className="block truncate">
            <small className="text-xs text-muted-foreground">{me.email}</small>
          </span>
        </span>
        <SignOutButton />
      </div>
    </div>
  );
}
