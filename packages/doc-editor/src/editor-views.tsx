import { type AnyExtension, type Editor, Extension } from "@tiptap/core";
import { CodeBlock } from "@tiptap/extension-code-block";
import { Placeholder } from "@tiptap/extensions";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { NodeViewContent, NodeViewWrapper, type ReactNodeViewProps, ReactNodeViewRenderer } from "@tiptap/react";
import { EMBED_LINE } from "@xdev-hive/contracts";
import { CopyButton } from "@xdev-hive/ui/code-block";
import { languageLabel } from "@xdev-hive/ui/highlight";
import { MermaidDiagram } from "@xdev-hive/ui/mermaid-diagram";
import { cn } from "cn";
import { createContext, useContext } from "react";
import { codeHighlight } from "./code-highlight.ts";
import type { DocEditorEnv, Lang } from "./env.tsx";
import { DocEmbed, docExtensions, type MarkdownCodec } from "./markdown.ts";
import { cleanPastedHtml, looksLikeMarkdown } from "./paste.ts";
import { type SlashController, slashCommand } from "./slash.ts";
import type { docEditorText } from "./text.ts";

export type EditorText = (typeof docEditorText)["vi"];

/** Node view vẽ trong cây React của EditorContent nên đọc chữ và env qua context thay vì qua props của node. */
export const ViewContext = createContext<{ t: EditorText; env: DocEditorEnv | null; lang: Lang } | null>(null);

function useView() {
  const v = useContext(ViewContext);
  if (!v) throw new Error("Node view cần ViewContext.");
  return v;
}

function CodeBlockView({ node, updateAttributes, editor }: ReactNodeViewProps) {
  const { t, lang: uiLang } = useView();
  const lang = String(node.attrs.language ?? "");
  return (
    <NodeViewWrapper as="figure" className="my-4">
      <div className="hive-code m-0">
        <div contentEditable={false} className="hive-code-bar">
          {editor.isEditable ? (
            <input
              aria-label={t.language}
              placeholder={t.languagePh}
              value={lang}
              spellCheck={false}
              onChange={(e) => updateAttributes({ language: e.currentTarget.value.trim() || null })}
              className="h-6 w-32 rounded-md border border-border bg-transparent px-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          ) : (
            <span className="hive-code-lang">{languageLabel(lang)}</span>
          )}
          <span className="flex-1" />
          <CopyButton text={node.textContent} lang={uiLang} />
        </div>
        <pre>
          <NodeViewContent<"code"> as="code" className="hljs" />
        </pre>
      </div>
      {lang === "mermaid" && (
        <div contentEditable={false}>
          <MermaidDiagram code={node.textContent} lang={uiLang} debounceMs={300} hideSource className="mt-2" />
        </div>
      )}
    </NodeViewWrapper>
  );
}

function DocEmbedView({ node, updateAttributes, editor, selected }: ReactNodeViewProps) {
  const { t, env } = useView();
  const key = String(node.attrs.key ?? "");
  const valid = EMBED_LINE.test(`![[${key}]]`);
  return (
    <NodeViewWrapper
      data-drag-handle=""
      className={cn(
        "my-2 flex items-center gap-2 rounded-lg border px-3 py-2 text-sm",
        valid ? "border-border" : "border-destructive",
        selected && "ring-2 ring-ring",
      )}
    >
      <span aria-hidden="true">↗</span>
      {editor.isEditable ? (
        <input
          aria-label={t.embedKey}
          title={valid ? undefined : t.embedBad}
          aria-invalid={!valid}
          value={key}
          spellCheck={false}
          onChange={(e) => updateAttributes({ key: e.currentTarget.value.trim() })}
          className="min-w-0 flex-1 bg-transparent font-mono outline-none"
        />
      ) : (
        <span className="min-w-0 flex-1 truncate font-mono">{key}</span>
      )}
      {env &&
        valid &&
        env.link({ to: { kind: "doc", key }, className: "text-xs text-primary underline", children: t.openEmbed })}
    </NodeViewWrapper>
  );
}

/** Vùng tô trong tài liệu: khối có đề xuất đang chờ, chỗ để thẻ đề xuất ngay dưới khối, đoạn có bình luận mở. */
export type DocMarks = {
  highlight: number[];
  anchors: { index: number; key: string; host: HTMLElement }[];
  quotes: string[];
};

const EMPTY_MARKS: DocMarks = { highlight: [], anchors: [], quotes: [] };
const marksKey = new PluginKey<DocMarks>("hiveDocMarks");

export function setDocMarks(editor: Editor, marks: DocMarks) {
  if (editor.isDestroyed) return;
  editor.view.dispatch(editor.state.tr.setMeta(marksKey, marks).setMeta("addToHistory", false));
}

