import type { ArtifactAccess } from "@xdev-hive/contracts";

export interface VersionHistoryProps {
  artifactId: string;
  /** Phiên bản đang xem. */
  current: number;
  access: ArtifactAccess;
  onOpen: (version: number) => void;
}

/** Lịch sử phiên bản: danh sách, đặt tên, khôi phục. T021 điền; T020 chỉ giữ tên để `index.ts` và màn khác dùng trước. */
export function VersionHistory(_props: VersionHistoryProps) {
  return null;
}
