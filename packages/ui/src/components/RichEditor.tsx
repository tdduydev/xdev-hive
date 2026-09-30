// The Docs rich editor (roadmap 23a): Tiptap, Notion-like (a / menu, blocks dragged by their handle, a toolbar on the
// selection, Tab and Shift+Tab in lists), writing the page's Markdown back (lib/editor/markdown.ts). A page the editor
// would change opens only when asked (the Markdown mode keeps it as written). Loaded on demand: Docs imports it lazily.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  Bold,
  CheckSquare,
  Code,
  Code2,
  GripVertical,
  Heading1,
  Heading2,
  Heading3,
  ImageIcon,
  Italic,
  Link2,
  List,
  ListOrdered,
  Minus,
  Quote,
  Workflow,
  Strikethrough,
  Table as TableIcon,
  Trash2,
} from "lucide-react";
import { cn } from "cn";
import { Extension, type Editor, type Range } from "@tiptap/core";
import CodeBlock from "@tiptap/extension-code-block";
import DragHandle from "@tiptap/extension-drag-handle-react";
import Image, { type ImageOptions } from "@tiptap/extension-image";
import { Placeholder } from "@tiptap/extensions";
import { EditorContent, NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, useEditor, type NodeViewProps } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import Suggestion from "@tiptap/suggestion";
import { docAssetRef, DOC_ASSET_MAX_BYTES, resolveDocLink } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { AssetImage, uploadDocAsset } from "#ui/components/DocAssets.tsx";
import { LinkPicker } from "#ui/components/LinkPicker.tsx";
import { MermaidDiagram } from "#ui/components/Mermaid.tsx";
import { Notice } from "#ui/components/common.tsx";
import { errorMessage, useHive } from "#ui/hooks.ts";
import { useT, type TFunction } from "#ui/i18n/index.tsx";
import { docExtensions, parseDocMarkdown, richSafe, serializeDocMarkdown, withPageTitles } from "#ui/lib/editor/markdown.ts";
import { fold } from "#ui/lib/text.ts";

// ── The / menu ──

interface SlashItem {
  id: string;
  label: string;
  hint: string;
  icon: typeof Bold;
  keywords: string;
  run: (editor: Editor, range: Range) => void;
}

interface SlashState {
  open: boolean;
  items: SlashItem[];
  index: number;
  rect: DOMRect | null;
  pick: ((item: SlashItem) => void) | null;
}

function slashStore() {
  let state: SlashState = { open: false, items: [], index: 0, rect: null, pick: null };
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set: (next: Partial<SlashState>) => {
      state = { ...state, ...next };
      for (const l of listeners) l();
    },
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}
type SlashStore = ReturnType<typeof slashStore>;

