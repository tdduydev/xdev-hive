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
import { type EditorText, editorExtensions, useLinkTarget, ViewContext } from "./editor-views.tsx";
import { type Lang, useOptionalDocEditorEnv } from "./env.tsx";
import { MarkdownCodec } from "./markdown.ts";
import { markdownPath, nameClipboardImage } from "./paste.ts";
import { SlashController as Slash, type SlashController, type SlashItem } from "./slash.ts";
import { docEditorText } from "./text.ts";

/** Kiểu chữ của nội dung soạn là `hive-prose` (packages/ui/src/prose.css, dùng chung với chế độ xem); ở đây chỉ phần riêng của ProseMirror. */
const PROSE = [
  "hive-prose min-h-40 outline-none",
  "[&_aside_p]:my-1",
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
  /** Tài liệu đang soạn (gốc phân giải link tương đối); file trên máy không có. */
  docKey: string | undefined;
  /** Tải file lên và chèn vào tài liệu; `null` khi app chủ không cung cấp `uploadAsset` hoặc đang chỉ đọc. */
  upload: ((files: File[]) => void) | null;
  /** Số file đang tải lên và lỗi của lần tải gần nhất (người dùng đóng thì xoá). */
  uploads: number;
  uploadError: string | null;
  dismissUploadError: () => void;
  /** Link tương đối vừa bấm, chờ app chủ phân giải để mở. */
  openLink: string | null;
  setOpenLink: (href: string | null) => void;
};

/** Đoạn văn chứa ảnh, hoặc link tới file đính kèm; mỗi file một đoạn để Markdown xuất ra mỗi file một dòng. */
function assetParagraph(file: File, relativePath: string): JSONContent {
  const href = markdownPath(relativePath);
  if (file.type.startsWith("image/"))
    return {
      type: "paragraph",
      content: [{ type: "image", attrs: { src: href, alt: file.name.replace(/\.[^.]+$/, "") } }],
    };
  return {
    type: "paragraph",
    content: [{ type: "text", text: file.name, marks: [{ type: "link", attrs: { href } }] }],
  };
}

