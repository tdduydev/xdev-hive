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
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/native-select";
import { Pill } from "@xdev-hive/ui/pill";
import { Table, TableBody, TableHeader, TableRow, Td, Th } from "@xdev-hive/ui/table";
import { FileIcon, LoaderCircleIcon } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { shortPath } from "@/lib/folder.ts";
import { type Dict, useT } from "@/lib/i18n.ts";
import type { LocalProject } from "@/lib/local-projects.ts";
import {
  type EnvTarget,
  type ImportAction,
  type ImportItem,
  type ImportResult,
  type ImportStatus,
  importWrites,
  type OnConflict,
  pickSecretsFile,
  secretsImport,
  secretsImportEnv,
  secretsImportPreview,
} from "@/lib/secrets.ts";
import { errorText } from "@/lib/tauri.ts";

const text: Dict<{
  title: string;
  lead: string;
  source: string;
  sourceFile: string;
  sourceEnv: string;
  file: string;
  noFile: string;
  pickFile: string;
  pickTitle: string;
  password: string;
  passwordNote: string;
  needFile: string;
  needPassword: string;
  target: string;
  targetNote: string;
  targetNone: string;
  targetAll: string;
  preview: string;
  previewing: string;
  previewTitle: string;
  previewLead: string;
  conflict: string;
  conflictSkip: string;
  conflictOverwrite: string;
  colName: string;
  colStatus: string;
  colAction: string;
  colProjects: string;
  line: (n: number) => string;
  status: Record<ImportStatus, string>;
  action: Record<ImportAction, string>;
  done: Record<ImportAction, string>;
  allProjects: string;
  noProjects: string;
  unmatched: (names: string) => string;
  limited: (names: string) => string;
  willSummary: (write: number, skip: number) => string;
  doneSummary: (write: number, skip: number) => string;
  nothing: string;
  unmatchedHint: string;
  back: string;
  cancel: string;
  confirm: (n: number) => string;
  importing: string;
  doneTitle: string;
  close: string;
}> = {
  vi: {
    title: "Nhập bí mật",
    lead: "Nhập từ file .hivesecrets xuất ở máy khác, hoặc từ file .env. Xem trước rồi mới ghi vào kho của máy này.",
    source: "Nguồn",
    sourceFile: "File .hivesecrets",
    sourceEnv: "File .env",
    file: "File",
    noFile: "Chưa chọn file",
    pickFile: "Chọn file…",
    pickTitle: "Chọn file bí mật",
    password: "Mật khẩu của file",
    passwordNote: "Mật khẩu đặt lúc xuất. App không lưu mật khẩu này.",
    needFile: "Chọn file để nhập.",
    needPassword: "Nhập mật khẩu của file.",
    target: "Gán cho",
    targetNote: "File .env không ghi dự án; chọn dự án sẽ nhận các biến này.",
    targetNone: "Không gán dự án nào",
    targetAll: "Mọi dự án",
    preview: "Xem trước",
    previewing: "Đang đọc file…",
    previewTitle: "Xem trước khi nhập",
    previewLead: "Chưa có gì được ghi. Bảng chỉ có tên và dự án, không có giá trị.",
    conflict: "Tên đã có trên máy",
    conflictSkip: "Bỏ qua, giữ bí mật đang có",
    conflictOverwrite: "Ghi đè giá trị và mô tả, giữ các gán đang có",
    colName: "Tên",
    colStatus: "Trạng thái",
    colAction: "Sẽ làm",
    colProjects: "Dự án",
    line: (n) => `dòng ${n}`,
    status: {
      new: "Mới",
      same_name: "Trùng tên",
      same_value: "Trùng cả giá trị",
      invalid: "Không hợp lệ",
    },
    action: { create: "Thêm", overwrite: "Ghi đè", skip: "Bỏ qua" },
    done: { create: "Đã thêm", overwrite: "Đã ghi đè", skip: "Bỏ qua" },
    allProjects: "Mọi dự án",
    noProjects: "Không gán thêm",
    unmatched: (names) => `Không khớp dự án trên máy: ${names}`,
    limited: (names) => `Không gán vì dự án đã đủ 64 bí mật: ${names}`,
    willSummary: (write, skip) => `Sẽ ghi ${write} bí mật, bỏ qua ${skip}.`,
    doneSummary: (write, skip) => `Đã ghi ${write} bí mật, bỏ qua ${skip}.`,
    nothing: "Không có bí mật nào để ghi.",
    unmatchedHint: "Dự án không khớp chưa được gán. Gán lại bằng nút Sửa của từng bí mật.",
    back: "Quay lại",
    cancel: "Huỷ",
    confirm: (n) => `Nhập ${n} bí mật`,
    importing: "Đang nhập…",
    doneTitle: "Đã nhập bí mật",
    close: "Đóng",
  },
  en: {
    title: "Import secrets",
    lead: "Import a .hivesecrets file exported on another machine, or a .env file. Preview first, then write to this machine's store.",
    source: "Source",
    sourceFile: ".hivesecrets file",
    sourceEnv: ".env file",
    file: "File",
    noFile: "No file chosen",
    pickFile: "Choose file…",
    pickTitle: "Choose a secrets file",
    password: "File password",
    passwordNote: "The password set when exporting. The app does not store it.",
    needFile: "Choose a file to import.",
    needPassword: "Enter the file's password.",
    target: "Assign to",
    targetNote: "A .env file has no projects; choose which projects receive these variables.",
    targetNone: "No project",
    targetAll: "All projects",
    preview: "Preview",
    previewing: "Reading the file…",
    previewTitle: "Preview before importing",
    previewLead: "Nothing has been written yet. The table only shows names and projects, never values.",
    conflict: "Names already on this machine",
    conflictSkip: "Skip them, keep the existing secrets",
    conflictOverwrite: "Overwrite value and description, keep existing assignments",
    colName: "Name",
    colStatus: "Status",
    colAction: "Will",
    colProjects: "Projects",
    line: (n) => `line ${n}`,
    status: {
      new: "New",
      same_name: "Same name",
      same_value: "Same value",
      invalid: "Invalid",
    },
    action: { create: "Add", overwrite: "Overwrite", skip: "Skip" },
    done: { create: "Added", overwrite: "Overwritten", skip: "Skipped" },
    allProjects: "All projects",
    noProjects: "No new assignment",
    unmatched: (names) => `No matching project on this machine: ${names}`,
    limited: (names) => `Not assigned, the project already has 64 secrets: ${names}`,
    willSummary: (write, skip) => `Will write ${write} ${write === 1 ? "secret" : "secrets"}, skip ${skip}.`,
    doneSummary: (write, skip) => `Wrote ${write} ${write === 1 ? "secret" : "secrets"}, skipped ${skip}.`,
    nothing: "There is no secret to write.",
    unmatchedHint: "Unmatched projects were not assigned. Assign them with each secret's Edit button.",
    back: "Back",
    cancel: "Cancel",
    confirm: (n) => `Import ${n} ${n === 1 ? "secret" : "secrets"}`,
    importing: "Importing…",
    doneTitle: "Secrets imported",
    close: "Close",
  },
};

