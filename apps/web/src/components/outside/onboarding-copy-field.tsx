import { useEffect, useRef, useState } from "react";
import { type Dict, useT } from "../../lib/i18n.ts";
import { Button } from "../ui/button.tsx";
import { Input } from "../ui/input.tsx";

const text: Dict<{ copied: string; copy: string; failure: string }> = {
  vi: {
    copied: "Đã chép",
    copy: "Chép",
    failure: "Trình duyệt chặn chép tự động. Ô đã được chọn sẵn, bấm Ctrl+C (⌘C trên Mac) để chép.",
  },
  en: {
    copied: "Copied",
    copy: "Copy",
    failure: "Automatic copying is blocked. The field is selected; press Ctrl+C (⌘C on Mac) to copy.",
  },
};
type Copied = "idle" | "done" | "failed";

/**
 * Chép vào clipboard. navigator.clipboard chỉ có trên HTTPS hoặc localhost và có thể bị chính sách công ty chặn;
 * khi đó ô vẫn được chọn sẵn để người dùng tự bấm Ctrl+C.
 */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ô chỉ đọc kèm nút Chép, như link mời và callback URL trong mockup. Đặt trong `<Field>` để ô có nhãn. `copyLabel`
 * nói nút chép cái gì, để phân biệt khi có nhiều nút Chép (vd. "link mời cho ha@congty.vn").
 */
export function CopyField({ value, copyLabel }: { value: string; copyLabel?: string | undefined }) {
  const t = useT(text);
  const input = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState<Copied>("idle");
  useEffect(() => {
    if (copied !== "done") return;
    const timer = setTimeout(() => setCopied("idle"), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const copyTextLabel = copied === "done" ? t.copied : t.copy;

  async function onCopy() {
    const ok = await copyText(value);
    if (!ok) input.current?.select();
    setCopied(ok ? "done" : "failed");
  }

  return (
    <div className="grid gap-1">
      <div className="flex gap-2">
        <Input
          ref={input}
          readOnly
          value={value}
          spellCheck={false}
          onFocus={(e) => e.currentTarget.select()}
          className="min-w-0 flex-1 font-mono text-xs"
        />
        <Button variant="outline" onClick={onCopy} aria-label={copyLabel ? `${copyTextLabel} ${copyLabel}` : undefined}>
          {copyTextLabel}
        </Button>
      </div>
      {copied === "failed" && (
        <small role="status" className="text-xs text-muted-foreground">
          {t.failure}
        </small>
      )}
    </div>
  );
}
