import { MarkdownEditor } from "@xdev-hive/doc-editor";
import { Button } from "@xdev-hive/ui/button";
import { Textarea } from "@xdev-hive/ui/textarea";
import { LoaderCircleIcon, XIcon } from "lucide-react";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "@/components/doc-view.tsx";
import { type LocalFile, readLocalFile, writeLocalFile } from "@/lib/agent.ts";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import { errorText } from "@/lib/tauri.ts";
import { cn } from "@/lib/utils.ts";

const text: Dict<{
  label: string;
  loading: string;
  view: string;
  edit: string;
  save: string;
  saving: string;
  saved: string;
  unsaved: string;
  localDoc: string;
  readOnly: string;
  readOnlyHint: string;
  close: string;
  changedOnDisk: string;
  reload: string;
  keep: string;
  empty: string;
}> = {
  vi: {
    label: "File trong thư mục",
    loading: "Đang đọc…",
    view: "Xem",
    edit: "Sửa",
    save: "Lưu vào file",
    saving: "Đang lưu…",
    saved: "Đã lưu vào file",
    unsaved: "Chưa lưu",
    localDoc: "Tài liệu trên máy",
    readOnly: "Chỉ xem",
    readOnlyHint: "File code chỉ xem ở đây; nhờ agent sửa (chế độ Accept edits) hoặc mở bằng trình soạn code.",
    close: "Đóng file",
    changedOnDisk: "File vừa đổi trên đĩa (agent đã sửa). Bản bạn đang soạn chưa lưu.",
    reload: "Lấy bản trên đĩa",
    keep: "Giữ bản đang soạn",
    empty: "File trống.",
  },
  en: {
    label: "File in the folder",
    loading: "Reading…",
    view: "View",
    edit: "Edit",
    save: "Save to file",
    saving: "Saving…",
    saved: "Saved to file",
    unsaved: "Unsaved",
    localDoc: "Local doc",
    readOnly: "View only",
    readOnlyHint: "Code files are view-only here; ask the agent (Accept edits mode) or open them in a code editor.",
    close: "Close file",
    changedOnDisk: "The file just changed on disk (the agent edited it). Your edits here are not saved.",
    reload: "Use the disk version",
    keep: "Keep my edits",
    empty: "Empty file.",
  },
};

const isMarkdown = (path: string) => /\.(md|mdx|markdown)$/i.test(path);

/**
 * File mở từ cây ở khung giữa màn Tài liệu: tài liệu (.md, .mdx, .txt) xem và sửa được rồi "Lưu vào file"; file code chỉ
 * xem, chữ đơn cách kèm số dòng. File Markdown sửa bằng trình soạn dùng chung với web, lưu ra vẫn là Markdown. Không
 * cần liên kết hub. `reload` tăng khi agent sửa file trong thư mục: bản chưa sửa thì đọc lại luôn, đang soạn dở thì hỏi.
 */
