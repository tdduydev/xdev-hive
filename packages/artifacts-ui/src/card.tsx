import type { ArtifactType } from "@xdev-hive/contracts";
import { Button } from "@xdev-hive/ui/button";
import { cn } from "cn";
import {
  AtomIcon,
  BracesIcon,
  CodeIcon,
  FileIcon,
  FileTextIcon,
  GlobeIcon,
  ImageIcon,
  type LucideIcon,
  TableIcon,
  WorkflowIcon,
} from "lucide-react";
import { type ArtifactRef, useText } from "./env.tsx";

export const ARTIFACT_TYPE_ICON: Record<ArtifactType, LucideIcon> = {
  markdown: FileTextIcon,
  code: CodeIcon,
  html: GlobeIcon,
  react: AtomIcon,
  svg: ImageIcon,
  mermaid: WorkflowIcon,
  csv: TableIcon,
  json: BracesIcon,
  image: ImageIcon,
  pdf: FileIcon,
};

export interface ArtifactCardProps {
  /** `null`: artifact đã xoá hoặc người xem không còn đọc được (tin nhắn thẻ vẫn còn trong chat). */
  artifact: ArtifactRef | null;
  onOpen?: ((artifact: ArtifactRef) => void) | undefined;
  /** Đang mở trong khung bên cạnh. */
  selected?: boolean | undefined;
  className?: string | undefined;
}

/** Thẻ tham chiếu thay cho nội dung artifact trong tin nhắn (D10, FR-041). */
export function ArtifactCard({ artifact, onOpen, selected = false, className }: ArtifactCardProps) {
  const t = useText();
  if (!artifact)
    return (
      <div className={cn("rounded-lg border border-dashed border-border p-3 text-sm text-muted-foreground", className)}>
        {t.unavailable}
      </div>
    );
  const Icon = ARTIFACT_TYPE_ICON[artifact.type];
  return (
    <article
      aria-label={t.cardLabel(artifact.title, artifact.version)}
      className={cn(
        "flex min-w-0 items-center gap-3 rounded-lg border border-border bg-card p-3",
        selected && "border-primary",
        className,
      )}
    >
      <Icon aria-hidden className="size-5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium" title={artifact.title}>
          {artifact.title}
        </p>
        <p className="font-mono text-xs text-muted-foreground">
          {artifact.type} · {t.version(artifact.version)}
        </p>
      </div>
      {onOpen && (
        <Button variant="outline" size="sm" onClick={() => onOpen(artifact)}>
          {t.open}
        </Button>
      )}
    </article>
  );
}
