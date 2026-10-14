import type { ArtifactSummary, ArtifactVersion, ArtifactWriteResult } from "@xdev-hive/contracts";

export interface ArtifactEditorProps {
  artifact: ArtifactSummary;
  /** Bản gốc của lần sửa (`baseVersion`). */
  version: ArtifactVersion;
  onSaved: (result: ArtifactWriteResult) => void;
  onCancel: () => void;
}

/** Ô soạn chữ tối thiểu, xem trước qua `preview`, xung đột "Xem khác biệt rồi gộp". T021 điền. */
export function ArtifactEditor(_props: ArtifactEditorProps) {
  return null;
}
