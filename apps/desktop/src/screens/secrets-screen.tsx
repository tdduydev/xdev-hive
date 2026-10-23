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
import { Label } from "@xdev-hive/ui/label";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/native-select";
import { Pill } from "@xdev-hive/ui/pill";
import { Table, TableBody, TableHeader, TableRow, Td, Th } from "@xdev-hive/ui/table";
import { ListIcon, LockIcon, PencilIcon, PlusIcon, RefreshCwIcon, Trash2Icon, TriangleAlertIcon } from "lucide-react";
import { useCallback, useEffect, useId, useState, useSyncExternalStore } from "react";
import { SecretFormDialog } from "@/components/secret-form-dialog.tsx";
import { SecretValueActions } from "@/components/secret-value-actions.tsx";
import { SecretsLog } from "@/components/secrets-log.tsx";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import { type LocalProject, localProjects } from "@/lib/local-projects.ts";
import {
  formatWhen,
  isMissingValue,
  type ReservedNames,
  type SecretItem,
  type SecretsList,
  type StoreStatus,
  secretDelete,
  secretsFilterFromHash,
  secretsHash,
  secretsList,
  secretsStatus,
  storeUsable,
} from "@/lib/secrets.ts";
import { errorText } from "@/lib/tauri.ts";
import { cn } from "@/lib/utils.ts";

