import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { fakeClient, renderWithEnv, testEnv } from "../test-fixtures.tsx";
import { MarkdownViewer } from "./markdown.tsx";

const user = userEvent.setup({ delay: null });

describe("MarkdownViewer", () => {
  it("không dựng HTML thô: <script>, <img onerror>, <iframe> hiện thành chữ", () => {
    const { container } = renderWithEnv(
      <MarkdownViewer
        content={[
          "# Báo cáo",
          "",
          "<script>window.pwned = true</script>",
          "",
          'Đoạn có <img src="x" onerror="window.pwned = true"> giữa dòng.',
          "",
          '<iframe src="https://evil.test"></iframe>',
          "",
          "[link xấu](javascript:alert(1))",
        ].join("\n")}
      />,
      testEnv(fakeClient()),
    );
    expect(screen.getByRole("heading", { name: "Báo cáo" })).toBeTruthy();
    expect(container.querySelector("script, img, iframe, [onerror]")).toBeNull();
    expect(container.querySelector('a[href^="javascript"]')).toBeNull();
    expect(container.textContent).toContain("<script>window.pwned = true</script>");
    expect(container.textContent).toContain('<img src="x" onerror="window.pwned = true">');
    expect((window as { pwned?: boolean }).pwned).toBeUndefined();
  });

  it("ảnh ngoài chỉ tải khi bấm, không gửi Referer", async () => {
    const { container } = renderWithEnv(
      <MarkdownViewer content="![Sơ đồ kiến trúc](https://tracker.test/pixel.png)" />,
      testEnv(fakeClient()),
    );
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("Sơ đồ kiến trúc")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Tải ảnh" }));
    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toBe("https://tracker.test/pixel.png");
    expect(img?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(img?.getAttribute("alt")).toBe("Sơ đồ kiến trúc");
  });

  it("khối mermaid vào khung cách ly qua bản xem trước, offline thì hiện nguồn", async () => {
    const client = fakeClient();
    const source = "flowchart TD\n  A --> B";
    const content = `Trước\n\n\`\`\`mermaid\n${source}\n\`\`\`\n`;
    const view = renderWithEnv(<MarkdownViewer content={content} />, testEnv(client));
    const frame = await screen.findByTitle("Mermaid");
    expect(frame.getAttribute("src")).toBe("http://hub.test/_artifact/frame/preview");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(client.artifacts.preview.mock.calls[0]?.[0]).toEqual({ type: "mermaid", content: source, theme: "light" });
    expect(view.container.querySelector("svg.hive-mermaid-canvas, .hive-mermaid-canvas")).toBeNull();
    view.unmount();

    const offline = fakeClient();
    renderWithEnv(<MarkdownViewer content={content} />, testEnv(offline, { offline: true }));
    await waitFor(() => expect(screen.getByText(/A --> B/)).toBeTruthy());
    expect(screen.queryByTitle("Mermaid")).toBeNull();
    expect(offline.artifacts.preview).not.toHaveBeenCalled();
  });
});
