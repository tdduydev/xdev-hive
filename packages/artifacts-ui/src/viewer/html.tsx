import { FramedArtifact, type FrameViewerProps } from "./frame.tsx";

/** HTML chạy nguyên văn trong khung cách ly; bootstrap của khung báo lỗi và chiều cao lên trang cha. */
export function HtmlViewer(props: FrameViewerProps) {
  return <FramedArtifact {...props} />;
}
