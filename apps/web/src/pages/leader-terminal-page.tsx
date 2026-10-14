import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import type { TerminalSession } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Dialog, DialogActions, DialogContent, DialogDescription, DialogTitle } from "@xdev-hive/ui/dialog";
import { NativeSelect } from "@xdev-hive/ui/native-select";
import { Pill } from "@xdev-hive/ui/pill";
import { TERMINAL_DEFAULT_FONT_SIZE, TERMINAL_FONT_SIZES } from "@xdev-hive/ui/terminal-theme";
import { ChevronLeftIcon, KeyboardIcon, ListChecksIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { pendingCount, TerminalActivity, useTerminalActivity } from "@/components/terminal-activity.tsx";
import { TerminalKeys, useKeyPad } from "@/components/terminal-keys.tsx";
import { type ReplayStatus, TerminalView, type TerminalViewHandle } from "@/components/terminal-view.tsx";
import { LoadFailure, LoadingState } from "@/components/ui/query-state.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { cx } from "@/lib/cx.ts";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import { isOrgAdmin } from "@/lib/roles.ts";
import {
  endReasonText,
  isEnded,
  isLive,
  MODE_VIEW,
  MODEL_LABEL,
  PERMISSIONS_LABEL,
  STATE_VIEW,
} from "@/lib/terminal.ts";
import type { Connection } from "@/lib/terminal-socket.ts";
import { useOrg } from "@/shell/org-context.ts";
import { PageBody, PageHeader } from "@/shell/page-header.tsx";

const text: Dict<
  Record<
    | "back"
    | "connecting"
    | "connected"
    | "reconnecting"
    | "ended"
    | "failed"
    | "forbidden"
    | "ticket"
    | "replaying"
    | "replayFailed"
    | "viewOnly"
    | "viewOnlyHint"
    | "share"
    | "shareHint"
    | "close"
    | "closeTitle"
    | "closeBody"
    | "closing"
    | "keep"
    | "fontSize"
    | "keyBar"
    | "keyBarHint"
    | "terminal"
    | "machine"
    | "account"
    | "permissions"
    | "owner"
    | "advisor"
    | "team"
    | "panelProposals"
    | "panelActions"
    | "hubMessage"
    | "linkConfirm"
    | "exitCode",
    string
  >
> = {
  vi: {
    back: "Leader",
    connecting: "Đang kết nối",
    connected: "Đã kết nối",
    reconnecting: "Mất kết nối, đang nối lại…",
    ended: "Phiên đã kết thúc",
    failed: "Phiên bị lỗi",
    forbidden: "Bạn không còn quyền xem phiên này. Có thể bạn mất vai trò hoặc chủ phiên đã tắt “Cho đội xem”.",
    ticket: "Không xin được vé kết nối tới phiên. Tải lại trang để thử lại.",
    replaying: "Đang tải bản ghi…",
    replayFailed: "Không tải được bản ghi của phiên.",
    viewOnly: "Chỉ xem",
    viewOnlyHint: "Bạn đang xem phiên của người khác, terminal không nhận phím gõ.",
    share: "Cho đội xem",
    shareHint: "Thành viên đội xem được phiên này (chỉ xem, không gõ).",
    close: "Đóng phiên",
    closeTitle: "Đóng phiên terminal?",
    closeBody: "Claude bị dừng và worktree tạm của phiên bị xoá. Bản ghi vẫn xem lại được.",
    closing: "Đang đóng…",
    keep: "Giữ phiên",
    fontSize: "Cỡ chữ",
    keyBar: "Thanh phím",
    keyBarHint: "Esc, Tab, Ctrl, mũi tên và ô soạn dòng cho điện thoại",
    terminal: "Terminal Leader",
    machine: "Máy",
    account: "Gói",
    permissions: "Quyền",
    owner: "Người mở",
    advisor: "cố vấn",
    team: "Đội xem được",
    panelProposals: "Đề xuất",
    panelActions: "Nhật ký",
    hubMessage: "Hub báo",
    linkConfirm: "Mở liên kết này trong tab mới?\n\n",
    exitCode: "Mã thoát",
  },
  en: {
    back: "Leader",
    connecting: "Connecting",
    connected: "Connected",
    reconnecting: "Connection lost, reconnecting…",
    ended: "Session ended",
    failed: "Session failed",
    forbidden:
      "You can no longer view this session. You may have lost your role, or the owner turned off “Share with team”.",
    ticket: "Could not get a connection ticket for the session. Reload the page to try again.",
    replaying: "Loading the recording…",
    replayFailed: "Could not load the session recording.",
    viewOnly: "View only",
    viewOnlyHint: "You are watching someone else's session; the terminal does not take keystrokes.",
    share: "Share with team",
    shareHint: "Team members can watch this session (view only, no typing).",
    close: "Close session",
    closeTitle: "Close the terminal session?",
    closeBody: "Claude is stopped and the session's temporary worktree is deleted. The recording stays viewable.",
    closing: "Closing…",
    keep: "Keep session",
    fontSize: "Font size",
    keyBar: "Key bar",
    keyBarHint: "Esc, Tab, Ctrl, arrows and a line composer for phones",
    terminal: "Leader terminal",
    machine: "Machine",
    account: "Account",
    permissions: "Permissions",
    owner: "Opened by",
    advisor: "advisor",
    team: "Visible to team",
    panelProposals: "Proposals",
    panelActions: "Log",
    hubMessage: "Hub says",
    linkConfirm: "Open this link in a new tab?\n\n",
    exitCode: "Exit code",
  },
};

const FONT_KEY = "hive.terminal.fontSize";

/** Thanh phím mở sẵn trên màn hẹp và màn cảm ứng (không có Esc, Tab, Ctrl); trên máy tính để người dùng tự bật. */
const keysByDefault = () => matchMedia("(pointer: coarse), (max-width: 56.24rem)").matches;

function readFontSize(): number {
  try {
    const value = Number(localStorage.getItem(FONT_KEY));
    return (TERMINAL_FONT_SIZES as readonly number[]).includes(value) ? value : TERMINAL_DEFAULT_FONT_SIZE;
  } catch {
    return TERMINAL_DEFAULT_FONT_SIZE;
  }
}

/** Trang một phiên terminal Leader: xterm toàn khung, trạng thái kết nối, và khung đề xuất / nhật ký bên phải. */
export function LeaderTerminalPage() {
  const t = useT(text);
  const { id } = useParams({ from: "/session/app/in-org/leader/terminal/$id" });
  const { api } = useOrg();
  const session = useQuery(api.terminal.get.queryOptions({ input: { id } }));

  if (session.isPending) {
    return (
      <>
        <PageHeader title={t.terminal} />
        <PageBody>
          <LoadingState />
        </PageBody>
      </>
    );
  }
  if (session.isError) {
    return (
      <>
        <PageHeader title={t.terminal} />
        <PageBody>
          <LoadFailure error={session.error} retry={session.refetch} />
        </PageBody>
      </>
    );
  }
  return <SessionView key={id} session={session.data} />;
}

function SessionView({ session }: { session: TerminalSession }) {
  const t = useT(text);
  const lang = useLang();
  const { api, org } = useOrg();
  const queryClient = useQueryClient();
  const ids = { font: useId(), panel: useId(), share: useId() };
  const projects = useQuery(api.projects.list.queryOptions({ input: {} }));
  const activity = useTerminalActivity(session);
  const [connection, setConnection] = useState<Connection>({ kind: "connecting" });
  const [canInput, setCanInput] = useState<boolean | null>(null);
  const [replay, setReplay] = useState<ReplayStatus>("idle");
  const [hubMessage, setHubMessage] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [fontSize, setFontSize] = useState(readFontSize);
  const [keysOpen, setKeysOpen] = useState(keysByDefault);
  const view = useRef<TerminalViewHandle>(null);
  const pad = useKeyPad();
  const messageTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (messageTimer.current && clearTimeout(messageTimer.current)), []);

  const live = isLive(session);
  const ended = isEnded(session);
  const readOnly = ended || !(canInput ?? session.isOwner);
  // Phím gửi cùng đường với chữ gõ trong xterm (khung `in` của WS), nên chỉ khi người dùng được gõ.
  const canType = live && !readOnly;
  const bypass = session.mode === "bypass";
  const mode = MODE_VIEW[session.mode];
  const state = STATE_VIEW[session.state];

  const sessionKey = api.terminal.get.queryKey({ input: { id: session.id } });
  // Hàm đổi mỗi lần vẽ không sao: TerminalView đọc handler qua ref, không nối lại socket.
  const put = (next: TerminalSession) => queryClient.setQueryData(sessionKey, next);
  const refreshActivity = () => queryClient.invalidateQueries({ queryKey: api.terminal.activity.key() });

  const visibility = useMutation({
    mutationFn: (value: "private" | "team") => api.terminal.setVisibility.call({ id: session.id, visibility: value }),
    onSuccess: put,
  });
  const close = useMutation({
    mutationFn: () => api.terminal.close.call({ id: session.id }),
    onSuccess: async (next) => {
      put(next);
      setClosing(false);
      await queryClient.invalidateQueries({ queryKey: api.terminal.list.key() });
    },
  });

  const handlers = {
    onConnection: setConnection,
    onHello: (next: TerminalSession, input: boolean) => {
      put(next);
      setCanInput(input);
    },
    onState: put,
    onActivity: () => void refreshActivity(),
    onError: (_code: string, message: string) => {
      setHubMessage(message);
      if (messageTimer.current) clearTimeout(messageTimer.current);
      messageTimer.current = setTimeout(() => setHubMessage(null), 8000);
    },
    onReplay: setReplay,
  };
  // Hub đóng WS với 4404 (phiên đã kết thúc): lấy trạng thái mới để terminal chuyển sang phát lại phần còn thiếu.
  const onConnection = (next: Connection) => {
    setConnection(next);
    if (next.kind === "stopped" && next.reason === "notFound") {
      void queryClient.invalidateQueries({ queryKey: sessionKey });
    }
  };

  let status: { tone: "neutral" | "ok" | "warn" | "bad" | "sel"; label: string };
  if (ended)
    status = {
      tone: session.state === "failed" ? "bad" : "neutral",
      label: session.state === "failed" ? t.failed : t.ended,
    };
  else if (connection.kind === "stopped") {
    status = {
      tone: "bad",
      label: connection.reason === "notFound" ? t.ended : connection.reason === "forbidden" ? t.viewOnly : t.failed,
    };
  } else if (connection.kind === "connected") status = { tone: "ok", label: t.connected };
  else if (connection.kind === "reconnecting") status = { tone: "warn", label: t.reconnecting };
  else status = { tone: "sel", label: t.connecting };

  const pending = pendingCount(activity.data?.proposals);
  const canClose = live && (session.isOwner || isOrgAdmin(org.role));
  const panelLabel = bypass ? t.panelActions : t.panelProposals;
  const panelCount = bypass ? activity.data?.actions.length : pending;

  return (
    <>
      <PageHeader
        crumb={
          <Link to="/leader" className="inline-flex items-center gap-0.5 text-primary hover:text-primary/90">
            <ChevronLeftIcon className="size-3.5" aria-hidden="true" />
            {t.back}
          </Link>
        }
        title={`${session.projectKey} · ${session.projectName}`}
      >
        <Pill tone={status.tone} dot role="status">
          {status.label}
        </Pill>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground" htmlFor={ids.font}>
          {t.fontSize}
          <NativeSelect
            id={ids.font}
            size="sm"
            className="w-auto"
            value={String(fontSize)}
            onChange={(event) => {
              const next = Number(event.target.value);
              setFontSize(next);
              try {
                localStorage.setItem(FONT_KEY, String(next));
              } catch {
                /* Không lưu được thì vẫn đổi cho phiên này. */
              }
            }}
          >
            {TERMINAL_FONT_SIZES.map((size) => (
              <option key={size} value={size}>
                {size}px
              </option>
            ))}
          </NativeSelect>
        </label>
        {session.isOwner && !ended && (
          <div className="flex items-center gap-2 text-sm font-medium" title={t.shareHint}>
            <Switch
              id={ids.share}
              aria-label={t.share}
              checked={session.visibility === "team"}
              disabled={visibility.isPending}
              onCheckedChange={(checked) => visibility.mutate(checked ? "team" : "private")}
            />
            <label htmlFor={ids.share} className="cursor-pointer">
              {t.share}
            </label>
          </div>
        )}
        {canClose && (
          <Button variant="destructive" onClick={() => setClosing(true)}>
            {t.close}
          </Button>
        )}
      </PageHeader>
      <PageBody>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-muted-foreground">
          <Pill tone={mode.tone}>{mode.label[lang]}</Pill>
          <Pill>
            {MODEL_LABEL[session.model]}
            {session.advisor ? ` + ${t.advisor} ${session.advisor}` : ""}
          </Pill>
          <Pill tone={state.tone}>{state.label[lang]}</Pill>
          {!session.isOwner && <Pill tone="warn">{t.viewOnly}</Pill>}
          {canType && (
            <Button
              variant="outline"
              size="sm"
              aria-pressed={keysOpen}
              title={t.keyBarHint}
              onClick={() => setKeysOpen((open) => !open)}
            >
              <KeyboardIcon aria-hidden="true" />
              {t.keyBar}
            </Button>
          )}
          {session.visibility === "team" && <Pill>{t.team}</Pill>}
          <span className="min-w-0 break-words">
            {t.machine}: <strong className="font-medium text-foreground">{session.machineName}</strong>
          </span>
          {session.accountLabel && (
            <span className="min-w-0 break-words">
              {t.account}: <strong className="font-medium text-foreground">{session.accountLabel}</strong>
            </span>
          )}
          {session.permissions && (
            <span>
              {t.permissions}:{" "}
              <strong className="font-medium text-foreground">{PERMISSIONS_LABEL[session.permissions][lang]}</strong>
            </span>
          )}
          {session.ownerName && (
            <span className="min-w-0 break-words">
              {t.owner}: <strong className="font-medium text-foreground">{session.ownerName}</strong>
            </span>
          )}
        </div>

        {ended && (
          <Alert>
            {endReasonText(session, lang)}
            {session.exitCode !== null && ` ${t.exitCode}: ${session.exitCode}.`}
          </Alert>
        )}
        {!ended && connection.kind === "stopped" && connection.reason === "forbidden" && (
          <Alert variant="destructive">{t.forbidden}</Alert>
        )}
        {!ended && connection.kind === "stopped" && connection.reason === "ticket" && (
          <Alert variant="destructive">{t.ticket}</Alert>
        )}
        {!session.isOwner && live && <p className="text-xs text-muted-foreground">{t.viewOnlyHint}</p>}
        {hubMessage && (
          <Alert variant="destructive">
            {t.hubMessage}: {hubMessage}
          </Alert>
        )}
        {replay === "loading" && (
          <p role="status" className="text-xs text-muted-foreground">
            {t.replaying}
          </p>
        )}
        {replay === "failed" && <Alert variant="destructive">{t.replayFailed}</Alert>}
        {visibility.isError && <Alert variant="destructive">{apiErrorMessage(visibility.error)}</Alert>}

        <div className="grid min-w-0 gap-3 app:grid-cols-[minmax(0,1fr)_23rem]">
          <div className="grid min-w-0 content-start gap-2">
            <div className="h-[60dvh] min-h-[20rem] min-w-0 app:h-[calc(100dvh-16rem)] app:min-h-[26rem]">
              <TerminalView
                ref={view}
                transformInput={pad.transform}
                sessionId={session.id}
                cols={session.cols}
                rows={session.rows}
                live={live}
                readOnly={readOnly}
                fontSize={fontSize}
                label={`${t.terminal} ${session.projectKey}`}
                fetchTicket={() => api.terminal.ticket.call({ id: session.id })}
                fetchChunks={(after) => api.terminal.chunks.call({ id: session.id, after, limit: 200 })}
                confirmLink={(uri) => window.confirm(`${t.linkConfirm}${uri}`)}
                handlers={{ ...handlers, onConnection }}
              />
            </div>
            {canType && keysOpen && <TerminalKeys pad={pad} send={(data) => view.current?.send(data)} />}
          </div>
          <div className="grid min-h-0 min-w-0 content-start gap-2">
            <Button
              variant="outline"
              className="app:hidden"
              aria-expanded={panelOpen}
              aria-controls={ids.panel}
              onClick={() => setPanelOpen((value) => !value)}
            >
              <ListChecksIcon aria-hidden="true" />
              {panelLabel}
              {panelCount !== undefined && panelCount > 0 ? ` (${panelCount})` : ""}
            </Button>
            <div
              className={cx(
                "min-h-0 max-h-[60dvh] app:block app:h-[calc(100dvh-16rem)] app:max-h-none",
                panelOpen ? "block" : "hidden",
              )}
            >
              <TerminalActivity id={ids.panel} session={session} projects={projects.data} />
            </div>
          </div>
        </div>
      </PageBody>

      <Dialog open={closing} onOpenChange={(open) => !open && !close.isPending && setClosing(false)}>
        <DialogContent>
          <DialogTitle>{t.closeTitle}</DialogTitle>
          <DialogDescription>{t.closeBody}</DialogDescription>
          {close.isError && <Alert variant="destructive">{apiErrorMessage(close.error)}</Alert>}
          <DialogActions>
            <Button variant="outline" onClick={() => setClosing(false)} disabled={close.isPending}>
              {t.keep}
            </Button>
            <Button variant="destructive-solid" onClick={() => close.mutate()} disabled={close.isPending}>
              {close.isPending ? t.closing : t.close}
            </Button>
          </DialogActions>
        </DialogContent>
      </Dialog>
    </>
  );
}
