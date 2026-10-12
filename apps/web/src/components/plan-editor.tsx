import type { PlanContent } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Input } from "@xdev-hive/ui/input";
import { NativeSelect } from "@xdev-hive/ui/native-select";
import { Textarea } from "@xdev-hive/ui/textarea";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { Card } from "@/components/ui/card.tsx";
import { cx } from "@/lib/cx.ts";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import {
  type DraftErrors,
  draftKey,
  FILE_CHANGES,
  type FileChange,
  fileChangeLabel,
  fromDraft,
  move,
  type PlanDraft,
  toDraft,
} from "@/lib/plan-view.ts";

const text: Dict<
  Record<
    | "step"
    | "move"
    | "up"
    | "down"
    | "edit"
    | "summary"
    | "steps"
    | "addStep"
    | "title"
    | "detail"
    | "files"
    | "addFile"
    | "emptyFiles"
    | "path"
    | "change"
    | "reason"
    | "risks"
    | "addRisk"
    | "emptyRisks"
    | "questions"
    | "question"
    | "addQuestion"
    | "emptyQuestions"
    | "invalidFields"
    | "cancel"
    | "save"
    | "upAction"
    | "downAction"
    | "deleteAction"
    | "unspecified"
    | "content",
    string
  >
> = {
  vi: {
    step: "Bước",
    move: "Đưa",
    up: "lên",
    down: "xuống",
    edit: "Sửa kế hoạch",
    summary: "Tóm tắt",
    steps: "Các bước",
    addStep: "Thêm bước",
    title: "Tiêu đề",
    detail: "Chi tiết (không bắt buộc)",
    files: "File dự kiến đụng",
    addFile: "Thêm file",
    emptyFiles: "Chưa có file nào.",
    path: "Đường dẫn",
    change: "Thay đổi",
    reason: "Lý do (không bắt buộc)",
    risks: "Rủi ro",
    addRisk: "Thêm rủi ro",
    emptyRisks: "Chưa có rủi ro nào.",
    questions: "Câu hỏi cho người duyệt",
    question: "Câu hỏi",
    addQuestion: "Thêm câu hỏi",
    emptyQuestions: "Chưa có câu hỏi nào.",
    invalidFields: "Kế hoạch còn ô chưa hợp lệ. Sửa các ô được đánh dấu rồi bấm lại.",
    cancel: "Huỷ sửa",
    save: "Dùng bản sửa",
    upAction: "Lên",
    downAction: "Xuống",
    deleteAction: "Xoá",
    unspecified: "Chưa rõ",
    content: "Nội dung",
  },
  en: {
    step: "Step",
    move: "Move",
    up: "up",
    down: "down",
    edit: "Edit plan",
    summary: "Summary",
    steps: "Steps",
    addStep: "Add step",
    title: "Title",
    detail: "Details (optional)",
    files: "Files it expects to touch",
    addFile: "Add file",
    emptyFiles: "No files yet.",
    path: "Path",
    change: "Change",
    reason: "Reason (optional)",
    risks: "Risks",
    addRisk: "Add risk",
    emptyRisks: "No risks yet.",
    questions: "Questions for the reviewer",
    question: "Question",
    addQuestion: "Add question",
    emptyQuestions: "No questions yet.",
    invalidFields: "Some fields are invalid. Fix the marked fields and try again.",
    cancel: "Cancel edits",
    save: "Use edited version",
    upAction: "Up",
    downAction: "Down",
    deleteAction: "Delete",
    unspecified: "Unspecified",
    content: "Content",
  },
};

/*
 * Giới hạn độ dài chép từ `planContent` (packages/contracts/src/tasks.ts), đặt thành maxLength để người duyệt không
 * gõ quá rồi mới bị hub từ chối.
 */
const MAX = { summary: 20_000, stepTitle: 500, stepDetail: 10_000, path: 500, reason: 2000, line: 4000 } as const;

/**
 * Form sửa kế hoạch theo đúng schema của hub: tóm tắt, các bước (đổi thứ tự được), file dự kiến đụng, rủi ro, câu hỏi.
 * Không phải ô JSON thô: người duyệt không cần biết định dạng, và lỗi hiện ngay cạnh ô sai.
 */
