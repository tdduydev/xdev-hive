// The Docs editor's document model (roadmap 23a): Tiptap nodes that read and write the same Markdown the rest of Hive
// uses (agents read it, a sync writes it into AGENTS.md), so a page edited in the rich editor stays a Markdown page.
// Browser-safe and DOM-free: the same extensions parse and serialize in tests.
import { Mark, mergeAttributes, type AnyExtension, type JSONContent } from "@tiptap/core";
import CodeBlock from "@tiptap/extension-code-block";
import Image from "@tiptap/extension-image";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit, renderTableToMarkdown } from "@tiptap/extension-table";
import { MarkdownManager } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";

// In a table cell the | before the text is written \| (GFM), and read back either way.
const PAGE_LINK = /^\[\[([^\]\n|]{1,200}?)\\?(?:\|([^\]\n]{1,200}))?\]\]/;

/**
 * [[slug]] or [[key|text]]: a link to another page (see core doclinks.ts), a mark like [text](url) so bold and italic
 * wrap it as they wrap any text. Its text is what the page shows; when it is not the target, it is written as |text.
 * The editor shows a bare [[slug]] as the page's title (`shown`), and writes it back bare while that text is kept.
 */
export const PageLink = Mark.create({
  name: "pageLink",
  inclusive: false,
  excludes: "link",
  addAttributes() {
    return { target: { default: "" }, shown: { default: null, rendered: false } };
  },
  parseHTML() {
    return [{ tag: "span[data-page-link]", getAttrs: (el) => ({ target: (el as HTMLElement).dataset.pageLink ?? "" }) }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes({ "data-page-link": HTMLAttributes.target, class: "page-link" }), 0];
  },
  markdownTokenizer: {
    name: "pageLink",
    level: "inline",
    start: (src: string) => src.indexOf("[["),
    tokenize: (src: string) => {
      const m = PAGE_LINK.exec(src);
      return m ? { type: "pageLink", raw: m[0], target: m[1]!.trim(), label: m[2]?.trim() || null } : undefined;
    },
  },
  parseMarkdown: (token, h) => {
    const t = token as unknown as { target: string; label: string | null };
    return h.applyMark("pageLink", [h.createTextNode(t.label ?? t.target)], { target: t.target });
  },
  // Marks are written as an opening and a closing part around their text (ctx.meta.markText is that text).
  renderMarkdown: (node: JSONContent, h: { renderChildren: (n: JSONContent | JSONContent[]) => string }, ctx?: { meta?: { markText?: string } }) => {
    const target = String(node.attrs?.target ?? "");
    const text = ctx?.meta?.markText;
    const inner = h.renderChildren(node);
    return text === undefined || text === target ? `[[${inner}]]` : `[[${target}|${inner}]]`;
  },
});

