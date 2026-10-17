import { getSchema, type JSONContent } from "@tiptap/core";
import { Node as PMNode } from "@tiptap/pm/model";
import { normalizeDoc } from "@xdev-hive/contracts";
import { Marked } from "marked";
import { describe, expect, it } from "vitest";
import { type BlockTemplate, blockTemplate } from "./blocks.ts";
import { docExtensions, escapeMarkdownText, MarkdownCodec } from "./markdown.ts";

const schema = getSchema(docExtensions());
const marked = new Marked({ gfm: true });
/** "Nội dung có nghĩa": HTML marked dựng ra, bỏ khác biệt khoảng trắng. */
const meaning = (md: string) =>
  (marked.parse(md, { async: false }) as string).replace(/>\s+</g, "><").replace(/\s+/g, " ").trim();

/** Nạp như trình soạn (có chữ gốc) rồi xuất. */
function load(md: string) {
  const codec = new MarkdownCodec();
  const { doc, groups } = codec.parse(md);
  const node = PMNode.fromJSON(schema, doc);
  codec.remember(node, groups);
  return { codec, node, json: doc };
}

/** Xuất lại từ node như khi mọi khối đều vừa được sửa (không dùng chữ gốc). */
function rewrite(md: string) {
  const codec = new MarkdownCodec();
  return codec.serialize(PMNode.fromJSON(schema, codec.parse(md).doc));
}

const types = (json: JSONContent) => (json.content ?? []).map((n) => n.type);

const TEMPLATES: BlockTemplate[] = [
  "h1",
  "h2",
  "para",
  "bullet",
  "ordered",
  "checklist",
  "table",
  "requirement",
  "code",
  "mermaid",
  "callout",
  "embed",
];

const FIXTURES = {
  // packages/contracts/src/doc-text.test.ts
  contracts: [
    "# Hoàn tiền một phần",
    "Mục tiêu: hoàn một phần.",
    "",
    "## Yêu cầu",
    "- R-1 Hoàn nhiều lần",
    "- R-2 Chặn vượt số tiền gốc",
    "",
    "```mermaid",
    "graph TD",
    "",
    "A --> B",
    "```",
    "| ID | Yêu cầu |",
    "| --- | --- |",
    "| R-3 | Lịch sử |",
    "",
    "![[project/pay/money]]",
    "",
    "> [!NOTE] Đầu vào cho agent",
    "",
    "- [ ] Tiêu chí 1",
  ].join("\n"),
  // apps/web/e2e/doc-editor.spec.ts
  e2e: "## Yêu cầu\n\n- R-1: Hoàn tiền một phần.\n\nTổng hoàn phải nhỏ hơn số tiền gốc.\n",
  // apps/desktop/src/screens/docs-screen.test.tsx
  desktop:
    "# Kiến trúc payment-api\n\n## 1. Tổng quan\n\nWorker là một binary Go.\n\n## 2. Kênh tới hub\n\nWorker giữ một WebSocket tới hub, thử lại với thời gian chờ tăng dần (`internal/channel/ws.go:42`).\n\nProxy công ty: dự kiến, chưa có code.",
  knowledge: "# Review\n- Check permissions\n```ts\nconst safe = true;\n```",
  prd: [
    "# PRD: Hoàn tiền",
    "",
    "Mục tiêu **giảm** khiếu nại, *tăng* tỉ lệ giữ chân; xem [runbook](https://wiki.acme.vn/runbook) và `pay.refund()`.",
    "",
    "## Yêu cầu",
    "",
    "- R-1: Hoàn tiền một phần.",
    "- R-2: Tổng hoàn không vượt ~~số tiền~~ giá trị gốc.",
    "  - Ghi chú lồng bên trong",
    "",
    "1. Bước một",
    "2. Bước hai",
    "",
    "| ID | Yêu cầu | Ưu tiên |",
    "| --- | :--- | ---: |",
    "| R-1 | Hoàn một phần | P0 |",
    "| R-2 | Chặn vượt \\| gốc | P1 |",
    "",
    "> [!warning]",
    "> Cần pháp chế duyệt.",
    ">",
    "> Đoạn thứ hai.",
    "",
    "> Trích dẫn thường.",
    "",
    "---",
    "",
    "- [x] Đã có thiết kế",
    "- [ ] Có số liệu đối soát",
    "",
    "Dòng một\\",
    "dòng hai sau ngắt dòng.",
  ].join("\n"),
};

