import type { Editor, JSONContent } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import { nextRequirementId } from "@xdev-hive/contracts";
import { NativeSelect } from "@xdev-hive/ui/native-select";
import { cn } from "cn";
import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { type BlockTemplate, blockTemplate } from "./blocks.ts";
import { type EditorText, editorExtensions, ViewContext } from "./editor-views.tsx";
import { type Lang, useOptionalDocEditorEnv } from "./env.tsx";
import { MarkdownCodec } from "./markdown.ts";
import { SlashController as Slash, type SlashController, type SlashItem } from "./slash.ts";
import { docEditorText } from "./text.ts";

/** Kiểu chữ của nội dung soạn; Tailwind không có plugin typography nên viết theo thẻ con. */
const PROSE = [
  "min-h-40 text-[15px] leading-[1.75] text-foreground outline-none",
  "[&_h1]:mt-6 [&_h1]:mb-3 [&_h1]:text-2xl [&_h1]:font-semibold [&_h1]:tracking-tight",
  "[&_h2]:mt-6 [&_h2]:mb-2 [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:mt-5 [&_h3]:mb-2 [&_h3]:text-lg [&_h3]:font-semibold",
  "[&_h4]:mt-4 [&_h4]:font-semibold [&_p]:my-2",
  "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-6 [&_li>p]:my-0.5",
  "[&_ul[data-type=taskList]]:list-none [&_ul[data-type=taskList]]:pl-0.5 [&_li[data-checked]]:flex [&_li[data-checked]]:items-start [&_li[data-checked]]:gap-2.5",
  "[&_li[data-checked]>label]:mt-1.5 [&_li[data-checked]>div]:flex-1 [&_li[data-checked=true]>div]:text-muted-foreground [&_input[type=checkbox]]:accent-primary",
  "[&_blockquote]:my-3 [&_blockquote]:border-l-3 [&_blockquote]:border-border [&_blockquote]:pl-3.5 [&_blockquote]:text-muted-foreground",
  "[&_aside_p]:my-1 [&_hr]:my-6 [&_hr]:border-border [&_a]:text-primary [&_a]:underline",
  "[&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-muted [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:font-mono [&_:not(pre)>code]:text-[0.9em]",
  "[&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_table]:text-sm [&_td]:border [&_td]:border-border [&_td]:px-2.5 [&_td]:py-1.5",
  "[&_th]:border [&_th]:border-border [&_th]:bg-muted [&_th]:px-2.5 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-semibold [&_td>p]:my-0 [&_th>p]:my-0 [&_.selectedCell]:bg-accent/60",
  "[&_p.is-empty]:before:pointer-events-none [&_p.is-empty]:before:float-left [&_p.is-empty]:before:h-0 [&_p.is-empty]:before:text-muted-foreground [&_p.is-empty]:before:content-[attr(data-placeholder)]",
  "[&_pre[data-raw-markdown]]:before:mb-1 [&_pre[data-raw-markdown]]:before:block [&_pre[data-raw-markdown]]:before:font-sans [&_pre[data-raw-markdown]]:before:text-xs [&_pre[data-raw-markdown]]:before:text-muted-foreground [&_pre[data-raw-markdown]]:before:content-['Markdown']",
  "[&_.ProseMirror-selectednode]:outline-2 [&_.ProseMirror-selectednode]:outline-ring",
].join(" ");

/** Khối có trong menu `/` của tài liệu trên hub; file trên máy bỏ nhúng tài liệu hub. */
export const DOC_SLASH: BlockTemplate[] = [
  "h2",
  "checklist",
  "table",
  "requirement",
  "code",
  "mermaid",
  "embed",
  "callout",
];
export const FILE_SLASH: BlockTemplate[] = [
  "h1",
  "h2",
  "bullet",
  "ordered",
  "checklist",
  "table",
  "code",
  "mermaid",
  "callout",
];

/** Vị trí ngay sau bảng chứa con trỏ, nếu có. */
function afterTable(editor: Editor): number | null {
  const { $from } = editor.state.selection;
  for (let d = $from.depth; d > 0; d--) if ($from.node(d).type.name === "table") return $from.after(d);
  return null;
}

