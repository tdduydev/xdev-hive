import { Alert, AlertDescription, AlertTitle } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@xdev-hive/ui/dialog";
import { Input } from "@xdev-hive/ui/input";
import { Label } from "@xdev-hive/ui/label";
import { Pill } from "@xdev-hive/ui/pill";
import { FolderPlusIcon, QrCodeIcon, TriangleAlertIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Toggle } from "@/components/toggle.tsx";
import { pickFolder, shortPath } from "@/lib/folder.ts";
import { type Dict, useT } from "@/lib/i18n.ts";
import {
  type HiveCliStatus,
  hiveCliInstall,
  hiveCliStatus,
  isHttpHub,
  type LocalSession,
  onRemotePairDone,
  onRemotePairRequest,
  onRemoteSessions,
  onRemoteState,
  type PairDone,
  type PairInfo,
  type PairRequest,
  qrPath,
  type RemoteSettingKey,
  type RemoteStatus,
  remoteDeviceRemove,
  remoteDisable,
  remoteEnable,
  remotePair,
  remotePairDecide,
  remoteRootAdd,
  remoteRootRemove,
  remoteSessionKill,
  remoteSessions,
  remoteSet,
  remoteStatus,
  remoteTotpConfirm,
  remoteTotpDisable,
  remoteTotpEnroll,
  remoteTotpUnlock,
  type TotpEnroll,
} from "@/lib/remote.ts";
import { errorText, workerState } from "@/lib/tauri.ts";

