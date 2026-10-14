import { type FrameMessage, MAX_FRAME_HEIGHT, parseFrameMessage } from "@xdev-hive/artifacts-runtime";
import { ARTIFACT_LIMITS, type ArtifactPageError } from "@xdev-hive/contracts";
import { Button } from "@xdev-hive/ui/button";
import { cn } from "cn";
import { RotateCcwIcon, SquareIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useText } from "./env.tsx";

/** Tin lỗi giữ lại mỗi lần nạp khung (FR-074), cũng là trần của "Nhờ Leader sửa" (FR-151). */
export const MAX_PAGE_ERRORS = ARTIFACT_LIMITS.pageErrors;

const MIN_HEIGHT = 240;

function toPageError(message: FrameMessage): ArtifactPageError | null {
  if (message.type !== "error" && message.type !== "console") return null;
  const text = message.message.trim();
  // Lỗi rỗng không giúp được Leader và hub từ chối mục rỗng ở askLeaderFix.
  if (!text) return null;
  if (message.type === "console") return { kind: "console", message: text };
  return { kind: message.kind === "compile" ? "compile" : "error", message: text };
}

export interface SandboxFrameProps {
  /** URL khung có vé của hub (`/_artifact/frame/…`) hoặc `hive-artifact://…` của app khi offline. */
  src: string;
  title: string;
  /** Danh sách lỗi của lần nạp hiện tại (≤ 20), báo lên khung bên cạnh cho "Nhờ Leader sửa". */
  onErrors?: ((errors: ArtifactPageError[]) => void) | undefined;
  className?: string | undefined;
  /** "Tải lại trang" cần vé mới (vé cũ có thể đã hết hạn): người gọi xin vé rồi đặt `src` mới. */
  onReload?: (() => void) | undefined;
}

/**
 * Nơi duy nhất tạo `iframe` cho nội dung chạy được (D16, FR-070). Không `allow-same-origin`: tài liệu khung có origin mờ
 * nên không đọc được cookie, DOM hay bộ nhớ của hub/app. Vì origin là `"null"`, tin `postMessage` được kiểm bằng
 * `event.source` thay vì chuỗi origin, rồi bằng schema; chữ lỗi chỉ hiện dạng text.
 */
export function SandboxFrame({ src, title, onErrors, className, onReload }: SandboxFrameProps) {
  const t = useText();
  const frame = useRef<HTMLIFrameElement>(null);
  const [load, setLoad] = useState(0);
  const [stopped, setStopped] = useState(false);
  const [height, setHeight] = useState(MIN_HEIGHT);
  const [errors, setErrors] = useState<ArtifactPageError[]>([]);
  const onErrorsRef = useRef(onErrors);
  onErrorsRef.current = onErrors;

  // Mỗi lần nạp (đổi URL, tải lại) bắt đầu lại danh sách lỗi và chiều cao.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `src` và `load` là tín hiệu nạp lại, không dùng trong thân.
  useEffect(() => {
    setErrors([]);
    setHeight(MIN_HEIGHT);
  }, [src, load]);

  useEffect(() => {
    onErrorsRef.current?.(errors);
  }, [errors]);

  useEffect(() => {
    if (stopped) return;
    const onMessage = (event: MessageEvent) => {
      const own = frame.current?.contentWindow;
      if (!own || event.source !== own) return;
      const message = parseFrameMessage(event.data);
      if (!message) return;
      if (message.type === "resize") {
        setHeight(Math.min(Math.max(Math.ceil(message.height), MIN_HEIGHT), MAX_FRAME_HEIGHT));
        return;
      }
      const error = toPageError(message);
      if (error) setErrors((list) => (list.length >= MAX_PAGE_ERRORS ? list : [...list, error]));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [stopped]);

  return (
    <div className={cn("flex min-w-0 flex-col gap-2", className)}>
      <p className="rounded-md bg-warning-soft px-3 py-2 text-xs text-warning">{t.notice}</p>
      {stopped ? (
        <div className="flex min-h-60 flex-col items-center justify-center gap-3 rounded-md border border-border p-6 text-center text-sm">
          <p>{t.stopped}</p>
          <Button
            variant="outline"
            onClick={() => {
              setStopped(false);
              setLoad((n) => n + 1);
              onReload?.();
            }}
          >
            <RotateCcwIcon aria-hidden />
            {t.reload}
          </Button>
        </div>
      ) : (
        <>
          <iframe
            key={`${src}#${load}`}
            ref={frame}
            src={src}
            title={title}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            allow=""
            loading="lazy"
            className="w-full rounded-md border border-border bg-background"
            style={{ height }}
          />
          <Button variant="destructive" size="sm" className="self-start" onClick={() => setStopped(true)}>
            <SquareIcon aria-hidden />
            {t.stop}
          </Button>
        </>
      )}
    </div>
  );
}