/** Chèn khối theo mẫu của blocks.ts tại con trỏ; kiểu chữ và danh sách đổi khối hiện tại thay vì chèn chữ mẫu. */
export function insertTemplate(editor: Editor, kind: BlockTemplate, codec: MarkdownCodec): boolean {
  const c = editor.chain().focus();
  // Ô bảng GFM chỉ chứa được chữ một dòng: khối chèn lúc con trỏ trong bảng đặt ngay sau bảng.
  const after = afterTable(editor);
  if (after !== null)
    return c.insertContentAt(after, codec.fragment(blockTemplate(kind, codec.serialize(editor.state.doc)))).run();
  switch (kind) {
    case "h1":
    case "h2":
      return c.setNode("heading", { level: kind === "h1" ? 1 : 2 }).run();
    case "para":
      return c.setParagraph().run();
    case "bullet":
      return c.toggleBulletList().run();
    case "ordered":
      return c.toggleOrderedList().run();
    case "checklist":
      return c.toggleTaskList().run();
    case "requirement": {
      const req: JSONContent[] = [
        { type: "requirement", attrs: { id: nextRequirementId(codec.serialize(editor.state.doc)) } },
        { type: "text", text: " " },
      ];
      if (editor.isActive("listItem") || editor.isActive("taskItem")) return c.insertContent(req).run();
      return c
        .insertContent({
          type: "bulletList",
          content: [{ type: "listItem", content: [{ type: "paragraph", content: req }] }],
        })
        .run();
    }
    default:
      return c.insertContent(codec.fragment(blockTemplate(kind, codec.serialize(editor.state.doc)))).run();
  }
}

export type MarkdownEditorHandle = {
  editor: Editor | null;
  codec: MarkdownCodec;
  slash: SlashController;
  t: EditorText;
  linkOpen: boolean;
  setLinkOpen: (open: boolean) => void;
  /** Chữ Markdown của khối cấp cao chứa con trỏ (neo bình luận, ngữ cảnh cho AI). */
  currentBlock: () => string;
  /** Chữ thường đang chọn. */
  selectedText: () => string;
};

/**
 * Trình soạn Tiptap trên chữ Markdown: `value` vào, `onChange` ra Markdown. Đổi `value` từ ngoài (người khác lưu, nhận
 * đề xuất) thì nạp lại; giá trị chính nó vừa phát ra thì bỏ qua để gõ (kể cả gõ dấu tiếng Việt qua IME) không bị nạp
 * lại giữa chừng.
 */
export function useMarkdownEditor({
  value,
  onChange,
  editable,
  lang,
  label,
  slashKinds = DOC_SLASH,
  onAi,
}: {
  value: string;
  onChange?: ((markdown: string) => void) | undefined;
  editable: boolean;
  lang: Lang;
  label: string;
  slashKinds?: BlockTemplate[] | undefined;
  onAi?: (() => void) | undefined;
}): MarkdownEditorHandle {
  const t = docEditorText[lang];
  const tRef = useRef(t);
  tRef.current = t;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const codec = useMemo(() => new MarkdownCodec(), []);
  const slash = useMemo(() => new Slash(), []);
  const [linkOpen, setLinkOpen] = useState(false);
  // `value`: giá trị app chủ đang giữ; `initial`, `baseline`: chữ lúc nạp và bản xuất ngay sau khi nạp.
  const sync = useRef({ value, initial: value, baseline: "" });
  const first = useRef<ReturnType<MarkdownCodec["parse"]> | null>(null);
  first.current ??= codec.parse(value);

  const load = (editor: Editor, next: string) => {
    const { doc, groups } = codec.parse(next);
    const keep = editor.isFocused ? editor.state.selection.from : null;
    editor.commands.setContent(doc, { emitUpdate: false });
    if (keep !== null) editor.commands.setTextSelection(Math.min(keep, editor.state.doc.content.size - 1));
    codec.remember(editor.state.doc, groups);
    sync.current = { value: next, initial: next, baseline: codec.serialize(editor.state.doc) };
  };

  const emit = (editor: Editor) => {
    const s = sync.current;
    const md = codec.serialize(editor.state.doc);
    let out = md === s.baseline ? s.initial : md;
    // File trên máy không có dòng trống cuối thì giữ như vậy.
    if (out !== s.initial && s.initial && !s.initial.endsWith("\n")) out = out.replace(/\n$/, "");
    if (out === s.value) return;
    s.value = out;
    onChangeRef.current?.(out);
  };

  const extensions = useMemo(
    () =>
      editorExtensions({
        slash,
        codec: () => codec,
        text: () => tRef.current,
        onLinkKey: () => setLinkOpen(true),
      }),
    [codec, slash],
  );
  const editor = useEditor(
    {
      extensions,
      editable,
      editorProps: {
        attributes: { role: "textbox", "aria-multiline": "true", "aria-label": label, class: PROSE },
      },
      content: first.current.doc,
      onCreate: ({ editor }) => {
        if (first.current) codec.remember(editor.state.doc, first.current.groups);
        sync.current.baseline = codec.serialize(editor.state.doc);
      },
      onUpdate: ({ editor }) => emit(editor),
    },
    [],
  );

  useEffect(() => {
    // Đang ghép chữ (IME) thì chưa nạp lại: lần vẽ sau khi ghép xong sẽ nạp.
    if (editor && value !== sync.current.value && !editor.view.composing) load(editor, value);
  });
  useEffect(() => {
    if (editor && editor.isEditable !== editable) editor.setEditable(editable, false);
  }, [editor, editable]);
  useEffect(() => {
    editor?.setOptions({
      editorProps: { attributes: { role: "textbox", "aria-multiline": "true", "aria-label": label, class: PROSE } },
    });
  }, [editor, label]);

  slash.items = (query) => {
    const q = query.toLowerCase();
    const items: SlashItem[] = slashKinds.map((k) => ({
      id: k,
      label: t.insert[k],
      hint: t.insertHint[k],
      run: (ed) => insertTemplate(ed, k, codec),
    }));
    if (onAi) items.push({ id: "ai", label: `✦ ${t.writeAi}`, hint: t.writeAiHint, run: () => onAi() });
    return items.filter((i) => !q || i.label.toLowerCase().includes(q) || i.id.includes(q));
  };

  return {
    editor,
    codec,
    slash,
    t,
    linkOpen,
    setLinkOpen,
    currentBlock: () => {
      if (!editor) return "";
      return codec.blocks(editor.state.doc)[editor.state.selection.$from.index(0)] ?? "";
    },
    selectedText: () => {
      if (!editor) return "";
      const { from, to } = editor.state.selection;
      return editor.state.doc.textBetween(from, to, "\n");
    },
  };
}

