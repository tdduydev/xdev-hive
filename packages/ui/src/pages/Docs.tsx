// Tài liệu (docs/design/2026-09-redesign, xDev Hive Client): spaces (Chung and each project) and their pages on the
// left, as a tree of folders and pages under pages (roadmap 22j); the page on the right in Xem / Sửa (the rich editor,
// roadmap 23a) / Markdown (the source with a toolbar and a preview), its files, its versions, and drafts that stay on
// the device until saved. Managers save a new version, contributors send it as a proposal.
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  BookOpen,
  Bold,
  ChevronDown,
  ChevronRight,
  Code,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Heading2,
  History,
  ImageIcon,
  Italic,
  Link2,
  List,
  Paperclip,
  Plus,
  Quote,
  Sparkles,
  Table,
  X,
} from "lucide-react";
import { cn } from "cn";
import { DOC_ASSET_MAX_BYTES, docLinkRefs, isContextDoc, keyPrefix, parseDocKey, resolveDocLink, stripHidden, systemOf, systemOwner, type Doc, type DocSummary, type DocVersion, type HiveSystem } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Checkbox } from "@xdev-hive/ui/components/ui/checkbox";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/components/ui/native-select";
import { Diff } from "#ui/components/Diff.tsx";
import { AttachmentsPanel, uploadDocAsset, useDocAssets } from "#ui/components/DocAssets.tsx";
import { DocAssistant } from "#ui/components/DocAssistant.tsx";
import { DocMarkdown, docHref, type DocContext } from "#ui/components/DocMarkdown.tsx";
import { LinkPicker } from "#ui/components/LinkPicker.tsx";
import { HiddenChars } from "#ui/components/HiddenChars.tsx";
import { ErrorNote, Notice } from "#ui/components/common.tsx";
import { MobileBack } from "#ui/components/MobileDetail.tsx";
import { PaneEmpty } from "#ui/components/panes.tsx";
import { errorMessage, formatTime, sourceText, useAction, useCan, useHive, useQuery } from "#ui/hooks.ts";
import { useT, type TFunction } from "#ui/i18n/index.tsx";
import { DRAFTS_EVENT, insertMd, isUnreachable, parsePaths, readDrafts, writeDrafts, type DocDraft } from "#ui/lib/docdraft.ts";
import { buildTree, flatten, freeSlug, isServiceGroup, parentChoices, slugify, systemTree, trail, type TreeNode } from "#ui/lib/doctree.ts";
import { emptyState } from "#ui/lib/empty.ts";
import { fold } from "#ui/lib/text.ts";
import { useMobileDetail } from "#ui/lib/mobile-detail.ts";
import { docOwner, docPrefix, inScope, ownerName, projectScope, SHARED, systemScope, type Scope } from "#ui/lib/scope.ts";
import { useToast } from "#ui/shell/toast.tsx";

/** The project's AGENTS.md and decisions doc are for the whole repo. */
const wholeRepo = (key: string) => /^project\/[^/]+\/(agents|decisions)$/.test(key);

/** The slug part of a new page's key (core keys.ts); skills are made on the Skill page. */
const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;

/** A folder shows this many pages until "Xem thêm". */
const FOLDER_PAGE = 12;

/** Xem, Sửa (the rich editor, roadmap 23a), Markdown (the source, with its preview beside it). */
type Mode = "view" | "edit" | "markdown";

// Tiptap is big: it loads when a page is first edited.
const RichEditor = lazy(() => import("#ui/components/RichEditor.tsx"));

interface Space {
  id: string;
  /** null = shared by every project (org/*); sys:<name> = a system's (roadmap 19c). */
  owner: string | null;
  label: string;
  docs: DocSummary[];
  /** A system's space (roadmap 40c) also holds these services' pages, a group each after the system's own. */
  services?: string[];
}

/**
 * The spaces a scope shows: Chung, each project in it, and the systems those projects are services of (roadmap 19c).
 * A system's scope, and the scope of one of its services, show the system's space holding its services' pages too
 * (roadmap 40c): the system's own pages first, then a group per service (only the scope's own one for a service).
 */
function spacesFor(all: DocSummary[], scope: Scope, t: TFunction, systems: HiveSystem[], seen: (owner: string) => boolean): Space[] {
  const shared: Space = { id: "shared", owner: null, label: t("inbox.shared"), docs: all.filter((d) => docOwner(d.key) === null) };
  const of = (p: string): Space => ({ id: `project:${p}`, owner: p, label: p, docs: all.filter((d) => docOwner(d.key) === p) });
  const sys = (name: string): Space => ({ id: `system:${name}`, owner: systemOwner(name), label: t("docs.systemSpace", { system: name }), docs: all.filter((d) => docOwner(d.key) === systemOwner(name)) });
  const visible = systems.filter((s) => seen(systemOwner(s.name)));
  if (scope.kind === "shared") return [shared];
  const withServices = (name: string, services: string[]): Space => {
    const own = sys(name);
    return { ...own, docs: [...own.docs, ...services.flatMap((p) => of(p).docs)], services };
  };
  if (scope.kind === "project") {
    const mine = visible.filter((s) => s.projects.includes(scope.project));
    return [...(mine.length ? mine.map((s) => withServices(s.name, [scope.project])) : [of(scope.project)]), shared];
  }
  if (scope.kind === "system") {
    const services = [...scope.projects].sort();
    return [...(visible.some((s) => s.name === scope.system) ? [withServices(scope.system, services)] : services.map(of)), shared];
  }
  const owners = [...new Set(all.map((d) => docOwner(d.key)).filter((p): p is string => p !== null))];
  const projects = owners.filter((p) => systemOf(p) === null).sort();
  // A system with pages the list has shows even when the system list is older than it (made since the app opened).
  const names = [...new Set([...visible.map((s) => s.name), ...owners.map(systemOf).filter((n): n is string => n !== null)])].sort();
  return [shared, ...names.map(sys), ...projects.map(of)];
}

/** The space with that id; a project's page whose project is a group of a system's space opens there. */
function findSpace(spaces: Space[], id: string | null): Space | null {
  const found = spaces.find((s) => s.id === id);
  if (found) return found;
  const project = id?.startsWith("project:") ? id.slice("project:".length) : null;
  return (project !== null ? spaces.find((s) => s.services?.includes(project)) : undefined) ?? spaces[0] ?? null;
}

/** The owners whose pages a space holds: its own, then its services'. */
const spaceOwners = (space: Space | null): Array<string | null> => (space ? [space.owner, ...(space.services ?? [])] : []);

