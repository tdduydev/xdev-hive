import { Alert, AlertDescription, AlertTitle } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@xdev-hive/ui/dialog";
import { Input } from "@xdev-hive/ui/input";
import { Label } from "@xdev-hive/ui/label";
import { LoaderCircleIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { type Dict, useT } from "@/lib/i18n.ts";
import { SSH_STATUS_TEXT, type SshScan, type SshSetup, type SshTarget, sshScan, sshSetup } from "@/lib/ssh.ts";
import { errorText } from "@/lib/tauri.ts";

const text: Dict<{
  title: string;
  lead: string;
  host: string;
  port: string;
  user: string;
  alias: string;
  aliasNote: string;
  next: string;
  cancel: string;
  close: string;
  done: string;
  missing: string;
  fingerprint: string;
  firstTime: string;
  confirm: string;
  known: string;
  changedTitle: string;
  changed: string;
  password: (user: string, host: string) => string;
  passwordNote: string;
  install: string;
  installing: string;
  keyCreated: (path: string) => string;
  configWritten: (alias: string) => string;
  success: (alias: string) => string;
  partial: (label: string) => string;
}> = {
  vi: {
    title: "Thêm máy chủ SSH",
    lead: "App chép khoá công khai của máy này lên máy chủ bằng mật khẩu bạn gõ một lần, rồi chỉ dùng khoá.",
    host: "Địa chỉ máy chủ",
    port: "Cổng",
    user: "Tên đăng nhập",
    alias: "Tên gợi nhớ",
    aliasNote: "Dùng trong lệnh ssh <tên gợi nhớ>. Chỉ chữ, số, dấu chấm, gạch dưới, gạch ngang.",
    next: "Tiếp",
    cancel: "Huỷ",
    close: "Đóng",
    done: "Xong",
    missing: "Nhập đủ địa chỉ, cổng, tên đăng nhập và tên gợi nhớ.",
    fingerprint: "Dấu vân tay khoá máy chủ",
    firstTime:
      "Lần đầu nối máy chủ này. Nhờ người quản trị máy chủ chạy lệnh dưới đây rồi so dấu vân tay. Khớp thì mới gõ mật khẩu.",
    confirm: "Tôi đã đối chiếu với người quản trị, dấu vân tay khớp",
    known: "Máy chủ đã biết: khoá khớp ~/.ssh/known_hosts.",
    changedTitle: "Khoá máy chủ đã đổi",
    changed:
      "Khoá máy chủ khác khoá đã lưu trong ~/.ssh/known_hosts. Có thể có người giả mạo máy chủ, nên app dừng ở đây và không hỏi mật khẩu. Hỏi người quản trị máy chủ.",
    password: (user, host) => `Mật khẩu của ${user}@${host}`,
    passwordNote:
      "App chỉ dùng mật khẩu này một lần để chép khoá lên máy chủ. App không lưu, không ghi log, không gửi đi nơi khác.",
    install: "Cài khoá",
    installing: "Đang cài khoá…",
    keyCreated: (path) => `Đã tạo khoá mới ${path}.`,
    configWritten: (alias) => `Đã thêm ${alias} vào ~/.ssh/config (có bản sao lưu).`,
    success: (alias) => `Xong: ssh ${alias} đăng nhập bằng khoá, không cần mật khẩu.`,
    partial: (label) => `Đã chép khoá lên máy chủ, nhưng đăng nhập bằng khoá chưa được: ${label}.`,
  },
  en: {
    title: "Add SSH server",
    lead: "The app copies this machine's public key to the server with a password you type once, then uses only the key.",
    host: "Server address",
    port: "Port",
    user: "User name",
    alias: "Alias",
    aliasNote: "Used as ssh <alias>. Letters, digits, dots, underscores and hyphens only.",
    next: "Next",
    cancel: "Cancel",
    close: "Close",
    done: "Done",
    missing: "Fill in the address, port, user name and alias.",
    fingerprint: "Server key fingerprint",
    firstTime:
      "First connection to this server. Ask its admin to run the command below and compare the fingerprint. Type the password only if it matches.",
    confirm: "I compared it with the server admin and the fingerprint matches",
    known: "Known server: its key matches ~/.ssh/known_hosts.",
    changedTitle: "Server key changed",
    changed:
      "The server key differs from the one saved in ~/.ssh/known_hosts. Someone may be impersonating the server, so the app stops here and does not ask for the password. Ask the server admin.",
    password: (user, host) => `Password for ${user}@${host}`,
    passwordNote:
      "The app uses this password once to copy the key to the server. It does not store, log or send it anywhere else.",
    install: "Install key",
    installing: "Installing key…",
    keyCreated: (path) => `Created a new key ${path}.`,
    configWritten: (alias) => `Added ${alias} to ~/.ssh/config (with a backup).`,
    success: (alias) => `Done: ssh ${alias} signs in with the key, no password.`,
    partial: (label) => `The key is on the server, but key sign-in does not work yet: ${label}.`,
  },
};

type Step = "server" | "hostkey" | "password" | "done";

export function SshAddDialog({
  open,
  initial,
  onClose,
  onDone,
}: {
  open: boolean;
  /** Mục có sẵn (khối viết tay, khối của app cần cài lại): ô điền sẵn và chỉ đọc. */
  initial: SshTarget | null;
  onClose: () => void;
  /** Cài xong: màn đọc lại danh sách. */
  onDone: () => void;
}) {
  const t = useT(text);
  const statusText = useT(SSH_STATUS_TEXT);
  const id = useId();
  const [step, setStep] = useState<Step>("server");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [user, setUser] = useState("");
  const [alias, setAlias] = useState("");
  const [scan, setScan] = useState<SshScan | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [password, setPassword] = useState("");
  const [result, setResult] = useState<SshSetup | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setStep("server");
    setHost(initial?.host ?? "");
    setPort(String(initial?.port ?? 22));
    setUser(initial?.user ?? "");
    setAlias(initial?.alias ?? "");
    setScan(null);
    setConfirmed(false);
    setPassword("");
    setResult(null);
    setError(null);
  }, [open, initial]);

  const target: SshTarget = { host: host.trim(), port: Number(port), user: user.trim(), alias: alias.trim() };

  function close() {
    // Không giữ mật khẩu trong state khi hộp thoại đóng.
    setPassword("");
    onClose();
  }

  async function next() {
    if (!target.host || !target.user || !target.alias || !Number.isInteger(target.port)) {
      setError(t.missing);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const found = await sshScan(target.host, target.port);
      setScan(found);
      setStep(found.known === "known" ? "password" : "hostkey");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function install() {
    if (!scan) return;
    const secret = password;
    // Ô trống ngay khi gửi, thành công hay lỗi đều phải gõ lại (FR-051).
    setPassword("");
    setBusy(true);
    setError(null);
    try {
      setResult(await sshSetup(target, scan.fingerprint, secret));
      setStep("done");
      onDone();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const locked = initial !== null;
  const field = (key: string, label: string, value: string, set: (v: string) => void, note?: string) => (
    <div className="flex flex-col gap-1">
      <Label htmlFor={`${id}-${key}`}>{label}</Label>
      <Input
        id={`${id}-${key}`}
        value={value}
        readOnly={locked}
        disabled={step !== "server"}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => set(e.target.value)}
      />
      {note && <span className="text-xs text-muted-foreground">{note}</span>}
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t.title}</DialogTitle>
          <DialogDescription>{t.lead}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (step === "server") void next();
            else if (step === "hostkey" && confirmed) setStep("password");
            else if (step === "password" && password) void install();
          }}
        >
          <div className="grid grid-cols-[1fr_6rem] gap-2">
            {field("host", t.host, host, setHost)}
            {field("port", t.port, port, setPort)}
          </div>
          {field("user", t.user, user, setUser)}
          {field("alias", t.alias, alias, setAlias, step === "server" && !locked ? t.aliasNote : undefined)}

          {scan && scan.known === "changed" && (
            <Alert variant="destructive">
              <AlertTitle>{t.changedTitle}</AlertTitle>
              <AlertDescription>{t.changed}</AlertDescription>
            </Alert>
          )}
          {scan && scan.known !== "changed" && step !== "server" && (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                {t.fingerprint} ({scan.algorithm})
              </span>
              <code className="font-mono text-sm break-all">{scan.fingerprint}</code>
              {scan.known === "known" ? (
                <span className="text-xs text-muted-foreground">{t.known}</span>
              ) : (
                <>
                  <span className="text-xs text-muted-foreground">{t.firstTime}</span>
                  <pre className="m-0 rounded-lg bg-brand-navy px-3 py-2.5 font-mono text-sm whitespace-pre-wrap text-slate-200">
                    {scan.adminCommand}
                  </pre>
                  {step === "hostkey" && (
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                      {t.confirm}
                    </label>
                  )}
                </>
              )}
            </div>
          )}

          {step === "password" && (
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${id}-password`}>{t.password(target.user, target.host)}</Label>
              <Input
                id={`${id}-password`}
                type="password"
                autoComplete="off"
                value={password}
                disabled={busy}
                onChange={(e) => setPassword(e.target.value)}
              />
              <span className="text-xs text-muted-foreground">{t.passwordNote}</span>
            </div>
          )}

          {step === "done" && result && (
            <div role="status" className="flex flex-col gap-1 text-sm">
              {result.keyCreated && <p>{t.keyCreated(result.key.path)}</p>}
              {result.configWritten && <p>{t.configWritten(target.alias)}</p>}
              {result.check.status === "ok" ? (
                <p className="font-medium text-success">{t.success(target.alias)}</p>
              ) : (
                <>
                  <p className="font-medium text-warning">{t.partial(statusText[result.check.status].label)}</p>
                  <p className="text-muted-foreground">{statusText[result.check.status].hint}</p>
                  {result.check.detail && (
                    <pre className="m-0 font-mono text-xs whitespace-pre-wrap">{result.check.detail}</pre>
                  )}
                </>
              )}
            </div>
          )}

          {busy && (
            <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
              <LoaderCircleIcon aria-hidden="true" className="size-4 animate-spin" />
              {step === "password" ? t.installing : null}
            </p>
          )}
          {error && (
            <p role="alert" className="rounded-lg bg-destructive-soft px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}

          <DialogFooter>
            {step === "done" || scan?.known === "changed" ? (
              <Button type="button" onClick={close}>
                {step === "done" ? t.done : t.close}
              </Button>
            ) : (
              <>
                <Button type="button" variant="outline" disabled={busy} onClick={close}>
                  {t.cancel}
                </Button>
                {step === "password" ? (
                  <Button type="submit" disabled={busy || !password}>
                    {t.install}
                  </Button>
                ) : (
                  <Button type="submit" disabled={busy || (step === "hostkey" && !confirmed)}>
                    {t.next}
                  </Button>
                )}
              </>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
