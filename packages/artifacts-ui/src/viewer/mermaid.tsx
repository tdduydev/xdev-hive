import { FramedArtifact, type FrameViewerProps } from "./frame.tsx";

/**
 * Sơ đồ vẽ trong khung (mermaid `securityLevel: "strict"` qua import map), không vẽ trong trang: lỗ hổng của mermaid
 * khi đó chỉ chạm tới khung có origin mờ. Lỗi cú pháp hiện trong khung và báo lên như lỗi trang.
 */
export function MermaidViewer(props: FrameViewerProps) {
  return <FramedArtifact {...props} />;
}
