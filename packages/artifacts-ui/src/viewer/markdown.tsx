import { Button } from "@xdev-hive/ui/button";
import { CodeBlock } from "@xdev-hive/ui/code-block";
import { Markdown } from "@xdev-hive/ui/markdown";
import { ImageIcon } from "lucide-react";
import { useState } from "react";
import { useArtifactsEnv, useText } from "../env.tsx";
import { FramedPreview } from "./frame.tsx";

/**
 * Ảnh ngoài trong Markdown do agent viết có thể là ảnh theo dõi (lộ IP, biết ai đang đọc): chỉ tải khi người xem bấm,
 * và không gửi Referer (FR-060, D20).
 */
function ExternalImage({ src, alt, title }: { src: string; alt: string; title: string | null }) {
  const t = useText();
  const [load, setLoad] = useState(false);
  if (load) return <img src={src} alt={alt} title={title ?? undefined} referrerPolicy="no-referrer" decoding="async" />;
  return (
    <span className="inline-flex flex-wrap items-center gap-2 rounded-md border border-dashed border-border px-2 py-1 text-sm">
      <ImageIcon aria-hidden className="size-4 text-muted-foreground" />
      <span>{alt || t.imageBlocked}</span>
      <Button variant="outline" size="xs" title={t.imageBlocked} onClick={() => setLoad(true)}>
        {t.loadImage}
      </Button>
    </span>
  );
}

/**
 * Markdown chỉ đọc bằng trình đọc dùng chung của web/app (cùng CSS với doc-editor): dựng phần tử React từ token, HTML
 * thô hiện thành chữ. Khối ```mermaid vào khung cách ly thay vì vẽ SVG trong trang (D20).
 */
export function MarkdownViewer({ content }: { content: string }) {
  const env = useArtifactsEnv();
  return (
    <Markdown
      content={content}
      lang={env.lang}
      renderImage={({ key, ...image }) => <ExternalImage key={key} {...image} />}
      renderCode={({ key, text, language }) =>
        language === "mermaid" ? (
          <FramedPreview
            key={key}
            type="mermaid"
            content={text}
            title="Mermaid"
            fallback={<CodeBlock code={text} language="mermaid" lang={env.lang} />}
          />
        ) : undefined
      }
    />
  );
}