const vi = {
  http: "Hub chạy HTTP: nội dung phiên và phím gõ không được mã hoá trên đường truyền. Chỉ dùng trong mạng nội bộ.",
  loading: "Đang tải…",
  loadFailed: "Không tải được trạng thái điều khiển từ xa.",
  retry: "Tải lại",
  allow: "Cho điều khiển từ xa",
  allowHint: "Mặc định tắt. Chỉ bật được tại máy này; hub và điện thoại không bật hộ được.",
  offHint: "Đang tắt: điện thoại không mở hay xem trực tiếp được phiên nào. Phiên đang chạy vẫn được ghi.",
  enabledLabel: "Đang bật",
  disabledLabel: "Đang tắt",
  enableTitle: "Bật điều khiển từ xa?",
  enableBody: "Agent có thể chạy lệnh trên máy này khi bạn điều khiển từ điện thoại.",
  enableOk: "Bật",
  roots: "Thư mục được phép",
  addRoot: "Thêm thư mục",
  pickRoot: "Chọn thư mục cho phép điều khiển từ xa",
  remove: "Gỡ",
  removeRoot: (name: string) => `Gỡ thư mục ${name}`,
  rootsHint: "Điện thoại chỉ mở phiên trong các thư mục này (và thư mục con). Đường dẫn trỏ ra ngoài bị từ chối.",
  noRoots: "Chưa có thư mục nào: điện thoại chưa mở được phiên mới.",
  devices: "Thiết bị đã ghép",
  noDevices: "Chưa ghép điện thoại nào.",
  pair: "Ghép điện thoại",
  qrLabel: "Mã QR ghép thiết bị",
  qrHint: "Quét mã bằng điện thoại đã đăng nhập hub, rồi xác thực Face ID / vân tay.",
  qrExpire: "Mã hết hạn sau 10 phút và chỉ dùng một lần.",
  qrClose: "Đóng mã QR",
  qrFailed: "Không vẽ được mã QR. Dùng địa chỉ bên dưới.",
  pairedOk: (label: string) => `Đã ghép ${label || "thiết bị"}.`,
  pairFailed: "Ghép không thành công",
  confirmAsk: "Điện thoại xin ghép:",
  confirmHint: "Chỉ cho phép khi chính bạn vừa quét mã. Máy này đang chờ câu trả lời.",
  allowBtn: "Cho phép",
  denyBtn: "Từ chối",
  revoke: "Gỡ thiết bị",
  revokeOne: (name: string) => `Gỡ thiết bị ${name}`,
  options: "Tuỳ chọn",
  confirmOnMachine: "Hỏi trên máy khi ghép",
  confirmOnMachineHint: "Mỗi yêu cầu ghép phải được bấm Cho phép tại máy này.",
  idleMinutes: "Không hoạt động quá (phút)",
  detachedHours: "Giữ khi không ai xem (giờ)",
  maxHours: "Tối đa mỗi phiên (giờ)",
  fullAccess: "Cho phép toàn quyền từ xa",
  fullAccessHint: "Điện thoại được mở phiên không hỏi quyền từng lệnh.",
  fullAccessTitle: "Cho phép toàn quyền từ xa?",
  fullAccessBody:
    "Agent trong phiên mở từ điện thoại chạy lệnh không hỏi lại từng bước. Chỉ bật nếu bạn tin thiết bị đã ghép.",
  totpOnHttps: "Cho dùng mã Authenticator cả khi hub có HTTPS",
  sessions: "Phiên đang chạy",
  noSessions: "Không có phiên nào đang chạy.",
  originUnknown: "CLI chưa cho biết phiên nào do điện thoại mở, nên danh sách hiện mọi phiên trên máy.",
  fromPhone: "Từ điện thoại",
  atMachine: "Tại máy",
  viewers: (n: number) => `${n} người xem`,
  minutes: (n: number) => `${n} phút`,
  end: "Ngắt",
  endOne: (name: string) => `Ngắt phiên ${name}`,
  endAll: "Ngắt tất cả",
  keep: "Giữ lại",
  cancel: "Huỷ",
  confirmOne: "Ngắt phiên này?",
  confirmOneBody: "Claude trong phiên bị dừng ngay (trong 10 giây). Bản ghi vẫn xem lại được.",
  confirmAllT: "Ngắt tất cả phiên?",
  confirmAllBody:
    "Mọi phiên đang chạy trên máy này bị dừng, kể cả phiên bạn đang gõ tại máy. Việc này được ghi nhật ký.",
  totp: "Mã Authenticator (đường lui cho hub HTTP)",
  totpHint: "Dùng khi hub không có HTTPS nên không tạo được passkey. Khoá nằm ở máy này, không gửi lên hub.",
  totpWarn: "Trên HTTP, nội dung phiên và phím gõ đi qua mạng không mã hoá. Chỉ bật trong mạng nội bộ tin cậy.",
  totpEnabled: "Đã bật",
  totpDisabled: "Chưa bật",
  totpLocked: "Đang khoá do nhập sai nhiều lần",
  totpUnlock: "Mở khoá",
  totpOn: "Bật mã Authenticator",
  totpQr: "Mã QR khoá Authenticator",
  totpSecret: "Hoặc nhập khoá này vào app:",
  totpCode: "Nhập mã 6 số hiện trong app Authenticator",
  totpCodeHint: "Chỉ khi mã đúng thì khoá mới được lưu.",
  totpConfirm: "Xác nhận và bật",
  totpOff: "Tắt mã Authenticator",
  totpOffTitle: "Tắt mã Authenticator?",
  totpOffBody: "Khoá trên máy này bị xoá. Muốn dùng lại phải quét khoá mới.",
  cli: "Lệnh hive trong terminal",
  cliHint: "Dùng hive ls, hive attach, hive remote… ngay trong terminal của máy này.",
  cliMissing: "Bản app này không kèm lệnh hive.",
  cliReady: (path: string) => `Đã sẵn sàng: ${path}`,
  cliNotOnPath: (dir: string) => `Đã cài nhưng thư mục ${dir} chưa nằm trong PATH. Thêm vào PATH rồi mở lại terminal.`,
  cliInstall: "Cài lệnh hive",
  cliUpdate: "Cập nhật lệnh hive",
  workerDown: "Worker chưa chạy nên chưa nhận yêu cầu ghép hay đọc được danh sách phiên.",
  pairReasons: {
    expired: "Mã ghép đã hết hạn hoặc đã dùng.",
    bad_tag: "Khoá của thiết bị không khớp mã ghép; đã từ chối.",
    denied: "Đã từ chối ghép.",
    timeout: "Không ai trả lời kịp tại máy; đã từ chối ghép.",
    user_mismatch: "Người quét không phải chủ máy trên hub; đã từ chối.",
    disabled: "Điều khiển từ xa đang tắt; đã từ chối ghép.",
  } as Record<string, string>,
};