/** Chèn tại `pos` (vị trí thả) hoặc con trỏ; con trỏ trong bảng thì chèn sau bảng vì ô GFM chỉ chứa chữ một dòng. */
function insertAssets(editor: Editor, content: JSONContent[], pos: number | null) {
  // Tài liệu có thể đã đổi trong lúc tải lên.
  if (pos !== null)
    return editor.chain().focus().insertContentAt(Math.min(pos, editor.state.doc.content.size), content).run();
  const after = afterTable(editor);
  return after !== null
    ? editor.chain().focus().insertContentAt(after, content).run()
    : editor.chain().focus().insertContent(content).run();
}

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
  docKey,
}: {
  value: string;
  onChange?: ((markdown: string) => void) | undefined;
  editable: boolean;
  lang: Lang;
  label: string;
  slashKinds?: BlockTemplate[] | undefined;
  onAi?: (() => void) | undefined;
  docKey?: string | undefined;
}): MarkdownEditorHandle {
  const t = docEditorText[lang];
  const tRef = useRef(t);
  tRef.current = t;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const codec = useMemo(() => new MarkdownCodec(), []);
  const slash = useMemo(() => new Slash(), []);
  const [linkOpen, setLinkOpen] = useState(false);
  const env = useOptionalDocEditorEnv();
  const envRef = useRef(env);
  envRef.current = env;
  const docKeyRef = useRef(docKey);
  docKeyRef.current = docKey;
  const editorRef = useRef<Editor | null>(null);
  const [uploads, setUploads] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [openLink, setOpenLink] = useState<string | null>(null);
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

  const uploadFiles = async (files: File[], pos: number | null) => {
    const e = envRef.current;
    const key = docKeyRef.current;
    if (!e?.uploadAsset || !key) return;
    setUploadError(null);
    setUploads((n) => n + files.length);
    const content: JSONContent[] = [];
    for (const original of files) {
      const file = original.type.startsWith("image/") ? nameClipboardImage(original) : original;
      try {
        const { relativePath } = await e.uploadAsset(key, file);
        content.push(assetParagraph(file, relativePath));
      } catch (error) {
        setUploadError(tRef.current.uploadFailed(file.name, e.errorMessage(error)));
      } finally {
        setUploads((n) => n - 1);
      }
    }
    const editor = editorRef.current;
    if (content.length && editor && !editor.isDestroyed) insertAssets(editor, content, pos);
  };
  const uploadRef = useRef(uploadFiles);
  uploadRef.current = uploadFiles;

  const extensions = useMemo(
    () =>
      editorExtensions({
        slash,
        codec: () => codec,
        text: () => tRef.current,
        onLinkKey: () => setLinkOpen(true),
        onFiles: (files, pos) => {
          if (!envRef.current?.uploadAsset || !docKeyRef.current || !editorRef.current?.isEditable) return false;
          void uploadRef.current(files, pos);
          return true;
        },
        onOpenLink: (href) => {
          if (envRef.current?.resolveLink && docKeyRef.current) setOpenLink(href);
        },
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

  editorRef.current = editor;

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
    docKey,
    upload: env?.uploadAsset && docKey && editable ? (files) => void uploadFiles(files, null) : null,
    uploads,
    uploadError,
    dismissUploadError: () => setUploadError(null),
    openLink,
    setOpenLink,
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
    else c.setLink({ href: /^([a-z][a-z0-9+.-]*:|\/|#|\.{1,2}\/)/i.test(url) ? url : `https://${url}` }).run();
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
  const imageInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
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
        {h.upload && (
          <>
            <Sep />
            <Tb label={t.insertImage} disabled={off} onClick={() => imageInput.current?.click()}>
              🖼
            </Tb>
            <Tb label={t.attachFile} disabled={off} onClick={() => fileInput.current?.click()}>
              📎
            </Tb>
            {([imageInput, fileInput] as const).map((ref, i) => (
              <input
                key={i === 0 ? "image" : "file"}
                ref={ref}
                type="file"
                hidden
                multiple
                data-testid={i === 0 ? "insert-image-input" : "attach-file-input"}
                accept={i === 0 ? "image/*" : undefined}
                onChange={(e) => {
                  const files = Array.from(e.currentTarget.files ?? []);
                  e.currentTarget.value = "";
                  if (files.length) h.upload?.(files);
                }}
              />
            ))}
          </>
        )}
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
      {(h.uploads > 0 || h.uploadError) && (
        <div
          role={h.uploadError ? "alert" : "status"}
          className={cn(
            "flex items-center gap-2 border-b border-border px-5 py-1.5 text-sm",
            h.uploadError ? "bg-destructive-soft text-destructive" : "bg-background text-muted-foreground",
          )}
        >
          <span className="min-w-0 flex-1">{h.uploadError ?? t.uploading(h.uploads)}</span>
          {h.uploadError && (
            <button
              type="button"
              aria-label={t.dismiss}
              className="h-6 cursor-pointer rounded-md border-0 bg-transparent px-1.5 hover:bg-muted"
              onClick={h.dismissUploadError}
            >
              ✕
            </button>
          )}
        </div>
      )}
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

/** Đích của link tương đối vừa bấm; app chủ quyết định mở trang nào (`env.link`), file đính kèm và link ngoài mở tab mới. */
function LinkTargetBar({ h }: { h: MarkdownEditorHandle }) {
  const env = useOptionalDocEditorEnv();
  const href = h.openLink ?? "";
  const state = useLinkTarget(env, h.docKey, href);
  if (h.openLink === null || !env) return null;
  const { t } = h;
  const target = state?.status === "ready" ? state.target : null;
  const anchor = "text-primary underline";
  return (
    <div
      role="status"
      className="sticky bottom-3 z-3 mt-3 flex w-fit max-w-full items-center gap-3 rounded-lg border border-border bg-popover px-3 py-1.5 text-sm shadow-lg"
    >
      <span className="min-w-0 truncate font-mono text-xs text-muted-foreground" title={href}>
        {href}
      </span>
      {!state || state.status === "loading" ? (
        <span className="text-muted-foreground">{t.linkResolving}</span>
      ) : !target ? (
        <span className="text-muted-foreground">{t.linkNone}</span>
      ) : target.kind === "doc" ? (
        env.link({ to: { kind: "doc", key: target.key }, className: anchor, children: t.openLinkedDoc(target.key) })
      ) : (
        <a href={target.url} target="_blank" rel="noopener noreferrer" className={anchor}>
          {target.kind === "asset" ? t.openLinkedAsset : t.openLinkedExternal}
        </a>
      )}
      <button
        type="button"
        aria-label={t.dismiss}
        className="h-6 cursor-pointer rounded-md border-0 bg-transparent px-1.5 hover:bg-muted"
        onClick={() => h.setOpenLink(null)}
      >
        ✕
      </button>
    </div>
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
  const view = useMemo(
    () => ({ t: h.t, env, lang: h.t === docEditorText.en ? ("en" as const) : ("vi" as const), docKey: h.docKey }),
    [h.t, env, h.docKey],
  );
  return (
    <ViewContext.Provider value={view}>
      <EditorContent editor={h.editor} className={className} />
      <LinkTargetBar h={h} />
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
