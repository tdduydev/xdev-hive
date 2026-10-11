import { PersonAvatar } from "../components/person.tsx";
import { useMe } from "./me-context.ts";
import { SignOutButton } from "./sign-out-button.tsx";

/** Hồ sơ người dùng ở chân sidebar. */
export function UserCard() {
  const me = useMe();
  return (
    <div className="mt-auto flex items-center gap-2.5 border-t border-line p-2.5">
      <PersonAvatar person={me} />
      <span className="min-w-0 flex-1">
        <b className="block truncate text-label font-medium text-ink">{me.name}</b>
        <span className="block truncate">
          <small className="text-xs text-muted">{me.email}</small>
        </span>
      </span>
      <SignOutButton />
    </div>
  );
}