export function LocalFileView({
  folder,
  path,
  reload,
  onClose,
}: {
  folder: string;
  path: string;
  reload: number;
  onClose: () => void;
}) {
  const t = useT(text);
  const lang = useLang();
  const [file, setFile] = useState<LocalFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [onDisk, setOnDisk] = useState<LocalFile | null>(null);
  const dirtyRef = useRef(false);
  const fileRef = useRef<LocalFile | null>(null);

  const dirty = !!file && draft !== file.content;
  dirtyRef.current = dirty;
  fileRef.current = file;

  useEffect(() => {
    let alive = true;
    setFile(null);
    setError(null);
    setOnDisk(null);
    setMode("view");
    setJustSaved(false);
    readLocalFile(folder, path).then(
      (f) => {
        if (!alive) return;
        setFile(f);
        setDraft(f.content);
      },
      (e) => alive && setError(errorText(e)),
    );
    return () => {
      alive = false;
    };
  }, [folder, path]);

  // Agent sửa file: đọc lại. Đang soạn dở thì không ghi đè, chỉ báo.
  // biome-ignore lint/correctness/useExhaustiveDependencies: chỉ chạy khi reload tăng
  useEffect(() => {
    if (!reload) return;
    let alive = true;
    readLocalFile(folder, path).then(
      (f) => {
        const cur = fileRef.current;
        if (!alive || (cur && f.content === cur.content)) return;
        if (dirtyRef.current) {
          setOnDisk(f);
          return;
        }
        setFile(f);
        setDraft(f.content);
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [reload]);

  const lineNumbers = useMemo(
    () =>
      file && !file.writable ? Array.from({ length: file.content.split("\n").length }, (_, i) => i + 1).join("\n") : "",
    [file],
  );

  async function save() {
    if (!file?.writable || saving) return;
    setSaving(true);
    setError(null);
    try {
      const modifiedMs = await writeLocalFile(folder, path, draft);
      setFile({ ...file, content: draft, modifiedMs, size: new TextEncoder().encode(draft).length });
      setOnDisk(null);
      setJustSaved(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }

  function onKey(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void save();
    }
  }

  return (
    <section aria-label={t.label} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-3.5 py-2">
        <span title={path} className="min-w-0 truncate font-mono text-sm font-medium">
          {path}
        </span>
        {file &&
          (file.writable ? (
            <span
              className={cn(
                "inline-flex h-5 items-center gap-1.5 rounded-full px-1.75 text-xs font-medium whitespace-nowrap",
                dirty ? "bg-warning-soft text-warning" : "bg-success-soft text-success",
              )}
            >
              <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
              {dirty ? t.unsaved : justSaved ? t.saved : t.localDoc}
            </span>
          ) : (
            <span
              title={t.readOnlyHint}
              className="inline-flex h-5 items-center rounded-full bg-muted px-1.75 text-xs font-medium whitespace-nowrap text-muted-foreground"
            >
              {t.readOnly}
            </span>
          ))}
        {file?.writable && (
          <div role="tablist" aria-label={t.label} className="inline-flex rounded-lg bg-muted p-0.5">
            {(
              [
                ["view", t.view],
                ["edit", t.edit],
              ] as const
            ).map(([m, label]) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={mode === m}
                onClick={() => setMode(m)}
                className={cn(
                  "h-6 cursor-pointer rounded-md px-2 text-xs",
                  mode === m
                    ? "bg-card font-semibold text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        <span className="flex-1" />
        {file?.writable && (
          <Button size="sm" disabled={!dirty || saving} onClick={() => void save()}>
            {saving && <LoaderCircleIcon aria-hidden="true" className="animate-spin" />}
            {saving ? t.saving : t.save}
          </Button>
        )}
        <Button variant="ghost" size="icon-sm" aria-label={t.close} title={t.close} onClick={onClose}>
          <XIcon aria-hidden="true" className="size-3.75" />
        </Button>
      </div>
      {onDisk && (
        <div className="flex flex-wrap items-center gap-2 border-b bg-warning-soft px-3.5 py-1.5 text-sm text-warning">
          <span className="flex-1">{t.changedOnDisk}</span>
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              setFile(onDisk);
              setDraft(onDisk.content);
              setOnDisk(null);
            }}
          >
            {t.reload}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              // Giữ bản đang soạn; lưu sẽ ghi đè bản agent vừa sửa.
              if (file) setFile({ ...file, content: onDisk.content });
              setOnDisk(null);
            }}
          >
            {t.keep}
          </Button>
        </div>
      )}
      {error && <p className="border-b px-3.5 py-1.5 text-sm text-destructive">{error}</p>}
      {!file ? (
        !error && (
          <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">{t.loading}</div>
        )
      ) : file.writable && mode === "edit" && isMarkdown(path) ? (
        <MarkdownEditor
          value={draft}
          onChange={(md) => {
            setDraft(md);
            setJustSaved(false);
          }}
          lang={lang}
          label={path}
          onKeyDown={onKey}
        />
      ) : file.writable && mode === "edit" ? (
        <Textarea
          aria-label={path}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setJustSaved(false);
          }}
          onKeyDown={onKey}
          className="min-h-0 flex-1 resize-none rounded-none border-0 px-9 py-6 font-mono text-sm [field-sizing:fixed] focus-visible:ring-0 md:text-sm"
        />
      ) : file.writable ? (
        <article className="flex-1 overflow-y-auto px-9 py-6 text-[15px] leading-[1.75]">
          {!draft.trim() ? (
            <p className="text-sm text-muted-foreground">{t.empty}</p>
          ) : isMarkdown(path) ? (
            <Markdown text={draft} />
          ) : (
            <pre className="font-mono text-sm whitespace-pre-wrap">{draft}</pre>
          )}
        </article>
      ) : (
        <div className="flex min-h-0 flex-1 overflow-auto bg-card font-mono text-[13px] leading-[1.6]">
          <pre
            aria-hidden="true"
            className="sticky left-0 shrink-0 border-r bg-muted/50 px-2.5 py-3 text-right text-muted-foreground select-none"
          >
            {lineNumbers}
          </pre>
          <pre data-testid="code" className="min-w-0 flex-1 px-3.5 py-3 text-foreground">
            {file.content || t.empty}
          </pre>
        </div>
      )}
    </section>
  );
}
