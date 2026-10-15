import { type AnyExtension, InputRule, type JSONContent, mergeAttributes, Node } from "@tiptap/core";
import { CodeBlock } from "@tiptap/extension-code-block";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import { MarkdownManager } from "@tiptap/markdown";
import type { Node as PMNode } from "@tiptap/pm/model";
import { StarterKit } from "@tiptap/starter-kit";
import { EMBED_LINE, joinBlocks, splitBlocks } from "@xdev-hive/contracts";
import { Marked, type marked } from "marked";

/*
 * Markdown là dạng lưu chuẩn (ADR 0015): hub, agent, review và đồng bộ repo đều đọc Markdown, Tiptap chỉ là lớp soạn.
 * File này giữ phần thuần (schema, nạp và xuất Markdown) để test không cần DOM; giao diện node nằm ở editor-views.tsx.
 */

const CALLOUT = /^\[!(note|info|tip|warning|important|caution)\]/i;
const REQUIREMENT = /^(R-\d{1,5}):(?=\s|$)/;
const FRONT_MATTER = /^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

/** Mã yêu cầu `R-n:` đầu một mục danh sách: node nguyên khối để sửa chữ phía sau không làm đổi mã. */
export const Requirement = Node.create({
  name: "requirement",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: () => ({
    id: {
      default: "R-1",
      parseHTML: (el) => el.getAttribute("data-requirement"),
      renderHTML: (attrs) => ({ "data-requirement": attrs.id }),
    },
  }),
  parseHTML: () => [{ tag: "span[data-requirement]" }],
  renderHTML: ({ node, HTMLAttributes }) => [
    "span",
    mergeAttributes(HTMLAttributes, {
      class:
        "mr-0.5 inline-flex h-5 items-center rounded-md bg-accent px-1.5 align-baseline font-mono text-xs font-semibold text-accent-foreground",
      title: `${node.attrs.id}`,
    }),
    String(node.attrs.id),
  ],
  renderText: ({ node }) => `${node.attrs.id}:`,
  renderMarkdown: (node) => `${node.attrs?.id ?? "R-1"}:`,
  addInputRules() {
    return [
      // Gõ tay `R-7: ` đầu một mục danh sách cũng thành mã yêu cầu như khi chèn từ menu `/`.
      new InputRule({
        find: /^(R-\d{1,5}):\s$/,
        handler: ({ state, range, match }) => {
          const $from = state.doc.resolve(range.from);
          if (!["listItem", "taskItem"].includes($from.node(-1)?.type.name ?? "") || $from.index(-1) !== 0) return null;
          state.tr.replaceWith(range.from, range.to, [this.type.create({ id: match[1] }), state.schema.text(" ")]);
        },
      }),
    ];
  },
});

/** Ghi chú nổi theo cú pháp GitHub `> [!note]`; giữ nguyên chữ của nhãn (note, warning…) khi xuất. */
export const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,
  addAttributes: () => ({
    kind: {
      default: "note",
      parseHTML: (el) => el.getAttribute("data-callout") ?? "note",
      renderHTML: (attrs) => ({ "data-callout": attrs.kind }),
    },
  }),
  parseHTML: () => [{ tag: "aside[data-callout]" }],
  renderHTML: ({ HTMLAttributes }) => [
    "aside",
    mergeAttributes(HTMLAttributes, {
      class: "my-4 rounded-[10px] bg-accent px-3.5 py-2 text-sm text-accent-foreground",
    }),
    0,
  ],
  renderMarkdown: (node, h) => {
    const body = (node.content ?? [])
      .map((child: JSONContent, i: number) => h.renderChild?.(child, i) ?? h.renderChildren([child]))
      .join("\n\n");
    return [`[!${node.attrs?.kind ?? "note"}]`, ...body.split("\n")].map((l) => (l ? `> ${l}` : ">")).join("\n");
  },
});

/** Khối nhúng tài liệu `![[key]]`: agent đọc Markdown vẫn hiểu là tham chiếu. */
export const DocEmbed = Node.create({
  name: "docEmbed",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes: () => ({
    key: {
      default: "",
      parseHTML: (el) => el.getAttribute("data-doc-embed") ?? "",
      renderHTML: (attrs) => ({ "data-doc-embed": attrs.key }),
    },
  }),
  parseHTML: () => [{ tag: "div[data-doc-embed]" }],
  renderHTML: ({ node, HTMLAttributes }) => [
    "div",
    mergeAttributes(HTMLAttributes, { class: "my-2 rounded-lg border border-border px-3 py-2 font-mono text-sm" }),
    `![[${node.attrs.key}]]`,
  ],
  renderMarkdown: (node) => `![[${node.attrs?.key ?? ""}]]`,
});

