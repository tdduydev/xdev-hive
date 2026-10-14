import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import type { RemoteSession } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Pill } from "@xdev-hive/ui/pill";
import { TERMINAL_DEFAULT_FONT_SIZE } from "@xdev-hive/ui/terminal-theme";
import { ChevronLeftIcon } from "lucide-react";
import { useState } from "react";
import { TerminalView } from "@/components/terminal-view.tsx";
import { LoadFailure, LoadingState } from "@/components/ui/query-state.tsx";
import { formatDayTime, formatDuration } from "@/lib/format.ts";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import { cliLabel } from "@/lib/run-view.ts";
import { formatBytes, ORIGIN_LABEL, remoteEndReasonText, sessionDurationMs } from "@/lib/terminal/sessions.ts";
import { isEnded, isLive, STATE_VIEW } from "@/lib/terminal.ts";
import { useOrg } from "@/shell/org-context.ts";
import { PageBody, PageHeader } from "@/shell/page-header.tsx";

const text: Dict<
  Record<
    | "back"
    | "terminal"
    | "machine"
    | "cli"
    | "account"
    | "folder"
    | "origin"
    | "started"
    | "duration"
    | "size"
    | "owner"
    | "exitCode"
    | "team"
    | "viewOnly"
    | "liveHint"
    | "replaying"
    | "replayFailed"
    | "linkConfirm",
    string
  >
> = {
  vi: {
    back: "Điều khiển từ xa",
    terminal: "Phiên",
    machine: "Máy",
    cli: "CLI",
    account: "Gói",
    folder: "Thư mục",
    origin: "Mở",
    started: "Bắt đầu",
    duration: "Thời lượng",
    size: "Bản ghi",
    owner: "Người mở",
    exitCode: "Mã thoát",
    team: "Cho đội xem",
    viewOnly: "Chỉ xem",
    liveHint: "Phiên đang chạy. Bên dưới là bản ghi tới lúc này; xem trực tiếp và điều khiển chưa có ở trang này.",
    replaying: "Đang tải bản ghi…",
    replayFailed: "Không tải được bản ghi của phiên.",
    linkConfirm: "Mở liên kết trong output của phiên? Địa chỉ: ",
  },
  en: {
    back: "Remote control",
    terminal: "Session",
    machine: "Machine",
    cli: "CLI",
    account: "Plan",
    folder: "Folder",
    origin: "Opened",
    started: "Started",
    duration: "Duration",
    size: "Recording",
    owner: "Opened by",
    exitCode: "Exit code",
    team: "Shared with team",
    viewOnly: "View only",
    liveHint:
      "The session is running. Below is the recording up to now; live view and control are not on this page yet.",
    replaying: "Loading the recording…",
    replayFailed: "Could not load the session recording.",
    linkConfirm: "Open the link found in the session output? Address: ",
  },
};

/** Trang một phiên tương tác: siêu dữ liệu, trạng thái và bản ghi phát lại theo trang (`remote.chunks`). */
export function RemoteSessionPage() {
  const t = useT(text);
  const { id } = useParams({ from: "/session/app/in-org/remote/$id" });
  const { api } = useOrg();
  const session = useQuery({
    ...api.remote.get.queryOptions({ input: { id } }),
    // Phiên còn chạy thì hỏi lại để biết lúc nó kết thúc và tải nốt phần output còn thiếu.
    refetchInterval: (q) => (q.state.data && isLive(q.state.data) ? 5_000 : false),
  });

  if (session.isPending || session.isError) {
    return (
      <>
        <PageHeader title={t.terminal} />
        <PageBody>
          {session.isPending ? <LoadingState /> : <LoadFailure error={session.error} retry={session.refetch} />}
        </PageBody>
      </>
    );
  }
  return <SessionView session={session.data} />;
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 break-words">
      <dt className="inline text-muted-foreground">{label}: </dt>
      <dd className="inline font-medium text-foreground">{children}</dd>
    </div>
  );
}

function SessionView({ session }: { session: RemoteSession }) {
  const t = useT(text);
  const lang = useLang();
  const { api } = useOrg();
  const [replay, setReplay] = useState<"idle" | "loading" | "done" | "failed">("idle");
  const ended = isEnded(session);
  const state = STATE_VIEW[session.state];
  const title = session.taskKey ?? session.projectKey ?? session.cwdLabel ?? cliLabel(session.cli);

  return (
    <>
      <PageHeader
        crumb={
          <Link to="/remote" className="inline-flex items-center gap-0.5 text-primary hover:text-primary/90">
            <ChevronLeftIcon className="size-3.5" aria-hidden="true" />
            {t.back}
          </Link>
        }
        title={title}
      >
        <Pill tone={state.tone} dot role="status">
          {state.label[lang]}
        </Pill>
        {session.visibility === "team" && <Pill>{t.team}</Pill>}
        {!session.isOwner && <Pill tone="warn">{t.viewOnly}</Pill>}
      </PageHeader>
      <PageBody>
        <dl className="flex min-w-0 flex-wrap gap-x-4 gap-y-1 text-xs">
          <Meta label={t.machine}>{session.machineName}</Meta>
          <Meta label={t.cli}>{cliLabel(session.cli)}</Meta>
          {session.accountLabel && <Meta label={t.account}>{session.accountLabel}</Meta>}
          {session.cwdLabel && <Meta label={t.folder}>{session.cwdLabel}</Meta>}
          <Meta label={t.origin}>{ORIGIN_LABEL[session.origin][lang]}</Meta>
          <Meta label={t.started}>{formatDayTime(session.createdAt, lang)}</Meta>
          <Meta label={t.duration}>{formatDuration(sessionDurationMs(session, Date.now()))}</Meta>
          <Meta label={t.size}>{formatBytes(session.bytes)}</Meta>
          {!session.isOwner && session.ownerName && <Meta label={t.owner}>{session.ownerName}</Meta>}
        </dl>

        {ended ? (
          <Alert variant={session.state === "failed" ? "destructive" : undefined}>
            {remoteEndReasonText(session, lang)}
            {session.exitCode !== null && ` ${t.exitCode}: ${session.exitCode}.`}
          </Alert>
        ) : (
          <p className="text-xs text-muted-foreground">{t.liveHint}</p>
        )}
        {replay === "loading" && (
          <p role="status" className="text-xs text-muted-foreground">
            {t.replaying}
          </p>
        )}
        {replay === "failed" && <Alert variant="destructive">{t.replayFailed}</Alert>}

        {/* Khung cao theo màn hình; TerminalView tự cuộn ngang khi cỡ phiên rộng hơn khung (điện thoại). */}
        <div className="h-[60dvh] min-h-[20rem] min-w-0">
          <TerminalView
            // Phiên vừa kết thúc: dựng lại để phát lại từ đầu tới hết, thay vì ghép vào bản ghi dở.
            key={`${session.id}:${ended ? "ended" : "live"}`}
            sessionId={session.id}
            cols={session.cols}
            rows={session.rows}
            live={false}
            readOnly
            fontSize={TERMINAL_DEFAULT_FONT_SIZE}
            label={`${t.terminal} ${title}`}
            fetchTicket={() => Promise.reject(new Error("Trang phát lại không nối WebSocket."))}
            fetchChunks={(after) => api.remote.chunks.call({ id: session.id, after, limit: 200 })}
            confirmLink={(uri) => window.confirm(`${t.linkConfirm}${uri}`)}
            handlers={{
              onConnection: () => {},
              onHello: () => {},
              onState: () => {},
              onActivity: () => {},
              onError: () => {},
              onReplay: setReplay,
            }}
          />
        </div>
      </PageBody>
    </>
  );
}
