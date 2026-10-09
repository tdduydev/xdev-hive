// Artifact (docs/design/hive-2026-10): a library of the files agents made on the left (search, kind tags, grouped list) and a
// viewer on the right (versions of the same file, Xem/Mã, download, remove). The hub keeps png/jpg/webp/pdf and md/txt/json/log,
// so "Xem" is the rendered Markdown, the picture or the PDF note; an HTML file would be shown in a sandboxed iframe.
import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, ChevronUp, Download, ExternalLink, File, FileJson, FileText, Image as ImageIcon, Trash2, type LucideIcon } from "lucide-react";
import { cn } from "cn";
import { isArtifactText, isImage, type Artifact } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { DocMarkdown } from "#ui/components/DocMarkdown.tsx";
import { ErrorNote } from "#ui/components/common.tsx";
import { Tag } from "#ui/components/ui/primitives.tsx";
import { errorMessage, formatTime, useCan, useHashParam, useHive, useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import { fileSize } from "#ui/lib/chat.ts";
import { scopeFilter, scopeKey } from "#ui/lib/scope.ts";
import { useToast } from "#ui/shell/toast.tsx";

const PAGE_SIZE = 50;
const PREVIEW_BYTES = 128 * 1024;
const GROUP_ITEMS = 5;
const kinds = ["markdown", "log", "json", "image", "text", "pdf"] as const;
type Kind = typeof kinds[number];
const groupBys = ["task", "kind", "run"] as const;
type GroupBy = typeof groupBys[number];
const bytes = (data: string) => Uint8Array.from(atob(data), (c) => c.charCodeAt(0));

const kindOf = (a: Artifact): Kind => (isImage(a.type) ? "image" : a.type === "application/pdf" ? "pdf" : a.type === "application/json" ? "json" : a.type === "text/markdown" ? "markdown" : a.name.endsWith(".log") ? "log" : "text");
const iconOf = (a: Artifact): LucideIcon => ({ image: ImageIcon, pdf: File, json: FileJson, markdown: FileText, log: FileText, text: FileText })[kindOf(a)];
/** Files with the same name from the same task are one file over time: its versions, oldest first. */
const sameFile = (a: Artifact, b: Artifact) => a.project === b.project && a.taskId === b.taskId && a.name === b.name;

export function ArtifactsPage() {
  const { client, scope } = useHive();
  const t = useT();
  const [id, clearId] = useHashParam("artifact");
  const [taskParam] = useHashParam("task");
  const [runParam] = useHashParam("run");
  const [task, setTask] = useState(taskParam ?? "");
  const [run, setRun] = useState(runParam ?? "");
  useEffect(() => setTask(taskParam ?? ""), [taskParam]);
  useEffect(() => setRun(runParam ?? ""), [runParam]);
  const [machine] = useHashParam("machine");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<Kind | "">("");
  const [groupBy, setGroupBy] = useState<GroupBy>("task");
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [more, setMore] = useState<Set<string>>(new Set());
  const [offset, setOffset] = useState(0);
  const [debounced, setDebounced] = useState(name);
  useEffect(() => { const timer = window.setTimeout(() => setDebounced(name), 200); return () => window.clearTimeout(timer); }, [name]);
  const key = `${scopeKey(scope)}:${debounced}:${task ?? ""}:${run ?? ""}:${kind}:${machine ?? ""}`;
  // Tie the page number to its filters to avoid querying an old offset when the scope changes.
  const [previousKey, setPreviousKey] = useState(key);
  if (previousKey !== key) { setPreviousKey(key); setOffset(0); }
  const listKey = `${key}:${offset}`;
  const query = useQuery(async () => ({ key: listKey, files: scope.kind === "shared" ? [] : await client.call("artifacts.list", { ...scopeFilter(scope), taskId: task || undefined, runId: run || undefined, machineId: machine || undefined, name: debounced, kind: kind || undefined, offset, limit: PAGE_SIZE + 1 }) }), [client, key, offset]);
  const files = { ...query, data: query.data?.key === listKey ? query.data.files : undefined };
  const direct = useQuery(async () => {
    if (!id || !/^\d+$/.test(id)) return null;
    // A direct link needs metadata only; bytes are fetched when the viewer opens.
    return (await client.call("artifacts.get", { id: Number(id), metadataOnly: true }))?.artifact ?? null;
  }, [client, id]);
  const list = useMemo(() => (files.loading || files.error ? [] : files.data?.slice(0, PAGE_SIZE) ?? []), [files.loading, files.error, files.data]);
  const [picked, setPicked] = useState<number | null>(null);
  // Newest version of each file is the one the library lists; older ones are reached with the version switch.
  const versionsOf = (a: Artifact) => list.filter((x) => sameFile(x, a)).sort((x, y) => x.createdAt.localeCompare(y.createdAt) || x.id - y.id);
  const library = useMemo(() => {
    const newest = new Map<string, Artifact>();
    for (const a of list) {
      const k = `${a.project}/${a.taskId}/${a.name}`;
      const cur = newest.get(k);
      if (!cur || a.createdAt > cur.createdAt || (a.createdAt === cur.createdAt && a.id > cur.id)) newest.set(k, a);
    }
    return [...newest.values()];
  }, [list]);
  const groups = useMemo(() => {
    const by = (a: Artifact) => (groupBy === "task" ? a.taskId : groupBy === "kind" ? t(`artifacts.${kindOf(a)}`) : a.runId);
    const map = new Map<string, Artifact[]>();
    for (const a of library) map.set(by(a), [...(map.get(by(a)) ?? []), a]);
    return [...map.entries()];
  }, [library, groupBy, t]);
  const directArtifact = id && !direct.loading && !direct.error ? direct.data : null;
  const current = (picked !== null ? list.find((a) => a.id === picked) : null) ?? (directArtifact && (id ? Number(id) === directArtifact.id : false) ? list.find((a) => a.id === directArtifact.id) ?? directArtifact : null) ?? library[0] ?? null;
  const order = library;
  const at = current ? order.findIndex((a) => sameFile(a, current)) : -1;
  const go = (step: number) => { const next = order[at + step]; if (next) { setPicked(next.id); if (id) clearId(); } };

  return <div className="flex flex-wrap items-start gap-4 px-7 py-4" data-artifacts-page>
    <div className="flex max-h-[calc(100vh-210px)] min-h-[520px] max-w-full flex-[1_1_300px] flex-col overflow-hidden rounded-[24px] bg-[var(--surface-1)] shadow-[var(--ring-glass)] max-md:max-h-none max-md:min-h-0">
      <div className="flex flex-col gap-2.5 px-3 pt-3 pb-2.5 shadow-[inset_0_-1px_0_var(--hairline)]">
        <Input controlSize="sm" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("artifacts.searchPlaceholder")} aria-label={t("artifacts.search")} data-artifact-filter="search" />
        <div className="flex flex-wrap gap-1.5">
          {(["", ...kinds] as const).map((k) => (
            <button key={k || "all"} type="button" aria-pressed={kind === k} className="cursor-pointer border-0 bg-transparent p-0" data-artifact-filter="kind" onClick={() => setKind(k)}>
              <Tag active={kind === k}>{k ? t(`artifacts.${k}`) : t("artifacts.all")}</Tag>
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <span className="flex-1 text-[var(--text-muted)] [font:var(--design-caption)]">{t("artifacts.total", { count: library.length })}</span>
          <span className="text-[var(--text-faint)] [font:var(--design-caption)]">{t("artifacts.groupBy")}</span>
          <div className="flex gap-0.5 rounded-full bg-[var(--surface-sunken)] p-[3px] shadow-[var(--ring-glass)]">
            {groupBys.map((g) => (
              <button key={g} type="button" aria-pressed={groupBy === g} onClick={() => setGroupBy(g)} className={cn("h-6 cursor-pointer rounded-full border-0 px-2.5 text-[11.5px]/none font-semibold", groupBy === g ? "bg-[var(--action-primary-bg)] text-[var(--action-primary-fg)]" : "bg-transparent text-[var(--text-secondary)]")}>
                {t(`artifacts.group_${g}`)}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="flex-1 overflow-auto px-1.5 pt-1.5 pb-2.5">
        <ErrorNote error={files.error ?? direct.error} />
        {id && !direct.loading && !direct.error && !direct.data ? <ErrorNote error={t("errors.notFound")} /> : null}
        {files.loading ? <p role="status" className="px-3 py-2 text-[var(--text-muted)] [font:var(--design-caption)]">{t("artifacts.loading")}</p> : null}
        <div role="table" aria-label={t("artifacts.page")}>
          {groups.map(([group, items]) => {
            const open = !closed.has(group);
            const shownItems = open ? (more.has(group) ? items : items.slice(0, GROUP_ITEMS)) : [];
            return <div key={group} role="rowgroup" className="flex flex-col">
              <button type="button" aria-expanded={open} onClick={() => setClosed((s) => { const n = new Set(s); if (n.has(group)) n.delete(group); else n.add(group); return n; })} className="flex h-[34px] cursor-pointer items-center gap-2 rounded-[10px] border-0 bg-transparent px-2 text-left text-[12px]/none font-semibold text-[var(--text-secondary)] hover:text-[var(--text-strong)]">
                {open ? <ChevronDown aria-hidden="true" className="size-3 opacity-50" /> : <ChevronRight aria-hidden="true" className="size-3 opacity-50" />}
                <span className="min-w-0 flex-1 truncate">{group}</span>
                <span className="text-[var(--text-faint)] [font:var(--design-micro)]">{items.length}</span>
              </button>
              {shownItems.map((a) => {
                const Icon = iconOf(a);
                const on = current ? sameFile(a, current) : false;
                return <div key={a.id} role="row" data-artifact-row={a.name} className={cn("flex items-center gap-1 rounded-[12px] pr-0.5 hover:bg-[var(--glass-bg)]", on ? "bg-[var(--tint-violet-soft)] shadow-[var(--ring-violet)]" : "bg-transparent")}>
                  <button type="button" role="cell" aria-current={on} onClick={() => { setPicked(a.id); if (id) clearId(); }} className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 border-0 bg-transparent px-2 py-1.5 text-left font-[inherit] text-[var(--text-strong)]">
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-[8px] bg-[var(--glass-bg)]"><Icon aria-hidden="true" className="size-3.5 opacity-85" /></span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-[12.5px]/[17px] font-semibold">{a.name}</span>
                      <span className="truncate text-[11px]/[15px] font-medium text-[var(--text-muted)]">{a.profileId ?? a.machineId} · {fileSize(a.size)} · {formatTime(a.createdAt)}</span>
                    </span>
                  </button>
                </div>;
              })}
              {open && items.length > GROUP_ITEMS && !more.has(group) ? <button type="button" onClick={() => setMore((s) => new Set(s).add(group))} className="mt-0.5 mr-0 mb-1.5 ml-11 h-[30px] cursor-pointer border-0 bg-transparent p-0 text-left text-[12px]/none font-semibold text-[var(--violet-soft)] hover:text-[var(--text-strong)]">{t("artifacts.more", { count: items.length - GROUP_ITEMS })}</button> : null}
            </div>;
          })}
        </div>
        {!files.loading && !files.error && !library.length ? <div className="px-4 py-10 text-center text-[var(--text-muted)] [font:var(--design-body-sm)]">{t("artifacts.empty")}</div> : null}
        {offset > 0 || (files.data?.length ?? 0) > PAGE_SIZE ? <nav aria-label={t("artifacts.page")} className="flex flex-wrap items-center gap-2 px-2 pt-2">
          <Button variant="glass" size="sm" disabled={!offset || files.loading} onClick={() => setOffset((n) => Math.max(0, n - PAGE_SIZE))}>{t("artifacts.previous")}</Button>
          <span className="text-[var(--text-muted)] [font:var(--design-caption)]">{t("artifacts.pageNumber", { n: offset / PAGE_SIZE + 1 })}</span>
          <Button variant="glass" size="sm" disabled={files.loading || (files.data?.length ?? 0) <= PAGE_SIZE} onClick={() => setOffset((n) => n + PAGE_SIZE)}>{t("artifacts.next")}</Button>
        </nav> : null}
      </div>
    </div>
    <ArtifactViewer key={current?.id ?? "none"} artifact={current} versions={current ? versionsOf(current) : []} onVersion={(v) => setPicked(v)} pos={at < 0 ? "" : `${at + 1} / ${order.length}`} onPrev={() => go(-1)} onNext={() => go(1)} canPrev={at > 0} canNext={at >= 0 && at < order.length - 1} onRemoved={() => { setPicked(null); void files.reload(); }} />
  </div>;
}

function ArtifactViewer({ artifact, versions, onVersion, pos, onPrev, onNext, canPrev, canNext, onRemoved }: { artifact: Artifact | null; versions: Artifact[]; onVersion: (id: number) => void; pos: string; onPrev: () => void; onNext: () => void; canPrev: boolean; canNext: boolean; onRemoved: () => void }) {
  const { client } = useHive();
  const t = useT();
  const toast = useToast();
  const allow = useCan();
  const [mode, setMode] = useState<"view" | "code">("view");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const file = useQuery(async () => !artifact || artifact.type === "application/pdf" ? null : client.call("artifacts.get", { id: artifact.id, maxBytes: PREVIEW_BYTES }), [client, artifact?.id]);
  const data = file.data;
  useEffect(() => {
    if (!artifact || !data || !isImage(artifact.type)) return;
    const object = URL.createObjectURL(new Blob([bytes(data.data)], { type: artifact.type }));
    setUrl(object);
    return () => URL.revokeObjectURL(object);
  }, [data, artifact]);
  const text = useMemo(() => artifact && data && isArtifactText(artifact.type) ? new TextDecoder().decode(bytes(data.data)) : "", [data, artifact]);
  const lines = useMemo(() => text.split("\n"), [text]);
  const download = async () => {
    if (!artifact) return;
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
  const remove = async () => {
    if (!artifact) return;
    setBusy(true); setError(null);
    try { await client.call("artifacts.remove", { id: artifact.id }); toast(t("artifacts.removed", { name: artifact.name })); onRemoved(); }
    catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  };
  const canView = artifact ? artifact.type === "text/markdown" || artifact.type === "text/html" : false;
  const isHtml = artifact?.type === "text/html";
  const tool = "flex size-8 cursor-pointer items-center justify-center rounded-[10px] border-0 bg-transparent text-[var(--text-secondary)] opacity-80 hover:bg-[var(--glass-bg)] hover:opacity-100 disabled:opacity-40 max-md:size-11";
  const nav = "size-[30px] cursor-pointer rounded-[10px] border-0 bg-transparent text-[var(--text-secondary)] hover:bg-[var(--glass-bg)] disabled:opacity-30 max-md:size-11";
  const seg = (on: boolean) => cn("cursor-pointer rounded-full border-0 text-[12px]/none font-semibold", on ? "bg-[var(--action-primary-bg)] text-[var(--action-primary-fg)]" : "bg-transparent text-[var(--text-secondary)]");
  const well = "min-h-[560px] flex-1 max-md:min-h-[320px]";
  return <div className="flex min-w-0 flex-[999_1_520px] flex-col overflow-hidden rounded-[24px] bg-[var(--surface-1)] shadow-[var(--ring-glass-strong)]" data-artifact-viewer>
    <div className="flex flex-wrap items-center gap-2.5 py-3 pr-3.5 pl-[18px] shadow-[inset_0_-1px_0_var(--hairline)]">
      <div className="flex min-w-[200px] flex-1 flex-col">
        <span className="text-[15px]/[22px] font-semibold break-all">{artifact?.name ?? ""}</span>
        <span className="text-[var(--text-muted)] [font:var(--design-caption)]">{artifact ? `${artifact.taskId} · ${artifact.runId} · ${artifact.profileId ?? artifact.machineId} · ${artifact.project}` : ""}</span>
      </div>
      <div className="flex items-center gap-0.5">
        <button type="button" className={nav} title={t("artifacts.prev")} aria-label={t("artifacts.prev")} disabled={!canPrev} onClick={onPrev}><ChevronUp aria-hidden="true" className="mx-auto size-[15px]" /></button>
        <span className="min-w-[54px] text-center text-[var(--text-muted)] [font:var(--design-caption)]">{pos}</span>
        <button type="button" className={nav} title={t("artifacts.nextFile")} aria-label={t("artifacts.nextFile")} disabled={!canNext} onClick={onNext}><ChevronDown aria-hidden="true" className="mx-auto size-[15px]" /></button>
      </div>
      {versions.length > 1 ? <div className="flex items-center gap-0.5 rounded-full bg-[var(--surface-sunken)] p-[3px] shadow-[var(--ring-glass)]" role="group" aria-label={t("artifacts.versions")}>
        {versions.map((v, i) => <button key={v.id} type="button" aria-pressed={v.id === artifact?.id} title={`${v.runId} · ${formatTime(v.createdAt)}`} onClick={() => onVersion(v.id)} className={cn(seg(v.id === artifact?.id), "h-[26px] px-2.5 text-[11.5px]/none")}>v{i + 1}</button>)}
      </div> : null}
      {canView ? <div className="flex items-center gap-0.5 rounded-full bg-[var(--surface-sunken)] p-[3px] shadow-[var(--ring-glass)]" role="group">
        <button type="button" aria-pressed={mode === "view"} onClick={() => setMode("view")} className={cn(seg(mode === "view"), "h-[26px] px-3")}>{t("artifacts.view")}</button>
        <button type="button" aria-pressed={mode === "code"} onClick={() => setMode("code")} className={cn(seg(mode === "code"), "h-[26px] px-3")}>{t("artifacts.code")}</button>
      </div> : null}
      {artifact ? <div className="flex gap-0.5">
        <a className={tool} title={t("artifacts.openRun")} aria-label={t("artifacts.openRun")} href={`#/runs?run=${encodeURIComponent(`${artifact.machineId}/${artifact.runId}`)}`}><ExternalLink aria-hidden="true" className="size-[15px]" /></a>
        <button type="button" className={tool} title={t("artifacts.download", { name: artifact.name })} aria-label={t("artifacts.download", { name: artifact.name })} disabled={busy} onClick={() => void download()}><Download aria-hidden="true" className="size-[15px]" /></button>
        {allow(artifact.project, "projectSettings") ? <button type="button" className={tool} title={t("artifacts.remove", { name: artifact.name })} aria-label={t("artifacts.remove", { name: artifact.name })} disabled={busy} onClick={() => void remove()}><Trash2 aria-hidden="true" className="size-[15px]" /></button> : null}
      </div> : null}
    </div>
    <ErrorNote error={error ?? file.error} />
    {!artifact ? null : file.loading ? <p role="status" className="m-0 p-4 text-[var(--text-muted)] [font:var(--design-body-sm)]">{t("artifacts.loading")}</p> : null}
    {artifact && data?.truncated ? <p className="m-0 px-4 pt-2 text-[var(--text-secondary)] [font:var(--design-caption)]" data-artifact-clipped>{t("artifacts.clipped", { size: fileSize(PREVIEW_BYTES) })}</p> : null}
    {artifact && isHtml && mode === "view" && text ? <iframe title={artifact.name} srcDoc={text} sandbox="allow-scripts" className={cn("block w-full border-0 bg-white", well)} /> : null}
    {artifact && artifact.type === "text/markdown" && mode === "view" && text ? <div tabIndex={0} className={cn("overflow-auto p-5 outline-none focus-visible:focus-ring", well)} data-artifact-content><DocMarkdown text={text} /></div> : null}
    {artifact && isArtifactText(artifact.type) && (mode === "code" || !canView) && text ? <div tabIndex={0} data-artifact-content className={cn("max-h-[70vh] overflow-auto bg-[var(--code-well)] py-3 text-[12px]/[20px] font-medium outline-none focus-visible:focus-ring [font-family:var(--font-code-design)]", well)}>
      {lines.map((line, i) => <div key={i} className="grid grid-cols-[52px_minmax(0,1fr)] gap-3 pr-4"><span className="text-right text-[var(--text-faint)] select-none">{i + 1}</span><span className="text-[var(--code-well-fg)] [overflow-wrap:anywhere] whitespace-pre-wrap">{line}</span></div>)}
    </div> : null}
    {artifact && url ? <div className={cn("flex items-center justify-center bg-[var(--surface-sunken)] p-4", well)} data-artifact-content><img src={url} alt={artifact.name} className="max-h-[65dvh] max-w-full rounded-[12px] object-contain" /></div> : null}
    {artifact && artifact.type === "application/pdf" ? <div className={cn("flex flex-col items-center justify-center gap-2.5 bg-[var(--surface-sunken)] text-[var(--text-muted)] [font:var(--design-body-sm)]", well)}><File aria-hidden="true" className="size-8 opacity-30" /><span>{t("artifacts.downloadOnly")}</span></div> : null}
  </div>;
}