/** Địa chỉ ảnh trong `![](…)`: có khoảng trắng hoặc ngoặc thì bọc `<…>` để Markdown đọc lại đúng một địa chỉ. */
const imageDest = (src: string) => (/[\s()]/.test(src) ? `<${src.replace(/[<>]/g, encodeURIComponent)}>` : src);

/**
 * Ảnh `![alt](src "title")`. Địa chỉ giữ nguyên chữ trong tài liệu (thường là đường dẫn tương đối trong repo);
 * trình soạn tự phân giải lúc hiển thị (editor-views.tsx), không bao giờ ghi địa chỉ đã phân giải ngược vào tài liệu.
 */
export const Image = Node.create({
  name: "image",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes: () => ({
    src: { default: "" },
    alt: { default: "" },
    title: { default: null },
  }),
  // Ảnh `data:` dán từ trang web có thể nặng vài MB: để lên đường tải file thay vì nhét vào Markdown.
  parseHTML: () => [{ tag: 'img[src]:not([src^="data:"])' }],
  renderHTML: ({ HTMLAttributes }) => ["img", mergeAttributes(HTMLAttributes, { class: "inline max-w-full" })],
  markdownTokenName: "image",
  parseMarkdown: (token, h) =>
    h.createNode("image", { src: token.href ?? "", alt: token.text ?? "", title: token.title ?? null }),
  renderMarkdown: (node) => {
    const { src, alt, title } = node.attrs ?? {};
    const label = String(alt ?? "").replace(/[[\]]/g, "\\$&");
    const tail = title ? ` "${String(title).replace(/"/g, '\\"')}"` : "";
    return `![${label}](${imageDest(String(src ?? ""))}${tail})`;
  },
});

/**
 * Khối Markdown trình soạn không dựng lại y nguyên được (HTML, front matter, chú thích…): hiện và sửa dạng chữ gốc
 * để nạp rồi lưu không làm mất nội dung.
 */
export const RawMarkdown = Node.create({
  name: "rawMarkdown",
  group: "block",
  content: "text*",
  marks: "",
  code: true,
  defining: true,
  parseHTML: () => [{ tag: "pre[data-raw-markdown]", preserveWhitespace: "full" }],
  renderHTML: ({ HTMLAttributes }) => [
    "pre",
    mergeAttributes(HTMLAttributes, {
      "data-raw-markdown": "",
      class: "my-2 rounded-lg border border-dashed border-border bg-muted/50 px-3 py-2 font-mono text-sm",
    }),
    ["code", 0],
  ],
  renderMarkdown: (node) => (node.content ?? []).map((c: JSONContent) => c.text ?? "").join(""),
  addKeyboardShortcuts() {
    return {
      // Như khối code: Enter xuống dòng trong khối thay vì tách khối.
      Enter: ({ editor }) =>
        editor.isActive(this.name) &&
        editor.commands.command(({ tr }) => {
          tr.insertText("\n");
          return true;
        }),
    };
  },
});

/** Các extension tạo schema; trình soạn thay codeBlock, docEmbed và image bằng bản có giao diện (cùng tên, cùng schema). */
export function docExtensions(
  views: { codeBlock?: AnyExtension; docEmbed?: AnyExtension; image?: AnyExtension } = {},
): AnyExtension[] {
  return [
    StarterKit.configure({
      codeBlock: false,
      // Markdown không có gạch chân.
      underline: false,
      link: { openOnClick: false, autolink: true, defaultProtocol: "https" },
    }),
    views.codeBlock ?? CodeBlock.configure({ defaultLanguage: null }),
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: false } }),
    Requirement,
    Callout,
    views.docEmbed ?? DocEmbed,
    views.image ?? Image,
    RawMarkdown,
  ];
}

const isWord = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c);
const isSpace = (c: string | undefined) => c === undefined || /\s/.test(c);

/**
 * Thoát ký tự Markdown trong chữ thường, ít nhất có thể để file đọc vẫn tự nhiên: `a_b`, `2 * 3`, `<` không theo sau
 * bởi tên thẻ, `&` không phải thực thể đều để nguyên (bản gốc của Tiptap đổi thành `\_`, `&lt;`, `&amp;`).
 */
