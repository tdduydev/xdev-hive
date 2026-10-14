// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Markdown } from "./markdown.tsx";

const mermaid = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock("./mermaid-render.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mermaid-render.ts")>()),
  renderMermaid: mermaid.render,
}));

afterEach(() => {
  cleanup();
  document.documentElement.className = "";
  mermaid.render.mockReset();
});

describe("Markdown", () => {
  it("renders headings, lists, quotes, tables and checklists", () => {
    const { container } = render(
      <Markdown
        content={[
          "# Tiêu đề",
          "",
          "Đoạn có `code` và **đậm**.",
          "",
          "- một",
          "  - lồng",
          "- hai",
          "",
          "- [x] xong",
          "- [ ] chưa",
          "",
          "> trích dẫn",
          "",
          "| Cột | Giá trị |",
          "| --- | ---: |",
          "| a | 1 |",
          "| b | 2 |",
        ].join("\n")}
      />,
    );
    expect(container.querySelector("article.hive-prose")).not.toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "Tiêu đề" })).toBeTruthy();
    expect(container.querySelector("p code")?.textContent).toBe("code");
    expect(container.querySelector("ul ul li")?.textContent).toBe("lồng");
    expect(container.querySelectorAll("li.hive-task input[type=checkbox]")).toHaveLength(2);
    expect((container.querySelector("li.hive-task input") as HTMLInputElement).checked).toBe(true);
    expect(container.querySelector("li.hive-task")?.textContent).toBe("xong");
    expect(container.querySelector("blockquote")?.textContent).toBe("trích dẫn");
    expect(container.querySelectorAll(".hive-table tbody tr")).toHaveLength(2);
    expect(container.querySelector("th:nth-child(2)")?.getAttribute("style")).toContain("right");
  });

  it("only links to web and mail addresses and opens them in a new tab", () => {
    const { container } = render(
      <Markdown content="[ok](https://example.com) [mail](mailto:a@b.vn) [bad](javascript:alert(1)) [file](file:///etc/passwd)" />,
    );
    const links = [...container.querySelectorAll("a")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["https://example.com", "mailto:a@b.vn"]);
    expect(links[0]?.getAttribute("target")).toBe("_blank");
    expect(links[0]?.getAttribute("rel")).toContain("noopener");
    expect(container.textContent).toContain("bad");
  });

  it("shows only link text when links are off", () => {
    const { container } = render(<Markdown content="[ok](https://example.com)" links="text" />);
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toBe("ok");
  });

  it("renders web images and replaces other sources with their alt text", () => {
    const { container } = render(
      <Markdown content={"![logo](https://example.com/a.png)\n\n![local](file:///tmp/x.png)"} />,
    );
    expect(container.querySelectorAll("img")).toHaveLength(1);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("https://example.com/a.png");
    expect(container.textContent).toContain("local");
  });

  it("never turns raw HTML into elements", () => {
    const { container } = render(<Markdown content={'<img src=x onerror="alert(1)">\n\n<script>alert(1)</script>'} />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<script>");
  });

  it("highlights code blocks with hljs classes, a language label and a copy button", async () => {
    const { container } = render(<Markdown content={"```ts\nconst a = 1;\n```"} />);
    await waitFor(() => expect(container.querySelector(".hljs-keyword")?.textContent).toBe("const"));
    expect(container.querySelector(".hive-code-lang")?.textContent).toBe("TypeScript");
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    fireEvent.click(screen.getByRole("button", { name: "Chép mã" }));
    expect(writeText).toHaveBeenCalledWith("const a = 1;");
    await screen.findByText("Đã chép");
  });

  it("toggles line numbers on multi-line code", async () => {
    const { container } = render(<Markdown content={"```bash\nls\npwd\n```"} />);
    expect(container.querySelectorAll(".hive-line-num")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Số dòng" }));
    expect(container.querySelectorAll(".hive-line-num")).toHaveLength(2);
  });

  it("can show line numbers from the start", () => {
    const { container } = render(<Markdown content={"```\na\nb\n```"} lineNumbers />);
    expect(container.querySelectorAll(".hive-line-num")).toHaveLength(2);
  });

  it("marks planned paragraphs for the docs screen", () => {
    const { container } = render(
      <Markdown content={"Có rồi.\n\nChức năng này dự kiến làm sau."} isPlanned={(t) => /dự kiến/.test(t)} />,
    );
    expect(container.querySelectorAll("p.hive-planned")).toHaveLength(1);
  });

  it("lets the host replace web images and chosen code blocks", () => {
    const { container } = render(
      <Markdown
        content={
          "![logo](https://example.com/a.png)\n\n![local](file:///tmp/x.png)\n\n```mermaid\nA\n```\n\n```ts\nb\n```"
        }
        renderImage={({ key, alt, src }) => <button key={key} type="button">{`${alt} ${src}`}</button>}
        renderCode={({ key, language, text }) =>
          language === "mermaid" ? <output key={key}>{text}</output> : undefined
        }
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByRole("button", { name: "logo https://example.com/a.png" })).toBeTruthy();
    expect(container.textContent).toContain("local");
    expect(container.querySelector("output")?.textContent).toBe("A");
    expect(container.querySelector(".hive-mermaid-canvas, .hive-mermaid")).toBeNull();
    expect(container.querySelector("pre")?.textContent).toContain("b");
  });
});

