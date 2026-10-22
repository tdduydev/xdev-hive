import { FramedArtifact, type FrameViewerProps } from "./frame.tsx";

/**
 * SVG chạy trong khung cách ly như html, không chèn vào DOM của trang: SVG có thể mang `<script>`, `onload` và
 * `<foreignObject>`, nên dù đã lọc cũng không an toàn bằng origin mờ + CSP của khung.
 */
export function SvgViewer(props: FrameViewerProps) {
  return <FramedArtifact {...props} />;
}
