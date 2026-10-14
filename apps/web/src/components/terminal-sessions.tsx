import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { TerminalSession } from "@xdev-hive/contracts";
import { Button } from "@xdev-hive/ui/button";
import { Pill } from "@xdev-hive/ui/pill";
import { useState } from "react";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { formatDayTime } from "@/lib/format.ts";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import { isLive, MODE_VIEW, MODEL_LABEL, STATE_VIEW } from "@/lib/terminal.ts";
import { useOrg } from "@/shell/org-context.ts";

const text: Dict<Record<"title" | "empty" | "viewOnly" | "failed" | "retry" | "more" | "less" | "owner", string>> = {
  vi: {
    title: "Phiên terminal",
    empty: "Chưa có phiên terminal nào.",
    viewOnly: "Chỉ xem",
    failed: "Không tải được danh sách phiên.",
    retry: "Tải lại",
    more: "Xem thêm",
    less: "Thu gọn",
    owner: "Người mở",
  },
  en: {
    title: "Terminal sessions",
    empty: "No terminal sessions yet.",
    viewOnly: "View only",
    failed: "Could not load the sessions.",
    retry: "Retry",
    more: "Show more",
    less: "Show less",
    owner: "Opened by",
  },
};

const SHOWN = 5;

/**
 * Phiên terminal của tôi và phiên đội được xem (route `terminal.list`). Còn phiên đang chạy thì hỏi lại hub định kỳ để
 * trạng thái không cũ; phiên đã đóng bấm vào để xem lại bản ghi.
 */
export function TerminalSessions() {
  const t = useT(text);
  const { api } = useOrg();
  const [all, setAll] = useState(false);
  const sessions = useQuery({
    ...api.terminal.list.queryOptions({ input: {} }),
    refetchInterval: (q) => (q.state.data?.some(isLive) ? 10_000 : false),
  });
  const list = sessions.data ?? [];
  const shown = all ? list : list.slice(0, SHOWN);

  return (
    <section aria-labelledby="terminal-sessions-title" className="grid min-w-0 content-start gap-2">
      <h2 id="terminal-sessions-title" className="font-heading text-lg font-semibold">
        {t.title}
      </h2>
      {sessions.isPending && <p className="text-sm text-muted-foreground">…</p>}
      {sessions.isError && (
        <p className="text-sm text-muted-foreground" title={apiErrorMessage(sessions.error)}>
          {t.failed}{" "}
          <button type="button" className="cursor-pointer underline" onClick={() => sessions.refetch()}>
            {t.retry}
          </button>
        </p>
      )}
      {sessions.isSuccess && list.length === 0 && <p className="text-sm text-muted-foreground">{t.empty}</p>}
      {shown.length > 0 && (
        <ul className="grid gap-1.5">
          {shown.map((session) => (
            <li key={session.id}>
              <SessionLink session={session} />
            </li>
          ))}
        </ul>
      )}
      {list.length > SHOWN && (
        <Button variant="ghost" size="sm" className="justify-self-start" onClick={() => setAll((value) => !value)}>
          {all ? t.less : t.more}
        </Button>
      )}
    </section>
  );
}

function SessionLink({ session }: { session: TerminalSession }) {
  const t = useT(text);
  const lang = useLang();
  const state = STATE_VIEW[session.state];
  const mode = MODE_VIEW[session.mode];
  return (
    <Link
      to="/leader/terminal/$id"
      params={{ id: session.id }}
      className="grid min-w-0 gap-1 rounded-md border border-border px-3 py-2 text-xs transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
    >
      <span className="flex flex-wrap items-center gap-1.5">
        <Pill tone={state.tone} small dot>
          {state.label[lang]}
        </Pill>
        <Pill tone={mode.tone} small>
          {mode.label[lang]}
        </Pill>
        {!session.isOwner && <Pill small>{t.viewOnly}</Pill>}
      </span>
      <span className="truncate font-medium text-foreground">
        {session.projectKey} · {session.machineName}
      </span>
      <span className="truncate text-muted-foreground">
        {MODEL_LABEL[session.model]}
        {session.ownerName ? ` · ${session.ownerName}` : ""} · {formatDayTime(session.createdAt)}
      </span>
    </Link>
  );
}
