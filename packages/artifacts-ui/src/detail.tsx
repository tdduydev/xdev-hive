export interface ArtifactDetailProps {
  id: string;
  /** Bỏ trống là bản mới nhất. */
  version?: number | undefined;
  onVersionChange?: ((version: number) => void) | undefined;
}

/** Trang chi tiết: vùng xem + tab Phiên bản, Liên kết, Hoạt động. T022 điền. */
export function ArtifactDetail(_props: ArtifactDetailProps) {
  return null;
}