describe("Markdown round-trip", () => {
  it("mọi mẫu khối trong blocks.ts nạp thành node riêng, xuất lại đúng chữ", () => {
    const doc = "- R-1: Có sẵn\n";
    for (const kind of TEMPLATES) {
      const md = blockTemplate(kind, doc);
      const { json, codec, node } = load(md);
      expect(types(json), kind).not.toContain("rawMarkdown");
      expect(codec.serialize(node), kind).toBe(normalizeDoc(md));
      expect(meaning(rewrite(md)), kind).toBe(meaning(md));
    }
  });

  it("mẫu khối nạp ra đúng loại node", () => {
    const kindOf = (k: BlockTemplate) => types(load(blockTemplate(k, "")).json)[0];
    expect(kindOf("checklist")).toBe("taskList");
    expect(kindOf("table")).toBe("table");
    expect(kindOf("code")).toBe("codeBlock");
    expect(kindOf("mermaid")).toBe("codeBlock");
    expect(kindOf("callout")).toBe("callout");
    expect(kindOf("embed")).toBe("docEmbed");
    const code = load(blockTemplate("mermaid", "")).json.content?.[0];
    expect(code?.attrs?.language).toBe("mermaid");
  });

  it.each(Object.entries(FIXTURES))("tài liệu mẫu %s: nạp rồi lưu không đổi chữ, viết lại không đổi nghĩa", (_, md) => {
    const { codec, node, json } = load(md);
    expect(codec.serialize(node)).toBe(normalizeDoc(md));
    expect(meaning(rewrite(md))).toBe(meaning(md));
    // Cú pháp quen thuộc không rơi xuống dạng chữ gốc.
    expect(types(json)).not.toContain("rawMarkdown");
  });

  it("khối không dựng lại được giữ nguyên dạng chữ", () => {
    const md = [
      "---",
      "title: Hướng dẫn",
      "tags: [a, b]",
      "---",
      "",
      "# Hướng dẫn",
      "",
      "![Sơ đồ](https://acme.vn/a.png)",
      "",
      "<details>",
      "<summary>Thêm</summary>",
      "",
      "Chi tiết",
      "",
      "</details>",
      "",
      "Có chú thích[^1].",
      "",
      "[^1]: Nguồn.",
    ].join("\n");
    const { codec, node, json } = load(md);
    expect(types(json)[0]).toBe("rawMarkdown");
    expect(types(json)[1]).toBe("heading");
    expect(types(json)).toContain("rawMarkdown");
    expect(codec.serialize(node)).toBe(normalizeDoc(md).replace("---\n\ntitle", "---\ntitle"));
    expect(rewrite(md)).toContain("---\ntitle: Hướng dẫn\ntags: [a, b]\n---\n\n# Hướng dẫn");
    expect(rewrite(md)).toContain("![Sơ đồ](https://acme.vn/a.png)");
    expect(rewrite(md)).toContain("<details>\n<summary>Thêm</summary>");
  });

  it("chỉ khối bị sửa mới xuất lại; khối khác giữ đúng chữ gốc", () => {
    const md = "* sao\n* sao hai\n\nĐoạn __đậm__.\n\n1) một\n2) hai\n";
    const { codec, node } = load(md);
    const para = schema.nodeFromJSON({ type: "paragraph", content: [{ type: "text", text: "Đoạn mới." }] });
    const edited = node.copy(node.content.replaceChild(1, para));
    expect(codec.serialize(edited)).toBe("* sao\n* sao hai\n\nĐoạn mới.\n\n1) một\n2) hai\n");
  });

  // SRS chuyển từ Word và Markdown trong repo có mục kiểu `6.  `: trước đây cả tài liệu không mở được.
  it.each(["1. Một\n2.  \n3. Ba\n", "6.  \n", "1. Một\n2.  \n", "- Một\n- \n- Ba\n", "- [ ] Việc\n- [ ] \n"])(
    "mục danh sách rỗng nạp được, lưu không đổi chữ: %j",
    (md) => {
      const { codec, node, json } = load(md);
      node.check();
      expect(types(json)).not.toContain("rawMarkdown");
      expect(codec.serialize(node)).toBe(normalizeDoc(md));
      expect(meaning(rewrite(md))).toBe(meaning(md));
    },
  );

  it("chữ thường không bị thoát thừa nhưng vẫn không thành định dạng", () => {
    expect(escapeMarkdownText("a_b_c và 2 * 3 < 4 & x", true)).toBe("a_b_c và 2 * 3 < 4 & x");
    expect(escapeMarkdownText("*đậm* _x_ `c` [l] ~5", false)).toBe("\\*đậm\\* \\_x\\_ \\`c\\` \\[l\\] \\~5");
    expect(escapeMarkdownText("<div> &amp;", false)).toBe("\\<div> \\&amp;");
    expect(escapeMarkdownText("# a\n- b\n1. c\n> d\n---", true)).toBe("\\# a\n\\- b\n1\\. c\n\\> d\n\\---");
    expect(escapeMarkdownText("# giữa câu", false)).toBe("# giữa câu");
    for (const text of ["a_b_c và 2 * 3 < 4 & x", "*đậm* _x_ `c` [l](u) ~5~", "# a\n- b\n1. c", "<b>x</b> &amp;"]) {
      const md = new MarkdownCodec().serializeNode({ type: "paragraph", content: [{ type: "text", text }] });
      const html = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, " ");
      expect(meaning(md)).toBe(`<p>${html}</p>`);
    }
  });
});

