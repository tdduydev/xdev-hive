import { Button } from "@xdev-hive/ui/button";
import { CheckIcon, CircleAlertIcon } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useId, useState } from "react";
import { Switch } from "@/components/ui/switch.tsx";
import { cx } from "@/lib/cx.ts";
import { type Dict, useT } from "@/lib/i18n.ts";

const text: Dict<{ save: string; saving: string; discard: string; unsaved: string; saved: string }> = {
  vi: { save: "Lưu", saving: "Đang lưu…", discard: "Huỷ", unsaved: "Có thay đổi chưa lưu", saved: "Đã lưu" },
  en: { save: "Save", saving: "Saving…", discard: "Cancel", unsaved: "Unsaved changes", saved: "Saved" },
};

/**
 * Trang cài đặt nhiều mục (admin-layout.md § Form cài đặt): mục lục bám theo cuộn bên trái khi cột nội dung rộng từ
 * 896 px, các mục là card xếp dọc bên phải. Hẹp hơn thì mục lục thành hàng chip cuộn ngang để vẫn nhảy nhanh được tới
 * mục cuối. Đo theo cột nội dung chứ không theo màn hình: trong khu quản trị sidebar và menu Quản trị đã chiếm 448 px,
 * thêm cột mục lục ở 1100 px thì form chỉ còn khoảng 360 px.
 */
export function SettingsLayout({ nav, children }: { nav?: ReactNode; children: ReactNode }) {
  return (
    <div className="@container/settings min-w-0">
      <div className="grid min-w-0 gap-4 @4xl/settings:grid-cols-[12rem_minmax(0,1fr)] @4xl/settings:items-start @4xl/settings:gap-8">
        {nav}
        <div className="grid min-w-0 gap-4">{children}</div>
      </div>
    </div>
  );
}

export interface SettingsNavItem {
  id: string;
  label: string;
}

/**
 * Mục lục của trang cài đặt. Mục đang đọc sáng lên theo vị trí cuộn (IntersectionObserver); trình duyệt không có thì
 * chỉ còn là danh sách link, vẫn dùng được.
 */
