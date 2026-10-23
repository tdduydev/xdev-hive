import { FramedArtifact, type FrameViewerProps } from "./frame.tsx";

/** PDF dựng bằng pdf.js trong khung cách ly, không dùng trình xem PDF của trình duyệt (bị `sandbox` của khung chặn). */
export function PdfViewer(props: FrameViewerProps) {
  return <FramedArtifact {...props} />;
}