describe("cú pháp riêng của Hive", () => {
  it("mã yêu cầu thành node, chữ phía sau sửa được mà mã giữ nguyên", () => {
    const { json, node } = load("- R-3: Hoàn tiền **một** phần\n- R-4:\n- Không mã\n");
    const items = json.content?.[0]?.content ?? [];
    expect(items[0]?.content?.[0]?.content?.[0]).toEqual({ type: "requirement", attrs: { id: "R-3" } });
    expect(items[1]?.content?.[0]?.content?.[0]).toEqual({ type: "requirement", attrs: { id: "R-4" } });
    expect(items[2]?.content?.[0]?.content?.[0]?.type).toBe("text");
    // Sửa chữ của mục đầu: mã R-3 vẫn xuất đúng cú pháp `- R-3: …`.
    const codec = new MarkdownCodec();
    const first = node.child(0).child(0).child(0);
    const req = first.child(0);
    const changed = PMNode.fromJSON(schema, {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [req.toJSON(), { type: "text", text: " Hoàn tiền nhiều lần" }],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(codec.serialize(changed)).toBe("- R-3: Hoàn tiền nhiều lần\n");
  });

  it("R-n trong bảng hay giữa câu vẫn là chữ", () => {
    const { json } = load("Theo R-2: xem bảng.\n");
    expect(JSON.stringify(json)).not.toContain("requirement");
  });

  it("ghi chú nổi giữ nhãn và nội dung", () => {
    const { json } = load("> [!NOTE] Đầu vào cho agent\n");
    expect(json.content?.[0]).toMatchObject({
      type: "callout",
      attrs: { kind: "NOTE" },
      content: [{ type: "paragraph", content: [{ type: "text", text: "Đầu vào cho agent" }] }],
    });
    expect(rewrite("> [!NOTE] Đầu vào cho agent\n")).toBe("> [!NOTE]\n> Đầu vào cho agent\n");
    expect(rewrite("> [!tip]\n> Một\n>\n> Hai\n")).toBe("> [!tip]\n> Một\n>\n> Hai\n");
  });

  it("khối nhúng tài liệu", () => {
    expect(load("![[org/khac/tai-lieu]]").json.content?.[0]).toEqual({
      type: "docEmbed",
      attrs: { key: "org/khac/tai-lieu" },
    });
    expect(rewrite("![[org/khac/tai-lieu]]")).toBe("![[org/khac/tai-lieu]]\n");
  });

  it("tài liệu rỗng có một đoạn trống và xuất ra chuỗi rỗng", () => {
    const { codec, node } = load("");
    expect(node.childCount).toBe(1);
    expect(codec.serialize(node)).toBe("");
  });
  describe("ảnh và link tương đối", () => {
    const IMAGES = [
      "![Sơ đồ](assets/so-do.png)",
      "![](../assets/a.png)",
      '![Logo](https://acme.vn/logo.png "Logo Acme")',
      "Ảnh ![nhỏ](a.png) giữa chữ và [tài liệu khác](./khac.md#muc).",
      "![Tên có khoảng trắng](<assets/ảnh chụp.png>)",
      "[Báo cáo](files/bao-cao.pdf)",
    ];

    it("ảnh là node `image` chứ không phải khối Markdown thô", () => {
      const { json } = load(IMAGES[0] as string);
      expect(json.content?.[0]).toEqual({
        type: "paragraph",
        content: [{ type: "image", attrs: { src: "assets/so-do.png", alt: "Sơ đồ", title: null } }],
      });
    });

    it.each(IMAGES)("nạp rồi lưu không đổi byte: %s", (md) => {
      const doc = `${md}\n`;
      const { codec, node, json } = load(doc);
      expect(JSON.stringify(json)).not.toContain("rawMarkdown");
      expect(codec.serialize(node)).toBe(doc);
    });

    it.each(IMAGES)("khối bị viết lại vẫn cho cùng nghĩa: %s", (md) => {
      expect(meaning(rewrite(md))).toBe(meaning(md));
    });

    it("tài liệu nhiều khối: sửa chữ một khối không làm đổi byte của khối ảnh", () => {
      const md = "# Tiêu đề\n\n![Sơ đồ](assets/so-do.png)\n\nĐoạn   cuối.\n";
      const { codec, node } = load(md);
      expect(codec.serialize(node)).toBe(md);
    });

    it("ảnh dạng tham chiếu hoặc HTML vẫn giữ nguyên văn", () => {
      const md = '![alt][ref]\n\n[ref]: a.png\n\n<img src="a.png" width="40">\n';
      const { codec, node } = load(md);
      expect(codec.serialize(node)).toBe(md);
    });

    it("alt có ngoặc vuông được thoát khi xuất", () => {
      const out = rewrite("![a \\[1\\]](a.png)");
      expect(out).toBe("![a \\[1\\]](a.png)\n");
    });
  });
});

describe("xuống dòng trong ô bảng", () => {
  const TABLE = [
    "| Mã | Mô tả |",
    "| --- | --- |",
    "| UC-01 | Bước 1<br>Bước 2<br/>Bước 3 |",
    "| UC-02 | Một <br /> hai<BR>ba |",
  ].join("\n");
  /** `<br>`, `<br/>`, `<br />` và khoảng trắng quanh chúng hiển thị như nhau. */
  const cellMeaning = (md: string) => meaning(md).replace(/\s*<br\s*\/?>\s*/gi, "<br>");
  const inline = (json: JSONContent, row: number, col: number) =>
    json.content?.[0]?.content?.[row]?.content?.[col]?.content?.[0]?.content?.map((n) => n.type);

  it("bảng có `<br>` nạp thành bảng, mỗi `<br>` là một hardBreak", () => {
    const { json } = load(TABLE);
    expect(types(json)).toEqual(["table"]);
    expect(inline(json, 1, 1)).toEqual(["text", "hardBreak", "text", "hardBreak", "text"]);
    expect(inline(json, 2, 1)).toEqual(["text", "hardBreak", "text", "hardBreak", "text"]);
  });

  it("không sửa thì lưu đúng nguyên văn; viết lại thì hardBreak trong ô thành `<br>`", () => {
    const { codec, node } = load(`${TABLE}\n`);
    expect(codec.serialize(node)).toBe(`${TABLE}\n`);
    const out = rewrite(TABLE);
    expect(out).toContain("Bước 1<br>Bước 2<br>Bước 3");
    expect(cellMeaning(out)).toBe(cellMeaning(TABLE));
    expect(rewrite(out)).toBe(out);
  });

  it("sửa một ô chỉ đổi khối bảng đó", () => {
    const md = `# Use case\n\n${TABLE}\n\nĐoạn   cuối.\n`;
    const { codec, node } = load(md);
    const table = node.child(1).toJSON() as JSONContent;
    const id = table.content?.[1]?.content?.[0]?.content?.[0]?.content?.[0];
    if (id) id.text = "UC-09";
    const edited = node.copy(node.content.replaceChild(1, schema.nodeFromJSON(table)));
    const [head, body, tail] = codec.blocks(edited);
    expect(head).toBe("# Use case");
    expect(tail).toBe("Đoạn   cuối.");
    expect(body).toContain("UC-09");
    expect(body).toContain("Bước 1<br>Bước 2<br>Bước 3");
    expect(cellMeaning(body ?? "")).toBe(cellMeaning(TABLE.replace("UC-01", "UC-09")));
  });

  it.each([
    "| A |\n| --- |\n| `a<br>b` |",
    "| A |\n| --- |\n| a \\<br> b |",
    "| A |\n| --- |\n| <br>đầu |",
    "| A |\n| --- |\n| cuối<br> |",
    "| A |\n| --- |\n| a<br><br>b |",
  ])("ô đặc biệt vẫn lưu đúng nguyên văn và giữ nghĩa khi viết lại: %j", (md) => {
    const { codec, node } = load(`${md}\n`);
    expect(codec.serialize(node)).toBe(`${md}\n`);
    expect(cellMeaning(rewrite(md))).toBe(cellMeaning(md));
  });

  it("`<br>` trong code của ô vẫn là chữ", () => {
    const { json } = load("| A |\n| --- |\n| `a<br>b` |\n");
    expect(types(json)).toEqual(["table"]);
    expect(JSON.stringify(json)).not.toContain("hardBreak");
  });

  it("`<br>` ngoài bảng giữ như cũ", () => {
    const md = "Một<br>hai\n\n- mục<br/>một\n";
    const { codec, node, json } = load(md);
    expect(JSON.stringify(json)).not.toContain("hardBreak");
    expect(codec.serialize(node)).toBe(md);
  });
});
