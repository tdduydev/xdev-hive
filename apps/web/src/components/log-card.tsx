import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { useId, useLayoutEffect, useRef } from "react";
import { Card } from "@/components/ui/card.tsx";
import type { StreamStatus } from "@/lib/use-run-stream.ts";

const STREAM_TEXT: Record<StreamStatus, string> = {
  connecting: "Đang kết nối…",
  live: "Trực tiếp · tự cuộn",
  ended: "Run đã xong",
  error: "Mất kết nối",
};

/**
 * Log terminal. Tự cuộn xuống cuối khi có log mới, trừ khi người xem đang cuộn lên đọc phần trên. Dùng chung cho run
 * và lần triển khai; `endedText` và `emptyEndedText` để màn khác thay chữ "Run" khi cần.
 */
export function LogCard({
  log,
  status,
  onRetry,
  endedText = STREAM_TEXT.ended,
  emptyEndedText = "Run không có log.",
}: {
  log: string;
  status: StreamStatus;
  onRetry: () => void;
  endedText?: string;
  emptyEndedText?: string;
}) {
  const ref = useRef<HTMLElement>(null);
  const stick = useRef(true);
  const headingId = useId();
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current && log) el.scrollTop = el.scrollHeight;
  }, [log]);
  return (
    <Card className="overflow-hidden">
      <section aria-labelledby={headingId}>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
          <h2 id={headingId} className="text-base font-semibold text-foreground">
            Log trực tiếp
          </h2>
          <span role="status" className="text-xs text-muted-foreground">
            {status === "ended" ? endedText : STREAM_TEXT[status]}
          </span>
        </div>
        {status === "error" && (
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
            <Alert variant="destructive" className="flex-1">
              Không nhận được log trực tiếp từ hub. Kiểm tra mạng rồi thử lại.
            </Alert>
            <Button variant="outline" size="sm" onClick={onRetry}>
              Thử lại
            </Button>
          </div>
        )}
        {/* Vùng cuộn nhận focus để đọc log bằng bàn phím; có tên để trình đọc màn hình biết đang ở đâu. */}
        <section
          ref={ref}
          aria-label="Nội dung log"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: vùng cuộn cần focus để cuộn bằng bàn phím.
          tabIndex={0}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
          className="max-h-160 min-h-80 overflow-auto bg-muted px-4 py-3.5"
        >
          <pre className="font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-foreground">
            {log || (status === "ended" ? emptyEndedText : "Chưa có log.")}
          </pre>
        </section>
      </section>
    </Card>
  );
}
