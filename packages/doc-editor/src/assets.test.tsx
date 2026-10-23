// @vitest-environment jsdom
import type { Editor } from "@tiptap/core";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type DocEditorEnv, DocEditorProvider, type DocLinkTarget } from "./env.tsx";
import { EditorSurface, EditorToolbar, useMarkdownEditor } from "./markdown-editor.tsx";
import { isRelativeHref, markdownPath, nameClipboardImage, pastedFiles } from "./paste.ts";

const KEY = "project/pay/huong-dan";

let root: Root | null = null;
let host: HTMLElement | null = null;
let editor: Editor | null = null;
let markdown = "";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom không dựng bố cục; ProseMirror đo vị trí con trỏ khi focus.
  const noRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
  Range.prototype.getClientRects ??= noRects;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
  Element.prototype.getClientRects ??= noRects;
  document.elementFromPoint ??= () => null;
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = editor = null;
});

function Harness({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial);
  const h = useMarkdownEditor({
    value,
    onChange: (md) => {
      markdown = md;
      setValue(md);
    },
    editable: true,
    lang: "vi",
    label: "Soạn",
    docKey: KEY,
  });
  editor = h.editor;
  return (
    <>
      <EditorToolbar h={h} />
      <EditorSurface h={h} />
    </>
  );
}

function env(over: Partial<DocEditorEnv> = {}): DocEditorEnv {
  return {
    api: {} as DocEditorEnv["api"],
    lang: "vi",
    errorMessage: (e) => (e instanceof Error ? e.message : String(e)),
    link: ({ to, children }) => (
      <a href="#hive" data-testid="hive-link" data-to={JSON.stringify(to)}>
        {children}
      </a>
    ),
    ...over,
  };
}

async function mount(initial: string, e: DocEditorEnv) {
  markdown = initial;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <DocEditorProvider env={e}>
        <Harness initial={initial} />
      </DocEditorProvider>,
    );
  });
  return host;
}

const png = (name = "shot.png") => new File([new Uint8Array([137, 80, 78, 71])], name, { type: "image/png" });
/** ProseMirror tự thêm một `img.ProseMirror-separator` sau ảnh trong dòng. */
const IMG = "img:not(.ProseMirror-separator)";
const q = (sel: string) => host?.querySelector(sel) ?? null;

