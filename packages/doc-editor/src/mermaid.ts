type Mermaid = typeof import("mermaid")["default"];

let loading: Promise<Mermaid> | null = null;

/**
 * Vẽ sơ đồ Mermaid thành SVG. Thư viện nặng nên chỉ tải khi tài liệu có khối mermaid; `securityLevel: strict` để
 * mermaid tự lọc HTML và tắt sự kiện click trong sơ đồ (nội dung là chữ của người dùng).
 */
export async function renderMermaid(id: string, code: string): Promise<string> {
  loading ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "neutral" });
    return mermaid;
  });
  const mermaid = await loading;
  // Kiểm cú pháp trước: render lỗi để lại khung báo lỗi trong <body>.
  await mermaid.parse(code);
  const { svg } = await mermaid.render(id, code);
  return svg;
}