// Text is written as it is, unless it would read back as something else: the stock serializer escapes every *, _, [,
// ], ~ and turns <, >, & into entities, which agents then read in AGENTS.md ("\[Inference\]", "a &lt; b").
/** The parts of MarkdownManager the escaping needs (private in its types). */
type Manager = { instance: typeof import("marked").marked; codeTypes: Set<string> };
const proto = MarkdownManager.prototype as unknown as { encodeTextForMarkdown(this: Manager, text: string, node: JSONContent, parent?: JSONContent): string };
const stockEncode = proto.encodeTextForMarkdown;
proto.encodeTextForMarkdown = function (text, node, parent) {
  if (!/[\\`*_[\]~<>&]/.test(text)) return text;
  const inCode = (parent?.type != null && this.codeTypes.has(parent.type)) || (node.marks ?? []).some((m) => this.codeTypes.has(typeof m === "string" ? m : m.type));
  if (inCode) return text;
  try {
    const tokens = this.instance.Lexer.lexInline(text, this.instance.defaults);
    if (tokens.length === 1 && tokens[0]!.type === "text" && tokens[0]!.raw === text && !/&[#\w]+;/.test(text)) return text;
  } catch {
    // unreadable as inline Markdown: the stock escaping
  }
  return stockEncode.call(this, text, node, parent);
};

/** A table as the team writes it: `| a | b |` rows and `| --- |` rules, not columns padded to one width. */
export function compactTable(md: string): string {
  return md
    .split("\n")
    .map((line) => {
      if (!/^\s*\|.*\|\s*$/.test(line)) return line;
      const cells = line.trim().slice(1, -1).split(/(?<!\\)\|/).map((c) => c.trim());
      if (cells.every((c) => /^:?-{3,}:?$/.test(c))) {
        return `| ${cells.map((c) => `${c.startsWith(":") ? ":" : ""}---${c.endsWith(":") ? ":" : ""}`).join(" | ")} |`;
      }
      return `|${cells.map((c) => (c ? ` ${c} ` : " ")).join("|")}|`;
    })
    .join("\n");
}

const Table = TableKit.configure({ table: { resizable: false } }).extend({
  addExtensions() {
    return (this.parent?.() ?? []).map((ext: AnyExtension) =>
      ext.name === "table" ? ext.extend({ renderMarkdown: (node: JSONContent, h: Parameters<typeof renderTableToMarkdown>[1]) => compactTable(renderTableToMarkdown(node, h)) }) : ext,
    );
  },
});

/** The nodes and marks a page is made of, for the editor and for the Markdown in and out. */
export function docExtensions(extra: AnyExtension[] = []): AnyExtension[] {
  return [
    // The code block on its own: the editor gives it a view (its language, a Mermaid diagram under it).
    StarterKit.configure({ codeBlock: false, link: { openOnClick: false, autolink: true } }),
    CodeBlock,
    Table,
    TaskList,
    TaskItem.configure({ nested: true }),
    Image.configure({ inline: false }),
    PageLink,
    ...extra,
  ];
}

let manager: MarkdownManager | null = null;
const markdown = () => (manager ??= new MarkdownManager({ extensions: docExtensions() }));

export const parseDocMarkdown = (md: string): JSONContent => markdown().parse(md);

/** The document with each bare [[slug]] showing its page's title, where `title` knows it. */
export function withPageTitles(doc: JSONContent, title: (target: string) => string | undefined): JSONContent {
  const link = doc.marks?.find((m) => m.type === "pageLink");
  const target = String(link?.attrs?.target ?? "");
  const shown = link && doc.text === target ? title(target) : undefined;
  return {
    ...doc,
    ...(shown ? { text: shown, marks: doc.marks!.map((m) => (m === link ? { ...m, attrs: { ...m.attrs, shown } } : m)) } : {}),
    ...(doc.content ? { content: doc.content.map((c) => withPageTitles(c, title)) } : {}),
  };
}
/** The document with each link still showing its page's title back to its bare [[slug]]. */
function bareLinks(doc: JSONContent): JSONContent {
  const link = doc.marks?.find((m) => m.type === "pageLink" && m.attrs?.shown);
  return {
    ...doc,
    ...(link && doc.text === link.attrs!.shown ? { text: String(link.attrs!.target) } : {}),
    ...(doc.content ? { content: doc.content.map(bareLinks) } : {}),
  };
}

export const serializeDocMarkdown = (doc: JSONContent): string => `${markdown().serialize(bareLinks(doc)).replace(/\n{3,}/g, "\n\n").trim()}\n`;

/**
 * Pages the rich editor does not open, to keep them exactly as written: a skill (its SKILL.md starts with YAML
 * frontmatter, which Markdown turns into a rule and text), or any page with frontmatter or raw HTML blocks.
 */
export function richEditable(key: string, md: string): boolean {
  if (/\/skills\//.test(key)) return false;
  if (/^---\n[\s\S]*?\n---/.test(md)) return false;
  return !/^\s*<(?!br\b)[a-zA-Z!][^>]*>/m.test(md);
}

const letters = (md: string) => md.normalize("NFC").replace(/[^\p{L}\p{N}]/gu, "");
/** A document to compare: runs of white space in text read as one space (they render as one), except in code. */
function comparable(doc: JSONContent): JSONContent {
  const code = doc.type === "codeBlock" || (doc.marks ?? []).some((m) => m.type === "code");
  return {
    ...doc,
    ...(doc.text !== undefined ? { text: code ? doc.text : doc.text.replace(/\s+/g, " ") } : {}),
    ...(doc.content ? { content: doc.content.map(comparable) } : {}),
  };
}
const same = (a: JSONContent, b: JSONContent) => JSON.stringify(comparable(a)) === JSON.stringify(comparable(b));

/**
 * Whether the rich editor keeps this page as it is: every letter and digit survives a round trip through the editor,
 * and a second round trip changes nothing (formatting the parser cannot read would come back broken). What may change
 * is only how it is written: table spacing, list markers, lines of a paragraph joined.
 */
export function richSafe(key: string, md: string): boolean {
  if (!richEditable(key, md)) return false;
  try {
    const doc = parseDocMarkdown(md);
    const out = serializeDocMarkdown(doc);
    return letters(out) === letters(md) && same(parseDocMarkdown(out), doc);
  } catch {
    return false;
  }
}
