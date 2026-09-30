// Files attached to chat messages (roadmap 17g): picked, pasted or dropped while writing, each uploaded at once, and
// shown with the message they came with (images as pictures, the rest as downloads).
import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { FileText, Loader2, Paperclip, X } from "lucide-react";
import { cn } from "cn";
import { CHAT_FILE_ACCEPT, CHAT_FILE_MAX_BYTES, CHAT_FILES_PER_MESSAGE, isImage, type ChatFile } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { errorMessage, useHive } from "../hooks.ts";
import { useT } from "../i18n/index.tsx";
import { fileSize } from "../lib/chat.ts";

interface Pending {
  key: string;
  file: File;
  /** A local picture of an image, until it is sent. */
  preview: string | null;
  status: "uploading" | "ready" | "failed";
  meta?: ChatFile;
  error?: string;
}

const MB = CHAT_FILE_MAX_BYTES / 1024 / 1024;

/** The files of the message being written, for one project (a file belongs to the chat of one project). */
export function useAttachments(project: string) {
  const { client } = useHive();
  const t = useT();
  const [items, setItems] = useState<Pending[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const known = useRef(items);
  known.current = items;
  const upload = client.chatFiles;

  const clear = useCallback(() => {
    for (const p of known.current) if (p.preview) URL.revokeObjectURL(p.preview);
    setItems([]);
    setNotice(null);
  }, []);
  // Uploads belong to the project they were made for.
  useEffect(() => clear, [project, clear]);

  const update = (key: string, patch: Partial<Pending>) => setItems((cur) => cur.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  const add = (files: File[]) => {
    if (!upload || !project || !files.length) return;
    const room = Math.max(0, CHAT_FILES_PER_MESSAGE - known.current.length);
    setNotice(files.length > room ? t("chat.tooManyFiles", { max: CHAT_FILES_PER_MESSAGE }) : null);
    const next: Pending[] = files.slice(0, room).map((file, i) => ({
      key: `${Date.now()}-${i}-${file.name}`,
      file,
      preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
      ...(file.size > CHAT_FILE_MAX_BYTES ? { status: "failed" as const, error: t("errors.chatFileTooBig", { name: file.name, mb: MB }) } : { status: "uploading" as const }),
    }));
    setItems((cur) => [...cur, ...next]);
    for (const p of next) {
      if (p.status !== "uploading") continue;
      upload.upload(project, p.file).then(
        (meta) => update(p.key, { status: "ready", meta }),
        (err: unknown) => update(p.key, { status: "failed", error: errorMessage(err) }),
      );
    }
  };
  const remove = (key: string) =>
    setItems((cur) => {
      const gone = cur.find((p) => p.key === key);
      if (gone?.preview) URL.revokeObjectURL(gone.preview);
      return cur.filter((p) => p.key !== key);
    });

  return {
    /** Attaching works on the web hub signed in with an account. */
    enabled: Boolean(upload),
    items,
    notice,
    add,
    remove,
    clear,
    uploading: items.some((p) => p.status === "uploading"),
    ids: items.flatMap((p) => (p.status === "ready" && p.meta ? [p.meta.id] : [])),
    /** A pasted screenshot is attached; pasted text is left to the text box. */
    onPaste: (e: ClipboardEvent) => {
      const files = [...e.clipboardData.files];
      if (files.length && upload) e.preventDefault(), add(files);
    },
    onDrop: (e: DragEvent) => {
      if (!upload || !e.dataTransfer.files.length) return;
      e.preventDefault();
      add([...e.dataTransfer.files]);
    },
  };
}

export type Attachments = ReturnType<typeof useAttachments>;

/** The paperclip: opens the file picker. */
export function AttachButton({ att }: { att: Attachments }) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  if (!att.enabled) return null;
  return (
    <>
      <Button
        size="icon-sm"
        variant="ghost"
        type="button"
        aria-label={t("chat.attach")}
        title={t("chat.attachHint", { max: CHAT_FILES_PER_MESSAGE, mb: MB })}
        disabled={att.items.length >= CHAT_FILES_PER_MESSAGE}
        onClick={() => input.current?.click()}
      >
        <Paperclip />
      </Button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        accept={CHAT_FILE_ACCEPT}
        onChange={(e) => {
          att.add([...(e.target.files ?? [])]);
          e.target.value = "";
        }}
      />
    </>
  );
}

/** The files of the message being written: a picture or an icon each, its state, and a way to take it out. */
export function AttachmentBar({ att }: { att: Attachments }) {
  const t = useT();
  if (!att.items.length && !att.notice) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <ul className="flex flex-wrap gap-2">
        {att.items.map((p) => (
          <li
            key={p.key}
            className={cn("flex max-w-56 items-center gap-2 rounded-md border bg-muted/40 p-1.5 pr-1 text-xs", p.status === "failed" && "border-destructive/50")}
            title={p.error ?? p.file.name}
          >
            {p.preview ? <img src={p.preview} alt="" className="size-9 shrink-0 rounded object-cover" /> : <FileText className="size-5 shrink-0 text-muted-foreground" aria-hidden />}
            <span className="flex min-w-0 flex-col">
              <span className="truncate">{p.file.name}</span>
              <span className={cn("text-muted-foreground", p.status === "failed" && "text-destructive")}>
                {p.status === "uploading" ? t("chat.uploading") : p.status === "failed" ? t("chat.fileFailed") : fileSize(p.file.size)}
              </span>
            </span>
            {p.status === "uploading" ? <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-hidden /> : null}
            <Button size="icon-sm" variant="ghost" type="button" className="size-6 shrink-0" aria-label={t("chat.removeFile", { name: p.file.name })} onClick={() => att.remove(p.key)}>
              <X />
            </Button>
          </li>
        ))}
      </ul>
      {att.items
        .filter((p) => p.error)
        .map((p) => (
          <p key={p.key} className="text-xs text-destructive wrap-anywhere">
            {p.error}
          </p>
        ))}
      {att.notice ? <p className="text-xs text-warning">{att.notice}</p> : null}
    </div>
  );
}

/** The files a message came with: images as pictures that open full size, the rest as downloads. */
export function MessageFiles({ files }: { files: ChatFile[] }) {
  const { client } = useHive();
  const href = client.chatFiles?.href;
  if (!files.length) return null;
  const images = files.filter((f) => isImage(f.type));
  const others = files.filter((f) => !isImage(f.type));
  return (
    <div className="flex max-w-[85%] flex-col items-end gap-1.5">
      {images.length ? (
        <div className="flex flex-wrap justify-end gap-1.5">
          {images.map((f) =>
            href ? (
              <a key={f.id} href={href(f.id)} target="_blank" rel="noreferrer" title={f.name}>
                <img src={href(f.id)} alt={f.name} loading="lazy" className="max-h-48 max-w-64 rounded-lg border object-contain" />
              </a>
            ) : (
              <span key={f.id} className="rounded-md border px-2 py-1 text-xs">
                {f.name}
              </span>
            ),
          )}
        </div>
      ) : null}
      {others.map((f) => (
        <a
          key={f.id}
          href={href?.(f.id)}
          download={f.name}
          className="flex max-w-full items-center gap-2 rounded-md border bg-card px-2 py-1.5 text-xs hover:bg-muted/50"
        >
          <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 truncate">{f.name}</span>
          <span className="shrink-0 text-muted-foreground">{fileSize(f.size)}</span>
        </a>
      ))}
    </div>
  );
}
