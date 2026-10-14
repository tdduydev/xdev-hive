import { ARTIFACT_LIMITS } from "@xdev-hive/contracts";
import { useEffect } from "react";
import { useText } from "../env.tsx";
import { FramedArtifact, type FrameViewerProps } from "./frame.tsx";

/**
 * Hub biên dịch `react` khi lưu (D8): bản lỗi biên dịch không có gì để chạy, nên hiện lỗi thay khung và báo lên khung bên
 * cạnh như một lỗi trang để người xem nhờ Leader sửa.
 */
export function ReactViewer({ compileError, ...props }: FrameViewerProps & { compileError: string | null }) {
  const t = useText();
  const { onErrors } = props;
  useEffect(() => {
    if (compileError) onErrors?.([{ kind: "compile", message: compileError.slice(0, ARTIFACT_LIMITS.pageErrorChars) }]);
  }, [compileError, onErrors]);

  if (!compileError) return <FramedArtifact {...props} />;
  return (
    <div role="alert" className="flex flex-col gap-2 rounded-md bg-destructive-soft p-3 text-sm text-destructive">
      <p>{t.compileError}</p>
      <pre className="m-0 overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs">{compileError}</pre>
    </div>
  );
}
