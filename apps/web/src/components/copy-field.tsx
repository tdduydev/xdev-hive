import { Button } from "@xdev-hive/ui/button";
import { Input } from "@xdev-hive/ui/input";
import { useEffect, useRef, useState } from "react";

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
  const input = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState<Copied>("idle");
  useEffect(() => {
    if (copied !== "done") return;
    const timer = setTimeout(() => setCopied("idle"), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const text = copied === "done" ? "Đã chép" : "Chép";

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
        <Button variant="outline" onClick={onCopy} aria-label={copyLabel ? `${text} ${copyLabel}` : undefined}>
          {text}
        </Button>
      </div>
      {copied === "failed" && (
        <small role="status" className="text-xs text-muted-foreground">
          Trình duyệt chặn chép tự động. Ô đã được chọn sẵn, bấm Ctrl+C (⌘C trên Mac) để chép.
        </small>
      )}
    </div>
  );
}