type Source = "hivesecrets" | "env";

const STATUS_TONE: Record<ImportStatus, "ok" | "warn" | "neutral" | "bad"> = {
  new: "ok",
  same_name: "warn",
  same_value: "neutral",
  invalid: "bad",
};

interface Props {
  open: boolean;
  /** Dự án trên máy, để chọn đích gán khi nhập `.env`. */
  projects: LocalProject[];
  onClose: () => void;
  /** Gọi sau khi nhập thật xong, để màn tải lại danh sách. */
  onImported: () => void;
}

/**
 * Nhập file `.hivesecrets` (FR-068) hay `.env` (FR-069): chọn file, xem trước, chọn cách xử lý tên trùng, rồi mới ghi.
 * Mật khẩu chỉ nằm trong state của hộp, xoá khi nhập xong và mất hẳn khi đóng hộp.
 */
export function SecretImportDialog({ open, projects, onClose, onImported }: Props) {
  return open ? <ImportBody projects={projects} onClose={onClose} onImported={onImported} /> : null;
}

function ImportBody({ projects, onClose, onImported }: Omit<Props, "open">) {
  const t = useT(text);
  const id = useId();
  const [source, setSource] = useState<Source>("hivesecrets");
  const [path, setPath] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  // "" là không gán, "*" là mọi dự án, còn lại là localId.
  const [target, setTarget] = useState("");
  const [onConflict, setOnConflict] = useState<OnConflict>("skip");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  const selectable = projects.filter((p): p is LocalProject & { localId: string } => !!p.localId);
  const envTarget: EnvTarget =
    target === "" ? { kind: "none" } : target === "*" ? { kind: "all" } : { kind: "project", localId: target };
  const missing = !path ? "needFile" : source === "hivesecrets" && password === "" ? "needPassword" : null;

  function run(file: string, dryRun: boolean, conflict: OnConflict) {
    if (source === "env") return secretsImportEnv(file, dryRun, conflict, envTarget);
    return dryRun ? secretsImportPreview(file, password, conflict) : secretsImport(file, password, conflict);
  }

  async function call(dryRun: boolean, conflict: OnConflict) {
    if (!path || busy) return;
    setBusy(true);
    setError(null);
    try {
      const got = await run(path, dryRun, conflict);
      setResult(got);
      if (!dryRun) {
        setPassword("");
        onImported();
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function choose() {
    setError(null);
    try {
      const picked = await pickSecretsFile(t.pickTitle, source);
      if (picked) setPath(picked);
    } catch (e) {
      setError(errorText(e));
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (missing) {
      document.getElementById(`${id}-${missing === "needFile" ? "pick" : "password"}`)?.focus();
      return;
    }
    void call(true, onConflict);
  }

  function changeConflict(next: OnConflict) {
    setOnConflict(next);
    // Cách xử lý tên trùng đổi hành động của từng mục: xem trước lại để bảng đúng với lần nhập thật.
    void call(true, next);
  }

  const close = () => !busy && onClose();

  if (result) {
    const writes = result.items.filter(importWrites).length;
    const skips = result.items.length - writes;
    const conflicts = result.items.some((i) => i.status === "same_name" || i.status === "same_value");
    const unmatched = result.items.some((i) => i.unmatched.length > 0);
    return (
      <Dialog open onOpenChange={(o) => !o && close()}>
        <DialogContent className="flex max-h-[90vh] flex-col gap-3 overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{result.dryRun ? t.previewTitle : t.doneTitle}</DialogTitle>
            <DialogDescription>{result.dryRun ? t.previewLead : t.doneSummary(writes, skips)}</DialogDescription>
          </DialogHeader>
          {result.dryRun && (
            <p className="text-sm" aria-live="polite">
              {writes > 0 ? t.willSummary(writes, skips) : t.nothing}
            </p>
          )}
          {result.dryRun && conflicts && (
            <fieldset className="flex min-w-0 flex-col gap-1 border-0 p-0" disabled={busy}>
              <legend className="mb-1 text-sm font-medium">{t.conflict}</legend>
              {(
                [
                  ["skip", t.conflictSkip],
                  ["overwrite", t.conflictOverwrite],
                ] as const
              ).map(([value, label]) => (
                <label key={value} className="flex min-h-8 cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name={`${id}-conflict`}
                    className="size-4 shrink-0 accent-primary"
                    checked={onConflict === value}
                    onChange={() => changeConflict(value)}
                  />
                  {label}
                </label>
              ))}
            </fieldset>
          )}
          <ImportTable items={result.items} dryRun={result.dryRun} />
          {!result.dryRun && unmatched && <p className="text-sm text-muted-foreground">{t.unmatchedHint}</p>}
          {error && (
            <p role="alert" className="rounded-lg bg-destructive-soft px-3 py-2 text-sm break-words text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            {result.dryRun ? (
              <>
                <Button variant="outline" disabled={busy} onClick={() => setResult(null)}>
                  {t.back}
                </Button>
                <Button disabled={busy || writes === 0} onClick={() => void call(false, onConflict)}>
                  {busy && <LoaderCircleIcon aria-hidden="true" className="animate-spin" />}
                  {busy ? t.importing : t.confirm(writes)}
                </Button>
              </>
            ) : (
              <Button variant="outline" autoFocus onClick={onClose}>
                {t.close}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open onOpenChange={(o) => !o && close()}>
      <DialogContent className="flex max-h-[90vh] flex-col gap-3 overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t.title}</DialogTitle>
          <DialogDescription>{t.lead}</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={submit} noValidate>
          <fieldset className="flex min-w-0 flex-col gap-1 border-0 p-0" disabled={busy}>
            <legend className="mb-1 text-sm font-medium">{t.source}</legend>
            {(
              [
                ["hivesecrets", t.sourceFile],
                ["env", t.sourceEnv],
              ] as const
            ).map(([value, label]) => (
              <label key={value} className="flex min-h-8 cursor-pointer items-center gap-2 text-sm">
                <input
                  type="radio"
                  name={`${id}-source`}
                  className="size-4 shrink-0 accent-primary"
                  checked={source === value}
                  onChange={() => {
                    // File đã chọn thuộc loại kia: chọn lại cho đúng loại.
                    setSource(value);
                    setPath(null);
                    setPassword("");
                  }}
                />
                {label}
              </label>
            ))}
          </fieldset>
          <div className="flex flex-col gap-1">
            <span id={`${id}-file`} className="text-sm font-medium">
              {t.file}
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                id={`${id}-pick`}
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                aria-describedby={`${id}-file ${id}-path`}
                onClick={() => void choose()}
              >
                <FileIcon aria-hidden="true" />
                {t.pickFile}
              </Button>
              <span
                id={`${id}-path`}
                translate="no"
                className={
                  path ? "min-w-0 flex-1 font-mono text-sm break-all" : "min-w-0 flex-1 text-sm text-muted-foreground"
                }
              >
                {path ? shortPath(path) : t.noFile}
              </span>
            </div>
            {touched && !path && <span className="text-xs text-destructive">{t.needFile}</span>}
          </div>
          {source === "hivesecrets" && (
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${id}-password`}>{t.password}</Label>
              <Input
                id={`${id}-password`}
                name="password"
                type="password"
                value={password}
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
                aria-invalid={touched && password === "" ? true : undefined}
                aria-describedby={`${id}-password-note`}
                onChange={(e) => setPassword(e.target.value)}
              />
              <span
                id={`${id}-password-note`}
                className={touched && password === "" ? "text-xs text-destructive" : "text-xs text-muted-foreground"}
              >
                {touched && password === "" ? t.needPassword : t.passwordNote}
              </span>
            </div>
          )}
          {source === "env" && (
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${id}-target`}>{t.target}</Label>
              <NativeSelect
                id={`${id}-target`}
                className="max-w-full"
                value={target}
                disabled={busy}
                aria-describedby={`${id}-target-note`}
                onChange={(e) => setTarget(e.target.value)}
              >
                <NativeSelectOption value="">{t.targetNone}</NativeSelectOption>
                <NativeSelectOption value="*">{t.targetAll}</NativeSelectOption>
                {selectable.map((p) => (
                  <NativeSelectOption key={p.localId} value={p.localId}>
                    {p.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <span id={`${id}-target-note`} className="text-xs text-muted-foreground">
                {t.targetNote}
              </span>
            </div>
          )}
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
              {busy ? t.previewing : t.preview}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ImportTable({ items, dryRun }: { items: ImportItem[]; dryRun: boolean }) {
  const t = useT(text);
  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <Th>{t.colName}</Th>
            <Th>{t.colStatus}</Th>
            <Th>{t.colAction}</Th>
            <Th>{t.colProjects}</Th>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((it, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: tên có thể rỗng hay lặp (dòng .env sai); danh sách chỉ hiện, không đổi thứ tự.
            <TableRow key={i}>
              <Td className="min-w-36">
                {it.name && (
                  <div translate="no" className="font-mono text-sm font-medium break-all">
                    {it.name}
                  </div>
                )}
                {it.line !== undefined && <div className="text-xs text-muted-foreground">{t.line(it.line)}</div>}
              </Td>
              <Td className="whitespace-nowrap">
                <Pill small tone={STATUS_TONE[it.status]}>
                  {t.status[it.status]}
                </Pill>
              </Td>
              <Td className="text-sm whitespace-nowrap">{dryRun ? t.action[it.action] : t.done[it.action]}</Td>
              <Td className="min-w-44">
                <div className="flex flex-col gap-1">
                  <div className="flex flex-wrap gap-1">
                    {it.allProjects && (
                      <Pill small tone="sel">
                        {t.allProjects}
                      </Pill>
                    )}
                    {it.projects.map((p) => (
                      <Pill key={p.localId} small>
                        {p.name}
                      </Pill>
                    ))}
                    {!it.allProjects && it.projects.length === 0 && importWrites(it) && (
                      <span className="text-xs text-muted-foreground">{t.noProjects}</span>
                    )}
                  </div>
                  {it.unmatched.length > 0 && (
                    <p className="text-xs break-words text-warning">
                      {t.unmatched(it.unmatched.map((p) => p.name).join(", "))}
                    </p>
                  )}
                  {it.limited.length > 0 && (
                    <p className="text-xs break-words text-destructive">
                      {t.limited(it.limited.map((p) => p.name).join(", "))}
                    </p>
                  )}
                  {it.error && <p className="text-xs break-words text-destructive">{it.error.message}</p>}
                </div>
              </Td>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
