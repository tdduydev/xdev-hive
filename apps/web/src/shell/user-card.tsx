import { Avatar } from "@base-ui/react/avatar";
import { initials } from "../lib/people.ts";
import { useMe } from "./me-context.ts";
import { SignOutButton } from "./sign-out-button.tsx";

/** Hồ sơ người dùng ở chân sidebar. */
export function UserCard() {
  const me = useMe();
  return (
    <div className="mt-auto flex items-center gap-2.5 border-t border-line p-2.5">
      <Avatar.Root className="grid size-7 shrink-0 place-items-center overflow-hidden rounded-full bg-subtle text-xs font-semibold text-ink">
        {me.image && <Avatar.Image src={me.image} alt="" className="size-full object-cover" />}
        <Avatar.Fallback>{initials(me.name, me.email)}</Avatar.Fallback>
      </Avatar.Root>
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
