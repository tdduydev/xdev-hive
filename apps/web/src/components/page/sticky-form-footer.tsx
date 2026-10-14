import { Button } from "@xdev-hive/ui/button";
import { CheckIcon, CircleAlertIcon } from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { type Dict, useT } from "@/lib/i18n.ts";

const text: Dict<{ save: string; saving: string; discard: string; unsaved: string; saved: string }> = {
  vi: {
    save: "Lưu thay đổi",
    saving: "Đang lưu…",
    discard: "Huỷ thay đổi",
    unsaved: "Có thay đổi chưa lưu",
    saved: "Đã lưu",
  },
  en: { save: "Save changes", saving: "Saving…", discard: "Discard", unsaved: "Unsaved changes", saved: "Saved" },
};

/**
 * Thanh lưu dính đáy form (admin-layout.md § Form): luôn thấy nút Lưu khi form dài, nói rõ còn thay đổi chưa lưu, lỗi
 * khi lưu hay đã lưu xong. Đặt làm con cuối của `<form>` trong PageBody; lề âm kéo thanh ra sát hai mép nội dung.
 * Form chứa thanh nên có `FORM_SCROLL_MARGIN` để ô đang focus không bị thanh che khi bấm Tab xuống cuối.
 */
export const FORM_SCROLL_MARGIN = "[&_:is(input,select,textarea,button)]:scroll-mb-24";

export function StickyFormFooter({
  dirty,
  saving,
  saved = false,
  error,
  onDiscard,
  saveLabel,
  savingLabel,
  discardLabel,
  savedLabel,
  dirtyLabel,
}: {
  dirty: boolean;
  saving: boolean;
  saved?: boolean;
  error?: ReactNode;
  onDiscard: () => void;
  saveLabel?: string;
  savingLabel?: string;
  discardLabel?: string;
  savedLabel?: string;
  dirtyLabel?: string;
}) {
  const t = useT(text);
  // Đóng tab hay tải lại khi còn thay đổi chưa lưu thì trình duyệt hỏi lại; đổi trang trong app không chặn để khỏi
  // kẹt người dùng, câu "Có thay đổi chưa lưu" đã nhắc ngay trên thanh.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  let status: ReactNode = null;
  if (error)
    status = (
      <p role="alert" className="flex min-w-0 items-start gap-1.5 text-sm text-destructive">
        <CircleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <span className="min-w-0 break-words">{error}</span>
      </p>
    );
  else if (saved && !dirty)
    status = (
      <p role="status" className="flex items-center gap-1.5 text-sm text-success">
        <CheckIcon aria-hidden="true" className="size-4" />
        {savedLabel ?? t.saved}
      </p>
    );
  else if (dirty)
    status = (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <span aria-hidden="true" className="size-2 rounded-full bg-warning" />
        {dirtyLabel ?? t.unsaved}
      </p>
    );
  return (
    <div className="sticky bottom-0 z-10 -mx-4 -mb-4 flex flex-wrap items-center gap-3 border-t border-border bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80 md:-mx-6 md:-mb-6 md:px-6">
      <div className="min-w-0 flex-1 basis-56">{status}</div>
      <div className="ml-auto flex gap-2">
        <Button type="button" variant="outline" onClick={onDiscard} disabled={!dirty || saving}>
          {discardLabel ?? t.discard}
        </Button>
        <Button type="submit" variant="default" disabled={!dirty || saving}>
          {saving ? (savingLabel ?? t.saving) : (saveLabel ?? t.save)}
        </Button>
      </div>
    </div>
  );
}