type Strings = {
  [K in keyof typeof vi]: (typeof vi)[K] extends (...a: infer A) => string
    ? (...a: A) => string
    : (typeof vi)[K] extends string
      ? string
      : (typeof vi)[K];
};

const en: Strings = {
  http: "Hub runs on HTTP: session content and keystrokes are not encrypted in transit. Use only on an internal network.",
  loading: "Loading…",
  loadFailed: "Could not load the remote control state.",
  retry: "Retry",
  allow: "Allow remote control",
  allowHint: "Off by default. Can only be switched on at this machine; neither the hub nor the phone can do it.",
  offHint: "Off: no phone can open or watch a session live. Running sessions are still recorded.",
  enabledLabel: "On",
  disabledLabel: "Off",
  enableTitle: "Turn on remote control?",
  enableBody: "The agent can run commands on this machine while you control it from your phone.",
  enableOk: "Turn on",
  roots: "Allowed folders",
  addRoot: "Add folder",
  pickRoot: "Choose a folder to allow for remote control",
  remove: "Remove",
  removeRoot: (name) => `Remove folder ${name}`,
  rootsHint: "Phones can only open sessions inside these folders (and subfolders). Paths that escape are rejected.",
  noRoots: "No folder yet: phones cannot open new sessions.",
  devices: "Paired devices",
  noDevices: "No phone paired yet.",
  pair: "Pair phone",
  qrLabel: "Pairing QR code",
  qrHint: "Scan with a phone signed in to the hub, then confirm with Face ID / fingerprint.",
  qrExpire: "The code expires after 10 minutes and works once.",
  qrClose: "Close QR code",
  qrFailed: "Could not draw the QR code. Use the address below.",
  pairedOk: (label) => `Paired ${label || "device"}.`,
  pairFailed: "Pairing failed",
  confirmAsk: "A phone asks to pair:",
  confirmHint: "Allow only if you just scanned the code yourself. This machine is waiting for your answer.",
  allowBtn: "Allow",
  denyBtn: "Deny",
  revoke: "Remove device",
  revokeOne: (name) => `Remove device ${name}`,
  options: "Options",
  confirmOnMachine: "Ask on this machine when pairing",
  confirmOnMachineHint: "Every pairing request needs Allow to be pressed at this machine.",
  idleMinutes: "Idle longer than (minutes)",
  detachedHours: "Keep with no viewer (hours)",
  maxHours: "Maximum per session (hours)",
  fullAccess: "Allow full access remotely",
  fullAccessHint: "Phones may open sessions that do not ask permission for each command.",
  fullAccessTitle: "Allow full access remotely?",
  fullAccessBody:
    "The agent in a session opened from a phone runs commands without asking at each step. Turn on only if you trust the paired devices.",
  totpOnHttps: "Allow Authenticator code even when the hub has HTTPS",
  sessions: "Running sessions",
  noSessions: "No running sessions.",
  originUnknown: "The CLI does not say which sessions a phone opened, so the list shows every session on this machine.",
  fromPhone: "From phone",
  atMachine: "At machine",
  viewers: (n) => `${n} viewing`,
  minutes: (n) => `${n} min`,
  end: "End",
  endOne: (name) => `End session ${name}`,
  endAll: "End all",
  keep: "Keep",
  cancel: "Cancel",
  confirmOne: "End this session?",
  confirmOneBody: "Claude in the session is stopped within 10 seconds. The recording stays viewable.",
  confirmAllT: "End all sessions?",
  confirmAllBody:
    "Every running session on this machine is stopped, including the one you are typing in here. This is audit-logged.",
  totp: "Authenticator code (fallback for HTTP hubs)",
  totpHint:
    "For hubs without HTTPS where passkeys are unavailable. The key stays on this machine and is never sent to the hub.",
  totpWarn: "Over HTTP, session content and keystrokes travel unencrypted. Only enable on a trusted internal network.",
  totpEnabled: "Enabled",
  totpDisabled: "Not enabled",
  totpLocked: "Locked after too many wrong codes",
  totpUnlock: "Unlock",
  totpOn: "Enable Authenticator code",
  totpQr: "Authenticator key QR code",
  totpSecret: "Or type this key into the app:",
  totpCode: "Enter the 6-digit code from your Authenticator app",
  totpCodeHint: "The key is saved only when the code is correct.",
  totpConfirm: "Confirm and enable",
  totpOff: "Disable Authenticator code",
  totpOffTitle: "Disable Authenticator code?",
  totpOffBody: "The key on this machine is deleted. To use it again you must scan a new key.",
  cli: "The hive command in the terminal",
  cliHint: "Use hive ls, hive attach, hive remote… in this machine's terminal.",
  cliMissing: "This build of the app does not include the hive command.",
  cliReady: (path) => `Ready: ${path}`,
  cliNotOnPath: (dir) => `Installed, but ${dir} is not on PATH. Add it to PATH and reopen the terminal.`,
  cliInstall: "Install the hive command",
  cliUpdate: "Update the hive command",
  workerDown: "The worker is not running, so pairing requests and the session list are unavailable.",
  pairReasons: {
    expired: "The pairing code expired or was already used.",
    bad_tag: "The device key does not match the pairing code; rejected.",
    denied: "Pairing was denied.",
    timeout: "Nobody answered at this machine in time; pairing was denied.",
    user_mismatch: "The person who scanned is not the machine owner on the hub; rejected.",
    disabled: "Remote control is off; pairing was denied.",
  },
};