export function SettingsNav({ label, items }: { label: string; items: readonly SettingsNavItem[] }) {
  const [active, setActive] = useState(items[0]?.id);
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const seen = new Map<string, boolean>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) seen.set(entry.target.id, entry.isIntersecting);
        const first = items.find((item) => seen.get(item.id));
        if (first) setActive(first.id);
      },
      // Mục coi là "đang đọc" khi đầu của nó đã qua thanh trên và còn nằm ở nửa trên màn hình.
      { rootMargin: "-56px 0px -55% 0px" },
    );
    for (const item of items) {
      const el = document.getElementById(item.id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [items]);
  return (
    <nav aria-label={label} className="min-w-0 @4xl/settings:sticky @4xl/settings:top-16">
      <ul className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 [scrollbar-width:thin] @4xl/settings:mx-0 @4xl/settings:grid @4xl/settings:overflow-visible @4xl/settings:px-0 @4xl/settings:pb-0">
        {items.map((item) => (
          <li key={item.id} className="shrink-0">
            <a
              href={`#${item.id}`}
              aria-current={item.id === active ? "location" : undefined}
              onClick={() => setActive(item.id)}
              className={cx(
                "block rounded-md px-2.5 py-1.5 text-sm whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                "border border-border @4xl/settings:border-transparent",
                item.id === active
                  ? "bg-accent font-medium text-accent-foreground @4xl/settings:border-l-2 @4xl/settings:border-l-primary"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {item.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * Lưu riêng một mục (admin-layout.md § Decisions 4): mục có thay đổi thì nút Lưu bật và Huỷ hiện ra; kết quả lưu
 * ("Đã lưu" hay lỗi) nằm ngay ở chân mục đó. Trang tự giữ bản nháp và gọi hub; mục chỉ vẽ trạng thái.
 */
export interface SectionSave {
  dirty: boolean;
  saving: boolean;
  /** Vừa lưu xong và chưa sửa gì thêm. */
  saved?: boolean;
  error?: ReactNode;
  onSave: () => void;
  onDiscard: () => void;
  /** Khoá nút Lưu khi mục khác đang lưu (hub nhận từng bản vá một). */
  disabled?: boolean;
  saveLabel?: string;
  savedLabel?: string;
}

/**
 * Một mục cài đặt: card có đầu (tiêu đề, mô tả, nút phụ) tách bằng viền, thân là các hàng FormRow/SwitchRow cách nhau
 * bằng đường kẻ. `role="group"` để trình đọc màn hình đọc tên mục khi vào một ô bên trong. Có `save` thì mục là một
 * `<form>` riêng: Enter trong ô lưu đúng mục đó, chân mục có trạng thái và nút Huỷ, Lưu.
 */
export function SettingsSection({
  id,
  title,
  description,
  actions,
  save,
  children,
}: {
  id?: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  save?: SectionSave | undefined;
  children: ReactNode;
}) {
  const headingId = useId();
  const className = "min-w-0 scroll-mt-20 rounded-xl bg-card text-sm text-card-foreground ring-1 ring-foreground/10";
  const content = (
    <>
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2 border-b border-border px-4 py-3.5 sm:px-5">
        <div className="grid min-w-0 flex-1 basis-64 gap-0.5">
          <h2 id={headingId} className="text-base font-semibold text-foreground">
            {title}
          </h2>
          {description && <p className="text-xs text-pretty text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      <div className="grid divide-y divide-border px-4 sm:px-5 [&>*]:py-4">{children}</div>
      {save && <SectionSaveBar save={save} />}
    </>
  );
  if (save) {
    const onSubmit = (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (save.dirty && !save.saving && !save.disabled) save.onSave();
    };
    return (
      // biome-ignore lint/a11y/useSemanticElements: tên nhóm là h2 có sẵn trong đầu card, fieldset buộc dùng legend.
      <form
        id={id}
        role="group"
        aria-labelledby={headingId}
        noValidate
        onSubmit={onSubmit}
        data-dirty={save.dirty || undefined}
        className={className}
      >
        {content}
      </form>
    );
  }
  return (
    // biome-ignore lint/a11y/useSemanticElements: tên nhóm là h2 có sẵn trong đầu card, fieldset buộc dùng legend.
    <div id={id} role="group" aria-labelledby={headingId} className={className}>
      {content}
    </div>
  );
}

function SectionSaveBar({ save }: { save: SectionSave }) {
  const t = useT(text);
  let status: ReactNode = null;
  if (save.error)
    status = (
      <p role="alert" className="flex min-w-0 items-start gap-1.5 text-sm text-destructive">
        <CircleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <span className="min-w-0 break-words">{save.error}</span>
      </p>
    );
  else if (save.saved && !save.dirty)
    status = (
      <p role="status" className="flex items-center gap-1.5 text-sm text-success">
        <CheckIcon aria-hidden="true" className="size-4" />
        {save.savedLabel ?? t.saved}
      </p>
    );
  else if (save.dirty)
    status = (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <span aria-hidden="true" className="size-2 rounded-full bg-warning" />
        {t.unsaved}
      </p>
    );
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-b-xl border-t border-border bg-muted/40 px-4 py-2.5 sm:px-5">
      <div className="min-w-0 flex-1 basis-48">{status}</div>
      <div className="ml-auto flex gap-2">
        {save.dirty && (
          <Button type="button" variant="outline" size="sm" onClick={save.onDiscard} disabled={save.saving}>
            {t.discard}
          </Button>
        )}
        <Button type="submit" variant="default" size="sm" disabled={!save.dirty || save.saving || save.disabled}>
          {save.saving ? t.saving : (save.saveLabel ?? t.save)}
        </Button>
      </div>
    </div>
  );
}

/**
 * Hàng nhãn–ô trong mục cài đặt: nhãn và gợi ý bên trái (2/5), ô bên phải (3/5) từ 768 px; dưới đó xếp chồng. Ô đơn
 * thì truyền `htmlFor` để bấm nhãn là vào ô; nhiều ô (ma trận model, ngưỡng) thì bỏ trống và hàng thành `group`.
 */
export function FormRow({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
}) {
  const labelId = useId();
  const head = (
    <>
      <span className="text-sm font-medium text-foreground">{label}</span>
      {hint && <span className="text-xs text-pretty text-muted-foreground">{hint}</span>}
    </>
  );
  const grid = "grid min-w-0 gap-x-6 gap-y-2 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]";
  const control = <div className="grid min-w-0 content-start gap-3">{children}</div>;
  if (htmlFor)
    return (
      <div className={grid}>
        {/* Gợi ý nằm ngoài <label> để tên của ô chỉ là nhãn, không kéo theo cả câu giải thích. */}
        <div className="grid content-start gap-0.5">
          <label htmlFor={htmlFor} className="text-sm font-medium text-foreground">
            {label}
          </label>
          {hint && <span className="text-xs text-pretty text-muted-foreground">{hint}</span>}
        </div>
        {control}
      </div>
    );
  return (
    // biome-ignore lint/a11y/useSemanticElements: legend của fieldset không nằm được vào cột trái của lưới.
    <div role="group" aria-labelledby={labelId} className={grid}>
      <div id={labelId} className="grid content-start gap-0.5">
        {head}
      </div>
      {control}
    </div>
  );
}

/** Hàng bật/tắt: nhãn và gợi ý bên trái, công tắc bên phải ở mọi bề ngang. Bấm cả nhãn cũng bật/tắt. */
export function SwitchRow({
  label,
  hint,
  checked,
  onChange,
  disabled = false,
  children,
}: {
  label: string;
  hint?: ReactNode;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  /** Ô phụ chỉ hiện khi bật (thụt vào dưới hàng). */
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <div className="grid min-w-0 gap-3">
      <div className="flex items-start justify-between gap-4">
        <label htmlFor={id} className={cx("grid gap-0.5", disabled ? "cursor-not-allowed" : "cursor-pointer")}>
          <span className="text-sm font-medium text-foreground">{label}</span>
          {hint && <span className="text-xs text-pretty text-muted-foreground">{hint}</span>}
        </label>
        <Switch
          id={id}
          className="mt-0.5"
          checked={checked}
          onCheckedChange={onChange}
          disabled={disabled}
          aria-label={label}
        />
      </div>
      {children && <div className="grid min-w-0 gap-4 border-l-2 border-border pl-3.5">{children}</div>}
    </div>
  );
}

export interface RadioCardOption<V extends string> {
  value: V;
  title: string;
  description?: ReactNode;
  /** `destructive` cho lựa chọn rủi ro (toàn quyền): khi chọn thì viền đỏ thay vì xanh. */
  tone?: "default" | "destructive";
  disabled?: boolean;
}

/** Nhóm radio dạng thẻ cho lựa chọn cần giải thích (chế độ merge, quyền của run). Dùng input radio thật. */
export function RadioCards<V extends string>({
  name,
  label,
  value,
  onChange,
  options,
  disabled = false,
  columns = 1,
}: {
  name: string;
  label: string;
  value: V;
  onChange: (value: V) => void;
  options: readonly RadioCardOption<V>[];
  disabled?: boolean;
  columns?: 1 | 2 | 3;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cx("grid gap-2", columns === 2 && "sm:grid-cols-2", columns === 3 && "sm:grid-cols-3")}
    >
      {options.map((option) => {
        const on = value === option.value;
        const off = disabled || option.disabled;
        const danger = option.tone === "destructive";
        return (
          <label
            key={option.value}
            className={cx(
              "flex items-start gap-2.5 rounded-lg border p-3 text-sm transition-colors has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring",
              on
                ? danger
                  ? "border-destructive bg-destructive-soft"
                  : "border-primary bg-accent/40"
                : "border-border hover:bg-muted/40",
              off ? "cursor-not-allowed opacity-60" : "cursor-pointer",
            )}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={on}
              onChange={() => onChange(option.value)}
              disabled={off}
              className={cx("mt-0.5 size-4 shrink-0", danger ? "accent-destructive" : "accent-primary")}
            />
            <span className="grid gap-0.5">
              <strong className={cx("font-medium", on && danger ? "text-destructive" : "text-foreground")}>
                {option.title}
              </strong>
              {option.description && <span className="text-xs text-muted-foreground">{option.description}</span>}
            </span>
          </label>
        );
      })}
    </div>
  );
}
