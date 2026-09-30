import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import { mermaidSource } from "#ui/lib/mermaid.ts";
import { compactTable, parseDocMarkdown, richEditable, richSafe, serializeDocMarkdown, withPageTitles } from "#ui/lib/editor/markdown.ts";

const roundTrip = (md: string) => serializeDocMarkdown(parseDocMarkdown(md));

describe("rich editor Markdown", () => {
  it("keeps page links, with their text, inside bold and in tables", () => {
    assert.equal(roundTrip("Xem [[co-so-du-lieu]] và [[org/agent-protocol|quy ước agent]].\n"), "Xem [[co-so-du-lieu]] và [[org/agent-protocol|quy ước agent]].\n");
    assert.equal(roundTrip("**Đọc [[luong-xu-ly]] trước**\n"), "**Đọc [[luong-xu-ly]] trước**\n");
    const table = "| Trang | Ghi chú |\n| --- | --- |\n| [[org/deploy\\|Deploy]] | xem |\n";
    const out = roundTrip(table);
    assert.match(out, /\[\[org\/deploy\\?\|Deploy\]\]/);
    assert.equal(roundTrip(out), out);
  });

  it("shows a bare link as its page's title and writes it back bare until that text changes", () => {
    const doc = withPageTitles(parseDocMarkdown("Xem [[co-so-du-lieu]] và [[khac]].\n"), (t) => (t === "co-so-du-lieu" ? "Cơ sở dữ liệu" : undefined));
    assert.match(JSON.stringify(doc), /"text":"Cơ sở dữ liệu"/);
    assert.equal(serializeDocMarkdown(doc), "Xem [[co-so-du-lieu]] và [[khac]].\n");
    const link = doc.content![0]!.content!.find((n) => n.text === "Cơ sở dữ liệu")!;
    link.text = "bảng dữ liệu";
    assert.equal(serializeDocMarkdown(doc), "Xem [[co-so-du-lieu|bảng dữ liệu]] và [[khac]].\n");
  });

  it("writes text as it is unless it would read back as something else", () => {
    assert.equal(roundTrip("[Inference] a < b & c_d, snake_case\n"), "[Inference] a < b & c_d, snake_case\n");
    assert.equal(roundTrip("`a*b` và **đậm**\n"), "`a*b` và **đậm**\n");
    // A literal * that would start emphasis stays escaped.
    const star = parseDocMarkdown("\\*không nghiêng\\*\n");
    assert.equal(JSON.stringify(parseDocMarkdown(serializeDocMarkdown(star))), JSON.stringify(star));
  });

  it("writes tables compactly, keeping alignment", () => {
    assert.equal(compactTable("|  a   |  b  |\n| :--- | ---: |\n|  1   |     |"), "| a | b |\n| :--- | ---: |\n| 1 | |");
  });

  it("keeps lists, tasks and code", () => {
    const md = "## Việc\n\n- [ ] viết\n- [x] đọc\n\n1. một\n2. hai\n\n```ts\nconst a = 1;\n```\n";
    assert.equal(roundTrip(md), md);
    assert.equal(richSafe("project/p/viec", md), true);
  });

  it("does not open skills, frontmatter or raw HTML in the rich editor", () => {
    assert.equal(richEditable("project/p/skills/deploy", "# Deploy\n"), false);
    assert.equal(richEditable("org/a", "---\nname: a\n---\n\n# A\n"), false);
    assert.equal(richEditable("org/a", "<details>\n<summary>x</summary>\n</details>\n"), false);
    assert.equal(richEditable("org/a", "Dòng<br>mới\n"), true);
    assert.equal(richSafe("org/a", "---\nname: a\n---\n"), false);
  });

  it("keeps a Mermaid block as its fenced code", () => {
    const md = "## Luồng\n\n```mermaid\nflowchart LR\n  A[Yêu cầu] --> B{Máy rảnh?}\n  B -- có --> C\n```\n";
    assert.equal(roundTrip(md), md);
    assert.equal(richSafe("org/luong", md), true);
  });
});

describe("Mermaid in a page", () => {
  it("finds ```mermaid blocks in what react-markdown renders, and leaves other code as code", () => {
    const html = renderToStaticMarkup(
      createElement(
        Markdown,
        { components: { pre: ({ node, children }) => (mermaidSource(node as never) !== null ? createElement("figure", { "data-mermaid": mermaidSource(node as never) }) : createElement("pre", null, children)) } },
        "```mermaid\nflowchart LR\n  A --> B\n```\n\n```ts\nconst a = 1;\n```\n",
      ),
    );
    assert.match(html, /<figure data-mermaid="flowchart LR\n  A --&gt; B"><\/figure>/);
    assert.match(html, /<pre><code class="language-ts">const a = 1;/);
  });

  it("reads the code of a mermaid block only", () => {
    const pre = (lang: string) => ({ type: "element", tagName: "pre", children: [{ type: "element", tagName: "code", properties: { className: [`language-${lang}`] }, children: [{ type: "text", value: "graph TD\nA-->B\n" }] }] });
    assert.equal(mermaidSource(pre("mermaid")), "graph TD\nA-->B");
    assert.equal(mermaidSource(pre("ts")), null);
    assert.equal(mermaidSource(undefined), null);
  });
});
