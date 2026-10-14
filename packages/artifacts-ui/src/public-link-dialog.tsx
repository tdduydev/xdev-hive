import type { ArtifactSummary } from "@xdev-hive/contracts";

export interface PublicLinkDialogProps {
  artifact: ArtifactSummary;
  /** Phiên bản chọn sẵn khi tạo link. */
  version: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Tạo (chỉ chủ), xem, thu hồi link công khai của một artifact. T023 điền. */
export function PublicLinkDialog(_props: PublicLinkDialogProps) {
  return null;
}
