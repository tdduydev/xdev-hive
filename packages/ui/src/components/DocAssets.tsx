// A page's attached files (roadmap 22j): images shown in the page, the list beside it, uploads. Bytes travel in base64
// over the same call the rest of the app uses, so this works on the web, in the desktop app and against a local base.
import { useEffect, useRef, useState } from "react";
import { Download, ImageIcon, Paperclip, Trash2, Upload } from "lucide-react";
import { cn } from "cn";
import { CHAT_FILE_ACCEPT, DOC_ASSET_MAX_BYTES, docAssetPath, isImage, type DocAsset } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import type { HiveClient } from "../client.ts";
import { errorMessage, formatTime, useHive, useQuery } from "../hooks.ts";
import { useT } from "../i18n/index.tsx";
import { fileSize } from "../lib/chat.ts";
import { useToast } from "../shell/toast.tsx";

/** Tells shown images and lists that a page's files changed. */
export const ASSETS_EVENT = "hive-doc-assets";
const cache = new Map<string, Promise<string | null>>();
const cacheKey = (key: string, name: string) => `${key}\n${name}`;

function changed(key: string, name?: string) {
  for (const k of [...cache.keys()]) if (k.startsWith(`${key}\n`) && (!name || k === cacheKey(key, name))) cache.delete(k);
  window.dispatchEvent(new CustomEvent(ASSETS_EVENT, { detail: key }));
}

const toBlob = (data: string, type: string) => new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], { type });

/** An object URL for the file, fetched once per page view (null: the page has no such file). */
function assetUrl(client: HiveClient, key: string, name: string): Promise<string | null> {
  const k = cacheKey(key, name);
  let hit = cache.get(k);
  if (!hit) {
    hit = client.call("docs.assetGet", { key, name }).then((got) => (got ? URL.createObjectURL(toBlob(got.data, got.asset.type)) : null));
    // A failure is not remembered: the next view asks again.
    hit.catch(() => cache.delete(k));
    cache.set(k, hit);
  }
  return hit;
}

function useAssetsVersion(key: string): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const on = (e: Event) => (e as CustomEvent<string>).detail === key && setN((v) => v + 1);
    window.addEventListener(ASSETS_EVENT, on);
    return () => window.removeEventListener(ASSETS_EVENT, on);
  }, [key]);
  return n;
}

export function useDocAssets(key: string) {
  const { client } = useHive();
  const v = useAssetsVersion(key);
  // A hub older than 22j has no files.
  return useQuery(() => client.call("docs.assets", { key }).catch(() => [] as DocAsset[]), [client, key, v]);
}

const readBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });

/** Uploads a file to the page (one of the same name is replaced) and returns the Markdown that shows it. */
export async function uploadDocAsset(client: HiveClient, key: string, file: File, tooBig: string): Promise<{ asset: DocAsset; markdown: string }> {
  if (file.size > DOC_ASSET_MAX_BYTES) throw new Error(tooBig);
  const asset = await client.call("docs.assetPut", { key, name: file.name || "anh.png", data: await readBase64(file) });
  changed(key, asset.name);
  const path = docAssetPath(key, asset.name);
  const label = asset.name.replace(/\.[a-z0-9]+$/i, "");
  return { asset, markdown: isImage(asset.type) ? `![${label}](${path})` : `[${asset.name}](${path})` };
}

async function download(client: HiveClient, key: string, name: string) {
  const url = await assetUrl(client, key, name);
  if (!url) return;
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
}

/** An attached image in the page, or a frame saying it is missing. */
export function AssetImage({ docKey, name, alt }: { docKey: string; name: string; alt: string }) {
  const { client } = useHive();
  const t = useT();
  const v = useAssetsVersion(docKey);
  const [state, setState] = useState<{ url: string | null; error: string | null; loading: boolean }>({ url: null, error: null, loading: true });
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    assetUrl(client, docKey, name).then(
      (url) => live && setState({ url, error: null, loading: false }),
      (err) => live && setState({ url: null, error: errorMessage(err), loading: false }),
    );
    return () => {
      live = false;
    };
  }, [client, docKey, name, v]);
  return (
    <span className="my-1 flex flex-col gap-1.5">
      {state.url ? (
        <img src={state.url} alt={alt} className="max-h-[520px] max-w-full self-start rounded-md border border-line-subtle bg-subtle object-contain" />
      ) : (
        <span className="grid h-40 place-items-center rounded-md border border-dashed border-line-control bg-subtle px-3 text-center font-mono text-xs text-fg-muted">
          {state.loading ? t("docs.imageLoading") : (state.error ?? t("docs.imageMissing", { name }))}
        </span>
      )}
      {alt ? <span className="text-xs text-fg-muted">{alt}</span> : null}
    </span>
  );
}

