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
import { LoaderCircleIcon, TriangleAlertIcon } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { shortPath } from "@/lib/folder.ts";
import { type Dict, useT } from "@/lib/i18n.ts";
import {
  checkExportPassword,
  type ExportResult,
  type PasswordProblem,
  pickExportPath,
  SECRETS_FILE_EXTENSION,
  SECRETS_PASSWORD_MIN_LENGTH,
  secretsExport,
} from "@/lib/secrets.ts";
import { errorText } from "@/lib/tauri.ts";

const text: Dict<{
  title: string;
  lead: string;
  warnTitle: string;
  warnValues: string;
  warnForget: string;
  warnKeep: string;
  pick: string;
  pickAll: string;
  pickNone: string;
  picked: (n: number, total: number) => string;
  noneSelected: string;
  password: string;
  passwordNote: string;
  confirm: string;
  passwordProblem: Record<PasswordProblem, string>;
  cancel: string;
  submit: (n: number) => string;
  exporting: string;
  saveTitle: string;
  doneTitle: string;
  done: (n: number) => string;
  doneKeep: string;
  close: string;
}> = {
  vi: {
    title: "Xuất bí mật ra file",
    lead: "Tạo file .hivesecrets mã hoá bằng mật khẩu để tự mang sang máy khác. Hub không nhận, không lưu file này.",
    warnTitle: "Đọc trước khi xuất",
    warnValues: "File chứa giá trị của các bí mật đã chọn, chỉ được bảo vệ bằng mật khẩu bạn đặt.",
    warnForget: "Quên mật khẩu thì không ai mở được file, kể cả hub và đội xDev Hive. Không có cách khôi phục.",
    warnKeep: "Giữ file ở chỗ riêng tư, đừng gửi qua chat hay email cùng với mật khẩu, và xoá file khi đã nhập xong.",
    pick: "Bí mật đưa vào file",
    pickAll: "Chọn hết",
    pickNone: "Bỏ chọn hết",
    picked: (n, total) => `Đã chọn ${n}/${total}`,
    noneSelected: "Chọn ít nhất một bí mật.",
    password: "Mật khẩu",
    passwordNote: `Tối thiểu ${SECRETS_PASSWORD_MIN_LENGTH} ký tự. App không lưu mật khẩu này.`,
    confirm: "Nhập lại mật khẩu",
    passwordProblem: {
      short: `Mật khẩu cần tối thiểu ${SECRETS_PASSWORD_MIN_LENGTH} ký tự.`,
      mismatch: "Hai lần nhập mật khẩu không khớp.",
    },
    cancel: "Huỷ",
    submit: (n) => `Chọn nơi lưu và xuất ${n} bí mật`,
    exporting: "Đang xuất…",
    saveTitle: "Lưu file bí mật",
    doneTitle: "Đã xuất bí mật",
    done: (n) => `Đã ghi ${n} bí mật vào file:`,
    doneKeep: "Mang file sang máy khác rồi chọn Nhập ở màn Bí mật. Cần đúng mật khẩu vừa đặt để mở file.",
    close: "Đóng",
  },
  en: {
    title: "Export secrets to a file",
    lead: "Create a password-encrypted .hivesecrets file to carry to another machine yourself. The hub never receives or stores this file.",
    warnTitle: "Read before exporting",
    warnValues: "The file contains the values of the selected secrets, protected only by the password you set.",
    warnForget:
      "If you forget the password nobody can open the file, not even the hub or the xDev Hive team. There is no recovery.",
    warnKeep:
      "Keep the file somewhere private, never send it over chat or email together with the password, and delete it once imported.",
    pick: "Secrets to put in the file",
    pickAll: "Select all",
    pickNone: "Clear selection",
    picked: (n, total) => `${n} of ${total} selected`,
    noneSelected: "Select at least one secret.",
    password: "Password",
    passwordNote: `At least ${SECRETS_PASSWORD_MIN_LENGTH} characters. The app does not store this password.`,
    confirm: "Repeat the password",
    passwordProblem: {
      short: `The password needs at least ${SECRETS_PASSWORD_MIN_LENGTH} characters.`,
      mismatch: "The two passwords do not match.",
    },
    cancel: "Cancel",
    submit: (n) => `Choose where to save and export ${n} ${n === 1 ? "secret" : "secrets"}`,
    exporting: "Exporting…",
    saveTitle: "Save the secrets file",
    doneTitle: "Secrets exported",
    done: (n) => `Wrote ${n} ${n === 1 ? "secret" : "secrets"} to:`,
    doneKeep:
      "Take the file to the other machine and choose Import on the Secrets screen. You need this password to open it.",
    close: "Close",
  },
};

interface Props {
  open: boolean;
  /** Tên các bí mật đang có; mặc định chọn hết. */
  names: readonly string[];
  onClose: () => void;
}

/**
 * Xuất bí mật đã chọn ra file `.hivesecrets` (FR-067). Mật khẩu chỉ nằm trong state của hộp: xoá ngay khi gửi đi và mất
 * hẳn khi đóng hộp, không vào query cache hay localStorage.
 */
export function SecretExportDialog({ open, names, onClose }: Props) {
  return open ? <ExportBody names={names} onClose={onClose} /> : null;
}