/** Bỏ ký hiệu Markdown của đoạn trích để tìm trong chữ hiển thị. */
const plainQuote = (q: string) =>
  q
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*|__|~~|`/g, "")
    .replace(/(^|\s)[*_]|[*_](?=\s|$)/g, "$1")
    .replace(/^\s*(#{1,6}\s+|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+|>\s*)/gm, "")
    .trim();

function quoteMarks(block: PMNode, pos: number, quotes: string[], out: Decoration[]) {
  let text = "";
  const at: number[] = [];
  block.forEach((child, offset) => {
    const piece = child.isText ? (child.text ?? "") : child.type.name === "requirement" ? `${child.attrs.id}:` : "￼";
    for (let k = 0; k < piece.length; k++) at.push(pos + 1 + offset + (child.isText ? k : 0));
    text += piece;
  });
  for (const q of quotes) {
    const i = q ? text.indexOf(q) : -1;
    const from = at[i];
    const to = at[i + q.length - 1];
    if (i < 0 || from === undefined || to === undefined) continue;
    out.push(Decoration.inline(from, to + 1, { class: "rounded-sm bg-warning-soft underline decoration-warning/60" }));
  }
}

function buildMarks(doc: PMNode, marks: DocMarks): DecorationSet {
  if (!marks.highlight.length && !marks.anchors.length && !marks.quotes.length) return DecorationSet.empty;
  const starts: number[] = [];
  doc.forEach((_, offset, index) => {
    starts[index] = offset;
  });
  const end = (i: number) => (starts[i] === undefined ? undefined : (starts[i] ?? 0) + doc.child(i).nodeSize);
  const out: Decoration[] = [];
  for (const i of marks.highlight) {
    const from = starts[i];
    const to = end(i);
    if (from !== undefined && to !== undefined)
      out.push(Decoration.node(from, to, { class: "rounded-md bg-warning-soft/40" }));
  }
  for (const a of marks.anchors) {
    const pos = end(a.index);
    // Thẻ đề xuất là React (portal vào `host`): ProseMirror bỏ qua sự kiện và chọn chữ bên trong.
    if (pos !== undefined)
      out.push(Decoration.widget(pos, a.host, { key: a.key, side: 1, ignoreSelection: true, stopEvent: () => true }));
  }
  const quotes = marks.quotes.map(plainQuote).filter(Boolean);
  if (quotes.length)
    doc.descendants((node, pos) => {
      if (!node.isTextblock) return true;
      quoteMarks(node, pos, quotes, out);
      return false;
    });
  return DecorationSet.create(doc, out);
}

const DocMarksExtension = Extension.create({
  name: "hiveDocMarks",
  addProseMirrorPlugins() {
    return [
      new Plugin<DocMarks>({
        key: marksKey,
        state: { init: () => EMPTY_MARKS, apply: (tr, value) => tr.getMeta(marksKey) ?? value },
        props: { decorations: (state) => buildMarks(state.doc, marksKey.getState(state) ?? EMPTY_MARKS) },
      }),
    ];
  },
});

/** Extension của trình soạn: schema của markdown.ts kèm giao diện node, menu `/`, dán, phím tắt. */
export function editorExtensions(opts: {
  slash: SlashController;
  codec: () => MarkdownCodec;
  text: () => EditorText;
  onLinkKey: () => void;
}): AnyExtension[] {
  return [
    ...docExtensions({
      codeBlock: CodeBlock.configure({ defaultLanguage: null }).extend({
        addNodeView: () => ReactNodeViewRenderer(CodeBlockView),
        addProseMirrorPlugins: () => [codeHighlight()],
      }),
      docEmbed: DocEmbed.extend({ addNodeView: () => ReactNodeViewRenderer(DocEmbedView) }),
    }),
    Placeholder.configure({
      placeholder: ({ editor, node }) =>
        editor.isEmpty ? opts.text().emptyDoc : node.type.name === "paragraph" ? opts.text().slashHint : "",
    }),
    slashCommand(opts.slash),
    DocMarksExtension,
    Extension.create({
      name: "hivePaste",
      addProseMirrorPlugins() {
        const editor = this.editor;
        return [
          new Plugin({
            props: {
              transformPastedHTML: cleanPastedHtml,
              handlePaste: (_view, event) => {
                const data = event.clipboardData;
                if (!data || data.getData("text/html")) return false;
                const text = data.getData("text/plain");
                if (!text || !looksLikeMarkdown(text) || editor.isActive("codeBlock") || editor.isActive("rawMarkdown"))
                  return false;
                return editor.commands.insertContent(opts.codec().fragment(text));
              },
            },
          }),
        ];
      },
    }),
    Extension.create({
      name: "hiveKeys",
      addKeyboardShortcuts: () => ({
        "Mod-k": () => {
          opts.onLinkKey();
          return true;
        },
      }),
    }),
  ];
}
