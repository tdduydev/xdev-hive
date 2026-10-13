export type ProseLang = "vi" | "en";

/** Cả hai app đặt `<html lang>` theo ngôn ngữ đã chọn: component dùng chung đọc từ đó thay vì bắt mọi chỗ gọi truyền lang. */
export function pageLang(): ProseLang {
  return typeof document !== "undefined" && document.documentElement.lang.startsWith("en") ? "en" : "vi";
}

/** Chữ của khối code, sơ đồ và tài liệu dùng chung: app chủ truyền `lang`, mặc định tiếng Việt như phần còn lại. */
export const proseText = {
  vi: {
    copy: "Chép",
    copied: "Đã chép",
    copyCode: "Chép mã",
    lineNumbers: "Số dòng",
    diagram: "Sơ đồ",
    diagramLoading: "Đang vẽ sơ đồ…",
    zoomIn: "Phóng to",
    zoomOut: "Thu nhỏ",
    zoomReset: "Vừa khung",
    fullscreen: "Xem toàn màn hình",
    close: "Đóng",
    download: "Tải SVG",
    source: "Mã nguồn",
    sourceShow: "Xem mã nguồn",
    sourceHide: "Ẩn mã nguồn",
    syntaxError: "Sơ đồ có lỗi cú pháp",
    syntaxErrorAt: (line: number) => `Sơ đồ có lỗi cú pháp ở dòng ${line}`,
    image: "Ảnh",
  },
  en: {
    copy: "Copy",
    copied: "Copied",
    copyCode: "Copy code",
    lineNumbers: "Line numbers",
    diagram: "Diagram",
    diagramLoading: "Drawing the diagram…",
    zoomIn: "Zoom in",
    zoomOut: "Zoom out",
    zoomReset: "Fit to frame",
    fullscreen: "View full screen",
    close: "Close",
    download: "Download SVG",
    source: "Source",
    sourceShow: "Show source",
    sourceHide: "Hide source",
    syntaxError: "The diagram has a syntax error",
    syntaxErrorAt: (line: number) => `The diagram has a syntax error on line ${line}`,
    image: "Image",
  },
} as const;
