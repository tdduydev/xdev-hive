import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import type { RemoteSession } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { NativeSelect } from "@xdev-hive/ui/native-select";
import { Pill } from "@xdev-hive/ui/pill";
import { TERMINAL_DEFAULT_FONT_SIZE, TERMINAL_FONT_SIZES } from "@xdev-hive/ui/terminal-theme";
import { ChevronLeftIcon, KeyboardIcon } from "lucide-react";
import { useId, useRef, useState } from "react";
import { TerminalKeys, useKeyPad } from "@/components/terminal-keys.tsx";
import { type LiveSink, TerminalView, type TerminalViewHandle } from "@/components/terminal-view.tsx";
import { LoadFailure, LoadingState } from "@/components/ui/query-state.tsx";
import { formatDayTime, formatDuration } from "@/lib/format.ts";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import { cliLabel } from "@/lib/run-view.ts";
import { newControlAttempt } from "@/lib/terminal/input-mac.ts";
import { formatBytes, ORIGIN_LABEL, remoteEndReasonText, sessionDurationMs } from "@/lib/terminal/sessions.ts";
import { getAssertion, PasskeyError, pairedDevices, passkeySupport } from "@/lib/terminal/webauthn.ts";
import { type ControlState, RemoteSocket, type RevokeReason } from "@/lib/terminal/ws-client.ts";
import { isEnded, isLive, STATE_VIEW } from "@/lib/terminal.ts";
import type { Connection } from "@/lib/terminal-socket.ts";
import { useMe } from "@/shell/me-context.ts";
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
    | "replaying"
    | "replayFailed"
    | "linkConfirm"
    | "connecting"
    | "reconnecting"
    | "stopped"
    | "forbidden"
    | "ticket"
    | "control"
    | "requesting"
    | "resuming"
    | "release"
    | "controlling"
    | "watching"
    | "fontSize"
    | "keyBar"
    | "keyBarHint"
    | "unpaired"
    | "pairLink"
    | "insecure"
    | "unsupported"
    | "passkeyFailed"
    | "hubMessage"
    | "revokedTaken"
    | "revokedIdle"
    | "revokedDisabled"
    | "revokedDevice"
    | "revokedInput"
    | "revokedClosed"
    | "revokedExpired",
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
    replaying: "Đang tải bản ghi…",
    replayFailed: "Không tải được bản ghi của phiên.",
    linkConfirm: "Mở liên kết trong output của phiên? Địa chỉ: ",
    connecting: "Đang kết nối",
    reconnecting: "Mất kết nối, đang nối lại…",
    stopped: "Đã ngắt",
    forbidden: "Bạn không còn quyền xem phiên này, hoặc chủ máy đã tắt điều khiển từ xa.",
    ticket: "Không xin được vé kết nối tới phiên. Tải lại trang để thử lại.",
    control: "Điều khiển",
    requesting: "Đang xác thực…",
    resuming: "Đang lấy lại quyền gõ…",
    release: "Trả quyền",
    controlling: "Bạn đang điều khiển phiên này. Phím gõ ở đây đi thẳng tới máy.",
    watching: "Đang xem trực tiếp. Bấm “Điều khiển” và xác thực bằng passkey để gõ.",
    fontSize: "Cỡ chữ",
    keyBar: "Thanh phím",
    keyBarHint: "Esc, Tab, Ctrl, mũi tên và ô soạn dòng cho điện thoại",
    unpaired: "Thiết bị này chưa ghép với máy nên chưa điều khiển được.",
    pairLink: "Ghép thiết bị",
    insecure: "Trang không chạy HTTPS nên trình duyệt không dùng được passkey.",
    unsupported: "Trình duyệt này không hỗ trợ passkey.",
    passkeyFailed: "Không xác thực được bằng passkey.",
    hubMessage: "Hub báo",
    revokedTaken: "Quyền gõ đã chuyển sang nơi khác (terminal tại máy hoặc thiết bị khác).",
    revokedIdle: "Hết quyền gõ vì lâu không gõ.",
    revokedDisabled: "Chủ máy đã tắt điều khiển từ xa.",
    revokedDevice: "Thiết bị này đã bị gỡ khỏi máy.",
    revokedInput: "Máy từ chối phím gõ không hợp lệ và thu quyền. Bấm “Điều khiển” để xác thực lại.",
    revokedClosed: "Phiên đã đóng.",
    revokedExpired: "Quyền gõ đã hết hạn. Bấm “Điều khiển” để xác thực lại.",
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
    replaying: "Loading the recording…",
    replayFailed: "Could not load the session recording.",
    linkConfirm: "Open the link found in the session output? Address: ",
    connecting: "Connecting",
    reconnecting: "Connection lost, reconnecting…",
    stopped: "Disconnected",
    forbidden: "You can no longer view this session, or the machine owner turned remote control off.",
    ticket: "Could not get a connection ticket for the session. Reload the page to try again.",
    control: "Take control",
    requesting: "Verifying…",
    resuming: "Getting control back…",
    release: "Give back",
    controlling: "You are controlling this session. Keys typed here go straight to the machine.",
    watching: "Watching live. Press “Take control” and verify with your passkey to type.",
    fontSize: "Font size",
    keyBar: "Key bar",
    keyBarHint: "Esc, Tab, Ctrl, arrows and a line composer for phones",
    unpaired: "This device is not paired with the machine yet, so it cannot take control.",
    pairLink: "Pair device",
    insecure: "The page is not served over HTTPS, so the browser cannot use passkeys.",
    unsupported: "This browser does not support passkeys.",
    passkeyFailed: "Passkey verification failed.",
    hubMessage: "Hub says",
    revokedTaken: "Control moved elsewhere (the terminal on the machine or another device).",
    revokedIdle: "Control ended after a long idle period.",
    revokedDisabled: "The machine owner turned remote control off.",
    revokedDevice: "This device was removed from the machine.",
    revokedInput:
      "The machine rejected an invalid keystroke and took control back. Press “Take control” to verify again.",
    revokedClosed: "The session was closed.",
    revokedExpired: "Control expired. Press “Take control” to verify again.",
  },
};

