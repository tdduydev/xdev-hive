// Tài liệu (docs/design/2026-09-redesign, xDev Hive Client): spaces (Chung and each project) and their pages on the
// left; the page on the right in Xem / Sửa / Chia đôi with a Markdown toolbar, its versions, and drafts that stay on
// the device until saved. Managers save a new version, contributors send it as a proposal.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Bold, ChevronDown, ChevronRight, Code, FileText, Folder, FolderOpen, Heading2, Italic, Link2, List, Quote, Table, X } from "lucide-react";
import { cn } from "cn";
import { parseDocKey, stripHidden, type Doc, type DocSummary, type DocVersion } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Checkbox } from "@xdev-hive/ui/components/ui/checkbox";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/components/ui/native-select";
import { Diff } from "../components/Diff.tsx";
import { DocMarkdown } from "../components/DocMarkdown.tsx";
import { HiddenChars } from "../components/HiddenChars.tsx";
import { ErrorNote, Notice } from "../components/common.tsx";
import { errorMessage, formatTime, sourceText, useAction, useCan, useHashParam, useHive, useQuery } from "../hooks.ts";
import { useT, type TFunction } from "../i18n/index.tsx";
import { DRAFTS_EVENT, insertMd, isUnreachable, parsePaths, readDrafts, writeDrafts, type DocDraft } from "../lib/docdraft.ts";
import { fold } from "../lib/text.ts";
import { docOwner, inScope, projectScope, SHARED, type Scope } from "../lib/scope.ts";
import { useToast } from "../shell/toast.tsx";

/** The project's AGENTS.md and decisions doc are for the whole repo. */
const wholeRepo = (key: string) => /^project\/[^/]+\/(agents|decisions)$/.test(key);

/** Same shape as the slug part of a doc key in core (keys.ts); skills/<name> makes a skill (its content is a SKILL.md). */
const SLUG = /^(skills\/)?[a-z0-9][a-z0-9-]{0,79}$/;

type Mode = "view" | "edit" | "split";

interface Space {
  id: string;
  /** null = shared by every project (org/*). */
  owner: string | null;
  label: string;
  docs: DocSummary[];
}

/** The spaces a scope shows: Chung, and each project in it (the scope's own project first). */
function spacesFor(all: DocSummary[], scope: Scope, t: TFunction): Space[] {
  const shared: Space = { id: "shared", owner: null, label: t("inbox.shared"), docs: all.filter((d) => docOwner(d.key) === null) };
  const of = (p: string): Space => ({ id: `project:${p}`, owner: p, label: p, docs: all.filter((d) => docOwner(d.key) === p) });
  if (scope.kind === "shared") return [shared];
  if (scope.kind === "project") return [of(scope.project), shared];
  if (scope.kind === "system") return [...[...scope.projects].sort().map(of), shared];
  const projects = [...new Set(all.map((d) => docOwner(d.key)).filter((p): p is string => p !== null))].sort();
  return [shared, ...projects.map(of)];
}

