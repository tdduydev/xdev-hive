import type { ArtifactPageError, ArtifactSummary, ArtifactVersion } from "@xdev-hive/contracts";
import { useText } from "../env.tsx";
import { CodeViewer } from "./code.tsx";
import { HtmlViewer } from "./html.tsx";
import { MarkdownViewer } from "./markdown.tsx";
import { MermaidViewer } from "./mermaid.tsx";
import { ReactViewer } from "./react.tsx";

export interface ArtifactViewerProps {
  artifact: Pick<ArtifactSummary, "id" | "title" | "type" | "language">;
  version: Pick<ArtifactVersion, "version" | "content" | "compileError">;
  /** Lỗi trang của lần nạp hiện tại (khung báo hoặc lỗi biên dịch), cho "Nhờ Leader sửa". */
  onErrors?: ((errors: ArtifactPageError[]) => void) | undefined;
}

/** Trình xem theo loại (FR-060). Loại chưa có trình xem (sau MVP) hiện nguồn để vẫn đọc được. */
export function ArtifactViewer({ artifact, version, onErrors }: ArtifactViewerProps) {
  const t = useText();
  if (version.content === null)
    return <p className="rounded-md bg-muted p-3 text-sm text-muted-foreground">{t.tombstoned}</p>;
  const frame = { artifactId: artifact.id, version: version.version, title: artifact.title, onErrors };
  switch (artifact.type) {
    case "markdown":
      return <MarkdownViewer content={version.content} />;
    case "code":
      return <CodeViewer content={version.content} language={artifact.language} />;
    case "html":
      return <HtmlViewer {...frame} />;
    case "mermaid":
      return <MermaidViewer {...frame} />;
    case "react":
      return <ReactViewer {...frame} compileError={version.compileError} />;
    default:
      return (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">{t.unsupported}</p>
          <CodeViewer content={version.content} language={null} />
        </div>
      );
  }
}
