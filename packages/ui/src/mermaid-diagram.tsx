"use client";

import { cn } from "cn";
import { CodeIcon, DownloadIcon, MaximizeIcon, MinusIcon, PlusIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "./dialog.tsx";
import { describeMermaidError, type ThemeMode } from "./mermaid-render.ts";
import { type ProseLang, pageLang, proseText } from "./prose-text.ts";

const ZOOM_STEP = 0.25;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 4;

/** Theo dõi class `.dark` trên <html> (app đặt theo lựa chọn người dùng hoặc hệ điều hành) để vẽ lại sơ đồ khi đổi giao diện. */
const readMode = (): ThemeMode => (document.documentElement.classList.contains("dark") ? "dark" : "light");

function useThemeMode(): ThemeMode {
  const [mode, setMode] = useState<ThemeMode>(readMode);
  useEffect(() => {
    const observer = new MutationObserver(() => setMode(readMode()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return mode;
}

/** Lưu SVG thành file; dùng thẻ <a download> trên blob nên không cần quyền ghi file của app. */
function downloadSvg(svg: string) {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "so-do.svg";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** mermaid đặt max-width bằng cỡ tự nhiên của sơ đồ; phóng to hay xem toàn màn hình thì bỏ giới hạn đó để sơ đồ giãn theo khung. */
function Svg({ svg, zoom, fill = false }: { svg: string; zoom: number; fill?: boolean }) {
  const scaled = zoom !== 1 || fill;
  return (
    <div
      className="hive-mermaid-canvas"
      style={zoom === 1 ? undefined : { width: `${zoom * 100}%`, minWidth: `${zoom * 100}%` }}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: SVG do mermaid dựng với securityLevel strict (đã lọc HTML).
      dangerouslySetInnerHTML={{ __html: scaled ? svg.replace(/max-width:\s*[\d.]+px;?\s*/, "") : svg }}
    />
  );
}

/**
 * Sơ đồ Mermaid trong khung có viền: phóng to/thu nhỏ, xem toàn màn hình, tải SVG, xem mã nguồn. Màu lấy từ token của app
 * và vẽ lại khi đổi sáng/tối. Lỗi cú pháp hiện thông báo gọn kèm mã nguồn để sửa.
 */
export function MermaidDiagram({
  code,
  lang = pageLang(),
  debounceMs = 0,
  sourceInitiallyShown = false,
  hideSource = false,
  className,
}: {
  code: string;
  lang?: ProseLang;
  /** Trình soạn đặt ~300ms: vẽ lại mỗi phím vừa chậm vừa nhấp nháy. */
  debounceMs?: number;
  sourceInitiallyShown?: boolean;
  /** Trình soạn đã hiện mã nguồn ngay trên sơ đồ nên không cần nút xem mã. */
  hideSource?: boolean;
  className?: string;
}) {
  const t = proseText[lang];
  const id = `mmd${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const mode = useThemeMode();
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; detail: string } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [showSource, setShowSource] = useState(sourceInitiallyShown);
  const [full, setFull] = useState(false);
  const renderCount = useRef(0);

  useEffect(() => {
    let alive = true;
    const run = () => {
      // Mỗi lần vẽ một id riêng: mermaid để lại phần tử tạm theo id nếu render lỗi.
      const renderId = `${id}-${++renderCount.current}`;
      import("./mermaid-render.ts")
        .then((m) => m.renderMermaid(renderId, code, mode))
        .then(
          (out) => {
            if (!alive) return;
            setSvg(out);
            setError(null);
          },
          (e: unknown) => alive && setError(describeMermaidError(e, lang)),
        );
    };
    const h = setTimeout(run, debounceMs);
    return () => {
      alive = false;
      clearTimeout(h);
    };
  }, [id, code, mode, lang, debounceMs]);

  const tool = "hive-code-btn";
  return (
    <div className={cn("hive-mermaid", className)} data-testid="mermaid" data-mode={mode}>
      <div className="hive-code-bar">
        <span className="hive-code-lang">Mermaid</span>
        <span className="flex-1" />
        {svg && (
          <>
            <button
              type="button"
              className={tool}
              title={t.zoomOut}
              aria-label={t.zoomOut}
              disabled={zoom <= ZOOM_MIN}
              onClick={() => setZoom((z) => Math.max(ZOOM_MIN, z - ZOOM_STEP))}
            >
              <MinusIcon aria-hidden="true" />
            </button>
            <button
              type="button"
              className={cn(tool, "min-w-11 justify-center tabular-nums")}
              title={t.zoomReset}
              aria-label={t.zoomReset}
              onClick={() => setZoom(1)}
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              type="button"
              className={tool}
              title={t.zoomIn}
              aria-label={t.zoomIn}
              disabled={zoom >= ZOOM_MAX}
              onClick={() => setZoom((z) => Math.min(ZOOM_MAX, z + ZOOM_STEP))}
            >
              <PlusIcon aria-hidden="true" />
            </button>
            <button
              type="button"
              className={tool}
              title={t.fullscreen}
              aria-label={t.fullscreen}
              onClick={() => setFull(true)}
            >
              <MaximizeIcon aria-hidden="true" />
            </button>
            <button
              type="button"
              className={tool}
              title={t.download}
              aria-label={t.download}
              onClick={() => downloadSvg(svg)}
            >
              <DownloadIcon aria-hidden="true" />
            </button>
          </>
        )}
        {!hideSource && (
          <button
            type="button"
            className={tool}
            aria-pressed={showSource}
            title={showSource ? t.sourceHide : t.sourceShow}
            aria-label={showSource ? t.sourceHide : t.sourceShow}
            onClick={() => setShowSource((v) => !v)}
          >
            <CodeIcon aria-hidden="true" />
          </button>
        )}
      </div>
      <div role="img" aria-label={t.diagram} className="hive-mermaid-body">
        {error ? (
          <div role="alert" className="hive-mermaid-error">
            <p>{error.message}</p>
            {error.detail && <pre>{error.detail}</pre>}
          </div>
        ) : svg ? (
          <Svg svg={svg} zoom={zoom} />
        ) : (
          <p className="text-xs text-muted-foreground">{t.diagramLoading}</p>
        )}
      </div>
      {/* Lỗi thì luôn hiện mã nguồn: người dùng cần đối chiếu dòng báo lỗi. */}
      {(showSource || (error && !hideSource)) && <pre className="hive-mermaid-source">{code}</pre>}
      {svg && (
        <Dialog open={full} onOpenChange={setFull}>
          <DialogContent className="h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-none grid-rows-[auto_1fr] sm:max-w-none">
            <DialogTitle>{t.diagram}</DialogTitle>
            <div className="hive-mermaid-body min-h-0 overflow-auto" data-testid="mermaid-full">
              <Svg svg={svg} zoom={1} fill />
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