/** A link to an attached file that is not an image: downloads it. */
export function AssetLink({ docKey, name, children }: { docKey: string; name: string; children: React.ReactNode }) {
  const { client } = useHive();
  return (
    <button type="button" onClick={() => void download(client, docKey, name)} className="cursor-pointer font-medium text-fg-link underline underline-offset-2 hover:text-fg-link-hover">
      <Paperclip className="mr-0.5 inline size-3.5 align-[-2px]" />
      {children}
    </button>
  );
}

const ext = (name: string) => /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toUpperCase().slice(0, 4) ?? "FILE";

/**
 * The page's files: upload, insert into the draft (while editing), download, remove. Contributors upload; the person who
 * uploaded a file, or a manager, removes it.
 */
export function AttachmentsPanel({ docKey, canUpload, canManage, onInsert }: { docKey: string; canUpload: boolean; canManage: boolean; onInsert?: (markdown: string) => void }) {
  const { client, me } = useHive();
  const t = useT();
  const toast = useToast();
  const files = useDocAssets(docKey);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = files.data ?? [];
  const upload = async (picked: FileList | null) => {
    if (!picked?.length) return;
    setBusy(true);
    setError(null);
    try {
      for (const f of [...picked]) {
        const { markdown } = await uploadDocAsset(client, docKey, f, t("errors.chatFileTooBig", { name: f.name, mb: DOC_ASSET_MAX_BYTES / 1024 / 1024 }));
        onInsert?.(markdown);
      }
      toast(t("docs.uploaded", { count: picked.length }));
      files.reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };
  const remove = async (a: DocAsset) => {
    try {
      await client.call("docs.assetRemove", { key: docKey, name: a.name });
      changed(docKey, a.name);
      toast(t("docs.fileRemoved", { name: a.name }));
      files.reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <section aria-label={t("docs.attachments")} className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 px-1.5 pb-0.5">
        <span className="type-caption text-fg-muted">{t("docs.attachments")}</span>
        <span className="ml-auto font-mono text-[11px] text-fg-muted">{list.length}</span>
      </div>
      {!list.length && !files.loading ? <span className="px-1.5 text-xs text-fg-muted">{t("docs.noAttachments")}</span> : null}
      {list.map((a) => (
        <div key={a.id} className="group flex items-center gap-2 rounded-sm px-1.5 py-1 hover:bg-hover">
          <span className={cn("grid h-6 w-9 shrink-0 place-items-center rounded-xs font-mono text-[10px] font-semibold", isImage(a.type) ? "bg-running-soft text-running" : "bg-sunken text-fg-secondary")}>
            {isImage(a.type) ? <ImageIcon className="size-3.5" /> : ext(a.name)}
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-xs font-medium text-fg-strong" title={a.name}>
              {a.name}
            </span>
            <span className="truncate text-[11px] text-fg-muted">
              {fileSize(a.size)} · {a.uploadedBy} · {formatTime(a.createdAt)}
            </span>
          </span>
          {onInsert ? (
            <Button size="xs" variant="ghost" onClick={() => onInsert(isImage(a.type) ? `![${a.name.replace(/\.[a-z0-9]+$/i, "")}](${docAssetPath(docKey, a.name)})` : `[${a.name}](${docAssetPath(docKey, a.name)})`)}>
              {t("docs.insertFile")}
            </Button>
          ) : null}
          <button type="button" aria-label={t("docs.downloadFile", { name: a.name })} title={t("docs.downloadFile", { name: a.name })} onClick={() => void download(client, docKey, a.name)} className="grid size-6 cursor-pointer place-items-center rounded-xs text-fg-muted outline-none hover:text-fg-strong focus-visible:focus-ring">
            <Download className="size-3.5" />
          </button>
          {canManage || a.uploadedBy === me.name ? (
            <button type="button" aria-label={t("docs.removeFile", { name: a.name })} title={t("docs.removeFile", { name: a.name })} onClick={() => void remove(a)} className="grid size-6 cursor-pointer place-items-center rounded-xs text-fg-muted outline-none hover:text-danger focus-visible:focus-ring">
              <Trash2 className="size-3.5" />
            </button>
          ) : null}
        </div>
      ))}
      {error ? <span className="px-1.5 text-xs text-danger">{error}</span> : null}
      {canUpload ? (
        <>
          <input ref={input} type="file" multiple accept={CHAT_FILE_ACCEPT} className="hidden" onChange={(e) => void upload(e.target.files)} />
          <Button size="sm" variant="outline" className="mt-1 w-full" disabled={busy} onClick={() => input.current?.click()}>
            <Upload />
            {busy ? t("docs.uploading") : t("docs.upload")}
          </Button>
        </>
      ) : null}
      <span className="px-1.5 text-[11px]/4 text-fg-muted">{t("docs.attachmentsHint", { path: docAssetPath(docKey, "…").replace("%E2%80%A6", "…") })}</span>
    </section>
  );
}