const spaceIdOf = (key: string) => {
  const owner = docOwner(key);
  const system = systemOf(owner);
  return owner === null ? "shared" : system !== null ? `system:${system}` : `project:${owner}`;
};

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
          // Picked by value in the smoke run, whatever the interface language.
          data-value={k}
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

interface Creating {
  kind: "page" | "folder";
  /** Whose page it will be: the system's by default in a system's space, or one of its services' (roadmap 40c). */
  owner: string | null;
  parent: string | null;
  title: string;
  /** Typed by hand; else it follows the title. */
  slug: string | null;
}

export function DocsPage() {
  const { client, scope, setScope, systems } = useHive();
  const t = useT();
  const allow = useCan();
  const toast = useToast();
  const list = useQuery(() => client.call("docs.list", {}), [client]);
  const spaces = useMemo(() => spacesFor(list.data ?? [], scope, t, systems, (owner) => allow(owner, "view")), [list.data, scope, t, systems, allow]);
  const titles = useMemo(() => new Map((list.data ?? []).map((d) => [d.key, d.title])), [list.data]);
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const space = findSpace(spaces, spaceId);
  const [selected, setSelected] = useState<string | null>(null);
  const [treeOpen, setTreeOpen] = useState(false);
  const mobileDetail = useMobileDetail("doc");
  const pick = (key: string | null) => {
    setSelected(key);
    setTreeOpen(false);
    if (mobileDetail.mobile) mobileDetail.navigate(key);
  };
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [more, setMore] = useState<Record<string, boolean>>({});
  const [creating, setCreating] = useState<Creating | null>(null);
  const [newError, setNewError] = useState<string | null>(null);
  const create = useAction();
  const [drafts, setDraftsState] = useState<Record<string, DocDraft>>(readDrafts);
  // The outbox sends queued saves when the hub is back: show what it left.
  useEffect(() => {
    const on = () => setDraftsState(readDrafts());
    window.addEventListener(DRAFTS_EVENT, on);
    return () => window.removeEventListener(DRAFTS_EVENT, on);
  }, []);
  // Written here, not in the state updater: React may run that while rendering, and writing tells other components.
  const draftsNow = useRef(drafts);
  draftsNow.current = drafts;
  const setDraft = useCallback((key: string, draft: DocDraft | null) => {
    const cur = draftsNow.current;
    if (!draft && !(key in cur)) return;
    const next = { ...cur };
    if (draft) next[key] = draft;
    else delete next[key];
    draftsNow.current = next;
    writeDrafts(next);
    setDraftsState(next);
  }, []);

  // #/docs?doc=<key> (command palette, links): open that doc, moving to its scope when it is outside this one.
  const linked = mobileDetail.value;
  useEffect(() => {
    if (!linked || !list.data) return;
    if (list.data.some((d) => d.key === linked) || drafts[linked]) {
      const owner = docOwner(linked);
      const system = systemOf(owner);
      // A system's page outside this scope opens in the system's scope, where its space is.
      if (!inScope(scope, owner) && !(system !== null && spacesFor(list.data, scope, t, systems, () => true).some((s) => s.owner === owner))) {
        setScope(owner === null ? SHARED : system !== null ? systemScope(system, systems.find((s) => s.name === system)?.projects ?? []) : projectScope(owner));
      }
      setSpaceId(spaceIdOf(linked));
      setSelected(linked);
      setQ("");
    }
    if (!mobileDetail.mobile) mobileDetail.navigate(null, true);
  }, [linked, list.data, drafts, scope, setScope, t, systems, mobileDetail.mobile, mobileDetail.navigate]);

  const owners = useMemo(() => spaceOwners(space), [space]);
  const prefixes = useMemo(() => owners.map(docPrefix), [owners]);
  const inSpace = useCallback((key: string) => prefixes.some((p) => key.startsWith(p)), [prefixes]);
  // Pages made here and not saved yet sit in the tree with their draft.
  const unsaved = useMemo(
    () =>
      Object.entries(drafts)
        .filter(([k, d]) => inSpace(k) && d.baseVersion === 0 && !titles.has(k))
        .map(([key, d]) => ({ key, title: d.title, parent: d.parent ?? null })),
    [drafts, inSpace, titles],
  );
  const tree = useMemo(() => {
    const label = t("docs.skillsFolder");
    if (!space?.services) return buildTree(space?.docs ?? [], unsaved, label);
    const own = (owner: string | null) => (d: { key: string }) => docOwner(d.key) === owner;
    return systemTree(
      space.docs.filter(own(space.owner)),
      unsaved.filter(own(space.owner)),
      space.services.map((p) => ({ project: p, docs: space.docs.filter(own(p)), extra: unsaved.filter(own(p)) })),
      label,
    );
  }, [space, unsaved, t]);
  const nodes = useMemo(() => flatten(tree), [tree]);

  // A folder just made is selected before the list has it.
  const justMade = useRef<string | null>(null);
  // Keep the selection inside the space: the first page of the space when it falls out.
  useEffect(() => {
    if (!list.data || linked || !space) return;
    if (selected && selected === justMade.current) return;
    if (selected && inSpace(selected) && (titles.has(selected) || drafts[selected])) return;
    // On a phone the list is the first screen: opening a page there would hide it behind a page nobody picked.
    if (!mobileDetail.mobile) setSelected(nodes.find((n) => n.doc)?.key ?? null);
  }, [list.data, space, selected, linked, nodes, inSpace, titles, drafts, mobileDetail.mobile]);

  const selTrail = useMemo(() => new Set(selected ? trail(tree, selected).map((n) => n.key) : []), [tree, selected]);
  const isOpen = (n: TreeNode, depth: number) => open[n.key] ?? (selTrail.has(n.key) || (depth === 0 && n.folder));

  const needle = fold(q.trim());
  const hits = useMemo(() => (needle ? nodes.filter((n) => (n.doc || !n.folder) && fold(`${n.title} ${n.key}`).includes(needle)) : []), [nodes, needle]);

  // Where the person may make pages in this space; the first is where new ones go (the system's, roadmap 40c).
  const writable = owners.filter((o) => allow(o, "docEdit"));
  const canCreateHere = writable.length > 0;
  const empty = emptyState({ loaded: !list.loading, total: nodes.length, shown: needle ? hits.length : nodes.length, query: needle });
  const taken = (key: string) => titles.has(key) || Boolean(drafts[key]);
  const slugFor = (c: Creating) => c.slug ?? freeSlug(docPrefix(c.owner), slugify(c.title), taken);
  const startCreate = (kind: Creating["kind"], parent: string | null) => {
    if (!writable.length) return;
    const under = parent !== null ? docOwner(parent) : null;
    setNewError(null);
    setCreating(parent !== null && writable.includes(under) ? { kind, owner: under, parent, title: "", slug: null } : { kind, owner: writable[0]!, parent: null, title: "", slug: null });
    if (parent) setOpen((o) => ({ ...o, [parent]: true }));
  };
  const doCreate = () => {
    if (!creating) return;
    const title = creating.title.trim();
    const slug = slugFor(creating);
    if (!title) return setNewError(t("docs.needTitle"));
    if (!SLUG.test(slug)) return setNewError(t("docs.badSlug"));
    const key = docPrefix(creating.owner) + slug;
    try {
      parseDocKey(key);
    } catch (err) {
      return setNewError(errorMessage(err));
    }
    if (taken(key)) return setNewError(t("docs.slugTaken", { key }));
    setNewError(null);
    if (creating.kind === "folder") {
      // A folder is a page that holds pages: saved right away, empty.
      void create.run(async () => {
        await client.call("docs.save", { key, content: "", title, folder: true, parent: creating.parent, baseVersion: 0 });
        toast(t("docs.folderCreated", { title }));
        setCreating(null);
        setOpen((o) => ({ ...o, [key]: true }));
        justMade.current = key;
        pick(key);
        list.reload();
      });
      return;
    }
    // A page starts as a draft on this device, where it will go in the tree: the first save makes it.
    setDraft(key, { ...draftOf(null, key), title, parent: creating.parent });
    pick(key);
    setCreating(null);
  };

  const row = (n: TreeNode, depth: number, path?: string) => {
    const on = n.key === selected;
    const kids = n.children.length > 0;
    const expanded = isOpen(n, depth);
    const virtual = !n.doc && n.folder;
    const openable = !virtual;
    const Icon = n.folder || kids ? (expanded ? FolderOpen : Folder) : FileText;
    return (
      <div key={n.key} data-service-group={isServiceGroup(n) ? n.title : undefined} className="group relative flex items-center" style={{ paddingLeft: depth * 14 }}>
        <button
          type="button"
          tabIndex={-1}
          aria-hidden={!kids}
          aria-label={expanded ? t("docs.collapse", { title: n.title }) : t("docs.expand", { title: n.title })}
          onClick={() => setOpen((o) => ({ ...o, [n.key]: !expanded }))}
          className={cn("grid size-5 shrink-0 cursor-pointer place-items-center rounded-xs text-fg-muted hover:text-fg-strong", !kids && "invisible")}
        >
          {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        </button>
        <button
          type="button"
          role="treeitem"
          aria-selected={on}
          aria-expanded={kids ? expanded : undefined}
          onClick={() => (openable ? pick(n.key) : setOpen((o) => ({ ...o, [n.key]: !expanded })))}
          title={n.key}
          className={cn(
            "flex h-[30px] min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-sm pr-2 pl-1 text-left text-[13px]/none outline-none focus-visible:focus-ring",
            on ? "bg-surface font-semibold text-fg-strong shadow-e1" : "text-fg-primary hover:bg-hover",
            n.folder && !on && "font-semibold text-fg-secondary",
          )}
        >
          <Icon className={cn("size-3.5 shrink-0", n.folder || kids ? "text-fg-brand" : "text-fg-muted")} />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate">{n.title}</span>
            {path ? <span className="truncate text-[11px]/none font-normal text-fg-muted">{path}</span> : null}
          </span>
          {drafts[n.key] ? <span title={n.doc ? t("docs.draftLocal") : t("docs.unsavedPage")} className="size-1.5 shrink-0 rounded-full bg-warning-solid" /> : null}
          {kids && !expanded ? <span className="text-[11px]/none font-normal text-fg-muted">{n.children.length}</span> : null}
        </button>
        {n.doc && !virtual && !path && writable.includes(docOwner(n.key)) ? (
          <button
            type="button"
            aria-label={t("docs.addUnder", { title: n.title })}
            title={t("docs.addUnder", { title: n.title })}
            onClick={() => startCreate("page", n.key)}
            className="absolute right-1 hidden size-6 cursor-pointer place-items-center rounded-xs bg-surface text-fg-muted shadow-e1 outline-none group-hover:grid hover:text-fg-strong focus-visible:grid focus-visible:focus-ring"
          >
            <Plus className="size-3.5" />
          </button>
        ) : null}
      </div>
    );
  };
  const branch = (list: TreeNode[], depth: number): ReactNode[] =>
    list.flatMap((n) => {
      const out: ReactNode[] = [row(n, depth)];
      if (n.children.length && isOpen(n, depth)) {
        const all = more[n.key] || n.children.length <= FOLDER_PAGE + 2;
        out.push(...branch(all ? n.children : n.children.slice(0, FOLDER_PAGE), depth + 1));
        if (!all) {
          out.push(
            <button
              key={`${n.key}-more`}
              type="button"
              onClick={() => setMore((m) => ({ ...m, [n.key]: true }))}
              style={{ paddingLeft: (depth + 1) * 14 + 26 }}
              className="flex h-7 cursor-pointer items-center gap-1.5 rounded-sm text-left text-xs font-medium text-fg-link outline-none hover:bg-hover focus-visible:focus-ring"
            >
              <Plus className="size-3" />
              {t("docs.showMore", { count: n.children.length - FOLDER_PAGE })}
            </button>,
          );
        }
      }
      return out;
    });

  const parentTitle = creating?.parent ? (nodes.find((n) => n.key === creating.parent)?.title ?? creating.parent) : null;
  const active = mobileDetail.mobile ? mobileDetail.value : selected;
  const selectedNode = active ? nodes.find((n) => n.key === active) : undefined;

  return (
    <div className="mobile-master-detail flex h-full min-h-0 w-full bg-surface">
      {treeOpen && mobileDetail.showingDetail ? <button type="button" aria-label={t("common.close")} onClick={() => setTreeOpen(false)} className="fixed inset-0 z-30 bg-black/40 md:hidden" /> : null}
      <div className={cn("min-w-0 flex-1 flex-col border-r border-line-subtle bg-subtle md:flex md:min-w-[200px] md:flex-none md:shrink md:basis-[260px]", mobileDetail.showingDetail ? treeOpen ? "fixed inset-y-0 left-0 z-40 flex w-[min(340px,85vw)]" : "hidden" : "flex")}>
        <div className="flex shrink-0 flex-col gap-2 border-b border-line-subtle px-3 py-2.5">
          {spaces.length <= 3 ? (
            <Seg
              label={t("docs.list")}
              value={space?.id ?? ""}
              options={spaces.map((s) => [s.id, s.label])}
              onChange={(v) => {
                setSpaceId(v);
                pick(null);
                setCreating(null);
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
                pick(null);
                setCreating(null);
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
          {/* The page's own button goes at the right of its toolbar, as on Spec, Skill and Memory (roadmap 39h). */}
          <div className="flex items-center gap-1.5">
            <Input className="h-7 min-w-0 flex-1 text-xs" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("docs.search")} aria-label={t("docs.search")} />
            {canCreateHere && !creating ? (
              <>
                <Button size="icon-sm" variant="ghost" aria-label={t("docs.newFolder")} title={t("docs.newFolder")} onClick={() => startCreate("folder", null)}>
                  <FolderPlus />
                </Button>
                <Button size="sm" variant="outline" className="shrink-0" onClick={() => startCreate("page", selectedNode?.folder ? selectedNode.key : null)}>
                  {t("docs.newPage")}
                </Button>
              </>
            ) : null}
          </div>
          {/* The form opens right under the button that opened it, not at the far end of the pane. */}
          {creating ? (
            <div className="flex flex-col gap-1.5 rounded-md border border-line-selected bg-surface p-2">
              <span className="text-[11px]/4 font-semibold text-fg-muted">
                {creating.kind === "folder"
                  ? parentTitle
                    ? t("docs.newFolderIn", { parent: parentTitle })
                    : t("docs.newFolderTop", { space: ownerName(creating.owner, t("inbox.shared")) })
                  : parentTitle
                    ? t("docs.newPageIn", { parent: parentTitle })
                    : t("docs.newPageTop", { space: ownerName(creating.owner, t("inbox.shared")) })}
              </span>
              {writable.length > 1 ? (
                <NativeSelect
                  size="sm"
                  wrapperClassName="w-full"
                  value={creating.owner ?? ""}
                  title={t("docs.placeInHint")}
                  aria-label={t("docs.placeIn")}
                  data-doc-owner
                  onChange={(e) => {
                    const owner = e.target.value;
                    // A parent of another owner cannot hold the page: it goes to the top of the one picked.
                    setCreating({ ...creating, owner, parent: creating.parent !== null && docOwner(creating.parent) === owner ? creating.parent : null });
                  }}
                >
                  {writable.map((o) => (
                    <NativeSelectOption key={o ?? ""} value={o ?? ""}>
                      {t("docs.placeIn")}: {ownerName(o, t("inbox.shared"))}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              ) : null}
              <Input
                autoFocus
                className="h-7 text-xs"
                placeholder={creating.kind === "folder" ? t("docs.folderPlaceholder") : t("docs.pagePlaceholder")}
                value={creating.title}
                aria-invalid={newError ? true : undefined}
                onChange={(e) => setCreating({ ...creating, title: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") doCreate();
                  if (e.key === "Escape") setCreating(null);
                }}
                aria-label={t("docs.docTitle")}
              />
              {creating.slug !== null ? (
                <Input
                  className="h-7 font-mono text-xs"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={creating.slug}
                  onChange={(e) => setCreating({ ...creating, slug: e.target.value.toLowerCase() })}
                  onKeyDown={(e) => e.key === "Enter" && doCreate()}
                  aria-label={t("docs.slug")}
                />
              ) : null}
              <span className="flex items-center gap-1.5 font-mono text-[11px] break-all text-fg-muted">
                <span className="min-w-0 flex-1" data-new-doc-key>
                  {docPrefix(creating.owner) + (slugFor(creating) || `<${t("docs.slugPlaceholder")}>`)}
                </span>
                {creating.slug === null ? (
                  <button type="button" onClick={() => setCreating({ ...creating, slug: slugFor(creating) })} className="cursor-pointer font-sans text-fg-link hover:underline">
                    {t("docs.editSlug")}
                  </button>
                ) : null}
              </span>
              <ErrorNote error={newError ?? create.error} />
              <div className="flex justify-end gap-1.5">
                <Button size="xs" variant="ghost" onClick={() => setCreating(null)}>
                  {t("docs.cancelNew")}
                </Button>
                <Button size="xs" onClick={doCreate} disabled={!creating.title.trim() || create.busy}>
                  {t("docs.create")}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
        <div role="tree" aria-label={t("docs.list")} className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto p-1.5">
          <ErrorNote error={list.error} />
          {needle ? hits.map((n) => row(n, 0, n.path.join(" / ") || undefined)) : branch(tree, 0)}
          {/* The button for an empty space sits in the wide pane on the right, so the narrow tree keeps the sentence alone. */}
          {empty ? <PaneEmpty>{t(empty === "none" ? "docs.none" : "docs.noMatch")}</PaneEmpty> : null}
        </div>
        <div className="flex shrink-0 flex-col gap-1.5 border-t border-line-subtle px-3 py-2">
          <span className="text-[11px] text-fg-muted">{t("docs.pageCount", { count: space?.docs.length ?? 0 })}</span>
        </div>
      </div>
      <div className={cn("min-w-0 flex-1 flex-col", mobileDetail.mobile && !mobileDetail.showingDetail ? "hidden md:flex" : "flex")}>
        {mobileDetail.showingDetail ? <div className="flex items-center"><MobileBack onClick={() => pick(null)} /><Button variant="ghost" className="min-h-10" onClick={() => setTreeOpen(true)}>{t("docs.list")}</Button></div> : null}
        {active ? (
          <DocView
            key={active}
            docKey={active}
            canEdit={allow(docOwner(active), isContextDoc(active, (list.data ?? []).find((d) => d.key === active)) ? "contextEdit" : "docEdit")}
            canPropose={allow(docOwner(active), "docPropose")}
            draft={drafts[active] ?? null}
            setDraft={(d) => setDraft(active, d)}
            onSaved={list.reload}
            tree={tree}
            titles={titles}
            spaceLabel={ownerName(docOwner(active), t("inbox.shared"))}
            onPick={pick}
            onNew={(parent) => startCreate("page", parent)}
          />
        ) : (
          <div className="grid flex-1 place-items-center p-6">
            {empty === "none" ? (
              <PaneEmpty
                action={
                  canCreateHere ? (
                    <Button size="sm" data-empty-action onClick={() => startCreate("page", null)}>
                      {t("docs.newFirst")}
                    </Button>
                  ) : null
                }
              >
                {t("docs.none")}
              </PaneEmpty>
            ) : (
              <span className="text-[13px] text-fg-muted">{t("docs.pick")}</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

type MdId = "heading" | "bold" | "italic" | "code" | "list" | "quote" | "table" | "link" | "image";
const MD_ICON: Record<MdId, typeof Bold> = { heading: Heading2, bold: Bold, italic: Italic, code: Code, list: List, quote: Quote, table: Table, link: Link2, image: ImageIcon };
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
  { id: "link", pre: "" },
  { id: "image", pre: "" },
];

type Panel = "assist" | "files" | "history" | null;

function DocView({
  docKey,
  canEdit,
  canPropose,
  draft,
  setDraft,
  onSaved,
  tree,
  titles,
  spaceLabel,
  onPick,
  onNew,
}: {
  docKey: string;
  canEdit: boolean;
  canPropose: boolean;
  draft: DocDraft | null;
  setDraft: (d: DocDraft | null) => void;
  onSaved: () => void;
  tree: TreeNode[];
  titles: ReadonlyMap<string, string>;
  spaceLabel: string;
  onPick: (key: string) => void;
  onNew: (parent: string) => void;
}) {
  const { client } = useHive();
  const t = useT();
  const toast = useToast();
  const doc = useQuery(() => client.call("docs.get", { key: docKey }), [client, docKey]);
  const current: Doc | null = doc.data ?? null;
  const writer = canEdit || canPropose;
  const [mode, setMode] = useState<Mode>("view");
  const [props, setProps] = useState(false);
  // A page made just now opens with the assistant beside it, but not on a phone: there a panel takes the editor's place,
  // so the new page would open with nowhere to write (the assistant stays one tap away in the modes menu).
  const [panel, setPanel] = useState<Panel>(() =>
    draft && draft.baseVersion === 0 && !draft.content.trim() && !window.matchMedia("(max-width: 767px)").matches ? "assist" : null,
  );
  const [compare, setCompare] = useState<number | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [picker, setPicker] = useState(false);
  const action = useAction();
  const upload = useAction();
  const area = useRef<HTMLTextAreaElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  // The team's pages and a system's (roadmap 19c) go to AGENTS.md only when asked; a project's has its own AGENTS.md.
  const org = docKey.startsWith("org/") || docKey.startsWith("system/");
  const files = useDocAssets(docKey);
  const links = useQuery(async () => (current ? client.call("docs.links", { key: docKey }).catch(() => null) : null), [client, docKey, current?.version]);
  const path = useMemo(() => trail(tree, docKey), [tree, docKey]);
  const node = path.at(-1);

  // A page that does not exist yet opens in edit mode; one with a draft opens where the draft can be seen.
  useEffect(() => {
    if (doc.loading) return;
    if (!current && writer) setMode("edit");
    else if (draft && writer) setMode("edit");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.loading]);

  const work = draft ?? draftOf(current, docKey);
  const dirty = draft !== null && !sameAsDoc(draft, current);
  const stale = draft !== null && current !== null && current.version > draft.baseVersion;
  const edit = (patch: Partial<DocDraft>) => {
    const next = { ...work, ...patch, savedAt: new Date().toISOString() };
    // A new page keeps its draft (and so its place in the tree) until it is saved.
    setDraft(sameAsDoc(next, current) && !next.note && current ? null : next);
  };
  // Uploads finish later: they insert into the draft as it is by then.
  const latest = useRef({ work, edit });
  latest.current = { work, edit };
  const insertAt = (md: string, sel?: { start: number; end: number }) => {
    const { work: w, edit: e } = latest.current;
    const el = area.current;
    const start = sel?.start ?? el?.selectionStart ?? w.content.length;
    const end = sel?.end ?? el?.selectionEnd ?? start;
    const before = w.content.slice(0, start);
    const pad = before && !before.endsWith("\n") && md.startsWith("!") ? "\n" : "";
    const res = insertMd(w.content, start, end, pad + md);
    e({ content: res.text });
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(res.start, res.start);
    });
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
    if (canEdit) {
      const result = await client.call("docs.save", {
        key: docKey,
        content: work.content,
        title: work.title.trim() || undefined,
        includeInAgents: org ? work.includeInAgents : undefined,
        paths: wholeRepo(docKey) ? undefined : parsePaths(work.paths),
        note: work.note.trim() || undefined,
        baseVersion: current?.version ?? 0,
        ...(!current && work.parent ? { parent: work.parent } : {}),
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
  };

  const move = (parent: string | null) => {
    if (!current) return edit({ parent });
    void action.run(async () => {
      await client.call("docs.move", { key: docKey, parent });
      toast(t("docs.moved", { doc: current.title, parent: parent ? (titles.get(parent) ?? parent) : spaceLabel }));
      onSaved();
    });
  };

  // ⌘S saves (or proposes) the draft.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if ((dirty || (!current && draft)) && writer && !action.busy) void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const uploadFiles = (list: File[], sel?: { start: number; end: number }) =>
    void upload.run(async () => {
      for (const f of list) {
        const { markdown } = await uploadDocAsset(client, docKey, f, t("errors.chatFileTooBig", { name: f.name, mb: DOC_ASSET_MAX_BYTES / 1024 / 1024 }));
        insertAt(markdown, sel);
        sel = undefined;
      }
      toast(t("docs.uploaded", { count: list.length }));
      files.reload();
    });

  const tool = (spec: Exclude<(typeof MD_TOOLS)[number], "sep">) => {
    if (spec.id === "link") return setPicker((p) => !p);
    if (spec.id === "image") return imageInput.current?.click();
    const el = area.current;
    const start = el?.selectionStart ?? work.content.length;
    const end = el?.selectionEnd ?? work.content.length;
    const res = spec.id === "table" ? insertMd(work.content, start, end, `\n${t("docs.mdTable")}\n`) : insertMd(work.content, start, end, spec.pre, spec.post ?? "", spec.line);
    edit({ content: res.text });
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(res.start, res.end);
    });
  };

  const rich = mode === "edit" && writer;
  const source = mode === "markdown" && writer;
  const editing = rich || source;
  const previewing = !rich;
  const context: DocContext = useMemo(() => ({ key: docKey, titles, href: (k) => docHref(k) }), [docKey, titles]);
  const broken = useMemo(() => {
    const exists = (k: string) => titles.has(k);
    return docLinkRefs(work.content).filter((r) => resolveDocLink(r.target, docKey, exists)?.exists === false).length;
  }, [work.content, docKey, titles]);
  const images = (files.data ?? []).filter((f) => f.type.startsWith("image/")).length;
  const children = node?.children.filter((c) => c.doc) ?? [];
  // What the assistant offers as sources: pages linked either way, the page above, the pages below, the team's rules.
  const related = useMemo(() => {
    const keys = [
      ...(links.data?.out.filter((l) => l.exists).map((l) => l.key) ?? []),
      ...(links.data?.back.map((b) => b.key) ?? []),
      ...path.slice(0, -1).filter((n) => n.doc).map((n) => n.key),
      ...children.map((c) => c.key),
      ...(docKey.startsWith("project/") ? ["org/agent-protocol"] : []),
    ];
    return [...new Set(keys)].filter((k) => k !== docKey && titles.has(k)).map((k) => ({ key: k, title: titles.get(k)! }));
  }, [links.data, path, children, docKey, titles]);
  const applyAssist = (markdown: string) => {
    const before = draft;
    edit({ content: markdown });
    if (mode === "view" && writer) setMode("edit");
    return () => setDraft(before);
  };

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
              {rich ? (
                // The rich editor keeps the page in front: its title is the heading, its properties fold away.
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    aria-expanded={props}
                    onClick={() => setProps((v) => !v)}
                    className="flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-sm px-1.5 text-xs text-fg-muted outline-none hover:bg-hover hover:text-fg-strong focus-visible:focus-ring"
                  >
                    {props ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                    {t("docs.properties")}
                  </button>
                  <Input
                    aria-label={t("docs.note")}
                    className="h-7 min-w-0 flex-1 text-[13px]"
                    placeholder={canEdit ? t("docs.notePlaceholder") : t("docs.reasonPlaceholder")}
                    value={work.note}
                    onChange={(e) => edit({ note: e.target.value })}
                  />
                </div>
              ) : null}
              {!rich || props ? (
                <div className="grid grid-cols-[100px_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
                  {rich ? null : (
                    <>
                      <label htmlFor="doc-title" className="text-xs text-fg-muted">
                        {t("docs.docTitle")}
                      </label>
                      <Input id="doc-title" className="h-7 text-[13px]" value={work.title} readOnly={!canEdit} onChange={(e) => edit({ title: e.target.value })} />
                    </>
                  )}
                  {canEdit && !docKey.includes("/skills/") ? (
                    <>
                      <label htmlFor="doc-parent" className="text-xs text-fg-muted">
                        {t("docs.parent")}
                      </label>
                      <NativeSelect
                        id="doc-parent"
                        size="sm"
                        wrapperClassName="w-full"
                        value={(current ? current.parent : work.parent) ?? ""}
                        disabled={action.busy}
                        onChange={(e) => move(e.target.value || null)}
                      >
                        <NativeSelectOption value="">{t("docs.parentTop", { space: spaceLabel })}</NativeSelectOption>
                        {parentChoices(tree, docKey).map((n) => (
                          <NativeSelectOption key={n.key} value={n.key}>
                            {"  ".repeat(n.path.length)}
                            {n.title}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                    </>
                  ) : null}
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
                  {rich ? null : (
                    <>
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
                    </>
                  )}
                </div>
              ) : null}
              {org && (!rich || props) ? (
                <label className="flex items-center gap-2 text-xs text-fg-secondary">
                  <Checkbox checked={work.includeInAgents} disabled={!canEdit} onCheckedChange={(v) => edit({ includeInAgents: v === true })} />
                  {t(docKey.startsWith("system/") ? "docs.includeInSystemAgents" : "docs.includeInAgents")}
                </label>
              ) : null}
              {stale ? <Notice tone="warn">{t("docs.draftStale", { version: current!.version, base: draft!.baseVersion })}</Notice> : null}
              {/* Roadmap 26: the repo is its home; what is changed here goes when main next moves. */}
              {current?.mirror ? <Notice tone="warn">{t("docs.mirrorEdit", { from: current.mirror.from })}</Notice> : null}
              <HiddenChars
                fields={[
                  { label: t("docs.docTitle"), text: work.title },
                  { label: t("docs.content"), text: work.content },
                  { label: t("docs.note"), text: work.note },
                ]}
                onStrip={() => edit({ title: stripHidden(work.title), content: stripHidden(work.content), note: stripHidden(work.note) })}
              />
            </div>
            {rich ? (
              <Suspense fallback={<div className="p-6 text-[13px] text-fg-muted">{t("editor.loading")}</div>}>
                <RichEditor
                  docKey={docKey}
                  value={work.content}
                  onChange={(content) => edit({ content })}
                  titles={titles}
                  header={
                    <input
                      aria-label={t("docs.docTitle")}
                      value={work.title}
                      readOnly={!canEdit}
                      placeholder={t("docs.docTitle")}
                      onChange={(e) => edit({ title: e.target.value })}
                      className="mb-3 w-full border-0 bg-transparent p-0 text-[30px]/[38px] font-semibold tracking-tight text-fg-strong outline-none placeholder:text-fg-disabled"
                    />
                  }
                  onUseMarkdown={() => setMode("markdown")}
                  onError={(message) => message && toast(message, { tone: "error" })}
                />
              </Suspense>
            ) : (
            <textarea
              ref={area}
              value={work.content}
              onChange={(e) => edit({ content: e.target.value })}
              // An image pasted or dropped here is attached to the page and shown where it landed.
              onPaste={(e) => {
                const list = [...e.clipboardData.files];
                if (!list.length) return;
                e.preventDefault();
                uploadFiles(list);
              }}
              onDragOver={(e) => e.dataTransfer.types.includes("Files") && e.preventDefault()}
              onDrop={(e) => {
                const list = [...e.dataTransfer.files];
                if (!list.length) return;
                e.preventDefault();
                uploadFiles(list);
              }}
              spellCheck={false}
              aria-label={t("docs.content")}
              placeholder={t("docs.contentPlaceholder")}
              className="min-h-0 w-full flex-1 resize-none border-0 bg-code px-6 py-5 font-mono text-[13px]/[22px] text-code-fg outline-none placeholder:text-fg-muted"
            />
            )}
          </div>
        ) : null}
        {previewing ? (
          <div className={cn("min-w-0 flex-1 overflow-y-auto", editing && "hidden md:block")}>
            <div className="mx-auto flex max-w-[720px] flex-col gap-6 px-4 pt-6 pb-12 md:px-8">
              {work.content.trim() ? (
                <DocMarkdown text={work.content} doc={context} />
              ) : children.length || node?.folder ? null : (
                <p className="m-0 text-[15px] text-fg-muted">{t("docs.empty")}</p>
              )}
              {children.length || (node?.folder && canEdit) ? (
                <ChildPages nodes={children} onPick={onPick} onNew={canEdit && node?.doc ? () => onNew(docKey) : undefined} />
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    );

  const chip = "inline-flex h-5 items-center rounded-xs px-[7px] text-[11px]/none font-semibold whitespace-nowrap";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-[44px] shrink-0 flex-wrap items-center gap-2 border-b border-line-subtle px-4 py-2">
        <nav aria-label={t("docs.breadcrumb")} className="flex min-w-0 items-center gap-1 text-xs/none">
          <span className="shrink-0 font-mono font-medium text-fg-muted">{spaceLabel}</span>
          {path.slice(0, -1).map((n) => (
            <span key={n.key} className="flex min-w-0 items-center gap-1">
              <span className="text-fg-disabled">/</span>
              <button type="button" onClick={() => n.doc && onPick(n.key)} className="max-w-[160px] cursor-pointer truncate text-fg-secondary hover:text-fg-strong hover:underline">
                {n.title}
              </button>
            </span>
          ))}
          <span className="text-fg-disabled">/</span>
          <span title={docKey} className="min-w-0 truncate font-semibold text-fg-strong">
            {work.title || current?.title || docKey}
          </span>
        </nav>
        {current ? <span className="inline-flex h-5 items-center rounded-xs bg-sunken px-1.5 font-mono text-[11px]/none font-medium text-fg-secondary">v{current.version}</span> : null}
        {!current && draft ? <span className={cn(chip, "bg-warning-soft text-warning")}>{t("docs.unsavedPage")}</span> : null}
        {current?.includeInAgents ? <span className={cn(chip, "bg-info-soft text-info")}>{t("docs.inAgents")}</span> : null}
        {current?.mirror ? (
          <span title={t("docs.mirrorHint", { from: current.mirror.from, commit: current.mirror.commit })} className={cn(chip, "bg-sunken font-mono text-fg-secondary")}>
            {t("docs.mirrorChip", { from: current.mirror.from.split("#")[0]!, commit: current.mirror.commit })}
          </span>
        ) : null}
        {draft?.queued ? (
          <span title={t("docs.queuedHint")} className={cn(chip, "bg-warning-soft text-warning")}>
            {t("docs.queued")}
          </span>
        ) : null}
        {current?.paths?.length ? (
          <span title={current.paths.join(", ")} className={cn(chip, "bg-info-soft text-info")}>
            {t("docs.pathsChip", { count: current.paths.length })}
          </span>
        ) : null}
        {images ? <span className={cn(chip, "bg-sunken text-fg-secondary")}>{t("docs.imagesChip", { count: images })}</span> : null}
        {broken ? <span className={cn(chip, "bg-danger-soft text-danger")}>{t("docs.brokenChip", { count: broken })}</span> : null}
        {links.data?.back.length ? (
          <a href={docHref(docKey, "read")} className={cn(chip, "bg-sunken text-fg-secondary hover:text-fg-strong")}>
            {t("docs.backlinksChip", { count: links.data.back.length })}
          </a>
        ) : null}
        <span className="flex-1" />
        <details className="relative ml-auto md:hidden">
          <summary className="flex min-h-10 cursor-pointer items-center rounded-sm border border-line-default px-3 text-sm font-medium text-fg-strong">{t("docs.modes")}</summary>
          <div onClick={(event) => { if ((event.target as HTMLElement).closest("button, a")) event.currentTarget.closest("details")?.removeAttribute("open"); }} className="absolute right-0 z-30 mt-1 flex w-[min(290px,calc(100vw-32px))] flex-col gap-1 rounded-md border border-line-default bg-raised p-2 shadow-e3">
            {writer ? (["view", "edit", "markdown"] as const).map((m) => <Button key={m} role="radio" aria-checked={mode === m} variant={mode === m ? "secondary" : "ghost"} className="min-h-10 justify-start" onClick={(event) => { setMode(m); setCompare(null); event.currentTarget.closest("details")?.removeAttribute("open"); }}>{m === "view" ? t("docs.modeView") : m === "edit" ? t("docs.modeEdit") : t("docs.modeMarkdown")}</Button>) : null}
            {current ? <Button variant="ghost" className="min-h-10 justify-start" asChild><a href={docHref(docKey, "read")}>{t("docs.reader")}</a></Button> : null}
            {writer ? <Button variant="ghost" className="min-h-10 justify-start" onClick={() => setPanel((p) => p === "assist" ? null : "assist")}>{t("docs.assist.button")}</Button> : null}
            <Button variant="ghost" className="min-h-10 justify-start" onClick={() => setPanel((p) => p === "files" ? null : "files")}>{t("docs.attachments")}</Button>
            {current ? <Button variant="ghost" className="min-h-10 justify-start" onClick={() => setPanel((p) => p === "history" ? null : "history")}>{t("docs.history")}</Button> : null}
            {dirty && current ? <Button variant="ghost" className="min-h-10 justify-start" onClick={() => setShowDiff((v) => !v)}>{showDiff ? t("docs.hideChanges") : t("docs.showChanges")}</Button> : null}
            {dirty || (!current && draft) ? <Button variant="ghost" className="min-h-10 justify-start" onClick={() => { setDraft(null); setShowDiff(false); }}>{t("docs.discard")}</Button> : null}
            {writer && (dirty || (!current && draft)) ? <Button className="min-h-10" onClick={(event) => { void save(); event.currentTarget.closest("details")?.removeAttribute("open"); }} disabled={action.busy}>{canEdit ? t("docs.saveAs", { version: (current?.version ?? 0) + 1 }) : t("docs.propose")}</Button> : null}
          </div>
        </details>
        <div className="hidden flex-wrap items-center gap-2 md:flex">
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
              ["markdown", t("docs.modeMarkdown")],
            ]}
          />
        ) : null}
        {current ? (
          <Button size="sm" variant="outline" asChild>
            <a href={docHref(docKey, "read")} title={t("docs.openReader")}>
              <BookOpen />
              {t("docs.reader")}
            </a>
          </Button>
        ) : null}
        {writer ? (
          <Button
            size="sm"
            variant="outline"
            aria-pressed={panel === "assist"}
            className={cn(panel === "assist" && "border-line-selected bg-selected text-selected-fg")}
            onClick={() => setPanel((p) => (p === "assist" ? null : "assist"))}
          >
            <Sparkles />
            {t("docs.assist.button")}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          aria-pressed={panel === "files"}
          aria-label={t("docs.attachments")}
          title={t("docs.attachments")}
          className={cn("px-2", panel === "files" && "bg-selected")}
          onClick={() => setPanel((p) => (p === "files" ? null : "files"))}
        >
          <Paperclip />
          {files.data?.length ? files.data.length : null}
        </Button>
        {current ? (
          <Button
            size="icon-sm"
            variant="outline"
            aria-pressed={panel === "history"}
            aria-label={t("docs.history")}
            title={t("docs.history")}
            className={cn(panel === "history" && "bg-selected")}
            onClick={() => setPanel((p) => (p === "history" ? null : "history"))}
          >
            <History />
          </Button>
        ) : null}
        {dirty || (!current && draft) ? (
          <>
            {current ? (
              <Button size="sm" variant="ghost" onClick={() => setShowDiff((v) => !v)} aria-pressed={showDiff}>
                {showDiff ? t("docs.hideChanges") : t("docs.showChanges")}
              </Button>
            ) : null}
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
      </div>
      {source && compare === null && !showDiff ? (
        <div className="relative shrink-0">
          <details className="border-b border-line-subtle bg-subtle px-3 py-1 md:hidden">
            <summary className="flex min-h-10 cursor-pointer items-center text-sm font-medium">{t("docs.toolbar")}</summary>
            <div className="grid grid-cols-3 gap-1 pb-2">
              {MD_TOOLS.filter((s) => s !== "sep").map((spec) => <Button key={spec.id} variant="ghost" className="min-h-10 justify-start" onClick={() => tool(spec)}>{t(`docs.md.${spec.id}`)}</Button>)}
            </div>
          </details>
          <div role="toolbar" aria-label={t("docs.toolbar")} className="hidden items-center gap-0.5 border-b border-line-subtle bg-subtle px-3 py-1 md:flex">
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
                  aria-pressed={spec.id === "link" ? picker : undefined}
                  disabled={spec.id === "image" && upload.busy}
                  className={cn(
                    "grid size-7 cursor-pointer place-items-center rounded-[5px] text-fg-secondary outline-none hover:bg-hover hover:text-fg-strong focus-visible:focus-ring disabled:opacity-50",
                    spec.id === "link" && picker && "bg-selected text-selected-fg",
                  )}
                >
                  <Icon className="size-[15px]" />
                </button>
              );
            })}
            <input
              ref={imageInput}
              type="file"
              multiple
              accept="image/png,image/jpeg,image/gif,image/webp"
              className="hidden"
              onChange={(e) => {
                const list = [...(e.target.files ?? [])];
                e.target.value = "";
                if (list.length) uploadFiles(list);
              }}
            />
            <span className="ml-auto text-[11px]/none text-fg-muted">{upload.busy ? t("docs.uploading") : dirty ? t("docs.draftLocal") : t("docs.saveShortcut")}</span>
          </div>
          {picker ? (
            <LinkPicker
              from={docKey}
              titles={titles}
              onClose={() => setPicker(false)}
              onPick={(target) => {
                setPicker(false);
                insertAt(`[[${target}]]`);
              }}
            />
          ) : null}
        </div>
      ) : null}
      {(doc.error ?? action.error ?? upload.error) ? (
        <div className="px-4 pt-3">
          <ErrorNote error={doc.error ?? action.error ?? upload.error} />
        </div>
      ) : null}
      <div className="flex min-h-0 min-w-0 flex-1">
        <div className={cn("min-h-0 min-w-0 flex-1", panel ? "hidden md:flex" : "flex")}>{body}</div>
        {panel === "history" && current ? <HistoryPanel docKey={docKey} version={current.version} selected={compare} onPick={(version) => { setCompare(version); if (window.matchMedia("(max-width: 767px)").matches) setPanel(null); }} /> : null}
        {panel === "assist" && writer ? (
          <aside className="flex min-w-0 flex-1 flex-col border-l border-line-subtle bg-subtle md:w-[330px] md:flex-none md:shrink-0">
            <DocAssistant docKey={docKey} title={work.title || current?.title || ""} content={work.content} paths={current?.paths ?? parsePaths(work.paths)} related={related} onApply={applyAssist} />
          </aside>
        ) : null}
        {panel === "files" ? (
          <aside className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto border-l border-line-subtle p-3 md:w-[270px] md:flex-none md:shrink-0">
            <AttachmentsPanel docKey={docKey} canUpload={writer} canManage={canEdit} onInsert={source ? (md) => insertAt(md) : rich ? (md) => edit({ content: `${work.content.trimEnd()}\n\n${md}\n` }) : undefined} />
          </aside>
        ) : null}
      </div>
      {!writer ? <p className="m-0 border-t border-line-subtle bg-subtle px-4 py-2 text-xs text-fg-muted">{t("docs.viewOnly")}</p> : null}
    </div>
  );
}

/** The pages under this one (a folder's content). */
export function ChildPages({ nodes, onPick, onNew }: { nodes: TreeNode[]; onPick?: (key: string) => void; onNew?: () => void }) {
  const t = useT();
  return (
    <section className="flex flex-col gap-2">
      <h2 className="m-0 type-caption text-fg-muted">{t("docs.childPages", { count: nodes.length })}</h2>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2">
        {nodes.map((n) => {
          const Icon = n.folder || n.children.length ? Folder : FileText;
          const inner = (
            <>
              <Icon className={cn("size-4 shrink-0", n.folder || n.children.length ? "text-fg-brand" : "text-fg-muted")} />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-[13px] font-medium text-fg-strong">{n.title}</span>
                <span className="truncate text-[11px] text-fg-muted">
                  {n.children.length ? t("docs.pageCount", { count: n.children.length }) : n.doc ? `v${n.doc.version} · ${formatTime(n.doc.updatedAt)}` : ""}
                </span>
              </span>
            </>
          );
          const cls = "flex min-w-0 cursor-pointer items-center gap-2.5 rounded-md border border-line-subtle bg-surface px-3 py-2.5 text-left outline-none hover:border-line-default hover:bg-hover focus-visible:focus-ring";
          return onPick ? (
            <button key={n.key} type="button" onClick={() => onPick(n.key)} className={cls}>
              {inner}
            </button>
          ) : (
            <a key={n.key} href={docHref(n.key, "read")} className={cls}>
              {inner}
            </a>
          );
        })}
        {onNew ? (
          <button
            type="button"
            onClick={onNew}
            className="flex cursor-pointer items-center justify-center gap-1.5 rounded-md border border-dashed border-line-control px-3 py-2.5 text-xs font-medium text-fg-secondary outline-none hover:text-fg-strong focus-visible:focus-ring"
          >
            <Plus className="size-3.5" />
            {t("docs.addChild")}
          </button>
        ) : null}
      </div>
    </section>
  );
}

function HistoryPanel({ docKey, version, selected, onPick }: { docKey: string; version: number; selected: number | null; onPick: (v: number | null) => void }) {
  const { client } = useHive();
  const t = useT();
  const history = useQuery(() => client.call("docs.history", { key: docKey }), [client, docKey, version]);
  const versions: DocVersion[] = history.data ?? [];
  return (
    <aside aria-label={t("docs.versions")} className="flex min-w-0 flex-1 flex-col gap-1 overflow-y-auto border-l border-line-subtle p-3 md:w-[250px] md:flex-none md:shrink-0">
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
