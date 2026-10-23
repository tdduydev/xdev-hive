import { Button } from "@xdev-hive/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@xdev-hive/ui/dialog";
import { CopyIcon, EyeIcon, EyeOffIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { type Dict, useT } from "@/lib/i18n.ts";
import { secretCopy, secretReveal } from "@/lib/secrets.ts";
import { errorText } from "@/lib/tauri.ts";

/** Giá trị hiện trên màn hình bao lâu thì tự ẩn (FR-052). */
export const REVEAL_MS = 10_000;
/** Rust xoá clipboard sau chừng này; ở đây chỉ để bỏ dòng thông báo cùng lúc (src-tauri/src/secret_clipboard.rs). */
export const COPY_CLEAR_MS = 30_000;

const text: Dict<{
  reveal: string;
  hide: string;
  copy: string;
  revealAria: (name: string) => string;
  hideAria: (name: string) => string;
  copyAria: (name: string) => string;
  revealTitle: (name: string) => string;
  revealLead: string;
  copyTitle: (name: string) => string;
  copyLead: string;
  revealConfirm: string;
  copyConfirm: string;
  working: string;
  cancel: string;
  hidesIn: string;
  copied: string;
  value: string;
}> = {
  vi: {
    reveal: "Hiện",
    hide: "Ẩn",
    copy: "Sao chép",
    revealAria: (name) => `Hiện giá trị của ${name}`,
    hideAria: (name) => `Ẩn giá trị của ${name}`,
    copyAria: (name) => `Sao chép giá trị của ${name}`,
    revealTitle: (name) => `Hiện giá trị của ${name}?`,
    revealLead:
      "Giá trị hiện ngay trên màn hình trong 10 giây rồi tự ẩn; ai nhìn màn hình lúc đó cũng thấy. Lần xem được ghi vào nhật ký (ghi tên, không ghi giá trị).",
    copyTitle: (name) => `Sao chép giá trị của ${name}?`,
    copyLead:
      "Giá trị vào clipboard và bị xoá sau 30 giây; app khác đọc được clipboard trong lúc đó. Lần sao chép được ghi vào nhật ký (ghi tên, không ghi giá trị).",
    revealConfirm: "Hiện giá trị",
    copyConfirm: "Sao chép giá trị",
    working: "Đang lấy…",
    cancel: "Huỷ",
    hidesIn: "Tự ẩn sau 10 giây.",
    copied: "Đã sao chép. Clipboard tự xoá sau 30 giây.",
    value: "Giá trị",
  },
  en: {
    reveal: "Show",
    hide: "Hide",
    copy: "Copy",
    revealAria: (name) => `Show the value of ${name}`,
    hideAria: (name) => `Hide the value of ${name}`,
    copyAria: (name) => `Copy the value of ${name}`,
    revealTitle: (name) => `Show the value of ${name}?`,
    revealLead:
      "The value appears on screen for 10 seconds, then hides itself; anyone looking at the screen can read it. The view is logged (the name, never the value).",
    copyTitle: (name) => `Copy the value of ${name}?`,
    copyLead:
      "The value goes to the clipboard and is cleared after 30 seconds; other apps can read the clipboard until then. The copy is logged (the name, never the value).",
    revealConfirm: "Show value",
    copyConfirm: "Copy value",
    working: "Fetching…",
    cancel: "Cancel",
    hidesIn: "Hides itself after 10 seconds.",
    copied: "Copied. The clipboard clears itself after 30 seconds.",
    value: "Value",
  },
};

type Ask = "reveal" | "copy";

/**
 * Hiện và Sao chép giá trị của một bí mật (FR-052). Giá trị chỉ nằm trong state của dòng này, không vào query cache hay
 * chỗ nào khác, và biến mất khi hết 10 giây hay khi rời màn (unmount). Sao chép đi thẳng từ Rust vào clipboard nên giá trị
 * không qua giao diện.
 */
export function SecretValueActions({ name, disabled }: { name: string; disabled: boolean }) {
  const t = useT(text);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [value, setValue] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Dọn ở effect để cả hết giờ lẫn rời màn đều xoá giá trị.
  useEffect(() => {
    if (value === null) return;
    const timer = setTimeout(() => setValue(null), REVEAL_MS);
    return () => clearTimeout(timer);
  }, [value]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPY_CLEAR_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  function close() {
    if (busy) return;
    setAsk(null);
    setError(null);
  }

  async function confirm(kind: Ask) {
    setBusy(true);
    setError(null);
    try {
      if (kind === "reveal") setValue(await secretReveal(name));
      else {
        await secretCopy(name);
        setCopied(true);
      }
      setAsk(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-w-0 flex-col items-end gap-1">
      <div className="flex flex-wrap justify-end gap-1">
        {value === null ? (
          <Button
            variant="outline"
            size="sm"
            disabled={disabled}
            aria-label={t.revealAria(name)}
            onClick={() => setAsk("reveal")}
          >
            <EyeIcon aria-hidden="true" />
            {t.reveal}
          </Button>
        ) : (
          <Button variant="outline" size="sm" aria-label={t.hideAria(name)} onClick={() => setValue(null)}>
            <EyeOffIcon aria-hidden="true" />
            {t.hide}
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          aria-label={t.copyAria(name)}
          onClick={() => setAsk("copy")}
        >
          <CopyIcon aria-hidden="true" />
          {t.copy}
        </Button>
      </div>
      {value !== null && (
        <section aria-label={t.value} className="flex max-w-full min-w-0 flex-col items-end gap-0.5">
          <code translate="no" className="max-w-full rounded-md bg-muted px-2 py-1 font-mono text-xs break-all">
            {value}
          </code>
          <span className="text-xs text-muted-foreground">{t.hidesIn}</span>
        </section>
      )}
      {copied && (
        <p role="status" className="text-xs text-muted-foreground">
          {t.copied}
        </p>
      )}
      {error && ask === null && (
        <p role="alert" className="text-xs break-words text-destructive">
          {error}
        </p>
      )}

      <Dialog open={ask !== null} onOpenChange={(o) => !o && close()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{ask === "copy" ? t.copyTitle(name) : t.revealTitle(name)}</DialogTitle>
            <DialogDescription>{ask === "copy" ? t.copyLead : t.revealLead}</DialogDescription>
          </DialogHeader>
          {error && (
            <p role="alert" className="rounded-lg bg-destructive-soft px-3 py-2 text-sm break-words text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            {/* Huỷ được focus trước: Enter nhầm không làm lộ giá trị. */}
            <Button variant="outline" autoFocus disabled={busy} onClick={close}>
              {t.cancel}
            </Button>
            <Button disabled={busy} onClick={() => ask && void confirm(ask)}>
              {busy ? t.working : ask === "copy" ? t.copyConfirm : t.revealConfirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