function ExportBody({ names, onClose }: Omit<Props, "open">) {
  const t = useT(text);
  const id = useId();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set(names));
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<ExportResult | null>(null);

  const chosen = names.filter((n) => selected.has(n));
  const problem = checkExportPassword(password, confirm);
  // Báo lỗi mật khẩu từ lần bấm xuất đầu, không báo khi đang gõ dở.
  const shownProblem = touched ? problem : null;

  function toggle(name: string, on: boolean) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (busy || chosen.length === 0) return;
    if (problem) {
      document.getElementById(`${id}-${problem === "short" ? "password" : "confirm"}`)?.focus();
      return;
    }
    setError(null);
    let path: string | null;
    try {
      path = await pickExportPath(t.saveTitle, `xdev-hive-secrets.${SECRETS_FILE_EXTENSION}`);
    } catch (err) {
      setError(errorText(err));
      return;
    }
    if (!path) return;
    const typed = password;
    setBusy(true);
    setPassword("");
    setConfirm("");
    try {
      // Hộp lưu của hệ điều hành đã hỏi khi chọn trùng file có sẵn, nên chọn xong là đã xác nhận ghi đè.
      setDone(await secretsExport({ path, password: typed, names: chosen, force: true }));
    } catch (err) {
      // Lỗi thì trả lại mật khẩu để thử lại không phải gõ lại; đóng hộp vẫn xoá hẳn.
      setPassword(typed);
      setConfirm(typed);
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.doneTitle}</DialogTitle>
            <DialogDescription>{t.done(done.names.length)}</DialogDescription>
          </DialogHeader>
          <p translate="no" className="rounded-lg bg-muted px-3 py-2 font-mono text-sm break-all">
            {shortPath(done.out)}
          </p>
          <p className="text-sm text-muted-foreground">{t.doneKeep}</p>
          <DialogFooter>
            <Button variant="outline" autoFocus onClick={onClose}>
              {t.close}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="flex max-h-[90vh] flex-col gap-3 overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t.title}</DialogTitle>
          <DialogDescription>{t.lead}</DialogDescription>
        </DialogHeader>
        {/* Không dùng Alert (role="alert"): cảnh báo có sẵn từ đầu, không phải sự kiện cần đọc ngay. */}
        <section aria-labelledby={`${id}-warn`} className="rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning">
          <h3 id={`${id}-warn`} className="flex items-center gap-1.5 font-medium">
            <TriangleAlertIcon aria-hidden="true" className="size-4 shrink-0" />
            {t.warnTitle}
          </h3>
          <ul className="m-0 mt-1 flex list-disc flex-col gap-1 pl-5">
            <li>{t.warnValues}</li>
            <li>{t.warnForget}</li>
            <li>{t.warnKeep}</li>
          </ul>
        </section>
        <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)} noValidate>
          <fieldset className="flex min-w-0 flex-col gap-1.5 border-0 p-0" disabled={busy}>
            <legend className="mb-1 flex w-full flex-wrap items-center gap-2 text-sm font-medium">
              <span className="flex-1">{t.pick}</span>
              <span className="text-xs font-normal text-muted-foreground">{t.picked(chosen.length, names.length)}</span>
            </legend>
            <div className="flex flex-wrap gap-1">
              <Button type="button" variant="ghost" size="sm" onClick={() => setSelected(new Set(names))}>
                {t.pickAll}
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
                {t.pickNone}
              </Button>
            </div>
            <div className="flex max-h-48 flex-col overflow-y-auto rounded-lg border px-2 py-1">
              {names.map((n) => (
                <label key={n} className="flex min-h-8 cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-4 shrink-0 accent-primary"
                    checked={selected.has(n)}
                    onChange={(e) => toggle(n, e.target.checked)}
                  />
                  <span translate="no" className="min-w-0 font-mono break-all">
                    {n}
                  </span>
                </label>
              ))}
            </div>
            {chosen.length === 0 && <p className="text-xs text-destructive">{t.noneSelected}</p>}
          </fieldset>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-password`}>{t.password}</Label>
            <Input
              id={`${id}-password`}
              name="password"
              type="password"
              value={password}
              autoComplete="new-password"
              spellCheck={false}
              disabled={busy}
              aria-invalid={shownProblem === "short" ? true : undefined}
              aria-describedby={`${id}-password-note`}
              onChange={(e) => setPassword(e.target.value)}
            />
            <span
              id={`${id}-password-note`}
              className={shownProblem === "short" ? "text-xs text-destructive" : "text-xs text-muted-foreground"}
            >
              {shownProblem === "short" ? t.passwordProblem.short : t.passwordNote}
            </span>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-confirm`}>{t.confirm}</Label>
            <Input
              id={`${id}-confirm`}
              name="confirm"
              type="password"
              value={confirm}
              autoComplete="new-password"
              spellCheck={false}
              disabled={busy}
              aria-invalid={shownProblem === "mismatch" ? true : undefined}
              aria-describedby={shownProblem === "mismatch" ? `${id}-confirm-note` : undefined}
              onChange={(e) => setConfirm(e.target.value)}
            />
            {shownProblem === "mismatch" && (
              <span id={`${id}-confirm-note`} className="text-xs text-destructive">
                {t.passwordProblem.mismatch}
              </span>
            )}
          </div>
          {error && (
            <p role="alert" className="rounded-lg bg-destructive-soft px-3 py-2 text-sm break-words text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              {t.cancel}
            </Button>
            <Button type="submit" disabled={busy || chosen.length === 0}>
              {busy && <LoaderCircleIcon aria-hidden="true" className="animate-spin" />}
              {busy ? t.exporting : t.submit(chosen.length)}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