const text: Dict<Strings> = { vi, en };

function Card({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={id} className="text-sm font-semibold">
          {title}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** QR vẽ ở máy: khoá ghép và khoá TOTP không đi qua dịch vụ nào. */
function Qr({ value, label, fallback }: { value: string; label: string; fallback: string }) {
  const qr = useMemo(() => {
    try {
      return qrPath(value);
    } catch {
      return null;
    }
  }, [value]);
  if (!qr) return <p className="text-sm text-destructive">{fallback}</p>;
  const pad = 4;
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`${-pad} ${-pad} ${qr.size + pad * 2} ${qr.size + pad * 2}`}
      shapeRendering="crispEdges"
      className="size-44 shrink-0 rounded-lg border bg-white"
    >
      <path d={qr.d} fill="#000" />
    </svg>
  );
}

function Confirm({
  open,
  title,
  body,
  ok,
  cancel,
  destructive,
  onOk,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  ok: string;
  cancel: string;
  destructive?: boolean;
  onOk: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent role="alertdialog" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription render={<div />}>{body}</DialogDescription>
        </DialogHeader>
        <DialogActions>
          <Button type="button" variant="outline" onClick={onCancel}>
            {cancel}
          </Button>
          <Button type="button" variant={destructive ? "destructive-solid" : "default"} onClick={onOk}>
            {ok}
          </Button>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}

type Pending =
  | { kind: "enable" }
  | { kind: "full-access" }
  | { kind: "kill"; id: string; name: string }
  | { kind: "kill-all" }
  | { kind: "totp-off" };

const minutesSince = (iso: string) => Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));

function NumberField({
  label,
  value,
  max,
  disabled,
  onCommit,
}: {
  label: string;
  value: number;
  max: number;
  disabled: boolean;
  onCommit: (n: number) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = Number(draft);
    if (!Number.isInteger(n) || n < 1 || n > max) return setDraft(String(value));
    if (n !== value) onCommit(n);
  };
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <Label htmlFor={id} className="font-normal">
        {label}
      </Label>
      <Input
        id={id}
        inputMode="numeric"
        className="w-20 text-right"
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && commit()}
      />
    </div>
  );
}

