import type { ArtifactSummary } from "@xdev-hive/contracts";

export interface ShareDialogProps {
  artifact: ArtifactSummary;
  /** Phiên bản đang xem; cũ hơn bản mới nhất thì hộp cảnh báo người được chia sẻ thấy bản mới nhất. */
  version: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Đổi phạm vi `private`/`project`. T021 điền. */
export function ShareDialog(_props: ShareDialogProps) {
  return null;
}