const text: Dict<{
  lead: string;
  tabs: string;
  tabList: string;
  tabLog: string;
  add: string;
  reserved: string;
  refresh: string;
  loading: string;
  empty: string;
  emptyFiltered: string;
  filter: string;
  allProjects: string;
  colName: string;
  colProjects: string;
  colChanged: string;
  colActions: string;
  noProjects: string;
  moreProjects: (n: number) => string;
  edit: (name: string) => string;
  editLabel: string;
  remove: (name: string) => string;
  removeLabel: string;
  retry: string;
  deleteTitle: (name: string) => string;
  deleteLead: string;
  deleteInUse: (n: number) => string;
  deleteInUseHint: string;
  deleteProjects: (n: number) => string;
  cancel: string;
  deleteConfirm: string;
  deleting: string;
  reservedTitle: string;
  reservedLead: string;
  reservedExact: string;
  reservedPrefixes: string;
  close: string;
  storeLockedTitle: string;
  storeLockedHint: string;
  storeDownTitle: string;
  storeHint: Record<string, string>;
  recheck: string;
  missing: string;
}> = {
  vi: {
    tabs: "Mục của màn Bí mật",
    tabList: "Danh sách",
    tabLog: "Nhật ký",
    lead: "Bí mật của máy này (khoá API, chuỗi kết nối…). Giá trị nằm trong kho của hệ điều hành, không lên hub; agent nhận qua biến môi trường của dự án được gán.",
    add: "Thêm bí mật",
    reserved: "Tên dành riêng",
    refresh: "Tải lại",
    loading: "Đang tải…",
    empty: "Chưa có bí mật nào. Bấm Thêm bí mật để lưu khoá hay chuỗi kết nối rồi gán cho dự án.",
    emptyFiltered: "Dự án này chưa được gán bí mật nào.",
    filter: "Lọc theo dự án",
    allProjects: "Mọi dự án",
    colName: "Tên",
    colProjects: "Dự án",
    colChanged: "Đổi giá trị lúc",
    colActions: "Thao tác",
    noProjects: "Chưa gán",
    moreProjects: (n) => `+${n}`,
    edit: (name) => `Sửa ${name}`,
    editLabel: "Sửa",
    remove: (name) => `Xoá ${name}`,
    removeLabel: "Xoá",
    retry: "Thử lại",
    deleteTitle: (name) => `Xoá ${name}?`,
    deleteLead: "Giá trị bị xoá khỏi kho của máy và không khôi phục được. Nhật ký giữ lại tên với nhãn đã xoá.",
    deleteInUse: (n) => `Đang có ${n} run dùng bí mật này.`,
    deleteInUseHint: "Run đang chạy vẫn giữ giá trị đã nhận; run mới sẽ không còn thấy biến này.",
    deleteProjects: (n) => `Bí mật đang gán cho ${n} dự án; các dự án đó thôi nhận biến này.`,
    cancel: "Huỷ",
    deleteConfirm: "Xoá bí mật",
    deleting: "Đang xoá…",
    reservedTitle: "Tên dành riêng",
    reservedLead:
      "Bí mật không được đặt trùng các tên dưới đây, vì chúng chiếm quyền môi trường của hệ thống, git, ssh hay agent.",
    reservedExact: "Tên đầy đủ",
    reservedPrefixes: "Bắt đầu bằng",
    close: "Đóng",
    storeLockedTitle: "Kho bí mật của hệ điều hành đang khoá",
    storeLockedHint: "Mở khoá kho (đăng nhập lại hay nhập mật khẩu khi hệ điều hành hỏi) rồi bấm Kiểm tra lại.",
    storeDownTitle: "Máy này không có kho bí mật dùng được",
    storeHint: {
      wincred:
        "Giá trị chỉ lưu trong Credential Manager của Windows; app không lưu ở chỗ khác. Đăng nhập lại Windows rồi kiểm tra lại.",
      keychain:
        "Giá trị chỉ lưu trong Keychain của macOS; app không lưu ở chỗ khác. Mở khoá chuỗi khoá đăng nhập rồi kiểm tra lại.",
      "secret-service": "Giá trị chỉ lưu trong Secret Service (gnome-keyring hay KWallet); app không lưu ở chỗ khác.",
    },
    recheck: "Kiểm tra lại",
    missing: "Kho thiếu giá trị, hãy đặt lại",
  },
  en: {
    tabs: "Secrets sections",
    tabList: "List",
    tabLog: "Log",
    lead: "Secrets of this machine (API keys, connection strings…). Values live in the OS store, never on the hub; agents get them as environment variables of the assigned projects.",
    add: "Add secret",
    reserved: "Reserved names",
    refresh: "Refresh",
    loading: "Loading…",
    empty: "No secrets yet. Choose Add secret to store a key or connection string and assign it to projects.",
    emptyFiltered: "No secrets are assigned to this project.",
    filter: "Filter by project",
    allProjects: "All projects",
    colName: "Name",
    colProjects: "Projects",
    colChanged: "Value changed",
    colActions: "Actions",
    noProjects: "Not assigned",
    moreProjects: (n) => `+${n}`,
    edit: (name) => `Edit ${name}`,
    editLabel: "Edit",
    remove: (name) => `Delete ${name}`,
    removeLabel: "Delete",
    retry: "Try again",
    deleteTitle: (name) => `Delete ${name}?`,
    deleteLead:
      "The value is removed from this machine's store and cannot be recovered. The log keeps the name with a deleted label.",
    deleteInUse: (n) => `${n} runs are using this secret.`,
    deleteInUseHint: "Running runs keep the value they received; new runs will no longer see the variable.",
    deleteProjects: (n) => `The secret is assigned to ${n} projects; they stop receiving this variable.`,
    cancel: "Cancel",
    deleteConfirm: "Delete secret",
    deleting: "Deleting…",
    reservedTitle: "Reserved names",
    reservedLead:
      "Secrets cannot use these names, because they take over the environment of the system, git, ssh or agents.",
    reservedExact: "Exact names",
    reservedPrefixes: "Starting with",
    close: "Close",
    storeLockedTitle: "The OS secret store is locked",
    storeLockedHint: "Unlock it (sign in again or enter the password when the OS asks), then choose Check again.",
    storeDownTitle: "No usable secret store on this machine",
    storeHint: {
      wincred:
        "Values are kept only in Windows Credential Manager; the app stores them nowhere else. Sign in to Windows again, then check again.",
      keychain:
        "Values are kept only in the macOS Keychain; the app stores them nowhere else. Unlock the login keychain, then check again.",
      "secret-service":
        "Values are kept only in the Secret Service (gnome-keyring or KWallet); the app stores them nowhere else.",
    },
    recheck: "Check again",
    missing: "The store has lost the value, set it again",
  },
};