export function PlanEditor({
  initial,
  onCancel,
  onSave,
}: {
  initial: PlanContent;
  onCancel: () => void;
  onSave: (content: PlanContent) => void;
}) {
  const t = useT(text);
  const lang = useLang();
  const [draft, setDraft] = useState<PlanDraft>(() => toDraft(initial));
  const [errors, setErrors] = useState<DraftErrors>({});
  const ids = { summary: useId(), form: useId() };

  const patch = (next: Partial<PlanDraft>) => setDraft((d) => ({ ...d, ...next }));

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const r = fromDraft(draft, lang);
    if (!r.ok) {
      setErrors(r.errors);
      // Đưa focus tới ô sai đầu tiên để người dùng bàn phím và trình đọc màn hình biết phải sửa đâu.
      requestAnimationFrame(() => form.querySelector<HTMLElement>("[aria-invalid=true]")?.focus());
      return;
    }
    setErrors({});
    onSave(r.content);
  }

  return (
    <form noValidate onSubmit={onSubmit} aria-label={t.edit} className="grid gap-4">
      <Card className="border-primary/40 px-5 py-4">
        <div className="grid gap-1.5">
          <label htmlFor={ids.summary} className="text-sm font-medium text-foreground">
            {t.summary}
          </label>
          <Textarea
            id={ids.summary}
            rows={4}
            maxLength={MAX.summary}
            value={draft.summary}
            onChange={(e) => patch({ summary: e.currentTarget.value })}
            aria-invalid={errors.summary ? true : undefined}
            aria-describedby={errors.summary ? `${ids.summary}-error` : undefined}
          />
          <FieldErrorText id={`${ids.summary}-error`} message={errors.summary} />
        </div>
      </Card>

      <EditorSection
        title={t.steps}
        error={errors.steps}
        addLabel={t.addStep}
        onAdd={() => patch({ steps: [...draft.steps, { key: draftKey(), title: "", detail: "" }] })}
      >
        {draft.steps.map((s, i) => (
          <Row
            key={s.key}
            label={`${t.step} ${i + 1}`}
            onUp={i > 0 ? () => patch({ steps: move(draft.steps, i, -1) }) : undefined}
            onDown={i < draft.steps.length - 1 ? () => patch({ steps: move(draft.steps, i, 1) }) : undefined}
            onRemove={() => patch({ steps: draft.steps.filter((x) => x.key !== s.key) })}
          >
            <LabeledInput
              label={t.title}
              value={s.title}
              maxLength={MAX.stepTitle}
              error={errors[`steps.${s.key}.title`]}
              onChange={(title) => patch({ steps: draft.steps.map((x) => (x.key === s.key ? { ...x, title } : x)) })}
            />
            <LabeledTextarea
              label={t.detail}
              value={s.detail}
              maxLength={MAX.stepDetail}
              onChange={(detail) => patch({ steps: draft.steps.map((x) => (x.key === s.key ? { ...x, detail } : x)) })}
            />
          </Row>
        ))}
      </EditorSection>

      <EditorSection
        title={t.files}
        addLabel={t.addFile}
        empty={t.emptyFiles}
        onAdd={() => patch({ files: [...draft.files, { key: draftKey(), path: "", change: "", reason: "" }] })}
      >
        {draft.files.map((f, i) => (
          <Row
            key={f.key}
            label={`File ${i + 1}`}
            onRemove={() => patch({ files: draft.files.filter((x) => x.key !== f.key) })}
          >
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_9rem]">
              <LabeledInput
                label={t.path}
                mono
                value={f.path}
                maxLength={MAX.path}
                error={errors[`files.${f.key}.path`]}
                placeholder="src/vat.ts"
                onChange={(path) => patch({ files: draft.files.map((x) => (x.key === f.key ? { ...x, path } : x)) })}
              />
              <LabeledSelect
                label={t.change}
                value={f.change}
                onChange={(change) =>
                  patch({ files: draft.files.map((x) => (x.key === f.key ? { ...x, change } : x)) })
                }
              />
            </div>
            <LabeledInput
              label={t.reason}
              value={f.reason}
              maxLength={MAX.reason}
              onChange={(reason) => patch({ files: draft.files.map((x) => (x.key === f.key ? { ...x, reason } : x)) })}
            />
          </Row>
        ))}
      </EditorSection>

      <LineList
        title={t.risks}
        itemLabel={t.risks}
        addLabel={t.addRisk}
        empty={t.emptyRisks}
        rows={draft.risks}
        onChange={(risks) => patch({ risks })}
      />
      <LineList
        title={t.questions}
        itemLabel={t.question}
        addLabel={t.addQuestion}
        empty={t.emptyQuestions}
        rows={draft.questions}
        onChange={(questions) => patch({ questions })}
      />

      {errors.form && (
        <Alert variant="destructive" id={ids.form}>
          {errors.form}
        </Alert>
      )}
      {Object.keys(errors).length > 0 && !errors.form && <Alert variant="destructive">{t.invalidFields}</Alert>}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" onClick={onCancel}>
          {t.cancel}
        </Button>
        <Button type="submit" variant="default">
          {t.save}
        </Button>
      </div>
    </form>
  );
}

function FieldErrorText({ id, message }: { id: string; message: string | undefined }) {
  if (!message) return null;
  return (
    <p id={id} className="text-xs text-destructive">
      {message}
    </p>
  );
}