/** The part of a doc key after its owner: "skills/review-pr" for org/skills/review-pr. */
const slugOf = (key: string) => key.replace(/^org\//, "").replace(/^project\/[^/]+\//, "");

const draftOf = (doc: Doc | null, key: string): DocDraft => ({
  title: doc?.title ?? "",
  content: doc?.content ?? "",
  includeInAgents: doc?.includeInAgents ?? key.startsWith("org/"),
  paths: (doc?.paths ?? []).join(", "),
  note: "",
  baseVersion: doc?.version ?? 0,
  savedAt: new Date().toISOString(),
});

const sameAsDoc = (d: DocDraft, doc: Doc | null) =>
  d.content === (doc?.content ?? "") &&
  (!doc || (d.title === doc.title && d.includeInAgents === doc.includeInAgents && parsePaths(d.paths).join(",") === (doc.paths ?? []).join(",")));

function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: Array<[T, string]>; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex gap-0.5 rounded-[7px] bg-sunken p-0.5">
      {options.map(([k, text]) => (
        <button
          key={k}
          type="button"
          role="radio"
          aria-checked={value === k}
          onClick={() => onChange(k)}
          className={cn(
            "h-6 min-w-0 cursor-pointer truncate rounded-[5px] px-2.5 text-xs/none font-semibold whitespace-nowrap outline-none focus-visible:focus-ring",
            value === k ? "bg-surface text-fg-strong shadow-e1" : "text-fg-secondary hover:text-fg-strong",
          )}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

export function DocsPage() {
  const { client, scope, setScope } = useHive();
  const t = useT();
  const allow = useCan();
  const list = useQuery(() => client.call("docs.list", {}), [client]);
  const spaces = useMemo(() => spacesFor(list.data ?? [], scope, t), [list.data, scope, t]);
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const space = spaces.find((s) => s.id === spaceId) ?? spaces[0] ?? null;
  const [selected, setSelected] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [creating, setCreating] = useState(false);
  const [newSlug, setNewSlug] = useState("");
  const [newError, setNewError] = useState<string | null>(null);
  const [drafts, setDraftsState] = useState<Record<string, DocDraft>>(readDrafts);
  // The outbox sends queued saves when the hub is back: show what it left.
  useEffect(() => {
    const on = () => setDraftsState(readDrafts());
    window.addEventListener(DRAFTS_EVENT, on);
    return () => window.removeEventListener(DRAFTS_EVENT, on);
  }, []);
  const setDraft = useCallback((key: string, draft: DocDraft | null) => {
    setDraftsState((cur) => {
      const next = { ...cur };
      if (draft) next[key] = draft;
      else delete next[key];
      writeDrafts(next);
      return next;
    });
  }, []);

  // #/docs?doc=<key> (command palette, links): open that doc, moving to its scope when it is outside this one.
  const [linked, clearLinked] = useHashParam("doc");
  useEffect(() => {
    if (!linked || !list.data) return;
    if (list.data.some((d) => d.key === linked)) {
      const owner = docOwner(linked);
      if (!inScope(scope, owner)) setScope(owner === null ? SHARED : projectScope(owner));
      setSpaceId(owner === null ? "shared" : `project:${owner}`);
      setSelected(linked);
    }
    clearLinked();
  }, [linked, list.data, scope, setScope, clearLinked]);

  // Keep the selection inside the space: the first page of the space when it falls out.
  useEffect(() => {
    if (!list.data || linked || !space) return;
    if (selected && docOwner(selected) === space.owner) return;
    setSelected(space.docs[0]?.key ?? null);
  }, [list.data, space, selected, linked]);

  const needle = fold(q.trim());
  const pages = useMemo(
    () => (space?.docs ?? []).filter((d) => !needle || fold(`${d.title} ${d.key}`).includes(needle)).sort((a, b) => slugOf(a.key).localeCompare(slugOf(b.key))),
    [space, needle],
  );
  // A page whose slug has a folder part (skills/review-pr) goes under that folder.
  const tree = useMemo(() => {
    const rows: Array<{ folder: string; docs: DocSummary[] } | DocSummary> = [];
    const folders = new Map<string, DocSummary[]>();
    for (const d of pages) {
      const slug = slugOf(d.key);
      const i = slug.indexOf("/");
      if (i < 0) rows.push(d);
      else {
        const f = slug.slice(0, i);
        if (!folders.has(f)) {
          folders.set(f, []);
          rows.push({ folder: f, docs: folders.get(f)! });
        }
        folders.get(f)!.push(d);
      }
    }
    return rows;
  }, [pages]);

  const canCreateHere = space ? allow(space.owner, "manage") : false;
  const keyPrefix = space?.owner ? `project/${space.owner}/` : "org/";
  const createDoc = () => {
    const slug = newSlug.trim();
    if (!SLUG.test(slug)) return setNewError(t("docs.badSlug"));
    try {
      parseDocKey(keyPrefix + slug);
    } catch (err) {
      return setNewError(errorMessage(err));
    }
    setNewError(null);
    setSelected(keyPrefix + slug);
    setCreating(false);
    setNewSlug("");
  };

  const pageRow = (d: DocSummary, indent: boolean) => {
    const on = d.key === selected;
    return (
      <button
        key={d.key}
        type="button"
        role="treeitem"
        aria-selected={on}
        onClick={() => setSelected(d.key)}
        title={d.key}
        className={cn(
          "flex h-[30px] w-full shrink-0 cursor-pointer items-center gap-1.5 rounded-sm pr-2 text-left text-[13px]/none outline-none focus-visible:focus-ring",
          indent ? "pl-[30px]" : "pl-2",
          on ? "bg-surface font-semibold text-fg-strong shadow-e1" : "text-fg-primary hover:bg-hover",
        )}
      >
        <FileText className="size-3.5 shrink-0 text-fg-muted" />
        <span className="min-w-0 flex-1 truncate">{d.title || slugOf(d.key)}</span>
        {drafts[d.key] ? <span title={t("docs.draftLocal")} className="size-1.5 shrink-0 rounded-full bg-warning-solid" /> : null}
      </button>
    );
  };

  return (
    <div className="flex h-full min-h-0 w-full bg-surface">
      <div className="flex min-w-[190px] shrink basis-[250px] flex-col border-r border-line-subtle bg-subtle">
        <div className="flex shrink-0 flex-col gap-2 border-b border-line-subtle px-3 py-2.5">
          {spaces.length <= 3 ? (
            <Seg
              label={t("docs.list")}
              value={space?.id ?? ""}
              options={spaces.map((s) => [s.id, s.label])}
              onChange={(v) => {
                setSpaceId(v);
                setSelected(null);
              }}
            />
          ) : (
            <NativeSelect
              size="sm"
              wrapperClassName="w-full"
              className="font-mono"
              value={space?.id ?? ""}
              onChange={(e) => {
                setSpaceId(e.target.value);
                setSelected(null);
              }}
              aria-label={t("docs.list")}
            >
              {spaces.map((s) => (
                <NativeSelectOption key={s.id} value={s.id}>
                  {s.label} ({s.docs.length})
                </NativeSelectOption>
              ))}
            </NativeSelect>
          )}
          <Input className="h-7 text-xs" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("docs.search")} aria-label={t("docs.search")} />
        </div>
        <div role="tree" aria-label={t("docs.list")} className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto p-1.5">
          <ErrorNote error={list.error} />
          {tree.map((row) =>
            "folder" in row ? (
              <div key={`f-${row.folder}`} className="flex flex-col gap-px">
                <button
                  type="button"
                  aria-expanded={!collapsed[row.folder]}
                  onClick={() => setCollapsed((c) => ({ ...c, [row.folder]: !c[row.folder] }))}
                  className="flex h-[30px] shrink-0 cursor-pointer items-center gap-[5px] rounded-sm px-1 text-left text-xs/none font-semibold text-fg-secondary outline-none hover:bg-hover focus-visible:focus-ring"
                >
                  {collapsed[row.folder] ? <ChevronRight className="size-3 text-fg-muted" /> : <ChevronDown className="size-3 text-fg-muted" />}
                  {collapsed[row.folder] ? <Folder className="size-3.5 text-fg-brand" /> : <FolderOpen className="size-3.5 text-fg-brand" />}
                  <span className="min-w-0 flex-1 truncate">{row.folder}</span>
                  <span className="pr-1 text-[11px]/none font-normal text-fg-muted">{row.docs.length}</span>
                </button>
                {collapsed[row.folder] ? null : row.docs.map((d) => pageRow(d, true))}
              </div>
            ) : (
              pageRow(row, false)
            ),
          )}
          {!list.loading && !pages.length ? <p className="m-0 px-2 py-4 text-center text-xs text-fg-muted">{q ? t("docs.noMatch") : t("docs.none")}</p> : null}
        </div>
        <div className="flex shrink-0 flex-col gap-1.5 border-t border-line-subtle px-3 py-2">
          {creating ? (
            <div className="flex flex-col gap-1.5 rounded-md border border-line-selected bg-surface p-2">
              <span className="text-[11px]/4 font-semibold text-fg-muted">{t("docs.newDoc")}</span>
              <Input
                autoFocus
                className="h-7 font-mono text-xs"
                placeholder="vd: security"
                autoCapitalize="none"
                spellCheck={false}
                value={newSlug}
                aria-invalid={newError ? true : undefined}
                onChange={(e) => setNewSlug(e.target.value.toLowerCase())}
                onKeyDown={(e) => {
                  if (e.key === "Enter") createDoc();
                  if (e.key === "Escape") setCreating(false);
                }}
                aria-label={t("docs.slug")}
              />
              <span className="font-mono text-[11px] break-all text-fg-muted">{keyPrefix + (newSlug.trim() || `<${t("docs.slugPlaceholder")}>`)}</span>
              <ErrorNote error={newError} />
              <div className="flex justify-end gap-1.5">
                <Button size="xs" variant="ghost" onClick={() => setCreating(false)}>
                  {t("docs.cancelNew")}
                </Button>
                <Button size="xs" onClick={createDoc} disabled={!newSlug.trim()}>
                  {t("docs.create")}
                </Button>
              </div>
            </div>
          ) : null}
          <div className="flex items-center gap-1.5">
            <span className="flex-1 text-[11px] text-fg-muted">{t("docs.pageCount", { count: space?.docs.length ?? 0 })}</span>
            {canCreateHere && !creating ? (
              <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
                {t("docs.newPage")}
              </Button>
            ) : null}
          </div>
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        {selected ? (
          <DocView
            key={selected}
            docKey={selected}
            canEdit={allow(docOwner(selected), "manage")}
            canPropose={allow(docOwner(selected), "contribute")}
            draft={drafts[selected] ?? null}
            setDraft={(d) => setDraft(selected, d)}
            onSaved={list.reload}
          />
        ) : (
          <div className="grid flex-1 place-items-center p-6 text-[13px] text-fg-muted">{t("docs.pick")}</div>
        )}
      </div>
    </div>
  );
}

type MdId = "heading" | "bold" | "italic" | "code" | "list" | "quote" | "table" | "link";
const MD_ICON: Record<MdId, typeof Bold> = { heading: Heading2, bold: Bold, italic: Italic, code: Code, list: List, quote: Quote, table: Table, link: Link2 };
const MD_TOOLS: Array<{ id: MdId; pre: string; post?: string; line?: boolean } | "sep"> = [
  { id: "heading", pre: "## ", line: true },
  { id: "bold", pre: "**", post: "**" },
  { id: "italic", pre: "_", post: "_" },
  { id: "code", pre: "`", post: "`" },
  "sep",
  { id: "list", pre: "- ", line: true },
  { id: "quote", pre: "> ", line: true },
  { id: "table", pre: "" },
  "sep",
  { id: "link", pre: "[", post: "](org/)" },
];

function DocView({
  docKey,
  canEdit,
  canPropose,
  draft,
  setDraft,
  onSaved,
}: {
  docKey: string;
  canEdit: boolean;
  canPropose: boolean;
  draft: DocDraft | null;
  setDraft: (d: DocDraft | null) => void;
  onSaved: () => void;
}) {
  const { client } = useHive();
  const t = useT();
  const toast = useToast();
  const doc = useQuery(() => client.call("docs.get", { key: docKey }), [client, docKey]);
  const current: Doc | null = doc.data ?? null;
  const writer = canEdit || canPropose;
  const [mode, setMode] = useState<Mode>("view");
  const [hist, setHist] = useState(false);
  const [compare, setCompare] = useState<number | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const action = useAction();
  const area = useRef<HTMLTextAreaElement>(null);
  const org = docKey.startsWith("org/");

  // A page that does not exist yet opens in edit mode; one with a draft opens where the draft can be seen.
  useEffect(() => {
    if (doc.loading) return;
    if (!current && writer) setMode("edit");
    else if (draft && writer) setMode("split");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.loading]);

  const work = draft ?? draftOf(current, docKey);
  const dirty = draft !== null && !sameAsDoc(draft, current);
  const stale = draft !== null && current !== null && current.version > draft.baseVersion;
  const edit = (patch: Partial<DocDraft>) => {
    const next = { ...work, ...patch, savedAt: new Date().toISOString() };
    setDraft(sameAsDoc(next, current) && !next.note ? null : next);
  };

  const save = () =>
    action.run(async () => {
      try {
        await send();
      } catch (err) {
        // No hub: the draft stays on the device and the outbox sends it when the hub answers again.
        if (!isUnreachable(err)) throw err;
        setDraft({ ...work, queued: { mode: canEdit ? "save" : "propose", at: new Date().toISOString() } });
        toast(t("docs.queuedToast", { doc: work.title || docKey }));
      }
    });
  const send = async () => {
    {
      if (canEdit) {
        const result = await client.call("docs.save", {
          key: docKey,
          content: work.content,
          title: work.title.trim() || undefined,
          includeInAgents: org ? work.includeInAgents : undefined,
          paths: wholeRepo(docKey) ? undefined : parsePaths(work.paths),
          note: work.note.trim() || undefined,
          baseVersion: current?.version ?? 0,
        });
        toast(t("docs.savedToast", { doc: work.title || docKey, version: result.version }));
      } else {
        // Contributors send the change as a proposal for someone who manages the project to approve.
        await client.call("proposals.create", { docKey, baseVersion: current?.version ?? 0, content: work.content, reason: work.note.trim() || t("docs.proposeDefaultReason") });
        toast(t("docs.proposedToast", { doc: work.title || docKey }));
      }
      setDraft(null);
      setShowDiff(false);
      setMode("view");
      doc.reload();
      onSaved();
    }
  };

  // ⌘S saves (or proposes) the draft.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (dirty && writer && !action.busy) void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const tool = (spec: Exclude<(typeof MD_TOOLS)[number], "sep">) => {
    const el = area.current;
    const start = el?.selectionStart ?? work.content.length;
    const end = el?.selectionEnd ?? work.content.length;
    const res =
      spec.id === "table"
        ? insertMd(work.content, start, end, `\n${t("docs.mdTable")}\n`)
        : spec.id === "link" && start === end
          ? insertMd(work.content, start, end, `[${t("docs.mdLinkText")}`, spec.post)
          : insertMd(work.content, start, end, spec.pre, spec.post ?? "", spec.line);
    edit({ content: res.text });
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(res.start, res.end);
    });
  };

  const editing = mode !== "view" && writer;
  const previewing = mode !== "edit" || !writer;

  let body: ReactNode;
  if (compare !== null) body = <VersionDiff docKey={docKey} version={compare} onClose={() => setCompare(null)} />;
  else if (showDiff)
    body = (
      <div className="min-h-0 flex-1 overflow-auto p-5">
        <Diff before={current?.content ?? ""} after={work.content} />
      </div>
    );
  else
    body = (
      <div className="flex min-h-0 min-w-0 flex-1">
        {editing ? (
          <div className={cn("flex min-w-0 flex-1 flex-col", previewing && "border-r border-line-subtle")}>
            <div className="flex shrink-0 flex-col gap-2 border-b border-line-subtle px-4 py-2.5">
              <div className="grid grid-cols-[100px_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
                <label htmlFor="doc-title" className="text-xs text-fg-muted">
                  {t("docs.docTitle")}
                </label>
                <Input id="doc-title" className="h-7 text-[13px]" value={work.title} readOnly={!canEdit} onChange={(e) => edit({ title: e.target.value })} />
                {wholeRepo(docKey) ? null : (
                  <>
                    <label htmlFor="doc-paths" className="text-xs text-fg-muted" title={t("docs.pathsHint")}>
                      {t("docs.paths")}
                    </label>
                    <Input
                      id="doc-paths"
                      className="h-7 font-mono text-xs"
                      placeholder={t("docs.pathsPlaceholder")}
                      title={t("docs.pathsHint")}
                      value={work.paths}
                      readOnly={!canEdit}
                      onChange={(e) => edit({ paths: e.target.value })}
                    />
                  </>
                )}
                <label htmlFor="doc-note" className="text-xs text-fg-muted">
                  {t("docs.note")}
                </label>
                <Input
                  id="doc-note"
                  className="h-7 text-[13px]"
                  placeholder={canEdit ? t("docs.notePlaceholder") : t("docs.reasonPlaceholder")}
                  value={work.note}
                  onChange={(e) => edit({ note: e.target.value })}
                />
              </div>
              {org ? (
                <label className="flex items-center gap-2 text-xs text-fg-secondary">
                  <Checkbox checked={work.includeInAgents} disabled={!canEdit} onCheckedChange={(v) => edit({ includeInAgents: v === true })} />
                  {t("docs.includeInAgents")}
                </label>
              ) : null}
              {stale ? <Notice tone="warn">{t("docs.draftStale", { version: current!.version, base: draft!.baseVersion })}</Notice> : null}
              <HiddenChars
                fields={[
                  { label: t("docs.docTitle"), text: work.title },
                  { label: t("docs.content"), text: work.content },
                  { label: t("docs.note"), text: work.note },
                ]}
                onStrip={() => edit({ title: stripHidden(work.title), content: stripHidden(work.content), note: stripHidden(work.note) })}
              />
            </div>
            <textarea
              ref={area}
              value={work.content}
              onChange={(e) => edit({ content: e.target.value })}
              spellCheck={false}
              aria-label={t("docs.content")}
              placeholder={t("docs.contentPlaceholder")}
              className="min-h-0 w-full flex-1 resize-none border-0 bg-code px-6 py-5 font-mono text-[13px]/[22px] text-code-fg outline-none placeholder:text-fg-muted"
            />
          </div>
        ) : null}
        {previewing ? (
          <div className="min-w-[280px] flex-1 overflow-y-auto">
            <div className="mx-auto max-w-[720px] px-8 pt-6 pb-12">
              {work.content.trim() ? <DocMarkdown text={work.content} /> : <p className="m-0 text-[15px] text-fg-muted">{t("docs.empty")}</p>}
            </div>
          </div>
        ) : null}
      </div>
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-[44px] shrink-0 flex-wrap items-center gap-2 border-b border-line-subtle px-4 py-2">
        <span className="min-w-0 truncate font-mono text-xs/none font-medium text-fg-muted">{docKey}</span>
        {current ? <span className="inline-flex h-5 items-center rounded-xs bg-sunken px-1.5 font-mono text-[11px]/none font-medium text-fg-secondary">v{current.version}</span> : null}
        {current?.includeInAgents ? (
          <span className="inline-flex h-5 items-center rounded-xs bg-info-soft px-[7px] text-[11px]/none font-semibold whitespace-nowrap text-info">{t("docs.inAgents")}</span>
        ) : null}
        {draft?.queued ? (
          <span title={t("docs.queuedHint")} className="inline-flex h-5 items-center rounded-xs bg-warning-soft px-[7px] text-[11px]/none font-semibold whitespace-nowrap text-warning">
            {t("docs.queued")}
          </span>
        ) : null}
        {current?.paths?.length ? (
          <span title={current.paths.join(", ")} className="inline-flex h-5 items-center rounded-xs bg-info-soft px-[7px] text-[11px]/none font-semibold whitespace-nowrap text-info">
            {t("docs.pathsChip", { count: current.paths.length })}
          </span>
        ) : null}
        <span className="flex-1" />
        {writer ? (
          <Seg
            label={t("docs.modes")}
            value={mode}
            onChange={(m) => {
              setMode(m);
              setCompare(null);
            }}
            options={[
              ["view", t("docs.modeView")],
              ["edit", t("docs.modeEdit")],
              ["split", t("docs.modeSplit")],
            ]}
          />
        ) : null}
        {current ? (
          <Button size="sm" variant="outline" aria-pressed={hist} className={cn(hist && "bg-selected")} onClick={() => setHist((h) => !h)}>
            {t("docs.history")}
          </Button>
        ) : null}
        {dirty ? (
          <>
            <Button size="sm" variant="ghost" onClick={() => setShowDiff((v) => !v)} aria-pressed={showDiff}>
              {showDiff ? t("docs.hideChanges") : t("docs.showChanges")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setDraft(null);
                setShowDiff(false);
                toast(t("docs.discarded", { doc: work.title || docKey }));
              }}
            >
              {t("docs.discard")}
            </Button>
            {writer ? (
              <Button size="sm" onClick={() => void save()} disabled={action.busy} title={t("docs.saveShortcut")}>
                {action.busy ? (canEdit ? t("docs.saving") : t("docs.sending")) : canEdit ? t("docs.saveAs", { version: (current?.version ?? 0) + 1 }) : t("docs.propose")}
              </Button>
            ) : null}
          </>
        ) : null}
      </div>
      {editing && compare === null && !showDiff ? (
        <div role="toolbar" aria-label={t("docs.toolbar")} className="flex shrink-0 items-center gap-0.5 border-b border-line-subtle bg-subtle px-3 py-1">
          {MD_TOOLS.map((spec, i) => {
            if (spec === "sep") return <span key={`s${i}`} className="mx-1 h-4 w-px bg-line-default" />;
            const Icon = MD_ICON[spec.id];
            return (
              <button
                key={spec.id}
                type="button"
                onClick={() => tool(spec)}
                aria-label={t(`docs.md.${spec.id}`)}
                title={t(`docs.md.${spec.id}`)}
                className="grid size-7 cursor-pointer place-items-center rounded-[5px] text-fg-secondary outline-none hover:bg-hover hover:text-fg-strong focus-visible:focus-ring"
              >
                <Icon className="size-[15px]" />
              </button>
            );
          })}
          <span className="ml-auto text-[11px]/none text-fg-muted">{dirty ? t("docs.draftLocal") : t("docs.saveShortcut")}</span>
        </div>
      ) : null}
      {doc.error ?? action.error ? (
        <div className="px-4 pt-3">
          <ErrorNote error={doc.error ?? action.error} />
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1">
        {body}
        {hist && current ? <HistoryPanel docKey={docKey} version={current.version} selected={compare} onPick={setCompare} /> : null}
      </div>
      {!writer ? <p className="m-0 border-t border-line-subtle bg-subtle px-4 py-2 text-xs text-fg-muted">{t("docs.viewOnly")}</p> : null}
    </div>
  );
}

function HistoryPanel({ docKey, version, selected, onPick }: { docKey: string; version: number; selected: number | null; onPick: (v: number | null) => void }) {
  const { client } = useHive();
  const t = useT();
  const history = useQuery(() => client.call("docs.history", { key: docKey }), [client, docKey, version]);
  const versions: DocVersion[] = history.data ?? [];
  return (
    <aside aria-label={t("docs.versions")} className="flex w-[250px] shrink-0 flex-col gap-1 overflow-y-auto border-l border-line-subtle p-3">
      <span className="px-1.5 pb-1.5 text-[11px]/4 font-semibold text-fg-muted">{t("docs.versions")}</span>
      {!versions.length && !history.loading ? <span className="px-1.5 text-xs text-fg-muted">{t("docs.noVersions")}</span> : null}
      {versions.map((v, i) => (
        <button
          key={v.version}
          type="button"
          onClick={() => onPick(selected === v.version ? null : v.version)}
          aria-pressed={selected === v.version}
          className={cn("flex cursor-pointer flex-col gap-0.5 rounded-sm p-2 text-left outline-none focus-visible:focus-ring", selected === v.version ? "bg-selected" : "hover:bg-hover")}
        >
          <span className="flex gap-1.5 font-mono text-xs/4 font-semibold text-fg-strong">
            v{v.version}
            {i === 0 ? <span className="font-sans text-[11px] font-normal text-success">{t("docs.currentVersion")}</span> : null}
            <span className="ml-auto font-sans text-[11px]/4 font-normal text-fg-muted">{formatTime(v.createdAt)}</span>
          </span>
          <span className="text-xs/[17px] text-fg-secondary">{v.note || t("docs.noNote")}</span>
          <span className="text-[11px]/4 text-fg-muted">
            {v.author}
            {sourceText(v.source)}
          </span>
        </button>
      ))}
    </aside>
  );
}

/** What one version changed against the one before it. */
function VersionDiff({ docKey, version, onClose }: { docKey: string; version: number; onClose: () => void }) {
  const { client } = useHive();
  const t = useT();
  const history = useQuery(() => client.call("docs.history", { key: docKey }), [client, docKey]);
  const versions = history.data ?? [];
  const i = versions.findIndex((v) => v.version === version);
  const v = versions[i];
  const prev = versions[i + 1];
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line-subtle px-4">
        <span className="font-mono text-xs font-semibold text-fg-strong">{t("docs.compare", { from: prev?.version ?? 0, to: version })}</span>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={onClose}>
          <X />
          {t("docs.closeCompare")}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-5">{v ? <Diff before={prev?.content ?? ""} after={v.content} /> : null}</div>
    </div>
  );
}
