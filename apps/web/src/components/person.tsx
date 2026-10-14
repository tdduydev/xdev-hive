import { Avatar } from "@base-ui/react/avatar";
import { Button } from "@xdev-hive/ui/button";
import { Input } from "@xdev-hive/ui/input";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { type Dict, useT } from "@/lib/i18n.ts";
import { initials } from "@/lib/people.ts";

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
export function Who({ person, extra, inline = false }: { person: PersonLike; extra?: ReactNode; inline?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <PersonAvatar person={person} />
      <span className={inline ? "flex min-w-0 max-w-72 items-center gap-2" : "min-w-0"}>
        <span className={inline ? "flex min-w-0 max-w-36 shrink-0 items-center gap-1.5" : "flex items-center gap-1.5"}>
          <b title={person.name} className="truncate font-medium text-foreground">
            {person.name}
          </b>
          {extra}
        </span>
        <span className="block truncate" title={person.email}>
          <small className="text-xs text-muted-foreground">{person.email}</small>
        </span>
      </span>
    </div>
  );
}

const copyText: Dict<{ copy: string; copied: string; failed: string }> = {
  vi: {
    copy: "Chép",
    copied: "Đã chép",
    failed: "Trình duyệt chặn chép tự động. Ô đã được chọn sẵn, bấm Ctrl+C (⌘C trên Mac) để chép.",
  },
  en: {
    copy: "Copy",
    copied: "Copied",
    failed: "The browser blocked automatic copying. The field is selected; press Ctrl+C (⌘C on Mac) to copy.",
  },
};

/** These people screens need localized copy feedback while the existing shared CopyField remains unchanged. */
export function PeopleCopyField({ value, copyLabel }: { value: string; copyLabel: string }) {
  const t = useT(copyText);
  const input = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");
  useEffect(() => {
    if (copied !== "done") return;
    const timer = setTimeout(() => setCopied("idle"), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  async function onCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied("done");
    } catch {
      input.current?.select();
      setCopied("failed");
    }
  }
  const label = copied === "done" ? t.copied : t.copy;
  return (
    <div className="grid min-w-0 gap-1">
      <div className="flex min-w-0 gap-2">
        <Input
          ref={input}
          readOnly
          value={value}
          spellCheck={false}
          onFocus={(event) => event.currentTarget.select()}
          className="min-w-0 flex-1 font-mono text-xs"
        />
        <Button variant="outline" onClick={onCopy} aria-label={`${label} ${copyLabel}`}>
          {label}
        </Button>
      </div>
      {copied === "failed" && (
        <small role="status" className="text-xs text-muted-foreground">
          {t.failed}
        </small>
      )}
    </div>
  );
}