function slashItems(t: TFunction, actions: { image: () => void; link: () => void }): SlashItem[] {
  const block = (id: string, icon: typeof Bold, run: (e: Editor) => void, keywords = ""): SlashItem => ({
    id,
    label: t(`editor.slash.${id}` as never),
    hint: t(`editor.slashHint.${id}` as never),
    icon,
    keywords,
    run: (e, range) => {
      e.chain().focus().deleteRange(range).run();
      run(e);
    },
  });
  return [
    block("h1", Heading1, (e) => e.chain().focus().setHeading({ level: 1 }).run(), "heading tieu de"),
    block("h2", Heading2, (e) => e.chain().focus().setHeading({ level: 2 }).run(), "heading tieu de"),
    block("h3", Heading3, (e) => e.chain().focus().setHeading({ level: 3 }).run(), "heading tieu de"),
    block("bullet", List, (e) => e.chain().focus().toggleBulletList().run(), "list danh sach"),
    block("ordered", ListOrdered, (e) => e.chain().focus().toggleOrderedList().run(), "list so"),
    block("task", CheckSquare, (e) => e.chain().focus().toggleTaskList().run(), "todo viec can lam checkbox"),
    block("quote", Quote, (e) => e.chain().focus().toggleBlockquote().run(), "blockquote trich dan"),
    block("code", Code2, (e) => e.chain().focus().toggleCodeBlock().run(), "code khoi"),
    block(
      "mermaid",
      Workflow,
      (e) => e.chain().focus().insertContent({ type: "codeBlock", attrs: { language: "mermaid" }, content: [{ type: "text", text: MERMAID_SAMPLE }] }).run(),
      "so do mermaid diagram flowchart luu do sequence",
    ),
    block("table", TableIcon, (e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(), "bang table"),
    block("divider", Minus, (e) => e.chain().focus().setHorizontalRule().run(), "hr duong ke"),
    block("image", ImageIcon, () => actions.image(), "anh hinh image"),
    block("link", Link2, () => actions.link(), "lien ket trang page link"),
  ];
}

/** The / menu as an editor extension: the items come from the component (their texts are translated there). */
const SlashCommand = Extension.create<{ store: SlashStore | null; items: () => SlashItem[] }>({
  name: "slashCommand",
  addOptions() {
    return { store: null, items: () => [] };
  },
  addProseMirrorPlugins() {
    const { store, items } = this.options;
    return [
      Suggestion<SlashItem>({
        editor: this.editor,
        char: "/",
        startOfLine: false,
        allowSpaces: false,
        items: ({ query }) => {
          const q = fold(query);
          return items().filter((i) => !q || fold(`${i.label} ${i.keywords} ${i.id}`).includes(q));
        },
        command: ({ editor, range, props }) => props.run(editor, range),
        render: () => ({
          onStart: (p) => store?.set({ open: true, items: p.items, index: 0, rect: p.clientRect?.() ?? null, pick: (item) => p.command(item) }),
          onUpdate: (p) => store?.set({ items: p.items, index: 0, rect: p.clientRect?.() ?? null, pick: (item) => p.command(item) }),
          onKeyDown: ({ event }) => {
            const s = store?.get();
            if (!s?.open || !s.items.length) return false;
            if (event.key === "ArrowDown") return store!.set({ index: (s.index + 1) % s.items.length }), true;
            if (event.key === "ArrowUp") return store!.set({ index: (s.index - 1 + s.items.length) % s.items.length }), true;
            if (event.key === "Enter" || event.key === "Tab") return s.pick?.(s.items[s.index]!), true;
            if (event.key === "Escape") return store!.set({ open: false }), true;
            return false;
          },
          onExit: () => store?.set({ open: false }),
        }),
      }),
    ];
  },
});

function SlashMenu({ store }: { store: SlashStore }) {
  const t = useT();
  const s = useSyncExternalStore(store.subscribe, store.get);
  if (!s.open || !s.rect) return null;
  return (
    <div
      role="listbox"
      aria-label={t("editor.slashTitle")}
      style={{ position: "fixed", left: s.rect.left, top: s.rect.bottom + 6, zIndex: 50 }}
      className="flex max-h-80 w-72 flex-col overflow-y-auto rounded-lg border border-line-default bg-raised p-1 shadow-e3"
    >
      {!s.items.length ? <span className="px-2 py-2 text-xs text-fg-muted">{t("editor.slashNone")}</span> : null}
      {s.items.map((item, i) => {
        const Icon = item.icon;
        return (
          <button
            key={item.id}
            type="button"
            role="option"
            aria-selected={i === s.index}
            onMouseEnter={() => store.set({ index: i })}
            onMouseDown={(e) => {
              e.preventDefault();
              s.pick?.(item);
            }}
            className={cn("flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-left outline-none", i === s.index && "bg-hover")}
          >
            <span className="grid size-8 shrink-0 place-items-center rounded-md border border-line-subtle bg-surface text-fg-secondary">
              <Icon className="size-4" />
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-[13px] font-medium text-fg-strong">{item.label}</span>
              <span className="truncate text-[11px] text-fg-muted">{item.hint}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

const MERMAID_SAMPLE = "flowchart LR\n  A[Yêu cầu] --> B{Máy rảnh?}\n  B -- có --> C[Chạy agent]\n  B -- không --> D[Chờ]";

// ── Code blocks: their language, and a Mermaid block's diagram under its code ──

function CodeBlockView({ node, updateAttributes, editor }: NodeViewProps) {
  const t = useT();
  const language = String(node.attrs.language ?? "");
  return (
    <NodeViewWrapper className="code-block my-1 overflow-hidden rounded-md border border-line-subtle bg-code">
      <div contentEditable={false} className="flex items-center gap-2 border-b border-line-subtle px-2.5 py-1">
        <input
          aria-label={t("editor.codeLanguage")}
          placeholder={t("editor.codeLanguage")}
          value={language}
          readOnly={!editor.isEditable}
          onChange={(e) => updateAttributes({ language: e.target.value.trim() || null })}
          className="w-32 bg-transparent font-mono text-[11px] text-fg-secondary outline-none placeholder:text-fg-disabled"
        />
        {language === "mermaid" ? <span className="ml-auto text-[11px] text-fg-muted">{t("editor.mermaidHint")}</span> : null}
      </div>
      <pre spellCheck={false}>
        <NodeViewContent<"code"> as="code" />
      </pre>
      {language === "mermaid" ? (
        <div contentEditable={false} className="border-t border-line-subtle bg-surface p-2">
          <MermaidDiagram code={node.textContent} delay={400} />
        </div>
      ) : null}
    </NodeViewWrapper>
  );
}

const DocCodeBlock = CodeBlock.extend({
  addNodeView() {
    // Only the view's own controls (the language, the diagram) keep their events. By default a click on the frame
    // around the code (the <pre> and <code>) is kept from the editor too: the caret moves there but the editor's
    // selection stays where it was, and Enter or Backspace then act on that.
    return ReactNodeViewRenderer(CodeBlockView, { stopEvent: ({ event }) => (event.target instanceof Element ? event.target.closest("[contenteditable=false]") !== null : false) });
  },
});

// ── Images of the page ──

function ImageView({ node, extension, selected }: NodeViewProps) {
  const docKey = (extension.options as { docKey: string }).docKey;
  const src = String(node.attrs.src ?? "");
  const alt = String(node.attrs.alt ?? "");
  const file = docAssetRef(src, docKey);
  return (
    <NodeViewWrapper className={cn("my-2 rounded-md", selected && "ring-2 ring-line-selected")} data-drag-handle>
      {file ? (
        <AssetImage docKey={file.key} name={file.name} alt={alt} />
      ) : (
        <span className="grid h-32 place-items-center rounded-md border border-dashed border-line-control bg-subtle font-mono text-xs text-fg-muted">{src}</span>
      )}
    </NodeViewWrapper>
  );
}

type DocImageOptions = ImageOptions & { docKey: string };
const DocImage = Image.extend<DocImageOptions>({
  addOptions() {
    return { ...(this.parent?.() as ImageOptions), docKey: "" };
  },
  addNodeView() {
    return ReactNodeViewRenderer(ImageView);
  },
});

// ── The editor ──

function Tool({ label, icon: Icon, active, onClick, disabled }: { label: string; icon: typeof Bold; active?: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        "grid size-7 cursor-pointer place-items-center rounded-[5px] text-fg-secondary outline-none hover:bg-hover hover:text-fg-strong focus-visible:focus-ring disabled:opacity-50",
        active && "bg-selected text-selected-fg",
      )}
    >
      <Icon className="size-[15px]" />
    </button>
  );
}

export interface RichEditorProps {
  docKey: string;
  /** The page's Markdown (the draft). */
  value: string;
  onChange: (markdown: string) => void;
  /** Pages that exist (key → title), for links. */
  titles: ReadonlyMap<string, string>;
  readOnly?: boolean;
  /** Above the text, in its column: the page's title. */
  header?: ReactNode;
  /** The page would change in this editor: the person chose the Markdown mode instead. */
  onUseMarkdown: () => void;
  onError: (message: string | null) => void;
}

export default function RichEditor(props: RichEditorProps) {
  const t = useT();
  // Checked once, with the page as it was when the editor opened.
  const [safe] = useState(() => richSafe(props.docKey, props.value));
  const [forced, setForced] = useState(false);
  if (!safe && !forced) {
    return (
      <div className="flex flex-col gap-3 p-5">
        <Notice tone="warn">{t("editor.unsafe")}</Notice>
        <div className="flex gap-2">
          <Button size="sm" onClick={props.onUseMarkdown}>
            {t("editor.useMarkdown")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setForced(true)}>
            {t("editor.openAnyway")}
          </Button>
        </div>
      </div>
    );
  }
  return <Editing {...props} />;
}

function Editing({ docKey, value, onChange, titles, readOnly, header, onError }: RichEditorProps) {
  const t = useT();
  const { client } = useHive();
  const store = useMemo(slashStore, []);
  const [picker, setPicker] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const emitted = useRef(value);
  // The page as this editor writes it before any change: coming back to it gives the page as it was written.
  const base = useRef<{ raw: string; md: string } | null>(null);
  base.current ??= { raw: value, md: serializeDocMarkdown(parseDocMarkdown(value)) };
  const actions = useRef({ image: () => fileInput.current?.click(), link: () => setPicker(true) });
  const items = useMemo(() => slashItems(t, { image: () => actions.current.image(), link: () => actions.current.link() }), [t]);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const titleOf = (target: string) => {
    const to = resolveDocLink(target, docKey, (k) => titles.has(k));
    return to?.exists ? titles.get(to.key) : undefined;
  };
  const load = (md: string) => withPageTitles(parseDocMarkdown(md), titleOf);

  const upload = async (files: File[], editor: Editor, at?: number) => {
    onError(null);
    for (const f of files) {
      try {
        const { asset, markdown } = await uploadDocAsset(client, docKey, f, t("errors.chatFileTooBig", { name: f.name, mb: DOC_ASSET_MAX_BYTES / 1024 / 1024 }));
        const src = /\((assets\/[^)]+)\)$/.exec(markdown)?.[1] ?? "";
        const node = asset.type.startsWith("image/")
          ? { type: "image", attrs: { src, alt: asset.name.replace(/\.[a-z0-9]+$/i, "") } }
          : { type: "paragraph", content: [{ type: "text", text: asset.name, marks: [{ type: "link", attrs: { href: src } }] }] };
        if (at !== undefined) editor.chain().focus().insertContentAt(at, node).run();
        else editor.chain().focus().insertContent(node).run();
      } catch (err) {
        onError(errorMessage(err));
      }
    }
  };
  const uploadRef = useRef(upload);
  uploadRef.current = upload;

  const editor = useEditor({
    immediatelyRender: false,
    editable: !readOnly,
    extensions: [
      ...docExtensions([]).filter((e) => e.name !== "image" && e.name !== "codeBlock"),
      DocImage.configure({ docKey, inline: false }),
      DocCodeBlock,
      Placeholder.configure({ placeholder: t("editor.placeholder") }),
      SlashCommand.configure({ store, items: () => itemsRef.current }),
    ],
    content: load(value),
    editorProps: {
      attributes: { class: "hive-prose min-h-[320px] outline-none", "aria-label": t("docs.content") },
      handlePaste: (_view, event) => {
        const files = [...(event.clipboardData?.files ?? [])];
        if (!files.length || !editor) return false;
        void uploadRef.current(files, editor);
        return true;
      },
      handleDrop: (view, event) => {
        const files = [...((event as DragEvent).dataTransfer?.files ?? [])];
        if (!files.length || !editor) return false;
        const at = view.posAtCoords({ left: (event as DragEvent).clientX, top: (event as DragEvent).clientY })?.pos;
        void uploadRef.current(files, editor, at);
        return true;
      },
    },
    onUpdate: ({ editor: e }) => {
      const written = serializeDocMarkdown(e.getJSON());
      const md = written === base.current?.md ? base.current.raw : written;
      if (md === emitted.current) return;
      emitted.current = md;
      onChange(md);
    },
  });

  // Changed outside the editor (the assistant's text applied, a draft dropped): show it.
  useEffect(() => {
    if (!editor || value === emitted.current) return;
    emitted.current = value;
    base.current = { raw: value, md: serializeDocMarkdown(parseDocMarkdown(value)) };
    editor.commands.setContent(load(value), { emitUpdate: false });
  }, [editor, value]);
  useEffect(() => {
    editor?.setEditable(!readOnly);
  }, [editor, readOnly]);

  if (!editor) return null;
  const e = editor;
  const toolbar: Array<{ id: string; icon: typeof Bold; active?: boolean; run: () => void } | "sep"> = [
    { id: "h2", icon: Heading2, active: e.isActive("heading", { level: 2 }), run: () => e.chain().focus().toggleHeading({ level: 2 }).run() },
    { id: "bold", icon: Bold, active: e.isActive("bold"), run: () => e.chain().focus().toggleBold().run() },
    { id: "italic", icon: Italic, active: e.isActive("italic"), run: () => e.chain().focus().toggleItalic().run() },
    { id: "code", icon: Code, active: e.isActive("code"), run: () => e.chain().focus().toggleCode().run() },
    "sep",
    { id: "bullet", icon: List, active: e.isActive("bulletList"), run: () => e.chain().focus().toggleBulletList().run() },
    { id: "ordered", icon: ListOrdered, active: e.isActive("orderedList"), run: () => e.chain().focus().toggleOrderedList().run() },
    { id: "task", icon: CheckSquare, active: e.isActive("taskList"), run: () => e.chain().focus().toggleTaskList().run() },
    { id: "quote", icon: Quote, active: e.isActive("blockquote"), run: () => e.chain().focus().toggleBlockquote().run() },
    { id: "codeBlock", icon: Code2, active: e.isActive("codeBlock"), run: () => e.chain().focus().toggleCodeBlock().run() },
    { id: "table", icon: TableIcon, run: () => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
    "sep",
    { id: "link", icon: Link2, active: picker, run: () => setPicker((v) => !v) },
    { id: "image", icon: ImageIcon, run: () => fileInput.current?.click() },
  ];
  const insertPageLink = (target: string) => {
    setPicker(false);
    const { from, to, empty } = e.state.selection;
    const shown = empty ? (titleOf(target) ?? target) : null;
    const text = shown ?? e.state.doc.textBetween(from, to);
    e.chain().focus().insertContent({ type: "text", text, marks: [{ type: "pageLink", attrs: { target, shown } }] }).insertContent(" ").run();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {!readOnly ? (
        <div className="relative shrink-0">
          <div role="toolbar" aria-label={t("docs.toolbar")} className="flex items-center gap-0.5 border-b border-line-subtle bg-subtle px-3 py-1">
            {toolbar.map((b, i) => (b === "sep" ? <span key={`s${i}`} className="mx-1 h-4 w-px bg-line-default" /> : <Tool key={b.id} label={t(`editor.tool.${b.id}` as never)} icon={b.icon} active={b.active} onClick={b.run} />))}
            <span className="ml-auto text-[11px]/none text-fg-muted">{t("editor.slashTip")}</span>
          </div>
          {picker ? <LinkPicker from={docKey} titles={titles} onClose={() => setPicker(false)} onPick={insertPageLink} /> : null}
        </div>
      ) : null}
      <input
        ref={fileInput}
        type="file"
        multiple
        accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,.txt,.md,.csv,.json"
        className="hidden"
        onChange={(ev) => {
          const files = [...(ev.target.files ?? [])];
          ev.target.value = "";
          if (files.length) void upload(files, e);
        }}
      />
      <div className="relative min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[760px] px-12 pt-6 pb-24">
          {!readOnly ? (
            <DragHandle editor={e}>
              <span className="grid h-6 w-4 cursor-grab place-items-center rounded-xs text-fg-disabled hover:bg-hover hover:text-fg-secondary" title={t("editor.drag")}>
                <GripVertical className="size-3.5" />
              </span>
            </DragHandle>
          ) : null}
          {header}
          <EditorContent editor={e} />
        </div>
        <BubbleMenu editor={e} shouldShow={({ editor: ed, state }) => !state.selection.empty && !ed.isActive("image") && !ed.isActive("codeBlock")}>
          <Bubble>
            <Tool label={t("editor.tool.bold")} icon={Bold} active={e.isActive("bold")} onClick={() => e.chain().focus().toggleBold().run()} />
            <Tool label={t("editor.tool.italic")} icon={Italic} active={e.isActive("italic")} onClick={() => e.chain().focus().toggleItalic().run()} />
            <Tool label={t("editor.tool.strike")} icon={Strikethrough} active={e.isActive("strike")} onClick={() => e.chain().focus().toggleStrike().run()} />
            <Tool label={t("editor.tool.code")} icon={Code} active={e.isActive("code")} onClick={() => e.chain().focus().toggleCode().run()} />
            <Tool label={t("editor.tool.link")} icon={Link2} active={e.isActive("pageLink")} onClick={() => (e.isActive("pageLink") ? e.chain().focus().unsetMark("pageLink").run() : setPicker(true))} />
          </Bubble>
        </BubbleMenu>
        <BubbleMenu editor={e} pluginKey="tableMenu" shouldShow={({ editor: ed, state }) => state.selection.empty && ed.isActive("table")}>
          <Bubble>
            <button type="button" className={BUBBLE_TEXT} onClick={() => e.chain().focus().addRowAfter().run()}>
              {t("editor.table.addRow")}
            </button>
            <button type="button" className={BUBBLE_TEXT} onClick={() => e.chain().focus().addColumnAfter().run()}>
              {t("editor.table.addColumn")}
            </button>
            <button type="button" className={BUBBLE_TEXT} onClick={() => e.chain().focus().deleteRow().run()}>
              {t("editor.table.deleteRow")}
            </button>
            <button type="button" className={BUBBLE_TEXT} onClick={() => e.chain().focus().deleteColumn().run()}>
              {t("editor.table.deleteColumn")}
            </button>
            <Tool label={t("editor.table.delete")} icon={Trash2} onClick={() => e.chain().focus().deleteTable().run()} />
          </Bubble>
        </BubbleMenu>
      </div>
      <SlashMenu store={store} />
    </div>
  );
}

const BUBBLE_TEXT = "h-7 cursor-pointer rounded-[5px] px-2 text-xs font-medium text-fg-secondary hover:bg-hover hover:text-fg-strong";

function Bubble({ children }: { children: ReactNode }) {
  return <div className="flex items-center gap-0.5 rounded-lg border border-line-default bg-raised p-1 shadow-e2">{children}</div>;
}