export function escapeMarkdownText(text: string, lineStart: boolean): string {
  let s = text.replace(/\\(?=[!-/:-@[-`{-~])/g, "\\\\").replace(/[`[\]~]/g, "\\$&");
  s = s.replace(/\*/g, (m, i: number, all: string) =>
    i > 0 && isSpace(all[i - 1]) && isSpace(all[i + 1]) ? m : "\\*",
  );
  s = s.replace(/_/g, (m, i: number, all: string) => (isWord(all[i - 1]) && isWord(all[i + 1]) ? m : "\\_"));
  s = s.replace(/<(?=[A-Za-z/!?])/g, "\\<").replace(/&(?=#?\w+;)/g, "\\&");
  // Đầu dòng: chữ thường không được biến thành tiêu đề, danh sách, trích dẫn hay gạch chân tiêu đề.
  return s.replace(
    /(^|\n)([ \t]*)(#{1,6}(?=\s|$)|[-+](?=\s)|>|\d+(?=[.)]\s)|(?:=+|-+)[ \t]*(?=\n|$))/g,
    (m, nl, ws, mark, offset: number) =>
      offset === 0 && !nl && !lineStart ? m : /^\d/.test(mark) ? `${nl}${ws}${mark}\\` : `${nl}${ws}\\${mark}`,
  );
}

type TextEncoder = (text: string, node: JSONContent, parent?: JSONContent) => string;

const html = new Marked({ gfm: true });
const rendered = (md: string) =>
  (html.parse(md, { async: false }) as string).replace(/>\s+</g, "><").replace(/\s+/g, " ").trim();

/** Nhóm node cấp cao dựng từ cùng một khối Markdown; còn y nguyên thì xuất lại đúng chữ gốc của khối. */
type Source = { text: string; nodes: PMNode[] };

/**
 * Nạp Markdown thành tài liệu Tiptap và xuất ngược lại. Mỗi khối (splitBlocks) nạp riêng rồi xuất thử: HTML hai bản
 * khác nhau thì khối giữ nguyên dạng chữ (rawMarkdown). Khối người dùng không sửa xuất lại đúng chữ gốc, nên lưu không
 * làm đổi định dạng những chỗ không ai đụng tới.
 */
export class MarkdownCodec {
  readonly manager: MarkdownManager;
  private sources = new WeakMap<PMNode, Source>();

  constructor(extensions: AnyExtension[] = docExtensions()) {
    // Bản marked riêng: không đăng ký tokenizer lên bản marked dùng chung của trang.
    this.manager = new MarkdownManager({ extensions, marked: new Marked() as unknown as typeof marked });
    const codeTypes = new Set(["codeBlock", "rawMarkdown"]);
    const encode: TextEncoder = (text, node, parent) => {
      const inCode =
        (parent?.type && codeTypes.has(parent.type)) ||
        (node.marks ?? []).some((m) => (typeof m === "string" ? m : m.type) === "code");
      if (inCode) return text;
      return escapeMarkdownText(text, parent?.type === "paragraph" && parent.content?.[0] === node);
    };
    // Cách thoát chữ mặc định của @tiptap/markdown không có tuỳ chọn để thay; bản ghim trong package.json có test đi kèm.
    (this.manager as unknown as { encodeTextForMarkdown: TextEncoder }).encodeTextForMarkdown = encode;
  }

  /** Markdown → nội dung Tiptap, kèm số node cấp cao của từng khối để gắn chữ gốc (`remember`). */
  parse(markdown: string): { doc: JSONContent; groups: { size: number; text: string }[] } {
    const content: JSONContent[] = [];
    const groups: { size: number; text: string }[] = [];
    let rest = markdown.replace(/\r\n/g, "\n");
    const front = FRONT_MATTER.exec(rest);
    if (front) {
      const text = front[0].replace(/\n$/, "");
      content.push(raw(text));
      groups.push({ size: 1, text });
      rest = rest.slice(front[0].length);
    }
    for (const block of splitBlocks(rest)) {
      const nodes = this.parseBlock(block);
      content.push(...nodes);
      groups.push({ size: nodes.length, text: block });
    }
    return { doc: { type: "doc", content: content.length ? content : [{ type: "paragraph" }] }, groups };
  }

  /** Nội dung để chèn (menu `/`, dán Markdown): không kiểm khối như khi nạp cả tài liệu. */
  fragment(markdown: string): JSONContent[] {
    return this.parse(markdown).doc.content ?? [];
  }

  private parseBlock(block: string): JSONContent[] {
    let nodes: JSONContent[];
    try {
      nodes = (this.manager.parse(block).content ?? []).map(enhance).map(inParagraph);
    } catch {
      return [raw(block)];
    }
    if (!nodes.length) return [raw(block)];
    const back = nodes.map((n) => this.serializeNode(n)).join("\n\n");
    return rendered(back) === rendered(block) ? nodes : [raw(block)];
  }

  /** Gắn chữ gốc cho node cấp cao của tài liệu vừa nạp (gọi ngay sau setContent với kết quả của `parse`). */
  remember(doc: PMNode, groups: { size: number; text: string }[]) {
    let i = 0;
    for (const g of groups) {
      const nodes = Array.from({ length: g.size }, (_, k) => doc.maybeChild(i + k)).filter((n): n is PMNode => !!n);
      if (nodes[0] && nodes.length === g.size) this.sources.set(nodes[0], { text: g.text, nodes });
      i += g.size;
    }
  }

  serializeNode(node: JSONContent): string {
    return this.manager
      .serialize({ type: "doc", content: [markCellPipes(node, false)] })
      .replace(/^\n+|\s+$/g, "")
      .replaceAll(CELL_PIPE, "\\|");
  }

  /** Duyệt node cấp cao: nhóm còn y nguyên thì trả chữ gốc của nhóm, còn lại xuất từ node. */
  private walk(doc: PMNode, emit: (text: string, size: number) => void) {
    for (let i = 0; i < doc.childCount; ) {
      const node = doc.child(i);
      const src = this.sources.get(node);
      if (src?.nodes.every((n, k) => doc.maybeChild(i + k) === n)) {
        emit(src.text, src.nodes.length);
        i += src.nodes.length;
        continue;
      }
      emit(this.serializeNode(node.toJSON()), 1);
      i++;
    }
  }

  /** Chữ Markdown của từng node cấp cao (node trong cùng nhóm chữ gốc nhận chung chữ của nhóm). */
  blocks(doc: PMNode): string[] {
    const out: string[] = [];
    this.walk(doc, (text, size) => {
      for (let k = 0; k < size; k++) out.push(text);
    });
    return out;
  }

  serialize(doc: PMNode): string {
    const out: string[] = [];
    this.walk(doc, (text) => out.push(text));
    return joinBlocks(out);
  }
}

/** Ký tự thay `|` trong ô bảng lúc xuất: bảng của Tiptap không thoát `|` trong chữ thường, ô sẽ bị tách đôi. */
const CELL_PIPE = "\uE000";

function markCellPipes(node: JSONContent, inCell: boolean): JSONContent {
  if (node.type === "text") return inCell && node.text ? { ...node, text: node.text.replaceAll("|", CELL_PIPE) } : node;
  if (!node.content) return node;
  const cell = inCell || node.type === "tableCell" || node.type === "tableHeader";
  return { ...node, content: node.content.map((c) => markCellPipes(c, cell)) };
}

function raw(text: string): JSONContent {
  return { type: "rawMarkdown", content: text ? [{ type: "text", text }] : [] };
}

const firstText = (node: JSONContent | undefined) => {
  const t = node?.content?.[0];
  return t?.type === "text" && !t.marks?.length ? t : null;
};

const TEXT_HOSTS = new Set(["paragraph", "heading"]);

/** @tiptap/markdown bỏ đoạn văn bọc quanh ảnh đứng một mình; ảnh của ta là node trong dòng nên phải bọc lại. */
const inParagraph = (node: JSONContent): JSONContent =>
  node.type === "image" ? { type: "paragraph", content: [node] } : node;

/** Nhận ra cú pháp riêng của Hive trong cây @tiptap/markdown dựng: ghi chú nổi, nhúng tài liệu, mã yêu cầu. */
function enhance(node: JSONContent): JSONContent {
  const content = node.content?.map(enhance);
  const out: JSONContent = content ? { ...node, content } : { ...node };
  if (out.content && !TEXT_HOSTS.has(out.type ?? "")) out.content = out.content.map(inParagraph);
  if (out.type === "paragraph" && out.content?.length === 1) {
    const t = firstText(out);
    const key = t && EMBED_LINE.exec(t.text?.trim() ?? "")?.[1];
    if (key) return { type: "docEmbed", attrs: { key } };
  }
  if (out.type === "blockquote") {
    const head = out.content?.[0];
    const t = head?.type === "paragraph" ? firstText(head) : null;
    const m = t && CALLOUT.exec(t.text ?? "");
    if (head && t && m) {
      const restText = (t.text ?? "").slice(m[0].length).replace(/^[ \t]*\n?/, "");
      let restInline = [...(restText ? [{ ...t, text: restText }] : []), ...(head.content ?? []).slice(1)];
      if (restInline[0]?.type === "hardBreak") restInline = restInline.slice(1);
      const body = [...(restInline.length ? [{ ...head, content: restInline }] : []), ...(out.content ?? []).slice(1)];
      return { type: "callout", attrs: { kind: m[1] }, content: body.length ? body : [{ type: "paragraph" }] };
    }
  }
  if ((out.type === "listItem" || out.type === "taskItem") && out.content?.[0]?.type === "paragraph") {
    const para = out.content[0];
    const t = firstText(para);
    const m = t && REQUIREMENT.exec(t.text ?? "");
    if (t && m) {
      const restText = (t.text ?? "").slice(m[0].length);
      const inline = [
        { type: "requirement", attrs: { id: m[1] } },
        ...(restText ? [{ ...t, text: restText }] : []),
        ...(para.content ?? []).slice(1),
      ];
      return { ...out, content: [{ ...para, content: inline }, ...out.content.slice(1)] };
    }
  }
  return out;
}