function EditorSection({
  title,
  error,
  addLabel,
  empty,
  onAdd,
  children,
}: {
  title: string;
  error?: string | undefined;
  addLabel: string;
  empty?: string;
  onAdd: () => void;
  children: ReactNode[];
}) {
  const headingId = useId();
  return (
    <Card>
      <fieldset aria-labelledby={headingId} className="grid gap-3 px-5 py-4">
        <h2 id={headingId} className="text-base font-semibold text-foreground">
          {title}
        </h2>
        {children.length === 0 && empty && <p className="text-muted-foreground">{empty}</p>}
        {children}
        {error && <p className="text-xs text-destructive">{error}</p>}
        <div>
          <Button variant="outline" size="sm" onClick={onAdd}>
            {addLabel}
          </Button>
        </div>
      </fieldset>
    </Card>
  );
}

/** Một dòng có thể đổi thứ tự hay xoá; tên nút kèm số thứ tự để trình đọc màn hình biết đang thao tác dòng nào. */
function Row({
  label,
  onUp,
  onDown,
  onRemove,
  children,
}: {
  label: string;
  onUp?: (() => void) | undefined;
  onDown?: (() => void) | undefined;
  onRemove: () => void;
  children: ReactNode;
}) {
  const t = useT(text);
  return (
    <fieldset className="grid gap-2 rounded-lg border border-border p-3">
      <legend className="sr-only">{label}</legend>
      <div className="flex flex-wrap items-center gap-1.5">
        <span aria-hidden="true" className="mr-auto text-sm font-medium text-foreground">
          {label}
        </span>
        {(onUp || onDown) && (
          <>
            <Button
              size="sm"
              variant="ghost"
              disabled={!onUp}
              onClick={onUp}
              aria-label={`${t.move} ${label.toLowerCase()} ${t.up}`}
            >
              {t.upAction}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!onDown}
              onClick={onDown}
              aria-label={`${t.move} ${label.toLowerCase()} ${t.down}`}
            >
              {t.downAction}
            </Button>
          </>
        )}
        <Button size="sm" variant="ghost" onClick={onRemove} aria-label={`${t.deleteAction} ${label.toLowerCase()}`}>
          {t.deleteAction}
        </Button>
      </div>
      {children}
    </fieldset>
  );
}

function LabeledInput({
  label,
  value,
  onChange,
  maxLength,
  error,
  placeholder,
  mono = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  maxLength: number;
  error?: string | undefined;
  placeholder?: string;
  mono?: boolean;
}) {
  const id = useId();
  return (
    <div className="grid min-w-0 gap-1">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <Input
        id={id}
        value={value}
        maxLength={maxLength}
        placeholder={placeholder}
        className={cx(mono && "font-mono text-xs", error && "border-destructive")}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(e) => onChange(e.currentTarget.value)}
      />
      <FieldErrorText id={`${id}-error`} message={error} />
    </div>
  );
}

function LabeledTextarea({
  label,
  value,
  onChange,
  maxLength,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  maxLength: number;
}) {
  const id = useId();
  return (
    <div className="grid min-w-0 gap-1">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <Textarea
        id={id}
        rows={2}
        value={value}
        maxLength={maxLength}
        onChange={(e) => onChange(e.currentTarget.value)}
      />
    </div>
  );
}

function LabeledSelect({
  label,
  value,
  onChange,
}: {
  label: string;
  value: FileChange | "";
  onChange: (v: FileChange | "") => void;
}) {
  const t = useT(text);
  const lang = useLang();
  const id = useId();
  return (
    <div className="grid min-w-0 gap-1">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <NativeSelect id={id} value={value} onChange={(e) => onChange(e.currentTarget.value as FileChange | "")}>
        <option value="">{t.unspecified}</option>
        {FILE_CHANGES.map((c) => (
          <option key={c} value={c}>
            {fileChangeLabel(c, lang)}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
}

function LineList({
  title,
  itemLabel,
  addLabel,
  empty,
  rows,
  onChange,
}: {
  title: string;
  itemLabel: string;
  addLabel: string;
  empty: string;
  rows: PlanDraft["risks"];
  onChange: (rows: PlanDraft["risks"]) => void;
}) {
  const t = useT(text);
  return (
    <EditorSection
      title={title}
      addLabel={addLabel}
      empty={empty}
      onAdd={() => onChange([...rows, { key: draftKey(), text: "" }])}
    >
      {rows.map((r, i) => (
        <Row key={r.key} label={`${itemLabel} ${i + 1}`} onRemove={() => onChange(rows.filter((x) => x.key !== r.key))}>
          <LabeledTextarea
            label={t.content}
            value={r.text}
            maxLength={MAX.line}
            onChange={(text) => onChange(rows.map((x) => (x.key === r.key ? { ...x, text } : x)))}
          />
        </Row>
      ))}
    </EditorSection>
  );
}
