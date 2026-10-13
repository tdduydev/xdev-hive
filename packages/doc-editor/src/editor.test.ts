// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { docExtensions, MarkdownCodec } from "./markdown.ts";
import { insertTemplate } from "./markdown-editor.tsx";
import { cleanPastedHtml, looksLikeMarkdown } from "./paste.ts";

let editor: Editor | null = null;

beforeAll(() => {
  // jsdom không dựng bố cục; ProseMirror đo vị trí con trỏ khi focus.
  const noRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
  Range.prototype.getClientRects ??= noRects;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
  Element.prototype.getClientRects ??= noRects;
  document.elementFromPoint ??= () => null;
});

afterEach(() => {
  editor?.destroy();
  editor = null;
});

/** Trình soạn không giao diện trên cùng schema, nạp Markdown như useMarkdownEditor. */
function open(markdown: string) {
  const codec = new MarkdownCodec();
  const { doc, groups } = codec.parse(markdown);
  editor = new Editor({ element: document.createElement("div"), extensions: docExtensions(), content: doc });
  codec.remember(editor.state.doc, groups);
  // Xuất như trình soạn với file không có dòng trống cuối.
  const md = () => codec.serialize((editor as Editor).state.doc).replace(/\n$/, "");
  return { editor, codec, md };
}

describe("lệnh chèn khối", () => {
  it("yêu cầu lấy mã kế tiếp theo cả tài liệu và xuất đúng cú pháp `- R-n: `", () => {
    const { editor, codec, md } = open("# Spec\n\n- R-1: Có sẵn.\n- R-4: Có sẵn.\n\nĐoạn cuối.");
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    insertTemplate(editor, "requirement", codec);
    editor.commands.insertContent("Mới thêm.");
    expect(md()).toContain("- R-5: Mới thêm.");
    // Khối không đụng tới giữ đúng chữ gốc.
    expect(md().startsWith("# Spec\n\n- R-1: Có sẵn.\n- R-4: Có sẵn.")).toBe(true);
  });

  it("đang ở trong mục danh sách thì chỉ chèn mã, không lồng danh sách mới", () => {
    const { editor, codec, md } = open("- Mục đầu");
    editor.commands.setTextSelection(3);
    insertTemplate(editor, "requirement", codec);
    expect(md()).toBe("- R-1: Mục đầu");
  });

  it("bảng, ghi chú, mermaid xuất ra Markdown nạp lại được; khối chèn khi đang ở trong bảng nằm sau bảng", () => {
    const { editor, codec, md } = open("Mở đầu.");
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    for (const kind of ["table", "callout", "mermaid"] as const) insertTemplate(editor, kind, codec);
    const out = md();
    expect(out).toMatch(/\|.*\|\n\| ?-+/);
    expect(out).toMatch(/> \[!note\]/i);
    expect(out).toContain("```mermaid");
    // Nạp lại bản vừa xuất: không khối nào phải giữ dạng chữ thô.
    const again = new MarkdownCodec().parse(out).doc.content?.map((n) => n.type);
    expect(again).not.toContain("rawMarkdown");
    // Mermaid chèn lúc con trỏ còn trong ghi chú thì nằm trong ghi chú, như GitHub hiển thị `> ```mermaid`.
    expect(out).toContain("> ```mermaid");
    expect(again).toEqual(["paragraph", "table", "callout"]);

    const list = open("Việc cần làm");
    list.editor.commands.setTextSelection(2);
    insertTemplate(list.editor, "checklist", list.codec);
    expect(list.md()).toBe("- [ ] Việc cần làm");
  });

  it("đổi kiểu khối bằng lệnh tiêu đề", () => {
    const { editor, codec, md } = open("Tổng quan");
    editor.commands.setTextSelection(2);
    insertTemplate(editor, "h2", codec);
    expect(md()).toBe("## Tổng quan");
  });
});

/** Dán HTML như ProseMirror: qua bộ lọc của trình soạn (transformPastedHTML) rồi parse theo schema. */
function paste(html: string) {
  const { editor, md } = open("");
  editor.commands.setContent(cleanPastedHtml(html));
  return md();
}

describe("dán từ Word, Google Docs", () => {
  it("Word: đoạn MsoListParagraph thành danh sách thật, bỏ thẻ Office", () => {
    const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office"><head><style>p.MsoNormal{margin:0}</style></head><body>
<p class="MsoNormal"><b>Mục tiêu</b><o:p></o:p></p>
<p class="MsoListParagraphCxSpFirst" style="mso-list:l0 level1 lfo1"><span style="mso-list:Ignore">·<span>&nbsp;&nbsp;</span></span>Hoàn tiền một phần<o:p></o:p></p>
<p class="MsoListParagraphCxSpLast" style="mso-list:l0 level2 lfo1"><span style="mso-list:Ignore">o<span>&nbsp;</span></span>Không vượt số gốc<o:p></o:p></p>
<p class="MsoListParagraph" style="mso-list:l1 level1 lfo2"><span style="mso-list:Ignore">1.<span>&nbsp;</span></span>Bước một<o:p></o:p></p>
</body></html>`;
    const md = paste(html);
    expect(md).toContain("**Mục tiêu**");
    expect(md).toMatch(/^- Hoàn tiền một phần\n {2}- Không vượt số gốc$/m);
    expect(md).toMatch(/^1\. Bước một$/m);
    expect(md).not.toMatch(/·|mso|o:p/i);
  });

  it("Google Docs: bỏ thẻ <b> bọc ngoài, giữ đậm, nghiêng, danh sách và liên kết", () => {
    const html = `<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1"><h2 dir="ltr"><span style="font-weight:400">Phạm vi</span></h2>
<p dir="ltr"><span style="font-weight:700">Đậm</span><span> và </span><span style="font-style:italic">nghiêng</span>, xem <a href="https://acme.vn/spec"><span>spec</span></a>.</p>
<ul><li dir="ltr"><p dir="ltr"><span>Một</span></p></li><li dir="ltr"><p dir="ltr"><span>Hai</span></p></li></ul></b>`;
    expect(paste(html)).toBe("## Phạm vi\n\n**Đậm** và *nghiêng*, xem [spec](https://acme.vn/spec).\n\n- Một\n- Hai");
  });

  it("chữ thuần trông như Markdown thì nạp thành khối", () => {
    expect(looksLikeMarkdown("## Tiêu đề\n\n- một")).toBe(true);
    expect(looksLikeMarkdown("Câu thường, không ký hiệu.")).toBe(false);
  });
});
