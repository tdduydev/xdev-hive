import type { PlanContent } from "@xdev-hive/contracts";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { cx } from "../lib/cx.ts";
import {
  type DraftErrors,
  draftKey,
  FILE_CHANGE_LABEL,
  FILE_CHANGES,
  type FileChange,
  fromDraft,
  move,
  type PlanDraft,
  toDraft,
} from "../lib/plan-view.ts";
import { Alert } from "./ui/alert.tsx";
import { Button } from "./ui/button.tsx";
import { Card } from "./ui/card.tsx";
import { Input } from "./ui/input.tsx";
import { Select } from "./ui/select.tsx";
import { Textarea } from "./ui/textarea.tsx";

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
  const [draft, setDraft] = useState<PlanDraft>(() => toDraft(initial));
  const [errors, setErrors] = useState<DraftErrors>({});
  const ids = { summary: useId(), form: useId() };

  const patch = (next: Partial<PlanDraft>) => setDraft((d) => ({ ...d, ...next }));

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const r = fromDraft(draft);
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
    <form noValidate onSubmit={onSubmit} aria-label="Sửa kế hoạch" className="grid gap-4">
      <Card className="border-sel-line px-5 py-4">
        <div className="grid gap-1.5">
          <label htmlFor={ids.summary} className="text-label font-medium text-ink">
            Tóm tắt
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
        title="Các bước"
        error={errors.steps}
        addLabel="Thêm bước"
        onAdd={() => patch({ steps: [...draft.steps, { key: draftKey(), title: "", detail: "" }] })}
      >
        {draft.steps.map((s, i) => (
          <Row
            key={s.key}
            label={`Bước ${i + 1}`}
            onUp={i > 0 ? () => patch({ steps: move(draft.steps, i, -1) }) : undefined}
            onDown={i < draft.steps.length - 1 ? () => patch({ steps: move(draft.steps, i, 1) }) : undefined}
            onRemove={() => patch({ steps: draft.steps.filter((x) => x.key !== s.key) })}
          >
            <LabeledInput
              label="Tiêu đề"
              value={s.title}
              maxLength={MAX.stepTitle}
              error={errors[`steps.${s.key}.title`]}
              onChange={(title) => patch({ steps: draft.steps.map((x) => (x.key === s.key ? { ...x, title } : x)) })}
            />
            <LabeledTextarea
              label="Chi tiết (không bắt buộc)"
              value={s.detail}
              maxLength={MAX.stepDetail}
              onChange={(detail) => patch({ steps: draft.steps.map((x) => (x.key === s.key ? { ...x, detail } : x)) })}
            />
          </Row>
        ))}
      </EditorSection>

      <EditorSection
        title="File dự kiến đụng"
        addLabel="Thêm file"
        empty="Chưa có file nào."
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
                label="Đường dẫn"
                mono
                value={f.path}
                maxLength={MAX.path}
                error={errors[`files.${f.key}.path`]}
                placeholder="src/vat.ts"
                onChange={(path) => patch({ files: draft.files.map((x) => (x.key === f.key ? { ...x, path } : x)) })}
              />
              <LabeledSelect
                label="Thay đổi"
                value={f.change}
                onChange={(change) =>
                  patch({ files: draft.files.map((x) => (x.key === f.key ? { ...x, change } : x)) })
                }
              />
            </div>
            <LabeledInput
              label="Lý do (không bắt buộc)"
              value={f.reason}
              maxLength={MAX.reason}
              onChange={(reason) => patch({ files: draft.files.map((x) => (x.key === f.key ? { ...x, reason } : x)) })}
            />
          </Row>
        ))}
      </EditorSection>

      <LineList
        title="Rủi ro"
        itemLabel="Rủi ro"
        addLabel="Thêm rủi ro"
        empty="Chưa có rủi ro nào."
        rows={draft.risks}
        onChange={(risks) => patch({ risks })}
      />
      <LineList
        title="Câu hỏi cho người duyệt"
        itemLabel="Câu hỏi"
        addLabel="Thêm câu hỏi"
        empty="Chưa có câu hỏi nào."
        rows={draft.questions}
        onChange={(questions) => patch({ questions })}
      />

      {errors.form && <Alert id={ids.form}>{errors.form}</Alert>}
      {Object.keys(errors).length > 0 && !errors.form && (
        <Alert>Kế hoạch còn ô chưa hợp lệ. Sửa các ô được đánh dấu rồi bấm lại.</Alert>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button onClick={onCancel}>Huỷ sửa</Button>
        <Button type="submit" variant="primary">
          Dùng bản sửa
        </Button>
      </div>
    </form>
  );
}

function FieldErrorText({ id, message }: { id: string; message: string | undefined }) {
  if (!message) return null;
  return (
    <p id={id} className="text-xs text-bad">
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
        <h2 id={headingId} className="text-lg font-semibold text-ink">
          {title}
        </h2>
        {children.length === 0 && empty && <p className="text-muted">{empty}</p>}
        {children}
        {error && <p className="text-xs text-bad">{error}</p>}
        <div>
          <Button size="sm" onClick={onAdd}>
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
  return (
    <fieldset className="grid gap-2 rounded-lg border border-line p-3">
      <legend className="sr-only">{label}</legend>
      <div className="flex flex-wrap items-center gap-1.5">
        <span aria-hidden="true" className="mr-auto text-label font-medium text-ink">
          {label}
        </span>
        {(onUp || onDown) && (
          <>
            <Button
              size="sm"
              variant="ghost"
              disabled={!onUp}
              onClick={onUp}
              aria-label={`Đưa ${label.toLowerCase()} lên`}
            >
              Lên
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!onDown}
              onClick={onDown}
              aria-label={`Đưa ${label.toLowerCase()} xuống`}
            >
              Xuống
            </Button>
          </>
        )}
        <Button size="sm" variant="ghost" onClick={onRemove} aria-label={`Xoá ${label.toLowerCase()}`}>
          Xoá
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
      <label htmlFor={id} className="text-xs font-medium text-muted">
        {label}
      </label>
      <Input
        id={id}
        value={value}
        maxLength={maxLength}
        placeholder={placeholder}
        className={cx(mono && "font-mono text-sm", error && "border-bad")}
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
      <label htmlFor={id} className="text-xs font-medium text-muted">
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
  const id = useId();
  return (
    <div className="grid min-w-0 gap-1">
      <label htmlFor={id} className="text-xs font-medium text-muted">
        {label}
      </label>
      <Select id={id} value={value} onChange={(e) => onChange(e.currentTarget.value as FileChange | "")}>
        <option value="">Chưa rõ</option>
        {FILE_CHANGES.map((c) => (
          <option key={c} value={c}>
            {FILE_CHANGE_LABEL[c]}
          </option>
        ))}
      </Select>
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
            label="Nội dung"
            value={r.text}
            maxLength={MAX.line}
            onChange={(text) => onChange(rows.map((x) => (x.key === r.key ? { ...x, text } : x)))}
          />
        </Row>
      ))}
    </EditorSection>
  );
}
