import { Avatar } from "@base-ui/react/avatar";
import type { ReactNode } from "react";
import { initials } from "../lib/people.ts";

export interface PersonLike {
  name: string;
  email: string;
  image: string | null;
}

export function PersonAvatar({ person }: { person: PersonLike }) {
  return (
    <Avatar.Root className="grid size-7 shrink-0 place-items-center overflow-hidden rounded-full bg-muted text-xs font-semibold text-foreground">
      {person.image && <Avatar.Image src={person.image} alt="" className="size-full object-cover" />}
      <Avatar.Fallback>{initials(person.name, person.email)}</Avatar.Fallback>
    </Avatar.Root>
  );
}

/** Ô "Người" trong bảng: avatar, tên, email; `extra` hiện cạnh tên (vd. "bạn", "Đã khoá"). */
export function Who({ person, extra }: { person: PersonLike; extra?: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5">
      <PersonAvatar person={person} />
      <span className="min-w-0">
        <span className="flex items-center gap-1.5">
          <b className="truncate font-medium text-foreground">{person.name}</b>
          {extra}
        </span>
        <span className="block truncate">
          <small className="text-xs text-muted-foreground">{person.email}</small>
        </span>
      </span>
    </div>
  );
}
