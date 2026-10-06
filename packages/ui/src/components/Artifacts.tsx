// What the agents made and the hub kept (roadmap 41c): the files of one task, or of one run. Images open in place,
// anything else downloads. Bytes travel in base64 over the same call as the rest of the app, like a doc's files.
import { useEffect, useState } from "react";
import { Download, ImageIcon, Trash2 } from "lucide-react";
import { cn } from "cn";
import { isImage, type Artifact } from "@xdev-hive/core";
import type { HiveClient } from "#ui/client.ts";
import { errorMessage, formatTime, useCan, useHive, useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import { fileSize } from "#ui/lib/chat.ts";
import { useToast } from "#ui/shell/toast.tsx";

const cache = new Map<number, Promise<string>>();
const toBlob = (data: string, type: string) => new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], { type });

/** An object URL for the file, fetched once per page view. */
function artifactUrl(client: HiveClient, id: number): Promise<string> {
  let hit = cache.get(id);
  if (!hit) {
    hit = client.call("artifacts.get", { id }).then((got) => {
      if (!got) throw new Error(String(id));
      return URL.createObjectURL(toBlob(got.data, got.artifact.type));
    });
    // A failure is not remembered: the next view asks again.
    hit.catch(() => cache.delete(id));
    cache.set(id, hit);
  }
  return hit;
}

async function download(client: HiveClient, a: Artifact): Promise<void> {
  const url = await artifactUrl(client, a.id);
  const link = document.createElement("a");
  link.href = url;
  // A name with folders in it ("shots/board.png") would be a path the browser refuses: keep the last part.
  link.download = a.name.split("/").pop() ?? a.name;
  link.click();
}

/** The picture itself, once someone asks to see it: a list of twenty would otherwise fetch twenty files. */
function Preview({ artifact }: { artifact: Artifact }) {
  const { client } = useHive();
  const t = useT();
  const [state, setState] = useState<{ url: string | null; error: string | null }>({ url: null, error: null });
  useEffect(() => {
    let live = true;
    artifactUrl(client, artifact.id).then(
      (url) => live && setState({ url, error: null }),
      (err) => live && setState({ url: null, error: errorMessage(err) }),
    );
    return () => {
      live = false;
    };
  }, [client, artifact.id]);
  if (state.error) return <span className="px-1.5 text-xs text-danger">{state.error}</span>;
  if (!state.url) return <span className="px-1.5 text-xs text-fg-muted">{t("artifacts.loading")}</span>;
  return <img src={state.url} alt={artifact.name} className="max-h-[420px] max-w-full self-start rounded-md border border-line-subtle bg-subtle object-contain" />;
}

const ext = (name: string) => /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toUpperCase().slice(0, 4) ?? "FILE";

/**
 * The files of a task or of a run. `runId` without `taskId` is one run's; `taskId` alone is every run's of that task.
 * A project manager removes one (it goes in the audit log); nothing else ever deletes an artifact.
 */
export function ArtifactList({ project, taskId, runId, machineId }: { project: string; taskId?: string; runId?: string; machineId?: string }) {
  const { client } = useHive();
  const t = useT();
  const toast = useToast();
  const allow = useCan();
  // A hub older than 41c does not know artifacts: an empty section, not an error on the panel. Any other error shows,
  // or a refused query looks exactly like a run that made nothing.
  const files = useQuery(
    () =>
      client.call("artifacts.list", { project, taskId, runId, machineId }).catch((err: unknown) => {
        if (/Unknown method/.test(errorMessage(err))) return [] as Artifact[];
        throw err;
      }),
    [client, project, taskId, runId, machineId],
  );
  const [open, setOpen] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const list = files.data ?? [];
  const remove = async (a: Artifact) => {
    try {
      await client.call("artifacts.remove", { id: a.id });
      cache.delete(a.id);
      toast(t("artifacts.removed", { name: a.name }));
      files.reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  if (files.error) return <span className="px-1.5 text-xs text-danger">{t("artifacts.title")}: {files.error}</span>;
  if (!list.length && !files.loading) return null;
  return (
    <section aria-label={t("artifacts.title")} className="flex flex-col gap-1.5" data-artifacts={runId ?? taskId ?? project}>
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">{t("artifacts.title")}</h3>
        <span className="font-mono text-xs md:text-[11px] text-fg-muted">{list.length}</span>
      </div>
      {list.map((a) => (
        <div key={a.id} className="flex flex-col gap-1.5">
          <div className="group flex items-center gap-2 rounded-sm px-1.5 py-1 hover:bg-hover" data-artifact={a.name}>
            <span className={cn("grid h-6 w-9 shrink-0 place-items-center rounded-xs font-mono text-[10px] font-semibold", isImage(a.type) ? "bg-running-soft text-running" : "bg-sunken text-fg-secondary")}>
              {isImage(a.type) ? <ImageIcon className="size-3.5" /> : ext(a.name)}
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              {isImage(a.type) ? (
                <button
                  type="button"
                  onClick={() => setOpen((id) => (id === a.id ? null : a.id))}
                  aria-expanded={open === a.id}
                  className="min-h-11 cursor-pointer truncate text-left outline-none focus-visible:focus-ring md:min-h-0 text-xs font-medium text-fg-link underline underline-offset-2 hover:text-fg-link-hover"
                  title={a.name}
                >
                  {a.name}
                </button>
              ) : (
                <span className="truncate text-xs font-medium text-fg-strong" title={a.name}>
                  {a.name}
                </span>
              )}
              <span className="truncate text-xs md:text-[11px] text-fg-muted">
                {fileSize(a.size)} · {a.runId} · {formatTime(a.createdAt)}
              </span>
            </span>
            <button
              type="button"
              aria-label={t("artifacts.download", { name: a.name })}
              title={t("artifacts.download", { name: a.name })}
              onClick={() => void download(client, a).catch((err: unknown) => setError(errorMessage(err)))}
              className="grid size-11 shrink-0 cursor-pointer md:size-6 place-items-center rounded-xs text-fg-muted outline-none hover:text-fg-strong focus-visible:focus-ring"
            >
              <Download className="size-3.5" />
            </button>
            {allow(a.project, "projectSettings") ? (
              <button
                type="button"
                aria-label={t("artifacts.remove", { name: a.name })}
                title={t("artifacts.remove", { name: a.name })}
                onClick={() => void remove(a)}
                className="grid size-11 shrink-0 cursor-pointer md:size-6 place-items-center rounded-xs text-fg-muted outline-none hover:text-danger focus-visible:focus-ring"
              >
                <Trash2 className="size-3.5" />
              </button>
            ) : null}
          </div>
          {open === a.id ? <Preview artifact={a} /> : null}
        </div>
      ))}
      {error ? <span className="px-1.5 text-xs text-danger">{error}</span> : null}
    </section>
  );
}