export function Tb({
  label,
  onClick,
  disabled,
  active,
  className,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean | undefined;
  active?: boolean | undefined;
  className?: string | undefined;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      aria-pressed={active === undefined ? undefined : active}
      // Giữ chữ đang chọn trong trình soạn khi bấm nút định dạng.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        "inline-flex h-7.5 min-w-7.5 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent px-1 text-sm text-foreground hover:bg-muted disabled:cursor-default disabled:opacity-40",
        active && "bg-muted",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Sep() {
  return <span aria-hidden="true" className="mx-1.5 h-4.5 w-px bg-border" />;
}

const MARKS = [
  ["bold", "B", "font-bold"],
  ["italic", "I", "italic"],
  ["strike", "S", "line-through"],
  ["code", "</>", "font-mono"],
] as const;

function toggleMark(editor: Editor, mark: (typeof MARKS)[number][0]) {
  const c = editor.chain().focus();
  if (mark === "bold") c.toggleBold();
  else if (mark === "italic") c.toggleItalic();
  else if (mark === "strike") c.toggleStrike();
  else c.toggleCode();
  c.run();
}

function useToolState(editor: Editor | null) {
  return useEditorState({
    editor,
    selector: ({ editor: e }) => {
      if (!e) return null;
      const level = [1, 2, 3].find((l) => e.isActive("heading", { level: l }));
      return {
        editable: e.isEditable,
        kind: level ? (`h${level}` as const) : e.isActive("paragraph") ? ("para" as const) : null,
        bold: e.isActive("bold"),
        italic: e.isActive("italic"),
        strike: e.isActive("strike"),
        code: e.isActive("code"),
        link: e.isActive("link"),
        table: e.isActive("table"),
        inCode: e.isActive("codeBlock") || e.isActive("rawMarkdown"),
      };
    },
  });
}

/** Ô nhập địa chỉ cho liên kết (Mod-K hoặc nút ↗); window.prompt không chạy trong webview của app desktop. */
function LinkInput({ h }: { h: MarkdownEditorHandle }) {
  const { editor, t } = h;
  const [href, setHref] = useState(() => String(editor?.getAttributes("link").href ?? ""));
  if (!editor) return null;
  const apply = () => {
    const url = href.trim();
    const c = editor.chain().focus().extendMarkRange("link");
    if (!url) c.unsetLink().run();
    else c.setLink({ href: /^([a-z][a-z0-9+.-]*:|\/|#)/i.test(url) ? url : `https://${url}` }).run();
    h.setLinkOpen(false);
  };
  return (
    <form
      className="flex items-center gap-1.5 border-b border-border bg-background px-5 py-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        apply();
      }}
    >
      <input
        // biome-ignore lint/a11y/noAutofocus: ô vừa mở bằng phím tắt hoặc nút liên kết.
        autoFocus
        aria-label={t.linkUrl}
        placeholder="https://"
        value={href}
        onChange={(e) => setHref(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            h.setLinkOpen(false);
            editor.commands.focus();
          }
        }}
        className="h-7 min-w-0 flex-1 rounded-md border border-border bg-transparent px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <button type="submit" className="h-7 cursor-pointer rounded-md border border-border px-2 text-sm hover:bg-muted">
        {t.linkApply}
      </button>
      <button
        type="button"
        className="h-7 cursor-pointer rounded-md px-2 text-sm text-muted-foreground hover:bg-muted"
        onClick={() => {
          editor.chain().focus().extendMarkRange("link").unsetLink().run();
          h.setLinkOpen(false);
        }}
      >
        {t.unlink}
      </button>
    </form>
  );
}

/** Thanh công cụ (DocEditor.dc.html): kiểu khối, định dạng chữ, chèn khối; `children` là nút riêng của app chủ. */
export function EditorToolbar({
  h,
  inserts = ["bullet", "ordered", "checklist", "table", "callout", "mermaid"],
  children,
}: {
  h: MarkdownEditorHandle;
  inserts?: BlockTemplate[];
  children?: ReactNode;
}) {
  const { editor, t } = h;
  const s = useToolState(editor);
  const off = !editor || !s?.editable;
  const icon: Partial<Record<BlockTemplate, ReactNode>> = {
    bullet: "•≡",
    ordered: "1≡",
    checklist: "☑",
    table: "▦",
    callout: "ⓘ",
    mermaid: "mmd",
    code: "{ }",
  };
  return (
    <div className="sticky top-0 z-3 bg-background">
      <div
        role="toolbar"
        aria-label={t.toolbar}
        className="flex flex-wrap items-center gap-0.5 border-b border-border px-5 py-1.5"
      >
        <NativeSelect
          aria-label={t.blockType}
          size="sm"
          className="w-36! shrink-0 text-sm"
          disabled={off || !s?.kind}
          value={s?.kind ?? ""}
          onChange={(e) => {
            const v = e.currentTarget.value;
            const c = editor?.chain().focus();
            if (v === "para") c?.setParagraph().run();
            else c?.setNode("heading", { level: Number(v.slice(1)) }).run();
          }}
        >
          <option value="" disabled>
            {t.blockType}
          </option>
          <option value="para">{t.para}</option>
          <option value="h1">{t.h1}</option>
          <option value="h2">{t.h2}</option>
          <option value="h3">{t.h3}</option>
        </NativeSelect>
        <Sep />
        {MARKS.map(([m, glyph, cls]) => (
          <Tb
            key={m}
            label={t[m]}
            disabled={off || s?.inCode}
            active={s?.[m]}
            className={cls}
            onClick={() => editor && toggleMark(editor, m)}
          >
            {glyph}
          </Tb>
        ))}
        <Tb label={t.link} disabled={off || s?.inCode} active={s?.link} onClick={() => h.setLinkOpen(!h.linkOpen)}>
          ↗
        </Tb>
        <Sep />
        {inserts.map((k) => (
          <Tb
            key={k}
            label={t.insert[k]}
            disabled={off}
            className={k === "mermaid" ? "px-1.5 font-mono text-xs" : undefined}
            onClick={() => editor && insertTemplate(editor, k, h.codec)}
          >
            {icon[k] ?? t.insert[k]}
          </Tb>
        ))}
        {s?.table && !off && (
          <>
            <Sep />
            {(
              [
                ["rowAdd", "+≡", () => editor?.chain().focus().addRowAfter().run()],
                ["colAdd", "+‖", () => editor?.chain().focus().addColumnAfter().run()],
                ["rowDel", "−≡", () => editor?.chain().focus().deleteRow().run()],
                ["colDel", "−‖", () => editor?.chain().focus().deleteColumn().run()],
                ["tableDel", "✕▦", () => editor?.chain().focus().deleteTable().run()],
              ] as const
            ).map(([k, glyph, run]) => (
              <Tb key={k} label={t.table[k]} onClick={run} className="px-1.5 text-xs">
                {glyph}
              </Tb>
            ))}
          </>
        )}
        {children}
      </div>
      {h.linkOpen && !off && <LinkInput h={h} />}
    </div>
  );
}

function FormatBubble({ h, onComment }: { h: MarkdownEditorHandle; onComment?: (() => void) | undefined }) {
  const { editor, t } = h;
  const s = useToolState(editor);
  if (!editor) return null;
  return (
    <BubbleMenu
      editor={editor}
      shouldShow={({ state, view }) =>
        view.hasFocus() &&
        !state.selection.empty &&
        !(state.selection instanceof NodeSelection) &&
        !editor.isActive("codeBlock") &&
        !editor.isActive("rawMarkdown") &&
        (editor.isEditable || !!onComment)
      }
    >
      <div
        role="toolbar"
        aria-label={t.selectionMenu}
        className="flex items-center gap-0.5 rounded-lg border border-border bg-popover p-1 shadow-lg"
      >
        {s?.editable && (
          <>
            {MARKS.map(([m, glyph, cls]) => (
              <Tb key={m} label={t[m]} active={s[m]} className={cls} onClick={() => toggleMark(editor, m)}>
                {glyph}
              </Tb>
            ))}
            <Tb label={t.link} active={s.link} onClick={() => h.setLinkOpen(true)}>
              ↗
            </Tb>
          </>
        )}
        {onComment && (
          <>
            {s?.editable && <Sep />}
            <Tb label={t.comment} onClick={onComment}>
              ❝
            </Tb>
          </>
        )}
      </div>
    </BubbleMenu>
  );
}

function SlashMenu({ slash, t }: { slash: SlashController; t: EditorText }) {
  const s = useSyncExternalStore(slash.subscribe, slash.snapshot);
  if (!s) return null;
  return createPortal(
    <div role="listbox" aria-label={t.slash} className="w-72 rounded-lg border border-border bg-popover p-1 shadow-lg">
      <div className="px-2.5 py-1.5 text-xs text-muted-foreground">{t.blocks}</div>
      {s.items.map((item, i) => (
        <button
          key={item.id}
          type="button"
          role="option"
          aria-selected={i === s.active}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => s.pick(item)}
          className={cn(
            "flex w-full cursor-pointer flex-col rounded-md border-0 bg-transparent px-2.5 py-1.5 text-left text-sm hover:bg-muted",
            i === s.active && "bg-muted",
          )}
        >
          <span>{item.label}</span>
          {item.hint && <span className="text-xs text-muted-foreground">{item.hint}</span>}
        </button>
      ))}
    </div>,
    s.host,
  );
}

/** Vùng soạn: nội dung, menu định dạng khi chọn chữ, menu `/`. */
export function EditorSurface({
  h,
  onComment,
  className,
}: {
  h: MarkdownEditorHandle;
  onComment?: (() => void) | undefined;
  className?: string | undefined;
}) {
  const env = useOptionalDocEditorEnv();
  const view = useMemo(() => ({ t: h.t, env }), [h.t, env]);
  return (
    <ViewContext.Provider value={view}>
      <EditorContent editor={h.editor} className={className} />
      <FormatBubble h={h} onComment={onComment} />
      <SlashMenu slash={h.slash} t={h.t} />
    </ViewContext.Provider>
  );
}

/**
 * Trình soạn Markdown đứng riêng (không có bình luận, đề xuất): app desktop dùng cho file .md trong thư mục và chế độ
 * Sửa của tài liệu hub ở màn Tài liệu từ code. Lưu vẫn là chữ Markdown.
 */
export function MarkdownEditor({
  value,
  onChange,
  lang,
  label,
  onKeyDown,
  className,
}: {
  value: string;
  onChange: (markdown: string) => void;
  lang: Lang;
  label: string;
  onKeyDown?: ((e: KeyboardEvent<HTMLDivElement>) => void) | undefined;
  className?: string | undefined;
}) {
  const h = useMarkdownEditor({ value, onChange, editable: true, lang, label, slashKinds: FILE_SLASH });
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: bắt phím tắt lưu (Mod-S) nổi lên từ vùng soạn bên trong.
    <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", className)} onKeyDown={onKeyDown}>
      <EditorToolbar h={h} inserts={["bullet", "ordered", "checklist", "table", "code", "callout", "mermaid"]} />
      <div className="min-h-0 flex-1 overflow-y-auto px-9 py-6">
        <EditorSurface h={h} />
      </div>
    </div>
  );
}