export function RemoteScreen() {
  const t = useT(text);
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hub, setHub] = useState<string | null>(null);
  const [workerOnline, setWorkerOnline] = useState(true);
  const [sessions, setSessions] = useState<LocalSession[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [pairInfo, setPairInfo] = useState<PairInfo | null>(null);
  const [requests, setRequests] = useState<PairRequest[]>([]);
  const [enroll, setEnroll] = useState<TotpEnroll | null>(null);
  const [code, setCode] = useState("");
  const [cli, setCli] = useState<HiveCliStatus | null>(null);
  const codeId = useId();
  const pairRef = useRef<string | null>(null);
  pairRef.current = pairInfo?.pairId ?? null;
  // Chữ thông báo đổi theo ngôn ngữ, còn sự kiện chỉ cần nghe một lần.
  const tRef = useRef(t);
  tRef.current = t;

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setStatus(await remoteStatus());
    } catch (e) {
      setLoadError(errorText(e));
    }
  }, []);

  useEffect(() => {
    void load();
    void workerState()
      .then((w) => {
        setHub(w?.hub ?? null);
        setWorkerOnline(w?.kind === "online");
      })
      .catch(() => {});
    void remoteSessions()
      .then(setSessions)
      .catch(() => {});
    void hiveCliStatus()
      .then(setCli)
      .catch(() => {});
    const offs = [
      onRemoteState(setStatus),
      onRemoteSessions((e) => setSessions(e.sessions ?? [])),
      onRemotePairRequest((e) => setRequests((q) => (q.some((r) => r.pairId === e.pairId) ? q : [...q, e]))),
      onRemotePairDone((e: PairDone) => {
        setRequests((q) => q.filter((r) => r.pairId !== e.pairId));
        if (pairRef.current === e.pairId) setPairInfo(null);
        const now = tRef.current;
        if (e.ok) {
          setNotice(now.pairedOk(e.label ?? ""));
          void load();
        } else {
          setError(`${now.pairFailed}: ${now.pairReasons[e.reason ?? ""] ?? e.reason ?? ""}`);
        }
      }),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [load]);

  /** Chạy một thao tác ghi: khoá nút trong lúc chạy, hiện lỗi tiếng Việt của Rust nếu hỏng. */
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const set = (key: RemoteSettingKey, value: string) => run(async () => setStatus(await remoteSet(key, value)));

  const reloadSessions = async () => setSessions(await remoteSessions());

  const confirm = () => {
    const p = pending;
    setPending(null);
    if (!p) return;
    switch (p.kind) {
      case "enable":
        return void run(async () => setStatus(await remoteEnable()));
      case "full-access":
        return void set("allow-full-access", "on");
      case "kill":
        return void run(async () => {
          await remoteSessionKill(p.id);
          await reloadSessions();
        });
      case "kill-all":
        return void run(async () => {
          const all = sessions;
          const results = await Promise.allSettled(all.map((s) => remoteSessionKill(s.id)));
          await reloadSessions();
          const failed = results.find((r) => r.status === "rejected");
          if (failed) throw (failed as PromiseRejectedResult).reason;
        });
      case "totp-off":
        return void run(async () => {
          await remoteTotpDisable();
          setEnroll(null);
          await load();
        });
    }
  };

  const addRoot = () =>
    run(async () => {
      const path = await pickFolder(t.pickRoot);
      if (!path) return;
      await remoteRootAdd(path);
      await load();
    });

  const decide = (r: PairRequest, allow: boolean) =>
    run(async () => {
      await remotePairDecide(r.pairId, allow);
      setRequests((q) => q.filter((x) => x.pairId !== r.pairId));
    });

  const httpHub = isHttpHub(hub);
  const totpHttp = httpHub || isHttpHub(enroll?.hubUrl);
  const request = requests[0];
  const on = status?.enabled === true;

  const dialog = (() => {
    switch (pending?.kind) {
      case "enable":
        return { title: t.enableTitle, body: t.enableBody, ok: t.enableOk, cancel: t.cancel, destructive: false };
      case "full-access":
        return {
          title: t.fullAccessTitle,
          body: t.fullAccessBody,
          ok: t.enableOk,
          cancel: t.cancel,
          destructive: true,
        };
      case "kill":
        return { title: t.confirmOne, body: t.confirmOneBody, ok: t.end, cancel: t.keep, destructive: true };
      case "kill-all":
        return { title: t.confirmAllT, body: t.confirmAllBody, ok: t.endAll, cancel: t.keep, destructive: true };
      case "totp-off":
        return { title: t.totpOffTitle, body: t.totpOffBody, ok: t.totpOff, cancel: t.cancel, destructive: true };
      default:
        return null;
    }
  })();

  if (!status) {
    return (
      <div className="flex flex-col gap-3">
        {loadError ? (
          <Alert variant="destructive">
            <TriangleAlertIcon aria-hidden="true" />
            <AlertTitle>{t.loadFailed}</AlertTitle>
            <AlertDescription>{loadError}</AlertDescription>
            <div className="col-start-2 mt-1">
              <Button size="sm" variant="outline" onClick={() => void load()}>
                {t.retry}
              </Button>
            </div>
          </Alert>
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            {t.loading}
          </p>
        )}
        <CliCard t={t} cli={cli} setCli={setCli} onError={setError} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {httpHub && (
        <Alert variant="destructive">
          <TriangleAlertIcon aria-hidden="true" />
          <AlertDescription>{t.http}</AlertDescription>
        </Alert>
      )}
      {!workerOnline && (
        <Alert>
          <AlertDescription>{t.workerDown}</AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {notice && (
        <p role="status" className="text-sm text-success">
          {notice}
        </p>
      )}

      <Card
        title={t.allow}
        aside={
          <Pill tone={on ? "ok" : "neutral"} dot>
            {on ? t.enabledLabel : t.disabledLabel}
          </Pill>
        }
      >
        <div className="flex items-start gap-3">
          <Toggle
            on={on}
            label={t.allow}
            disabled={busy}
            onChange={(next) =>
              next ? setPending({ kind: "enable" }) : void run(async () => setStatus(await remoteDisable()))
            }
          />
          <p className="text-sm text-muted-foreground">{on ? t.allowHint : t.offHint}</p>
        </div>
      </Card>

      {on && (
        <>
          <Card
            title={t.roots}
            aside={
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void addRoot()}>
                <FolderPlusIcon aria-hidden="true" />
                {t.addRoot}
              </Button>
            }
          >
            <p className="text-sm text-muted-foreground">{t.rootsHint}</p>
            {status.roots.length === 0 ? (
              <p className="text-sm text-warning">{t.noRoots}</p>
            ) : (
              <ul className="flex flex-col divide-y rounded-lg border">
                {status.roots.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-3 px-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{r.label}</p>
                      <p className="truncate font-mono text-xs text-muted-foreground">{shortPath(r.path)}</p>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      aria-label={t.removeRoot(r.label)}
                      onClick={() =>
                        void run(async () => {
                          await remoteRootRemove(r.id);
                          await load();
                        })
                      }
                    >
                      {t.remove}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card
            title={t.devices}
            aside={
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    setPairInfo(await remotePair());
                  })
                }
              >
                <QrCodeIcon aria-hidden="true" />
                {t.pair}
              </Button>
            }
          >
            {pairInfo && (
              <div className="flex flex-wrap gap-4 rounded-lg border bg-muted/40 p-3">
                <Qr value={pairInfo.url} label={t.qrLabel} fallback={t.qrFailed} />
                <div className="flex min-w-60 flex-1 flex-col gap-2">
                  <p className="text-sm">{t.qrHint}</p>
                  <p className="text-xs text-muted-foreground">{t.qrExpire}</p>
                  <code className="break-all rounded bg-background px-2 py-1 font-mono text-xs">{pairInfo.url}</code>
                  <div>
                    <Button size="sm" variant="ghost" onClick={() => setPairInfo(null)}>
                      {t.qrClose}
                    </Button>
                  </div>
                </div>
              </div>
            )}
            {status.devices.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t.noDevices}</p>
            ) : (
              <ul className="flex flex-col divide-y rounded-lg border">
                {status.devices.map((d) => (
                  <li key={d.id} className="flex items-center justify-between gap-3 px-3 py-2">
                    <span className="truncate text-sm font-medium">{d.label}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      aria-label={t.revokeOne(d.label)}
                      onClick={() =>
                        void run(async () => {
                          await remoteDeviceRemove(d.id);
                          await load();
                        })
                      }
                    >
                      {t.revoke}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title={t.options}>
            <div className="flex flex-col gap-3">
              <div className="flex items-start gap-3">
                <Toggle
                  on={status.confirmOnMachine}
                  label={t.confirmOnMachine}
                  disabled={busy}
                  onChange={(next) => void set("confirm-on-machine", next ? "on" : "off")}
                />
                <div className="text-sm">
                  <p>{t.confirmOnMachine}</p>
                  <p className="text-xs text-muted-foreground">{t.confirmOnMachineHint}</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <Toggle
                  danger
                  on={status.allowFullAccess}
                  label={t.fullAccess}
                  disabled={busy}
                  onChange={(next) =>
                    next ? setPending({ kind: "full-access" }) : void set("allow-full-access", "off")
                  }
                />
                <div className="text-sm">
                  <p>{t.fullAccess}</p>
                  <p className="text-xs text-muted-foreground">{t.fullAccessHint}</p>
                </div>
              </div>
              <NumberField
                label={t.idleMinutes}
                value={status.idleMinutes}
                max={1440}
                disabled={busy}
                onCommit={(n) => void set("idle-minutes", String(n))}
              />
              <NumberField
                label={t.detachedHours}
                value={status.detachedHours}
                max={72}
                disabled={busy}
                onCommit={(n) => void set("detached-hours", String(n))}
              />
              <NumberField
                label={t.maxHours}
                value={status.maxHours}
                max={72}
                disabled={busy}
                onCommit={(n) => void set("max-hours", String(n))}
              />
            </div>
          </Card>

          <Card
            title={t.sessions}
            aside={
              sessions.length > 0 && (
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={busy}
                  onClick={() => setPending({ kind: "kill-all" })}
                >
                  {t.endAll}
                </Button>
              )
            }
          >
            {sessions.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t.noSessions}</p>
            ) : (
              <>
                {sessions.every((s) => !s.origin) && <p className="text-xs text-muted-foreground">{t.originUnknown}</p>}
                <ul className="flex flex-col divide-y rounded-lg border">
                  {sessions.map((s) => {
                    const name = `${s.cli} · ${shortPath(s.cwd)}`;
                    return (
                      <li key={s.id} className="flex items-center justify-between gap-3 px-3 py-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{name}</p>
                          <p className="truncate text-xs text-muted-foreground">
                            {[
                              t.minutes(minutesSince(s.started)),
                              s.viewers > 0 ? t.viewers(s.viewers) : null,
                              s.origin === "remote" ? t.fromPhone : s.origin ? t.atMachine : null,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </p>
                        </div>
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={busy}
                          aria-label={t.endOne(name)}
                          onClick={() => setPending({ kind: "kill", id: s.id, name })}
                        >
                          {t.end}
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </Card>

          <Card
            title={t.totp}
            aside={
              <Pill tone={status.totp?.enabled ? "ok" : "neutral"}>
                {status.totp?.enabled ? t.totpEnabled : t.totpDisabled}
              </Pill>
            }
          >
            <p className="text-sm text-muted-foreground">{t.totpHint}</p>
            {totpHttp && (
              <Alert variant="destructive">
                <TriangleAlertIcon aria-hidden="true" />
                <AlertDescription>{t.totpWarn}</AlertDescription>
              </Alert>
            )}
            {status.totp?.locked && (
              <div className="flex flex-wrap items-center gap-2 text-sm text-warning">
                {t.totpLocked}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await remoteTotpUnlock();
                      await load();
                    })
                  }
                >
                  {t.totpUnlock}
                </Button>
              </div>
            )}
            {enroll ? (
              <div className="flex flex-wrap gap-4 rounded-lg border bg-muted/40 p-3">
                <Qr value={enroll.uri} label={t.totpQr} fallback={t.qrFailed} />
                <form
                  className="flex min-w-60 flex-1 flex-col gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void run(async () => {
                      await remoteTotpConfirm(code);
                      setEnroll(null);
                      setCode("");
                      await load();
                    });
                  }}
                >
                  <p className="text-xs text-muted-foreground">{t.totpSecret}</p>
                  <code className="break-all rounded bg-background px-2 py-1 font-mono text-xs">{enroll.secret}</code>
                  <div className="flex flex-col gap-1 text-sm">
                    <Label htmlFor={codeId} className="font-normal">
                      {t.totpCode}
                    </Label>
                    <Input
                      id={codeId}
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                      value={code}
                      onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">{t.totpCodeHint}</p>
                  <div className="flex gap-2">
                    <Button type="submit" size="sm" disabled={busy || code.length !== 6}>
                      {t.totpConfirm}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setEnroll(null);
                        setCode("");
                      }}
                    >
                      {t.cancel}
                    </Button>
                  </div>
                </form>
              </div>
            ) : status.totp?.enabled ? (
              <div className="flex flex-col gap-3">
                <div className="flex items-start gap-3">
                  <Toggle
                    on={status.totpOnHttps === true}
                    label={t.totpOnHttps}
                    disabled={busy}
                    onChange={(next) => void set("totp-on-https", next ? "on" : "off")}
                  />
                  <p className="text-sm">{t.totpOnHttps}</p>
                </div>
                <div>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={busy}
                    onClick={() => setPending({ kind: "totp-off" })}
                  >
                    {t.totpOff}
                  </Button>
                </div>
              </div>
            ) : (
              <div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      setEnroll(await remoteTotpEnroll());
                    })
                  }
                >
                  {t.totpOn}
                </Button>
              </div>
            )}
          </Card>
        </>
      )}

      <CliCard t={t} cli={cli} setCli={setCli} onError={setError} />

      {dialog && (
        <Confirm
          open
          title={dialog.title}
          body={
            <>
              {dialog.body}
              {pending?.kind === "enable" && httpHub && <p className="mt-2 text-destructive">{t.http}</p>}
            </>
          }
          ok={dialog.ok}
          cancel={dialog.cancel}
          destructive={dialog.destructive}
          onOk={confirm}
          onCancel={() => setPending(null)}
        />
      )}

      <Dialog open={request !== undefined}>
        <DialogContent role="alertdialog" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{t.confirmAsk}</DialogTitle>
            <DialogDescription render={<div />}>
              <p className="text-base font-medium text-foreground">{request?.label}</p>
              <p className="mt-1">{t.confirmHint}</p>
            </DialogDescription>
          </DialogHeader>
          <DialogActions>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => request && void decide(request, false)}
            >
              {t.denyBtn}
            </Button>
            <Button type="button" disabled={busy} onClick={() => request && void decide(request, true)}>
              {t.allowBtn}
            </Button>
          </DialogActions>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Lệnh `hive` đi kèm app: cài vào PATH để dùng trong terminal (hive_cli.rs). */
function CliCard({
  t,
  cli,
  setCli,
  onError,
}: {
  t: Strings;
  cli: HiveCliStatus | null;
  setCli: (s: HiveCliStatus) => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  if (!cli) return null;
  const ready = cli.installed && cli.upToDate && cli.onPath;
  return (
    <Card title={t.cli}>
      <p className="text-sm text-muted-foreground">{t.cliHint}</p>
      {!cli.available ? (
        <p className="text-sm text-muted-foreground">{t.cliMissing}</p>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          {ready ? (
            <p className="font-mono text-xs text-muted-foreground">{t.cliReady(cli.path ?? "hive")}</p>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  setCli(await hiveCliInstall());
                } catch (e) {
                  onError(errorText(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {cli.installed ? t.cliUpdate : t.cliInstall}
            </Button>
          )}
          {cli.installed && !cli.onPath && cli.dir && <p className="text-sm text-warning">{t.cliNotOnPath(cli.dir)}</p>}
        </div>
      )}
    </Card>
  );
}
