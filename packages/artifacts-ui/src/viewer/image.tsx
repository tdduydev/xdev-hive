import { FramedArtifact, type FrameViewerProps } from "./frame.tsx";

/**
 * Ảnh cũng đi qua khung cách ly: link công khai và trang này dùng chung một đường tải, và `<img>` trỏ thẳng vào hub sẽ
 * phải mang vé trong URL của trang chính.
 */
export function ImageViewer(props: FrameViewerProps) {
  return <FramedArtifact {...props} />;
}
