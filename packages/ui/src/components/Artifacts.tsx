import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Download, Trash2 } from "lucide-react";
import { isImage, isArtifactText, type Artifact } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@xdev-hive/ui/components/ui/dialog";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { DocMarkdown } from "#ui/components/DocMarkdown.tsx";
import { ErrorNote } from "#ui/components/common.tsx";
import { errorMessage, formatTime, useCan, useHive, useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import { artifactParts, textMatches } from "#ui/lib/artifacts.ts";
import { fileSize } from "#ui/lib/chat.ts";
import { useToast } from "#ui/shell/toast.tsx";

const PREVIEW_BYTES = 128 * 1024;
const MAX_HIGHLIGHTS = 500;
const bytes = (data: string) => Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
export const ArtifactContext = createContext<readonly Artifact[]>([]);

/** All metadata for a task/run, including older files beyond the API's first page. */
export function useArtifacts(project: string, taskId?: string, runId?: string, machineId?: string, revision?: string) {
  const { client, me } = useHive();
  const key = `${project}:${taskId ?? ""}:${runId ?? ""}:${machineId ?? ""}`;
  const query = useQuery(async () => {
    if (me.mode !== "hub") return { key, files: [] as Artifact[] };
    const all: Artifact[] = [];
    for (let offset = 0; ; offset += 200) {
      const page = await client.call("artifacts.list", { project, taskId, runId, machineId, offset, limit: 200 }).catch((err: unknown) => {
        if (/Unknown method/.test(errorMessage(err))) return [] as Artifact[];
        throw err;
      });
      // Older hubs ignore offset: stop when a page repeats instead of looping forever.
      const known = new Set(all.map((a) => a.id));
      const added = page.filter((a) => !known.has(a.id));
      all.push(...added);
      if (page.length < 200 || !added.length) return { key, files: all };
    }
  }, [client, me.mode, project, taskId, runId, machineId, revision]);
  return { ...query, data: query.data?.key === key ? query.data.files : undefined };
}

export function ArtifactPreview({ artifact, onClose }: { artifact: Artifact | null; onClose: () => void }) {
  const t = useT();
  const returnFocus = useRef<HTMLElement | null>(null);
  return <Dialog open={!!artifact} onOpenChange={(open) => { if (!open) onClose(); }}>
    {artifact ? <DialogContent className="flex max-h-[90dvh] flex-col sm:max-w-4xl max-md:!max-h-dvh max-md:[&_button]:min-h-11 max-md:[&_input]:min-h-11" showCloseButton={false} onOpenAutoFocus={() => { returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }} onCloseAutoFocus={(event) => { if (returnFocus.current?.isConnected) { event.preventDefault(); returnFocus.current.focus(); } }} data-artifact-preview>
      <DialogHeader className="shrink-0 text-left">
        <div className="flex items-start justify-between gap-3"><DialogTitle className="min-w-0 break-all">{artifact.name}</DialogTitle><DialogClose asChild><Button variant="outline" className="min-h-11 shrink-0">{t("common.close")}</Button></DialogClose></div>
        <DialogDescription className="break-words">{artifact.project} · {artifact.taskId} · {artifact.runId} · {fileSize(artifact.size)}</DialogDescription>
      </DialogHeader>
      <PreviewBody key={`${artifact.id}:${artifact.sha256}`} artifact={artifact} />
    </DialogContent> : null}
  </Dialog>;
}

function PreviewBody({ artifact }: { artifact: Artifact }) {
  const { client } = useHive();
  const t = useT();
  const [find, setFind] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const file = useQuery(async () => artifact.type === "application/pdf" ? null : client.call("artifacts.get", { id: artifact.id, maxBytes: PREVIEW_BYTES }), [client, artifact.id]);
  const data = file.data;
  useEffect(() => {
    if (!data || !isImage(artifact.type)) return;
    const object = URL.createObjectURL(new Blob([bytes(data.data)], { type: artifact.type }));
    setUrl(object);
    return () => URL.revokeObjectURL(object);
  }, [data, artifact.type]);
  const text = useMemo(() => data && isArtifactText(artifact.type) ? new TextDecoder().decode(bytes(data.data)) : "", [data, artifact.type]);
  const parts = useMemo(() => textMatches(text, find), [text, find]);
  const download = async () => {
    setBusy(true); setError(null);
    try {
      const full = await client.call("artifacts.get", { id: artifact.id });
      if (!full) throw new Error(t("errors.notFound"));
      const object = URL.createObjectURL(new Blob([bytes(full.data)], { type: artifact.type }));
      const a = document.createElement("a");
      a.href = object; a.download = artifact.name.split("/").pop()!;
      document.body.append(a); a.click(); a.remove();
      // The browser needs time to start saving before the temporary URL is released.
      window.setTimeout(() => URL.revokeObjectURL(object), 1000);
    } catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  };
  return <>
    <div className="flex shrink-0 flex-wrap items-center gap-2">
      <Button variant="outline" disabled={busy} className="min-h-11 max-w-full whitespace-normal break-all" onClick={() => void download()} aria-label={t("artifacts.download", { name: artifact.name })}><Download aria-hidden="true" />{t("artifacts.download", { name: artifact.name })}</Button>
      {data?.truncated ? <p className="text-xs text-fg-secondary" data-artifact-clipped>{t("artifacts.clipped", { size: fileSize(PREVIEW_BYTES) })}</p> : null}
    </div>
    <ErrorNote error={error ?? file.error} />
    {file.loading ? <p role="status" className="text-sm">{t("artifacts.loading")}</p> : null}
    {!file.loading && file.data === null && artifact.type !== "application/pdf" ? <ErrorNote error={t("errors.notFound")} /> : null}
    {isArtifactText(artifact.type) ? <label className="flex shrink-0 flex-col gap-1 text-sm"><span>{t("artifacts.find")}</span><Input value={find} onChange={(e) => setFind(e.target.value)} className="min-h-11 text-base md:text-sm" data-artifact-find />{find ? <span role="status" className="text-xs">{t("artifacts.matches", { n: Math.floor(parts.length / 2) })}</span> : null}</label> : null}
    {Math.floor(parts.length / 2) > MAX_HIGHLIGHTS ? <p className="text-xs text-fg-secondary">{t("artifacts.highlightLimited", { n: MAX_HIGHLIGHTS })}</p> : null}
    <div tabIndex={0} className="min-h-0 overflow-y-auto overscroll-contain outline-none focus-visible:focus-ring" data-artifact-content>
      {url ? <img src={url} alt={artifact.name} className="max-h-[65dvh] max-w-full rounded-md object-contain" /> : null}
      {artifact.type === "text/html" && text ? <iframe title={artifact.name} srcDoc={`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; navigate-to 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'"><!doctype html>${text}`} sandbox="allow-scripts" className="min-h-[50vh] w-full border-0 bg-white" /> : null}
      {artifact.type === "text/markdown" && !find ? <DocMarkdown text={text} /> : isArtifactText(artifact.type) && artifact.type !== "text/html" ? <pre className="rounded-md border border-line-subtle bg-code p-3 font-mono text-xs/5 whitespace-pre-wrap break-all text-code-fg">{parts.slice(0, MAX_HIGHLIGHTS * 2 + 1).map((part, i) => i % 2 ? <mark key={i} className="bg-warning-soft text-fg-strong">{part}</mark> : part)}{parts.slice(MAX_HIGHLIGHTS * 2 + 1).join("")}</pre> : null}
      {artifact.type === "application/pdf" ? <p className="text-sm">{t("artifacts.downloadOnly")}</p> : null}
    </div>
  </>;
}

export function ArtifactText({ text, files }: { text: string; files?: readonly Artifact[] }) {
  const context = useContext(ArtifactContext);
  const [open, setOpen] = useState<Artifact | null>(null);
  return <>{artifactParts(text, files ?? context).map((part, i) => part.artifact ? <a key={i} href={`#/artifacts?artifact=${part.artifact.id}`} onClick={(e) => { if (!e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) { e.preventDefault(); setOpen(part.artifact!); } }} className="inline-flex min-h-11 min-w-11 max-w-full cursor-pointer items-center break-all text-left text-fg-link underline underline-offset-2 outline-none hover:text-fg-link-hover focus-visible:focus-ring md:min-h-0" data-artifact-link={part.artifact.name}>{part.text}</a> : part.text)}<ArtifactPreview artifact={open} onClose={() => setOpen(null)} /></>;
}

export function ArtifactRows({ files, error, loading, onChanged, context }: { files: readonly Artifact[]; error?: string | null; loading?: boolean; onChanged?: () => void; context?: string }) {
  const { client } = useHive();
  const t = useT(); const toast = useToast(); const allow = useCan();
  const [open, setOpen] = useState<Artifact | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [removing, setRemoving] = useState<number | null>(null);
  return <section aria-label={t("artifacts.title")} className="flex flex-col gap-2" data-artifacts={context}>
    <h3 className="text-sm font-medium text-fg-secondary">{t("artifacts.title")} <span className="font-mono">({files.length})</span></h3>
    <ErrorNote error={failure ?? error} />
    {loading ? <p role="status" className="text-sm">{t("artifacts.loading")}</p> : !files.length ? <p className="text-xs text-fg-muted">{t("artifacts.empty")}</p> : null}
    {files.map((a) => <div key={a.id} className="flex items-center gap-2 rounded-md border border-line-subtle p-2" data-artifact={a.name}>
      <div className="min-w-0 flex-1"><button type="button" onClick={() => setOpen(a)} className="min-h-11 w-full cursor-pointer break-all text-left text-sm text-fg-link underline outline-none hover:text-fg-link-hover focus-visible:focus-ring md:min-h-0">{a.name}</button><p className="break-words text-xs text-fg-muted">{fileSize(a.size)} · {a.runId} · {formatTime(a.createdAt)}</p></div>
      {allow(a.project, "projectSettings") ? <button type="button" disabled={removing !== null} aria-label={t("artifacts.remove", { name: a.name })} className="grid size-11 shrink-0 cursor-pointer place-items-center rounded-md text-fg-muted outline-none hover:text-danger focus-visible:focus-ring md:size-6" onClick={() => void (async () => {
        setRemoving(a.id); setFailure(null);
        try { await client.call("artifacts.remove", { id: a.id }); toast(t("artifacts.removed", { name: a.name })); onChanged?.(); }
        catch (err) { setFailure(errorMessage(err)); } finally { setRemoving(null); }
      })()}><Trash2 aria-hidden="true" className="size-4" /></button> : null}
    </div>)}
    <ArtifactPreview artifact={open} onClose={() => setOpen(null)} />
  </section>;
}

export function ReviewArtifacts({ project, taskId, note }: { project: string; taskId: string; note: string }) {
  const files = useArtifacts(project, taskId);
  const t = useT();
  const [open, setOpen] = useState<Artifact | null>(null);
  return <><ErrorNote error={files.error} /><div className="text-sm leading-relaxed whitespace-pre-wrap break-words"><ArtifactText text={note} files={files.data} /></div>
    {(files.data ?? []).some((a) => a.type === "text/markdown") ? <section aria-label={t("artifacts.reports")} className="flex flex-col gap-1" data-review-reports><h3 className="text-sm font-semibold">{t("artifacts.reports")}</h3>{files.data!.filter((a) => a.type === "text/markdown").map((a) => <button key={a.id} type="button" onClick={() => setOpen(a)} className="min-h-11 cursor-pointer break-all text-left text-sm text-fg-link underline outline-none focus-visible:focus-ring">{a.name}</button>)}</section> : null}
    <ArtifactPreview artifact={open} onClose={() => setOpen(null)} /></>;
}
