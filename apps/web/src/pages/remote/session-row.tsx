import { Link } from "@tanstack/react-router";
import type { RemoteSession } from "@xdev-hive/contracts";
import { Pill } from "@xdev-hive/ui/pill";
import { formatAgo } from "@/lib/format.ts";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import { cliLabel } from "@/lib/run-view.ts";
import { formatBytes, ORIGIN_LABEL, sessionTitle } from "@/lib/terminal/sessions.ts";
import { STATE_VIEW } from "@/lib/terminal.ts";

const text: Dict<Record<"team" | "viewOnly" | "owner" | "noRemote", string>> = {
  vi: { team: "Cho đội xem", viewOnly: "Chỉ xem", owner: "Người mở", noRemote: "Không cho từ xa" },
  en: { team: "Shared with team", viewOnly: "View only", owner: "Opened by", noRemote: "Remote off" },
};

/**
 * Một dòng phiên tương tác, dùng ở trang Điều khiển từ xa và mục "Phiên tương tác" của bảng việc. Cả dòng là link (vùng
 * bấm cao ≥ 44 px cho điện thoại) và mọi thông tin nằm trong cùng một tên truy cập để trình đọc màn hình đọc một lần.
 */
export function RemoteSessionRow({ session, now }: { session: RemoteSession; now: number }) {
  const t = useT(text);
  const lang = useLang();
  const state = STATE_VIEW[session.state];
  return (
    <Link
      to="/remote/$id"
      params={{ id: session.id }}
      className="grid min-h-11 min-w-0 gap-1 rounded-md border border-border bg-card px-3 py-2 text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0 font-medium break-words text-foreground">{sessionTitle(session)}</span>
        <Pill tone={state.tone} dot>
          {state.label[lang]}
        </Pill>
        {session.visibility === "team" && <Pill>{t.team}</Pill>}
        {!session.isOwner && <Pill tone="warn">{t.viewOnly}</Pill>}
      </span>
      <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
        <span className="min-w-0 break-words">{session.machineName}</span>
        <span>{cliLabel(session.cli)}</span>
        <span>{ORIGIN_LABEL[session.origin][lang]}</span>
        <span>{formatAgo(session.createdAt, now, lang)}</span>
        <span>{formatBytes(session.bytes)}</span>
        {!session.isOwner && session.ownerName && (
          <span className="min-w-0 break-words">
            {t.owner}: {session.ownerName}
          </span>
        )}
      </span>
    </Link>
  );
}
