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
import { Table, TableBody, TableHeader, TableRow, Td, Th } from "@xdev-hive/ui/table";
import {
  KeyRoundIcon,
  LoaderCircleIcon,
  LockIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import {
  DELIVERY_NAME_MAX_LENGTH,
  type DeliveryCredential,
  type DeliveryCredentialsList,
  deliveryCredDelete,
  deliveryCredSave,
  deliveryCredsList,
  deliveryCredsStatus,
  isValidDeliveryName,
} from "@/lib/delivery-credentials.ts";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import { formatWhen, type StoreStatus, storeUsable } from "@/lib/secrets.ts";
import { errorText } from "@/lib/tauri.ts";

const text: Dict<{
  add: string;
  refresh: string;
  loading: string;
  retry: string;
  empty: string;
  registration: (id: string) => string;
  colName: string;
  colChanged: string;
  colActions: string;
  replace: (name: string) => string;
  replaceLabel: string;
  remove: (name: string) => string;
  removeLabel: string;
  addTitle: string;
  replaceTitle: (name: string) => string;
  formLead: string;
  name: string;
  nameNote: string;
  nameEmpty: string;
  nameSyntax: string;
  duplicate: (name: string) => string;
  value: string;
  valueNote: string;
  formatJenkins: string;
  formatArgo: string;
  valueRequired: string;
  cancel: string;
  save: string;
  saving: string;
  deleteTitle: (name: string) => string;
  deleteLead: string;
  deleteConfirm: string;
  deleting: string;
  storeLockedTitle: string;
  storeLockedHint: string;
  storeDownTitle: string;
  storeDownHint: string;
  recheck: string;
}> = {
  vi: {
    add: "Thêm credential",
    refresh: "Tải lại",
    loading: "Đang tải…",
    retry: "Thử lại",
    empty:
      "Chưa có credential triển khai nào. Bấm Thêm credential rồi đặt đúng tên mà mục tiêu triển khai trên hub tham chiếu.",
    registration: (id) => `Thuộc đăng ký worker ${id}; worker của đăng ký khác không đọc được.`,
    colName: "Tên",
    colChanged: "Đổi giá trị lúc",
    colActions: "Thao tác",
    replace: (name) => `Thay giá trị của ${name}`,
    replaceLabel: "Thay giá trị",
    remove: (name) => `Xoá ${name}`,
    removeLabel: "Xoá",
    addTitle: "Thêm credential triển khai",
    replaceTitle: (name) => `Thay giá trị của ${name}`,
    formLead:
      "Giá trị lưu trong kho của hệ điều hành trên máy này, không gửi lên hub, không gán cho dự án và không vào biến môi trường của agent hay terminal. Đã lưu thì không xem lại được.",
    name: "Tên",
    nameNote: `Chữ thường, số và dấu gạch ngang, tối đa ${DELIVERY_NAME_MAX_LENGTH} ký tự. Trùng với tên mà mục tiêu triển khai trên hub tham chiếu.`,
    nameEmpty: "Nhập tên credential.",
    nameSyntax: `Tên chỉ gồm chữ thường a-z, số và dấu gạch ngang, tối đa ${DELIVERY_NAME_MAX_LENGTH} ký tự.`,
    duplicate: (name) => `Đã có credential tên ${name}. Dùng Thay giá trị ở dòng đó để đổi.`,
    value: "Giá trị",
    valueNote: "Sau khi lưu, ô này được xoá và giá trị không hiện lại ở đâu.",
    formatJenkins: "Jenkins: tên người dùng và API token, dạng user:token.",
    formatArgo: "Argo CD: token trần, không có tiền tố Bearer.",
    valueRequired: "Nhập giá trị.",
    cancel: "Huỷ",
    save: "Lưu",
    saving: "Đang lưu…",
    deleteTitle: (name) => `Xoá ${name}?`,
    deleteLead:
      "Giá trị bị xoá khỏi kho của máy và không khôi phục được. Lần triển khai sau tham chiếu tên này sẽ báo thiếu credential.",
    deleteConfirm: "Xoá credential",
    deleting: "Đang xoá…",
    storeLockedTitle: "Kho bí mật của hệ điều hành đang khoá",
    storeLockedHint: "Mở khoá kho (đăng nhập lại hay nhập mật khẩu khi hệ điều hành hỏi) rồi bấm Kiểm tra lại.",
    storeDownTitle: "Máy này không có kho bí mật dùng được",
    storeDownHint: "Credential triển khai chỉ lưu trong kho của hệ điều hành; app không lưu ở chỗ khác.",
    recheck: "Kiểm tra lại",
  },
  en: {
    add: "Add credential",
    refresh: "Refresh",
    loading: "Loading…",
    retry: "Try again",
    empty:
      "No delivery credentials yet. Choose Add credential and use the exact name the delivery target on the hub refers to.",
    registration: (id) => `Belongs to worker registration ${id}; workers of other registrations cannot read it.`,
    colName: "Name",
    colChanged: "Value changed",
    colActions: "Actions",
    replace: (name) => `Replace the value of ${name}`,
    replaceLabel: "Replace value",
    remove: (name) => `Delete ${name}`,
    removeLabel: "Delete",
    addTitle: "Add delivery credential",
    replaceTitle: (name) => `Replace the value of ${name}`,
    formLead:
      "The value is kept in this machine's OS store, never sent to the hub, never assigned to projects and never put in agent or terminal environments. Once saved it cannot be viewed again.",
    name: "Name",
    nameNote: `Lowercase letters, digits and hyphens, up to ${DELIVERY_NAME_MAX_LENGTH} characters. Match the name the delivery target on the hub refers to.`,
    nameEmpty: "Enter a credential name.",
    nameSyntax: `Use only lowercase a-z, digits and hyphens, up to ${DELIVERY_NAME_MAX_LENGTH} characters.`,
    duplicate: (name) => `A credential named ${name} already exists. Use Replace value on its row.`,
    value: "Value",
    valueNote: "This field is cleared after saving and the value is never shown again.",
    formatJenkins: "Jenkins: user name and API token, as user:token.",
    formatArgo: "Argo CD: the bare token, without a Bearer prefix.",
    valueRequired: "Enter a value.",
    cancel: "Cancel",
    save: "Save",
    saving: "Saving…",
    deleteTitle: (name) => `Delete ${name}?`,
    deleteLead:
      "The value is removed from this machine's store and cannot be recovered. The next delivery that refers to this name reports a missing credential.",
    deleteConfirm: "Delete credential",
    deleting: "Deleting…",
    storeLockedTitle: "The OS secret store is locked",
    storeLockedHint: "Unlock it (sign in again or enter the password when the OS asks), then choose Check again.",
    storeDownTitle: "No usable secret store on this machine",
    storeDownHint: "Delivery credentials are kept only in the OS store; the app stores them nowhere else.",
    recheck: "Check again",
  },
};

/**
 * Tab "Credential triển khai" của màn Bí mật (specs/032 T016): chỉ liệt kê tên và lúc đổi giá trị. Không có nút Hiện
 * hay Sao chép như bí mật dự án: credential triển khai chỉ worker đọc, ngay trước khi gọi Jenkins hay Argo CD (FR-063).
 */
export function DeliveryCredentials() {
  const t = useT(text);
  const lang = useLang();
  const [data, setData] = useState<DeliveryCredentialsList | null>(null);
  const [status, setStatus] = useState<StoreStatus | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<{ credential: DeliveryCredential | null } | null>(null);
  const [deleting, setDeleting] = useState<DeliveryCredential | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      // Trạng thái kho chỉ để báo; không đọc được thì danh sách vẫn hiện, lỗi thật sẽ ra khi lưu.
      const [list, store] = await Promise.all([deliveryCredsList(), deliveryCredsStatus().catch(() => undefined)]);
      setData(list);
      setStatus(store);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = data?.credentials ?? [];
  const usable = storeUsable(status);

  return (
    <div className="flex flex-col gap-3.5">
      {!usable && status && <StoreBanner status={status} onRecheck={() => void load()} />}

      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={!usable} onClick={() => setForm({ credential: null })}>
          <PlusIcon aria-hidden="true" />
          {t.add}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void load()}>
          <RefreshCwIcon aria-hidden="true" />
          {t.refresh}
        </Button>
        {data?.registration && (
          <p translate="no" className="min-w-0 flex-1 text-xs break-words text-muted-foreground">
            {t.registration(data.registration)}
          </p>
        )}
      </div>

      {error && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 rounded-lg bg-destructive-soft px-3 py-2 text-sm text-destructive"
        >
          <p className="min-w-0 flex-1 break-words">{error}</p>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCwIcon aria-hidden="true" />
            {t.retry}
          </Button>
        </div>
      )}
      {!data && !error && <p className="text-sm text-muted-foreground">{t.loading}</p>}

      {data && rows.length === 0 && <p className="text-sm text-muted-foreground">{t.empty}</p>}
      {data && rows.length > 0 && (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <Th>{t.colName}</Th>
                <Th>{t.colChanged}</Th>
                <Th>
                  <span className="sr-only">{t.colActions}</span>
                </Th>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((c) => (
                <TableRow key={c.name}>
                  <Td className="min-w-40">
                    <div translate="no" className="flex items-center gap-1.5 font-mono text-sm font-medium break-all">
                      <KeyRoundIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                      {c.name}
                    </div>
                  </Td>
                  <Td className="text-xs whitespace-nowrap text-muted-foreground">
                    {formatWhen(c.valueChangedAt, lang)}
                  </Td>
                  <Td>
                    <div className="flex flex-wrap justify-end gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!usable}
                        aria-label={t.replace(c.name)}
                        onClick={() => setForm({ credential: c })}
                      >
                        {t.replaceLabel}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive"
                        aria-label={t.remove(c.name)}
                        onClick={() => setDeleting(c)}
                      >
                        <Trash2Icon aria-hidden="true" />
                        {t.removeLabel}
                      </Button>
                    </div>
                  </Td>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {form && (
        <CredentialForm
          // key theo credential: mở lại với dòng khác thì form khởi tạo lại, không mang state cũ sang.
          key={form.credential?.name ?? "new"}
          credential={form.credential}
          taken={rows.map((c) => c.name)}
          onClose={() => setForm(null)}
          onSaved={() => void load()}
        />
      )}
      <DeleteDialog
        credential={deleting}
        onClose={() => setDeleting(null)}
        onDeleted={() => {
          setDeleting(null);
          void load();
        }}
      />
    </div>
  );
}

/** Kho của hệ điều hành khoá hay không có: báo lý do của worker, không có chỗ lưu thay thế (FR-102). */
function StoreBanner({ status, onRecheck }: { status: StoreStatus; onRecheck: () => void }) {
  const t = useT(text);
  const locked = status.available && status.locked === true;
  return (
    <Alert variant="destructive">
      {locked ? <LockIcon aria-hidden="true" /> : <TriangleAlertIcon aria-hidden="true" />}
      <AlertTitle>{locked ? t.storeLockedTitle : t.storeDownTitle}</AlertTitle>
      <AlertDescription className="flex flex-col gap-2">
        {!locked && status.reason && <p className="break-words">{status.reason}</p>}
        <p>{locked ? t.storeLockedHint : t.storeDownHint}</p>
        <div>
          <Button variant="outline" size="sm" onClick={onRecheck}>
            <RefreshCwIcon aria-hidden="true" />
            {t.recheck}
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}

/**
 * Thêm hoặc thay giá trị. Giá trị chỉ nằm trong state của form và bị xoá ngay khi bấm Lưu, dù thành công hay lỗi; không
 * có nút xem giá trị đang gõ.
 */
function CredentialForm({
  credential,
  taken,
  onClose,
  onSaved,
}: {
  /** null là thêm mới; có thì chỉ thay giá trị, tên giữ nguyên. */
  credential: DeliveryCredential | null;
  taken: readonly string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT(text);
  const id = useId();
  const [name, setName] = useState(credential?.name ?? "");
  const [value, setValue] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const replacing = credential !== null;
  const cleaned = name.trim().toLowerCase();
  // Lưu tên đã có sẽ ghi đè giá trị cũ; thêm mới thì chặn để không thay nhầm credential đang dùng.
  const nameError = replacing
    ? null
    : cleaned === ""
      ? t.nameEmpty
      : !isValidDeliveryName(cleaned)
        ? t.nameSyntax
        : taken.includes(cleaned)
          ? t.duplicate(cleaned)
          : null;
  const valueError = value.trim() === "" ? t.valueRequired : null;
  const shownNameError = touched ? nameError : null;
  const shownValueError = touched ? valueError : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (nameError || valueError || busy) {
      document.getElementById(`${id}-${nameError ? "name" : "value"}`)?.focus();
      return;
    }
    const typed = value;
    setBusy(true);
    setError(null);
    setValue("");
    try {
      await deliveryCredSave(cleaned, typed);
      onSaved();
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{credential ? t.replaceTitle(credential.name) : t.addTitle}</DialogTitle>
          <DialogDescription>{t.formLead}</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)} noValidate>
          {!replacing && (
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${id}-name`}>{t.name}</Label>
              <Input
                id={`${id}-name`}
                name="name"
                className="font-mono"
                value={name}
                spellCheck={false}
                autoComplete="off"
                autoCapitalize="none"
                aria-invalid={shownNameError ? true : undefined}
                aria-describedby={`${id}-name-note`}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => name !== "" && setTouched(true)}
              />
              <span
                id={`${id}-name-note`}
                className={shownNameError ? "text-xs text-destructive" : "text-xs text-muted-foreground"}
              >
                {shownNameError ?? t.nameNote}
              </span>
            </div>
          )}
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-value`}>{t.value}</Label>
            <Input
              id={`${id}-value`}
              name="value"
              type="password"
              className="font-mono"
              value={value}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={shownValueError ? true : undefined}
              aria-describedby={`${id}-value-note ${id}-format`}
              onChange={(e) => setValue(e.target.value)}
            />
            <span
              id={`${id}-value-note`}
              className={shownValueError ? "text-xs text-destructive" : "text-xs text-muted-foreground"}
            >
              {shownValueError ?? t.valueNote}
            </span>
            <ul id={`${id}-format`} className="m-0 list-disc pl-5 text-xs text-muted-foreground">
              <li>{t.formatJenkins}</li>
              <li>{t.formatArgo}</li>
            </ul>
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
            <Button type="submit" disabled={busy}>
              {busy && <LoaderCircleIcon aria-hidden="true" className="animate-spin" />}
              {busy ? t.saving : t.save}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({
  credential,
  onClose,
  onDeleted,
}: {
  credential: DeliveryCredential | null;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const t = useT(text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm(c: DeliveryCredential) {
    setBusy(true);
    setError(null);
    try {
      await deliveryCredDelete(c.name);
      onDeleted();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  // Lỗi của lần xoá trước không được còn khi mở hộp cho credential khác.
  const close = () => {
    setError(null);
    onClose();
  };

  return (
    <Dialog open={credential !== null} onOpenChange={(o) => !o && !busy && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{credential ? t.deleteTitle(credential.name) : ""}</DialogTitle>
          <DialogDescription>{t.deleteLead}</DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="rounded-lg bg-destructive-soft px-3 py-2 text-sm break-words text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          {/* Huỷ là nút được focus đầu: Enter nhầm không xoá được credential. */}
          <Button variant="outline" autoFocus disabled={busy} onClick={close}>
            {t.cancel}
          </Button>
          <Button variant="destructive" disabled={busy} onClick={() => credential && void confirm(credential)}>
            {busy ? t.deleting : t.deleteConfirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