const REVOKED: Record<RevokeReason, keyof (typeof text)["vi"]> = {
  taken: "revokedTaken",
  idle: "revokedIdle",
  disabled: "revokedDisabled",
  device_revoked: "revokedDevice",
  input_rejected: "revokedInput",
  closed: "revokedClosed",
  expired: "revokedExpired",
};

const FONT_KEY = "hive.terminal.fontSize";
/** 12 px là cỡ lớn nhất còn đủ 40 cột trên màn 360 px. */
const NARROW_FONT_SIZE = 12;

/** Như trang terminal Leader: thanh phím mở sẵn trên màn hẹp và màn cảm ứng. */
const keysByDefault = () => matchMedia("(pointer: coarse), (max-width: 56.24rem)").matches;

function readFontSize(): number {
  const fallback = matchMedia("(max-width: 30rem)").matches ? NARROW_FONT_SIZE : TERMINAL_DEFAULT_FONT_SIZE;
  try {
    const value = Number(localStorage.getItem(FONT_KEY));
    return (TERMINAL_FONT_SIZES as readonly number[]).includes(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

type Notice =
  | { kind: "revoked"; reason: RevokeReason }
  | { kind: "message"; message: string }
  | { kind: "text"; key: "unpaired" | "insecure" | "unsupported" | "passkeyFailed" };

/**
 * Trang một phiên tương tác. Phiên đã đóng: phát lại bản ghi theo trang (`remote.chunks`). Phiên đang chạy: xem trực
 * tiếp qua WebSocket và, nếu là chủ máy đã ghép thiết bị, xin quyền gõ bằng passkey (specs/010 US3).
 */
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
  const me = useMe();
  const { api } = useOrg();
  const queryClient = useQueryClient();
  const fontId = useId();
  const [replay, setReplay] = useState<"idle" | "loading" | "done" | "failed">("idle");
  const [connection, setConnection] = useState<Connection>({ kind: "connecting" });
  const [control, setControl] = useState<ControlState>("none");
  const [canControl, setCanControl] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [fontSize, setFontSize] = useState(readFontSize);
  const [keysOpen, setKeysOpen] = useState(keysByDefault);
  const view = useRef<TerminalViewHandle>(null);
  const socket = useRef<RemoteSocket | null>(null);
  const pad = useKeyPad();
  const ended = isEnded(session);
  const live = isLive(session);
  const state = STATE_VIEW[session.state];
  const title = session.taskKey ?? session.projectKey ?? session.cwdLabel ?? cliLabel(session.cli);
  // Chờ worker cấp lại sau khi nối lại vẫn cho gõ: phím xếp hàng trong `RemoteSocket`.
  const typing = live && (control === "granted" || control === "resuming");

  const sessionKey = api.remote.get.queryKey({ input: { id: session.id } });
  const put = (next: RemoteSession) => queryClient.setQueryData(sessionKey, next);

  const connect = (sink: LiveSink) => {
    const next = new RemoteSocket({
      sessionId: session.id,
      afterSeq: sink.afterSeq,
      fetchTicket: () => api.remote.ticket.call({ id: session.id }),
      handlers: {
        onConnection: (value) => {
          setConnection(value);
          // 4404: phiên vừa kết thúc, lấy trạng thái mới để chuyển sang phát lại.
          if (value.kind === "stopped" && value.reason === "notFound") {
            void queryClient.invalidateQueries({ queryKey: sessionKey });
          }
        },
        onHello: (value, can) => {
          put(value);
          setCanControl(can);
        },
        onOutput: sink.onOutput,
        onReset: () => sink.onReset(),
        onState: put,
        onControl: (value) => {
          setControl(value);
          if (value === "granted") setNotice(null);
        },
        onRevoked: (reason) => setNotice({ kind: "revoked", reason }),
        onDenied: (_code, message) => setNotice({ kind: "message", message }),
        onEvent: () => {},
        onError: (_code, message) => setNotice({ kind: "message", message }),
      },
    });
    socket.current = next;
    return next;
  };

  const takeControl = async () => {
    const current = socket.current;
    if (!current) return;
    setNotice(null);
    const support = passkeySupport();
    if (support !== "ok") {
      setNotice({ kind: "text", key: support });
      return;
    }
    const device = pairedDevices()[session.machineId];
    if (!device) {
      setNotice({ kind: "text", key: "unpaired" });
      return;
    }
    try {
      await current.requestControl(async (connId) => {
        const attempt = await newControlAttempt({
          machineId: session.machineId,
          params: { userId: me.id, deviceId: device.deviceId, sessionId: session.id, connId },
        });
        const assertion = await getAssertion({ challenge: attempt.challenge, credentialIds: [device.credentialId] });
        return {
          attempt,
          deviceId: device.deviceId,
          auth: { kind: "passkey", assertion, ephPub: attempt.ephPub, ts: attempt.ts, nonce: attempt.nonce },
        };
      });
    } catch (error) {
      setNotice(
        error instanceof PasskeyError
          ? { kind: "message", message: error.message }
          : { kind: "text", key: "passkeyFailed" },
      );
    }
  };

  let status = { tone: state.tone, label: state.label[lang] };
  if (live && connection.kind === "connecting") status = { tone: "sel", label: t.connecting };
  else if (live && connection.kind === "reconnecting") status = { tone: "warn", label: t.reconnecting };
  else if (live && connection.kind === "stopped") status = { tone: "bad", label: t.stopped };

  let noticeText: string | null = null;
  if (notice?.kind === "revoked") noticeText = t[REVOKED[notice.reason]];
  else if (notice?.kind === "message") noticeText = `${t.hubMessage}: ${notice.message}`;
  else if (notice?.kind === "text") noticeText = t[notice.key];

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
        <Pill tone={status.tone} dot role="status">
          {status.label}
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

        {ended && (
          <Alert variant={session.state === "failed" ? "destructive" : undefined}>
            {remoteEndReasonText(session, lang)}
            {session.exitCode !== null && ` ${t.exitCode}: ${session.exitCode}.`}
          </Alert>
        )}
        {live && connection.kind === "stopped" && (
          <Alert variant="destructive">{connection.reason === "ticket" ? t.ticket : t.forbidden}</Alert>
        )}
        {live && (
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
            {canControl && control === "none" && (
              <Button size="sm" disabled={connection.kind !== "connected"} onClick={() => void takeControl()}>
                {t.control}
              </Button>
            )}
            {control === "requesting" && (
              <Button size="sm" disabled>
                {t.requesting}
              </Button>
            )}
            {typing && (
              <Button size="sm" variant="outline" onClick={() => socket.current?.release()}>
                {t.release}
              </Button>
            )}
            {typing && (
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
            <label className="flex items-center gap-1.5 text-muted-foreground" htmlFor={fontId}>
              {t.fontSize}
              <NativeSelect
                id={fontId}
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
          </div>
        )}
        {live && (
          <p role="status" className="text-xs text-muted-foreground">
            {control === "resuming" ? t.resuming : typing ? t.controlling : canControl ? t.watching : ""}
          </p>
        )}
        {noticeText && (
          <Alert variant={notice?.kind === "revoked" ? undefined : "destructive"}>
            {noticeText}
            {notice?.kind === "text" && notice.key === "unpaired" && (
              <>
                {" "}
                <Link to="/remote" className="font-medium text-primary underline">
                  {t.pairLink}
                </Link>
              </>
            )}
          </Alert>
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
            ref={view}
            transformInput={pad.transform}
            sessionId={session.id}
            cols={session.cols}
            rows={session.rows}
            live={live}
            readOnly={!typing}
            // Người giữ quyền gõ quyết cỡ PTY theo màn của mình; người xem giữ cỡ phiên và cuộn ngang.
            fit={typing}
            fontSize={live ? fontSize : TERMINAL_DEFAULT_FONT_SIZE}
            label={`${t.terminal} ${title}`}
            connect={connect}
            fetchTicket={() => api.remote.ticket.call({ id: session.id })}
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
        {typing && keysOpen && <TerminalKeys pad={pad} send={(data) => view.current?.send(data)} />}
      </PageBody>
    </>
  );
}
