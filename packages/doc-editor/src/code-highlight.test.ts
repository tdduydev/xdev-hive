// @vitest-environment jsdom
import { Editor, Extension } from "@tiptap/core";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { codeHighlight } from "./code-highlight.ts";
import { docExtensions, MarkdownCodec } from "./markdown.ts";

let editor: Editor | null = null;

beforeAll(() => {
  // jsdom không dựng bố cục; ProseMirror đo vị trí khi cập nhật vùng chọn.
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

function open(markdown: string) {
  const { doc } = new MarkdownCodec().parse(markdown);
  editor = new Editor({
    element: document.createElement("div"),
    extensions: [
      ...docExtensions(),
      Extension.create({ name: "codeHighlight", addProseMirrorPlugins: () => [codeHighlight()] }),
    ],
    content: doc,
  });
  return editor.view.dom as HTMLElement;
}

describe("codeHighlight", () => {
  it("decorates code blocks of a known language with hljs classes", () => {
    const dom = open("```ts\nconst a = 'x';\n```");
    expect(dom.querySelector(".hljs-keyword")?.textContent).toBe("const");
    expect(dom.querySelector(".hljs-string")?.textContent).toBe("'x'");
  });

  it("leaves blocks without a language plain instead of guessing one", () => {
    const dom = open("```\nconst a = 1;\n```");
    expect(dom.querySelector("[class*=hljs]")).toBeNull();
  });

  it("follows the text while typing", () => {
    const dom = open("```js\nlet a\n```");
    expect(dom.querySelectorAll(".hljs-keyword")).toHaveLength(1);
    editor?.commands.insertContentAt(editor.state.doc.content.size - 1, "\nreturn 1");
    expect(dom.querySelectorAll(".hljs-keyword")).toHaveLength(2);
  });

  it("highlights each block by its own language", () => {
    const dom = open('```json\n{"a": 1}\n```\n\n```bash\necho hi\n```');
    expect(dom.querySelector(".hljs-attr")?.textContent).toBe('"a"');
    expect(dom.querySelector(".hljs-built_in")?.textContent).toBe("echo");
  });
});
