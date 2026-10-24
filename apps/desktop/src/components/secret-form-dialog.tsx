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
import { type FormEvent, useId, useState } from "react";
import { shortPath } from "@/lib/folder.ts";
import { type Dict, useT } from "@/lib/i18n.ts";
import type { LocalProject } from "@/lib/local-projects.ts";
import {
  checkSecretName,
  checkSecretValue,
  isMissingValue,
  type NameProblem,
  SECRET_NAME_MAX_LENGTH,
  SECRET_VALUE_MIN_LENGTH,
  type SecretItem,
  secretRename,
  secretSave,
  type ValueProblem,
} from "@/lib/secrets.ts";
import { errorText } from "@/lib/tauri.ts";

const text: Dict<{
  addTitle: string;
  editTitle: (name: string) => string;
  lead: string;
  name: string;
  nameNote: string;
  duplicate: (name: string) => string;
  nameProblem: Record<NameProblem, string>;
  description: string;
  descriptionNote: string;
  value: string;
  valueNote: string;
  valueEditNote: string;
  valueMissingNote: string;
  valueRequired: string;
  valueProblem: Record<ValueProblem, string>;
  shared: string;
  sharedWarning: string;
  projects: string;
  noProjects: string;
  missingId: string;
  cancel: string;
  save: string;
  saving: string;
}> = {
  vi: {
    addTitle: "Thêm bí mật",
    editTitle: (name) => `Sửa ${name}`,
    lead: "Giá trị lưu trong kho của hệ điều hành trên máy này, không gửi lên hub. Agent nhận bí mật qua biến môi trường có cùng tên.",
    name: "Tên biến",
    nameNote: "Chữ hoa, số và gạch dưới, không bắt đầu bằng số. Chữ thường tự đổi thành chữ hoa.",
    duplicate: (name) => `Đã có bí mật tên ${name}.`,
    nameProblem: {
      empty: "Nhập tên biến.",
      syntax: `Tên chỉ gồm chữ A-Z, số và dấu gạch dưới, không bắt đầu bằng số, tối đa ${SECRET_NAME_MAX_LENGTH} ký tự.`,
      reserved: "Tên này dành riêng cho hệ thống hay agent, hãy đặt tên khác.",
    },
    description: "Mô tả",
    descriptionNote: "Agent đọc được mô tả để biết dùng biến khi nào. Đừng ghi giá trị vào đây.",
    value: "Giá trị",
    valueNote: `Tối thiểu ${SECRET_VALUE_MIN_LENGTH} ký tự. Sau khi lưu, ô này được xoá; chỉ xem lại được khi bấm Hiện.`,
    valueEditNote: `Để trống nếu giữ nguyên giá trị hiện tại. Giá trị mới tối thiểu ${SECRET_VALUE_MIN_LENGTH} ký tự.`,
    valueMissingNote: "Kho không còn giá trị của bí mật này. Nhập lại giá trị để dùng tiếp.",
    valueRequired: "Nhập giá trị.",
    valueProblem: {
      short: `Giá trị cần tối thiểu ${SECRET_VALUE_MIN_LENGTH} ký tự.`,
      long: "Giá trị dài quá 8 KiB.",
      nul: "Giá trị không được chứa ký tự NUL.",
    },
    shared: "Dùng cho mọi dự án",
    sharedWarning:
      "Bí mật sẽ được đưa vào mọi lần chạy agent của mọi dự án trên máy này, kể cả repo clone sau này. Chỉ bật cho khoá thật sự dùng chung.",
    projects: "Dự án được dùng bí mật này",
    noProjects: "Chưa có dự án nào trên máy. Thêm dự án ở mục Dự án trên máy rồi gán sau.",
    missingId: "Worker của máy cần cập nhật mới gán được bí mật cho dự án.",
    cancel: "Huỷ",
    save: "Lưu",
    saving: "Đang lưu…",
  },
  en: {
    addTitle: "Add secret",
    editTitle: (name) => `Edit ${name}`,
    lead: "The value is kept in this machine's OS store and never sent to the hub. Agents receive it as an environment variable with the same name.",
    name: "Variable name",
    nameNote: "Capital letters, digits and underscores, not starting with a digit. Lowercase is converted.",
    duplicate: (name) => `A secret named ${name} already exists.`,
    nameProblem: {
      empty: "Enter a variable name.",
      syntax: `Use only A-Z, digits and underscores, not starting with a digit, up to ${SECRET_NAME_MAX_LENGTH} characters.`,
      reserved: "This name is reserved for the system or agents. Pick another one.",
    },
    description: "Description",
    descriptionNote: "Agents read the description to know when to use the variable. Do not write the value here.",
    value: "Value",
    valueNote: `At least ${SECRET_VALUE_MIN_LENGTH} characters. This field is cleared after saving; the value can only be viewed again with Show.`,
    valueEditNote: `Leave empty to keep the current value. A new value needs at least ${SECRET_VALUE_MIN_LENGTH} characters.`,
    valueMissingNote: "The store no longer has this secret's value. Enter it again to keep using it.",
    valueRequired: "Enter a value.",
    valueProblem: {
      short: `The value needs at least ${SECRET_VALUE_MIN_LENGTH} characters.`,
      long: "The value is longer than 8 KiB.",
      nul: "The value must not contain a NUL character.",
    },
    shared: "Use for every project",
    sharedWarning:
      "The secret will be put into every agent run of every project on this machine, including repos cloned later. Only turn this on for keys that are truly shared.",
    projects: "Projects that may use this secret",
    noProjects: "No projects on this machine yet. Add one under Projects on this machine, then assign.",
    missingId: "The worker on this machine needs an update before secrets can be assigned to projects.",
    cancel: "Cancel",
    save: "Save",
    saving: "Saving…",
  },
};