describe("Markdown mermaid", () => {
  it("draws mermaid fences as a framed diagram with tools and the current theme mode", async () => {
    mermaid.render.mockResolvedValue('<svg viewBox="0 0 10 10"><g/></svg>');
    document.documentElement.classList.add("dark");
    render(<Markdown content={"```mermaid\nflowchart LR\n  A --> B\n```"} />);
    await screen.findByRole("button", { name: "Phóng to" });
    expect(screen.getByTestId("mermaid").querySelector(".hive-mermaid-canvas svg")).not.toBeNull();
    expect(mermaid.render).toHaveBeenCalledWith(expect.any(String), "flowchart LR\n  A --> B", "dark");
    for (const name of ["Phóng to", "Thu nhỏ", "Xem toàn màn hình", "Tải SVG", "Xem mã nguồn"])
      expect(screen.getByRole("button", { name })).toBeTruthy();
  });

  it("redraws when the app switches between light and dark", async () => {
    mermaid.render.mockResolvedValue("<svg><g/></svg>");
    render(<Markdown content={"```mermaid\nflowchart LR\n  A --> B\n```"} />);
    await waitFor(() => expect(mermaid.render).toHaveBeenCalledWith(expect.any(String), expect.any(String), "light"));
    document.documentElement.classList.add("dark");
    await waitFor(() => expect(mermaid.render).toHaveBeenCalledWith(expect.any(String), expect.any(String), "dark"));
  });

  it("zooms and reveals the source on demand", async () => {
    mermaid.render.mockResolvedValue("<svg><g/></svg>");
    const { container } = render(<Markdown content={"```mermaid\nflowchart LR\n  A --> B\n```"} />);
    await screen.findByRole("button", { name: "Phóng to" });
    expect(container.querySelector(".hive-mermaid-source")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Phóng to" }));
    expect(screen.getByRole("button", { name: "Vừa khung" }).textContent).toBe("125%");
    fireEvent.click(screen.getByRole("button", { name: "Xem mã nguồn" }));
    expect(container.querySelector(".hive-mermaid-source")?.textContent).toBe("flowchart LR\n  A --> B");
  });

  it("explains a syntax error briefly in Vietnamese and keeps the source visible", async () => {
    mermaid.render.mockRejectedValue(new Error("Parse error on line 2:\nA -->\nExpecting 'SEMI'"));
    const { container } = render(<Markdown content={"```mermaid\nflowchart LR\n  A -->\n```"} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Sơ đồ có lỗi cú pháp ở dòng 2");
    expect(container.querySelector(".hive-mermaid-source")?.textContent).toBe("flowchart LR\n  A -->");
  });
});
