import type { ArtifactRef } from "./env.tsx";

export interface ArtifactLibraryProps {
  /** Mở một artifact; bỏ trống thì thẻ dẫn tới trang chi tiết qua `env.link`. */
  onOpen?: ((artifact: ArtifactRef) => void) | undefined;
}

/** Thư viện: lọc phạm vi/loại/nguồn/dự án, tìm, con trỏ, thùng rác. T022 điền. */
export function ArtifactLibrary(_props: ArtifactLibraryProps) {
  return null;
}