async function choose(input: Element | null, files: File[]) {
  Object.defineProperty(input, "files", { value: files, configurable: true });
  await act(async () => {
    input?.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("nút tải lên", () => {
  it("không có uploadAsset thì ẩn nút chèn ảnh và đính kèm", async () => {
    await mount("Xin chào\n", env());
    expect(q('[aria-label="Chèn ảnh"]')).toBeNull();
    expect(q('[aria-label="Đính kèm file"]')).toBeNull();
  });

  it("chọn ảnh thì tải lên rồi chèn markdown đường dẫn tương đối", async () => {
    const uploadAsset = vi.fn().mockResolvedValue({ relativePath: "assets/shot.png" });
    await mount("Xin chào\n", env({ uploadAsset }));
    await choose(q('[data-testid="insert-image-input"]'), [png()]);
    expect(uploadAsset).toHaveBeenCalledWith(KEY, expect.objectContaining({ name: "shot.png" }));
    expect(markdown).toContain("![shot](assets/shot.png)");
    expect(markdown).toContain("Xin chào");
  });

  it("file không phải ảnh thành link tới file, đường dẫn có khoảng trắng được mã hoá", async () => {
    const uploadAsset = vi.fn().mockResolvedValue({ relativePath: "files/báo cáo (1).pdf" });
    await mount("", env({ uploadAsset }));
    const pdf = new File(["%PDF-1.7"], "báo cáo (1).pdf", { type: "application/pdf" });
    await choose(q('[data-testid="attach-file-input"]'), [pdf]);
    expect(markdown).toContain("[báo cáo (1).pdf](files/báo%20cáo%20%281%29.pdf)");
  });

  it("tải lên lỗi thì báo bằng tiếng Việt và không chèn gì", async () => {
    const uploadAsset = vi.fn().mockRejectedValue(new Error("File quá lớn."));
    await mount("Giữ nguyên\n", env({ uploadAsset }));
    await choose(q('[data-testid="insert-image-input"]'), [png()]);
    expect(q('[role="alert"]')?.textContent).toContain("Không tải lên được shot.png: File quá lớn.");
    expect(markdown).toBe("Giữ nguyên\n");
    await act(async () => (q('[role="alert"] button') as HTMLElement).click());
    expect(q('[role="alert"]')).toBeNull();
  });

  it("dán ảnh chụp màn hình (clipboard không có chữ) thì tải lên với tên theo giờ", async () => {
    const uploadAsset = vi.fn().mockResolvedValue({ relativePath: "assets/image.png" });
    await mount("Xin chào\n", env({ uploadAsset }));
    const event = Object.assign(new Event("paste"), {
      clipboardData: { files: [png("image.png")], items: [], getData: () => "" },
    });
    let handled = false;
    await act(async () => {
      handled = !!editor?.view.someProp("handlePaste", (f) => f(editor?.view as never, event as never, null as never));
    });
    expect(handled).toBe(true);
    expect(uploadAsset.mock.calls[0]?.[1].name).toMatch(/^image-\d{8}-\d{6}\.png$/);
  });

  it("dán có cả chữ lẫn ảnh (bảng tính) thì giữ chữ, không tải lên", async () => {
    const uploadAsset = vi.fn();
    await mount("Xin chào\n", env({ uploadAsset }));
    const event = Object.assign(new Event("paste"), {
      clipboardData: {
        files: [png("image.png")],
        items: [],
        getData: (t: string) => (t === "text/plain" ? "A\tB" : ""),
      },
    });
    await act(async () => {
      editor?.view.someProp("handlePaste", (f) => f(editor?.view as never, event as never, null as never));
    });
    expect(uploadAsset).not.toHaveBeenCalled();
  });

  it("thả file vào trình soạn thì tải lên", async () => {
    const uploadAsset = vi.fn().mockResolvedValue({ relativePath: "assets/a.png" });
    await mount("Xin chào\n", env({ uploadAsset }));
    const event = Object.assign(new Event("drop", { cancelable: true }), {
      dataTransfer: { files: [png("a.png")], items: [] },
      clientX: 0,
      clientY: 0,
    });
    let handled = false;
    await act(async () => {
      handled = !!editor?.view.someProp("handleDrop", (f) =>
        f(editor?.view as never, event as never, null as never, false),
      );
    });
    expect(handled).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(uploadAsset).toHaveBeenCalledOnce();
    expect(markdown).toContain("![a](assets/a.png)");
  });
});

describe("ảnh và link tương đối", () => {
  it("ảnh tương đối hiện qua resolveLink nhưng tài liệu vẫn giữ đường dẫn gốc", async () => {
    const resolveLink = vi.fn(
      async (): Promise<DocLinkTarget> => ({ kind: "asset", url: "/api/v1/docs/assets/abc?doc=x" }),
    );
    await mount("![Sơ đồ](assets/so-do.png)\n", env({ resolveLink }));
    expect(resolveLink).toHaveBeenCalledWith(KEY, "assets/so-do.png");
    expect(q(IMG)?.getAttribute("src")).toBe("/api/v1/docs/assets/abc?doc=x");
    expect(markdown).toBe("![Sơ đồ](assets/so-do.png)\n");
  });

  it("không có resolveLink hoặc đích không an toàn thì hiện chỗ giữ chỗ, không tạo thẻ img", async () => {
    await mount("![Sơ đồ](assets/so-do.png)\n", env());
    expect(q(IMG)).toBeNull();
    expect(q('[role="img"]')?.textContent).toContain("Chưa hiện được ảnh");
  });

  it("đích javascript: không bao giờ thành src của ảnh", async () => {
    const resolveLink = async (): Promise<DocLinkTarget> => ({ kind: "external", url: "javascript:alert(1)" });
    await mount("![x](a.png)\n", env({ resolveLink }));
    expect(q(IMG)).toBeNull();
  });

  it("resolveLink trả data: (desktop, CSP không cho blob:) thì ảnh hiện, còn data: ghi thẳng trong Markdown thì không", async () => {
    const data = "data:image/png;base64,iVBORw0KGgo=";
    const resolveLink = async (): Promise<DocLinkTarget> => ({ kind: "asset", url: data });
    await mount("![Sơ đồ](assets/so-do.png)\n", env({ resolveLink }));
    expect(q(IMG)?.getAttribute("src")).toBe(data);
    expect(markdown).toBe("![Sơ đồ](assets/so-do.png)\n");
    await mount(`![x](${data})\n`, env({ resolveLink: vi.fn() }));
    expect(q(IMG)).toBeNull();
  });

  it("ảnh http(s) hiện thẳng, không hỏi app chủ", async () => {
    const resolveLink = vi.fn();
    await mount("![Logo](https://acme.vn/logo.png)\n", env({ resolveLink }));
    expect(q(IMG)?.getAttribute("src")).toBe("https://acme.vn/logo.png");
    expect(resolveLink).not.toHaveBeenCalled();
  });

  async function clickLink(href: string) {
    const a = q("a") as HTMLAnchorElement;
    const event = Object.assign(new MouseEvent("click", { bubbles: true, cancelable: true }), {});
    Object.defineProperty(event, "target", { value: a });
    let handled = false;
    await act(async () => {
      handled = !!editor?.view.someProp("handleClick", (f) => f(editor?.view as never, 1, event as never));
    });
    return { event, handled, href };
  }

  it("bấm link tới tài liệu thì mở bằng env.link", async () => {
    const resolveLink = vi.fn(async (): Promise<DocLinkTarget> => ({ kind: "doc", key: "project/pay/khac" }));
    await mount("[Tài liệu khác](./khac.md)\n", env({ resolveLink }));
    const { event } = await clickLink("./khac.md");
    expect(event.defaultPrevented).toBe(true);
    expect(resolveLink).toHaveBeenCalledWith(KEY, "./khac.md");
    const open = q('[data-testid="hive-link"]');
    expect(open?.getAttribute("data-to")).toBe(JSON.stringify({ kind: "doc", key: "project/pay/khac" }));
    expect(open?.textContent).toBe("Mở tài liệu project/pay/khac");
  });

  it("bấm link tới file đính kèm thì mở tab mới tới địa chỉ tải về", async () => {
    const resolveLink = async (): Promise<DocLinkTarget> => ({ kind: "asset", url: "/api/v1/docs/assets/z" });
    await mount("[Báo cáo](files/bao-cao.pdf)\n", env({ resolveLink }));
    await clickLink("files/bao-cao.pdf");
    const open = q('[role="status"] a') as HTMLAnchorElement;
    expect(open.getAttribute("href")).toBe("/api/v1/docs/assets/z");
    expect(open.target).toBe("_blank");
    expect(open.rel).toContain("noopener");
  });

  it("link tuyệt đối không bị chặn và không hỏi app chủ", async () => {
    const resolveLink = vi.fn();
    await mount("[Acme](https://acme.vn)\n", env({ resolveLink }));
    const { event, handled } = await clickLink("https://acme.vn");
    expect(handled).toBeFalsy();
    expect(event.defaultPrevented).toBe(false);
    expect(resolveLink).not.toHaveBeenCalled();
  });
});

describe("trợ giúp dán và đường dẫn", () => {
  it("nhận ra địa chỉ tương đối", () => {
    for (const href of ["a.md", "./a.md", "../x/a.md#m", "assets/a b.png"]) expect(isRelativeHref(href)).toBe(true);
    for (const href of ["https://a.vn", "mailto:a@b.vn", "/abs/a.md", "//cdn/a.png", "#muc", ""])
      expect(isRelativeHref(href)).toBe(false);
  });

  it("chỉ mã hoá ký tự làm hỏng Markdown", () => {
    expect(markdownPath("assets/ảnh chụp (2).png")).toBe("assets/ảnh%20chụp%20%282%29.png");
  });

  it("đặt tên ảnh dán theo thời gian; ảnh có tên thật giữ nguyên", () => {
    const at = new Date(2026, 9, 15, 8, 5, 9);
    expect(nameClipboardImage(png("image.png"), at).name).toBe("image-20261015-080509.png");
    expect(nameClipboardImage(new File([""], "x.jpg", { type: "image/jpeg" }), at).name).toBe("x.jpg");
    expect(nameClipboardImage(new File([""], "image.jpeg", { type: "image/jpeg" }), at).name).toBe(
      "image-20261015-080509.jpg",
    );
  });

  it("pastedFiles bỏ qua clipboard có chữ", () => {
    const data = (text: string) => ({ files: [png()], items: [], getData: () => text }) as unknown as DataTransfer;
    expect(pastedFiles(data(""))).toHaveLength(1);
    expect(pastedFiles(data("chữ"))).toHaveLength(0);
  });
});