interface Props {
  open: boolean;
  /** Bí mật đang sửa; null là thêm mới. */
  secret: SecretItem | null;
  projects: LocalProject[];
  /** Tên đã có, để báo trùng ngay trong form; worker vẫn kiểm lại. */
  taken: readonly string[];
  onClose: () => void;
  onSaved: () => void;
}

/**
 * Form thêm và sửa bí mật. Giá trị chỉ nằm trong state của form: xoá khi lưu xong và khi đóng, để không còn trong bộ
 * nhớ của giao diện lâu hơn cần (FR-007). Lưu lỗi thì giữ lại, vì người dùng sẽ phải nhập lại đúng giá trị đó.
 */
export function SecretFormDialog({ open, secret, projects, taken, onClose, onSaved }: Props) {
  // key theo bí mật: mở lại với bí mật khác thì form khởi tạo lại, không mang state cũ sang.
  return open ? (
    <FormBody
      key={secret?.name ?? "new"}
      secret={secret}
      projects={projects}
      taken={taken}
      onClose={onClose}
      onSaved={onSaved}
    />
  ) : null;
}

function FormBody({ secret, projects, taken, onClose, onSaved }: Omit<Props, "open">) {
  const t = useT(text);
  const id = useId();
  const [name, setName] = useState(secret?.name ?? "");
  const [description, setDescription] = useState(secret?.description ?? "");
  const [value, setValue] = useState("");
  const [assigned, setAssigned] = useState<ReadonlySet<string>>(new Set(secret?.projects.map((p) => p.localId)));
  const [shared, setShared] = useState(secret?.allProjects === true);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const editing = secret !== null;
  const checked = checkSecretName(name);
  const duplicate = checked.problem === null && checked.name !== secret?.name && taken.includes(checked.name);
  const nameError = checked.problem ? t.nameProblem[checked.problem] : duplicate ? t.duplicate(checked.name) : null;
  // Kho mất giá trị thì sửa cũng phải nhập lại: để trống sẽ chỉ "giữ" một giá trị không còn.
  const needsValue = !editing || (secret !== null && isMissingValue(secret));
  const valueProblem = value === "" ? null : checkSecretValue(value);
  const valueError = valueProblem ? t.valueProblem[valueProblem] : needsValue && value === "" ? t.valueRequired : null;
  const shownNameError = touched ? nameError : null;
  // Lỗi độ dài báo ngay khi gõ, không đợi bấm Lưu: worker từ chối thì người dùng đã phải gõ lại từ đầu.
  const shownValueError = touched || valueProblem ? valueError : null;
  const selectable = projects.filter((p): p is LocalProject & { localId: string } => !!p.localId);

  function toggle(localId: string, on: boolean) {
    setAssigned((cur) => {
      const next = new Set(cur);
      if (on) next.add(localId);
      else next.delete(localId);
      return next;
    });
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (nameError || valueError || busy) {
      // Đưa focus tới ô lỗi đầu tiên để người dùng bàn phím và trình đọc màn hình thấy ngay chỗ cần sửa.
      document.getElementById(`${id}-${nameError ? "name" : "value"}`)?.focus();
      return;
    }
    const typed = value;
    setBusy(true);
    setError(null);
    // Xoá trong lúc chờ worker; lỗi thì trả lại để người dùng sửa tiếp thay vì gõ lại. Đóng form vẫn xoá hẳn (FR-007).
    setValue("");
    try {
      if (secret && secret.name !== checked.name) await secretRename(secret.name, checked.name);
      await secretSave({
        name: checked.name,
        description: description.trim(),
        value: typed === "" ? undefined : typed,
        // Dùng chung thì worker bỏ gán riêng; tắt cờ thì gán lại các dự án còn được chọn.
        projects: shared ? [] : [...assigned],
        // Chỉ gửi cờ khi bật hay vừa tắt, để lưu bí mật thường không tốn thêm một lần gọi worker.
        allProjects: shared || secret?.allProjects ? shared : undefined,
      });
      onSaved();
      onClose();
    } catch (err) {
      setValue(typed);
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="top-0 right-0 left-auto flex h-full max-w-full translate-x-0 translate-y-0 flex-col gap-3 overflow-y-auto rounded-none sm:max-w-120 sm:rounded-l-xl motion-reduce:animate-none data-open:slide-in-from-right-8 data-open:zoom-in-100 data-closed:slide-out-to-right-8 data-closed:zoom-out-100">
        <DialogHeader className="pr-8">
          <DialogTitle>{secret ? t.editTitle(secret.name) : t.addTitle}</DialogTitle>
          <DialogDescription>{t.lead}</DialogDescription>
        </DialogHeader>
        <form className="flex flex-1 flex-col gap-3" onSubmit={(e) => void submit(e)} noValidate>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-name`}>{t.name}</Label>
            <Input
              id={`${id}-name`}
              name="name"
              className="font-mono"
              value={name}
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="characters"
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
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-description`}>{t.description}</Label>
            <Input
              id={`${id}-description`}
              name="description"
              value={description}
              autoComplete="off"
              aria-describedby={`${id}-description-note`}
              onChange={(e) => setDescription(e.target.value)}
            />
            <span id={`${id}-description-note`} className="text-xs text-muted-foreground">
              {t.descriptionNote}
            </span>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-value`}>{t.value}</Label>
            {/* Không có nút xem giá trị đang gõ: màn chỉ cho thấy giá trị qua nút Hiện có xác nhận (FR-007). */}
            <Input
              id={`${id}-value`}
              name="value"
              type="password"
              className="font-mono"
              value={value}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={shownValueError ? true : undefined}
              aria-describedby={`${id}-value-note`}
              onChange={(e) => setValue(e.target.value)}
            />
            <span
              id={`${id}-value-note`}
              className={shownValueError ? "text-xs text-destructive" : "text-xs text-muted-foreground"}
            >
              {shownValueError ?? (!editing ? t.valueNote : needsValue ? t.valueMissingNote : t.valueEditNote)}
            </span>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="flex min-h-8 cursor-pointer items-start gap-2 text-sm font-medium">
              <input
                type="checkbox"
                className="mt-1 size-4 shrink-0 accent-primary"
                checked={shared}
                aria-describedby={shared ? `${id}-shared-note` : undefined}
                onChange={(e) => setShared(e.target.checked)}
              />
              <span className="min-w-0">{t.shared}</span>
            </label>
            {shared && (
              <p id={`${id}-shared-note`} className="rounded-lg bg-warning-soft px-3 py-2 text-xs text-warning">
                {t.sharedWarning}
              </p>
            )}
          </div>
          {!shared && (
            <fieldset className="flex min-w-0 flex-col gap-1.5 border-0 p-0">
              <legend className="mb-1 text-sm font-medium">{t.projects}</legend>
              {projects.length === 0 && <p className="text-xs text-muted-foreground">{t.noProjects}</p>}
              {projects.length > 0 && selectable.length === 0 && (
                <p className="text-xs text-muted-foreground">{t.missingId}</p>
              )}
              {selectable.map((p) => (
                <label key={p.localId} className="flex min-h-8 cursor-pointer items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1 size-4 shrink-0 accent-primary"
                    checked={assigned.has(p.localId)}
                    onChange={(e) => toggle(p.localId, e.target.checked)}
                  />
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{p.name}</span>
                    <span className="block truncate font-mono text-xs text-muted-foreground">
                      {shortPath(p.folder)}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
          )}
          {error && (
            <p role="alert" className="rounded-lg bg-destructive-soft px-3 py-2 text-sm break-words text-destructive">
              {error}
            </p>
          )}
          <DialogFooter className="mt-auto">
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