const subscribe = (listener: () => void) => {
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
};

/** localId của dự án đang lọc (theo `#/secrets/<localId>`); rỗng là mọi dự án. */
const useProjectFilter = () =>
  useSyncExternalStore(
    subscribe,
    () => secretsFilterFromHash(location.hash),
    () => "",
  );

/** Màn Bí mật tại máy (specs/031-local-secrets): danh sách, thêm, sửa, gán dự án, xoá. Không cần tài khoản hub. */
export function SecretsScreen() {
  const t = useT(text);
  const lang = useLang();
  const filterId = useId();
  const filter = useProjectFilter();
  const [data, setData] = useState<SecretsList | null>(null);
  const [status, setStatus] = useState<StoreStatus | undefined>(undefined);
  const [projects, setProjects] = useState<LocalProject[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<{ secret: SecretItem | null } | null>(null);
  const [deleting, setDeleting] = useState<SecretItem | null>(null);
  const [showReserved, setShowReserved] = useState(false);
  const [tab, setTab] = useState<"list" | "log">("list");
  const tabsId = useId();

  const load = useCallback(async () => {
    setError(null);
    try {
      // Danh sách dự án chỉ để gán và lọc; không đọc được thì màn vẫn dùng được với các bí mật đã có.
      // Trạng thái kho chỉ để báo; worker cũ chưa có lệnh thì coi như dùng được.
      const [list, local, store] = await Promise.all([
        secretsList(),
        localProjects().catch(() => null),
        secretsStatus().catch(() => undefined),
      ]);
      setData(list);
      setStatus(store);
      setProjects(local?.projects ?? []);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = (data?.secrets ?? []).filter((s) => !filter || s.projects.some((p) => p.localId === filter));
  // Dự án để lọc lấy từ danh sách gán, không từ projects.json, để dự án đã bị gỡ khỏi máy vẫn chọn được khi còn gán mồ côi.
  const filterable = new Map<string, string>();
  for (const p of projects) if (p.localId) filterable.set(p.localId, p.name);
  for (const s of data?.secrets ?? []) for (const p of s.projects) filterable.set(p.localId, p.name);
  const selectable = filter && !filterable.has(filter) ? [...filterable, [filter, filter] as const] : [...filterable];

  return (
    <div className="flex flex-col gap-3.5">
      <header className="flex flex-wrap items-center gap-3">
        <p className="min-w-60 flex-1 text-sm text-muted-foreground">{t.lead}</p>
        <Button variant="outline" onClick={() => setShowReserved(true)}>
          <ListIcon aria-hidden="true" />
          {t.reserved}
        </Button>
        <Button disabled={!storeUsable(status)} onClick={() => setForm({ secret: null })}>
          <PlusIcon aria-hidden="true" />
          {t.add}
        </Button>
      </header>

      {!storeUsable(status) && status && <StoreBanner status={status} onRecheck={() => void load()} />}

      <div role="tablist" aria-label={t.tabs} className="inline-flex w-fit rounded-lg bg-muted p-0.5">
        {(
          [
            ["list", t.tabList],
            ["log", t.tabLog],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            id={`${tabsId}-${id}`}
            type="button"
            role="tab"
            aria-selected={tab === id}
            aria-controls={`${tabsId}-panel`}
            tabIndex={tab === id ? 0 : -1}
            onClick={() => setTab(id)}
            onKeyDown={(e) => {
              if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
              e.preventDefault();
              setTab(id === "list" ? "log" : "list");
              document.getElementById(`${tabsId}-${id === "list" ? "log" : "list"}`)?.focus();
            }}
            className={cn(
              "h-7 cursor-pointer rounded-md px-3 text-sm",
              tab === id
                ? "bg-card font-semibold text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <div
        role="tabpanel"
        id={`${tabsId}-panel`}
        aria-labelledby={`${tabsId}-${tab}`}
        className="flex flex-col gap-3.5"
      >
        {tab === "log" && (
          <SecretsLog
            secretNames={(data?.secrets ?? []).map((s) => s.name)}
            projects={[...filterable]}
            initialProject={filter}
          />
        )}
        {tab === "list" && (
          <>
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

            {data && (
              <div className="flex flex-wrap items-center gap-2">
                <Label htmlFor={filterId} className="text-sm text-muted-foreground">
                  {t.filter}
                </Label>
                <NativeSelect
                  id={filterId}
                  className="max-w-full min-w-48"
                  value={filter}
                  onChange={(e) => {
                    location.hash = secretsHash(e.target.value);
                  }}
                >
                  <NativeSelectOption value="">{t.allProjects}</NativeSelectOption>
                  {selectable.map(([id, name]) => (
                    <NativeSelectOption key={id} value={id}>
                      {name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                <Button variant="ghost" size="sm" onClick={() => void load()}>
                  <RefreshCwIcon aria-hidden="true" />
                  {t.refresh}
                </Button>
              </div>
            )}

            {data && rows.length === 0 && (
              <p className="text-sm text-muted-foreground">{filter ? t.emptyFiltered : t.empty}</p>
            )}
            {data && rows.length > 0 && (
              <div className="overflow-x-auto rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <Th>{t.colName}</Th>
                      <Th>{t.colProjects}</Th>
                      <Th>{t.colChanged}</Th>
                      <Th>
                        <span className="sr-only">{t.colActions}</span>
                      </Th>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((s) => (
                      <TableRow key={s.name}>
                        <Td className="min-w-40">
                          <div translate="no" className="font-mono text-sm font-medium break-all">
                            {s.name}
                          </div>
                          {s.description && (
                            <div className="text-xs break-words text-muted-foreground">{s.description}</div>
                          )}
                          {isMissingValue(s) && (
                            <div className="mt-0.5 flex items-center gap-1 text-xs text-destructive">
                              <TriangleAlertIcon aria-hidden="true" className="size-3.5 shrink-0" />
                              {t.missing}
                            </div>
                          )}
                        </Td>
                        <Td className="min-w-36">
                          <div className="flex flex-wrap gap-1">
                            {s.projects.length === 0 && (
                              <span className="text-xs text-muted-foreground">{t.noProjects}</span>
                            )}
                            {s.projects.slice(0, 2).map((p) => (
                              <Pill key={p.localId} small>
                                {p.name}
                              </Pill>
                            ))}
                            {s.projects.length > 2 && (
                              <Pill small title={s.projects.map((p) => p.name).join(", ")}>
                                {t.moreProjects(s.projects.length - 2)}
                              </Pill>
                            )}
                          </div>
                        </Td>
                        <Td className="text-xs whitespace-nowrap text-muted-foreground">
                          {formatWhen(s.valueChangedAt, lang)}
                        </Td>
                        <Td>
                          <div className="flex flex-col items-end gap-1">
                            {/* key theo lúc đổi giá trị: sửa giá trị thì giá trị đang hiện của dòng bị bỏ. */}
                            <SecretValueActions
                              key={`${s.name}:${s.valueChangedAt}`}
                              name={s.name}
                              disabled={!storeUsable(status) || isMissingValue(s)}
                            />
                            <div className="flex flex-wrap justify-end gap-1">
                              <Button
                                variant="outline"
                                size="sm"
                                aria-label={t.edit(s.name)}
                                onClick={() => setForm({ secret: s })}
                              >
                                <PencilIcon aria-hidden="true" />
                                {t.editLabel}
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-destructive"
                                aria-label={t.remove(s.name)}
                                onClick={() => setDeleting(s)}
                              >
                                <Trash2Icon aria-hidden="true" />
                                {t.removeLabel}
                              </Button>
                            </div>
                          </div>
                        </Td>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </>
        )}
      </div>

      <SecretFormDialog
        open={form !== null}
        secret={form?.secret ?? null}
        projects={projects}
        taken={(data?.secrets ?? []).map((s) => s.name)}
        onClose={() => setForm(null)}
        onSaved={() => void load()}
      />
      <DeleteDialog
        secret={deleting}
        onClose={() => setDeleting(null)}
        onDeleted={() => {
          setDeleting(null);
          void load();
        }}
      />
      <ReservedDialog open={showReserved} reserved={data?.reserved ?? null} onClose={() => setShowReserved(false)} />
    </div>
  );
}

/** Kho của hệ điều hành khoá hay không có: báo rõ cách sửa, và app không lưu giá trị chỗ nào khác (FR-062). */
function StoreBanner({ status, onRecheck }: { status: StoreStatus; onRecheck: () => void }) {
  const t = useT(text);
  const locked = status.available && status.locked === true;
  return (
    <Alert variant="destructive">
      {locked ? <LockIcon aria-hidden="true" /> : <TriangleAlertIcon aria-hidden="true" />}
      <AlertTitle>{locked ? t.storeLockedTitle : t.storeDownTitle}</AlertTitle>
      <AlertDescription className="flex flex-col gap-2">
        {!locked && status.reason && <p className="break-words">{status.reason}</p>}
        <p>{locked ? t.storeLockedHint : (t.storeHint[status.backend] ?? "")}</p>
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

function DeleteDialog({
  secret,
  onClose,
  onDeleted,
}: {
  secret: SecretItem | null;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const t = useT(text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm(s: SecretItem) {
    setBusy(true);
    setError(null);
    try {
      await secretDelete(s.name);
      onDeleted();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={secret !== null} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{secret ? t.deleteTitle(secret.name) : ""}</DialogTitle>
          <DialogDescription>{t.deleteLead}</DialogDescription>
        </DialogHeader>
        {secret && secret.inUseBy > 0 && (
          <Alert variant="destructive">
            <AlertTitle>{t.deleteInUse(secret.inUseBy)}</AlertTitle>
            <AlertDescription>{t.deleteInUseHint}</AlertDescription>
          </Alert>
        )}
        {secret && secret.projects.length > 0 && (
          <p className="text-sm text-muted-foreground">{t.deleteProjects(secret.projects.length)}</p>
        )}
        {error && (
          <p role="alert" className="rounded-lg bg-destructive-soft px-3 py-2 text-sm break-words text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          {/* Huỷ là nút được focus đầu: Enter nhầm không xoá được bí mật. */}
          <Button variant="outline" autoFocus disabled={busy} onClick={onClose}>
            {t.cancel}
          </Button>
          <Button variant="destructive" disabled={busy} onClick={() => secret && void confirm(secret)}>
            {busy ? t.deleting : t.deleteConfirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReservedDialog({
  open,
  reserved,
  onClose,
}: {
  open: boolean;
  reserved: ReservedNames | null;
  onClose: () => void;
}) {
  const t = useT(text);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t.reservedTitle}</DialogTitle>
          <DialogDescription>{t.reservedLead}</DialogDescription>
        </DialogHeader>
        {reserved && (
          <div className="flex flex-col gap-3 text-sm">
            <section aria-label={t.reservedExact} className="flex flex-col gap-1.5">
              <h3 className="text-xs font-medium text-muted-foreground">{t.reservedExact}</h3>
              <ul className="m-0 flex list-none flex-wrap gap-1 p-0">
                {reserved.exact.map((n) => (
                  <li key={n}>
                    <Pill className="font-mono">{n}</Pill>
                  </li>
                ))}
              </ul>
            </section>
            <section aria-label={t.reservedPrefixes} className="flex flex-col gap-1.5">
              <h3 className="text-xs font-medium text-muted-foreground">{t.reservedPrefixes}</h3>
              <ul className="m-0 flex list-none flex-wrap gap-1 p-0">
                {reserved.prefixes.map((n) => (
                  <li key={n}>
                    <Pill className="font-mono">{`${n}…`}</Pill>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t.close}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
