import { useEffect, useMemo, useState } from "react";
import { FolderGit2, Users } from "lucide-react";
import { cn } from "cn";
import { parseDocKey, stripHidden, type Doc, type DocSummary, type DocVersion } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Card, CardContent } from "@xdev-hive/ui/components/ui/card";
import { Checkbox } from "@xdev-hive/ui/components/ui/checkbox";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { Label } from "@xdev-hive/ui/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/components/ui/native-select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@xdev-hive/ui/components/ui/tabs";
import { Textarea } from "@xdev-hive/ui/components/ui/textarea";
import { Diff } from "../components/Diff.tsx";
import { HiddenChars } from "../components/HiddenChars.tsx";
import { Badge, Empty, ErrorNote, Notice, OwnerBadge, Page, PageHeader } from "../components/common.tsx";
import { errorMessage, formatTime, sourceText, useAction, useCan, useHashParam, useHive, useQuery } from "../hooks.ts";
import { useT, type TFunction } from "../i18n/index.tsx";
import { docOwner, inScope, projectScope, scopeLabel, scopeProject, SHARED, type Scope } from "../lib/scope.ts";

interface Draft {
  title: string;
  content: string;
  includeInAgents: boolean;
  /** Globs as typed: comma- or line-separated. */
  paths: string;
  note: string;
}

const parsePaths = (text: string) => [...new Set(text.split(/[\s,]+/).filter(Boolean))];
/** The project's AGENTS.md and decisions doc are for the whole repo. */
const wholeRepo = (key: string) => /^project\/[^/]+\/(agents|decisions)$/.test(key);

type EditorTab = "edit" | "preview-diff" | "history";

const emptyDraft = (key: string): Draft => ({
  title: "",
  content: "",
  includeInAgents: key.startsWith("org/"),
  paths: "",
  note: "",
});

/** Same shape as the slug part of a doc key in core (keys.ts); skills/<name> makes a skill (its content is a SKILL.md). */
const SLUG = /^(skills\/)?[a-z0-9][a-z0-9-]{0,79}$/;

interface DocGroup {
  id: string;
  /** null = shared by every project (org/*). */
  owner: string | null;
  label: string;
  docs: DocSummary[];
}

/** The doc list for a scope, shared vs project kept in separate, clearly labelled groups. */
function groupDocs(all: DocSummary[], scope: Scope, t: TFunction): DocGroup[] {
  const shared = all.filter((d) => docOwner(d.key) === null);
  if (scope.kind === "shared") return [{ id: "shared", owner: null, label: t("common.sharedTeam"), docs: shared }];
  if (scope.kind === "project") {
    const p = scope.project;
    return [
      { id: `project:${p}`, owner: p, label: t("docs.ownGroup", { project: p }), docs: all.filter((d) => docOwner(d.key) === p) },
      { id: "shared", owner: null, label: t("docs.sharedGroup"), docs: shared },
    ];
  }
  // A system: its projects, each with its own docs.
  if (scope.kind === "system") {
    return [
      { id: "shared", owner: null, label: t("common.sharedTeam"), docs: shared },
      ...[...scope.projects].sort().map((p) => ({ id: `project:${p}`, owner: p, label: p, docs: all.filter((d) => docOwner(d.key) === p) })),
    ];
  }
  const byProject = new Map<string, DocSummary[]>();
  for (const d of all) {
    const owner = docOwner(d.key);
    if (owner !== null) byProject.set(owner, [...(byProject.get(owner) ?? []), d]);
  }
  return [
    { id: "shared", owner: null, label: t("common.sharedTeam"), docs: shared },
    ...[...byProject.keys()].sort().map((p) => ({ id: `project:${p}`, owner: p, label: p, docs: byProject.get(p)! })),
  ];
}

export function DocsPage() {
  const { client, scope, setScope, projects } = useHive();
  const t = useT();
  const allow = useCan();
  const list = useQuery(() => client.call("docs.list", {}), [client]);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  // "" = Chung (org/…); otherwise the project the new doc belongs to.
  const [newOwner, setNewOwner] = useState(() => scopeProject(scope) ?? "");
  const [newSlug, setNewSlug] = useState("");
  const [newKeyError, setNewKeyError] = useState<string | null>(null);

  // Every doc in scope, in display order (ignores the text filter).
  const scoped = useMemo(() => groupDocs(list.data ?? [], scope, t), [list.data, scope, t]);
  const firstInScope = scoped.flatMap((g) => g.docs)[0]?.key ?? null;

  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return scoped
      .map((g) => ({ ...g, docs: g.docs.filter((d) => !q || d.key.includes(q) || d.title.toLowerCase().includes(q)) }))
      .filter((g) => g.docs.length > 0 || (!q && scope.kind === "project" && g.owner !== null));
  }, [scoped, filter, scope.kind]);
  const visibleCount = groups.reduce((n, g) => n + g.docs.length, 0);

  // #/docs?doc=<key> (command palette, links): open that doc, moving to its scope when it is outside this one.
  const [linked, clearLinked] = useHashParam("doc");
  useEffect(() => {
    if (!linked || !list.data) return;
    if (list.data.some((d) => d.key === linked)) {
      const owner = docOwner(linked);
      if (!inScope(scope, owner)) setScope(owner === null ? SHARED : projectScope(owner));
      setSelected(linked);
    }
    clearLinked();
  }, [linked, list.data, scope, setScope, clearLinked]);

  // Keep the selection inside the scope: pick the first doc in scope (or none) when it falls out.
  useEffect(() => {
    if (!list.data || linked) return;
    if (selected && inScope(scope, docOwner(selected))) return;
    setSelected(firstInScope);
  }, [list.data, scope, selected, firstInScope, linked]);

  // New docs default to the project being looked at (Chung for all / shared).
  useEffect(() => {
    setNewOwner(scopeProject(scope) ?? "");
  }, [scope]);

  // New docs go where this person may write: Chung, then the projects they manage.
  const ownerOptions = useMemo(
    () => [...new Set([...projects, ...(newOwner ? [newOwner] : [])])].sort().filter((p) => allow(p, "manage")),
    [projects, newOwner, allow],
  );
  const sharedOk = allow(null, "manage");
  const canCreate = sharedOk || ownerOptions.length > 0;
  useEffect(() => {
    if (!newOwner && !sharedOk && ownerOptions[0]) setNewOwner(ownerOptions[0]);
  }, [newOwner, sharedOk, ownerOptions]);
  const keyPrefix = newOwner ? `project/${newOwner}/` : "org/";
  const newKey = keyPrefix + newSlug.trim();

  const createDoc = () => {
    const slug = newSlug.trim();
    if (!SLUG.test(slug)) {
      setNewKeyError(t("docs.badSlug"));
      return;
    }
    try {
      parseDocKey(newKey);
      setNewKeyError(null);
      // A doc for another project than the one in view: follow it there so it stays selected.
      const owner = newOwner || null;
      if (owner !== null && !inScope(scope, owner)) setScope(projectScope(owner));
      setSelected(newKey);
      setNewSlug("");
    } catch (err) {
      setNewKeyError(errorMessage(err));
    }
  };

  return (
    <Page>
      <PageHeader
        title={t("docs.title")}
        subtitle={t("docs.subtitle")}
      />
      <div className="grid items-start gap-4 lg:grid-cols-[280px_1fr]">
        <Card className="min-w-0 py-3 lg:sticky lg:top-4 lg:max-h-[calc(100vh-8rem)] lg:overflow-y-auto">
          <CardContent className="px-3">
            <nav className="flex flex-col gap-3" aria-label={t("docs.list")}>
              <Input placeholder={t("docs.filterPlaceholder")} value={filter} onChange={(e) => setFilter(e.target.value)} aria-label={t("docs.filter")} />
              <ErrorNote error={list.error} />
              {visibleCount > 0 ? groups.map((g) => (
                <div key={g.id} role="group" aria-label={g.label} className="flex flex-col gap-0.5">
                  <div
                    className={cn(
                      "flex min-w-0 items-center gap-1.5 px-2 py-1 text-xs font-semibold",
                      g.owner === null ? "text-brand-soft-foreground" : "text-muted-foreground",
                    )}
                  >
                    {g.owner === null ? (
                      <Users className="size-3.5 shrink-0" aria-hidden="true" />
                    ) : (
                      <FolderGit2 className="size-3.5 shrink-0" aria-hidden="true" />
                    )}
                    <span className={cn("min-w-0 flex-1 truncate", (scope.kind === "all" || scope.kind === "system") && g.owner !== null && "font-mono")}>
                      {g.label}
                    </span>
                    <span className="font-normal text-muted-foreground tabular-nums">{g.docs.length}</span>
                  </div>
                  {g.docs.length === 0 ? (
                    <p className="px-2 pb-1 text-xs text-muted-foreground">{t("docs.noOwnDocs")}</p>
                  ) : null}
                  {g.docs.map((d) => (
                    <button
                      key={d.key}
                      className={cn(
                        "flex w-full min-w-0 flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50",
                        selected === d.key && "bg-brand-soft text-brand-soft-foreground hover:bg-brand-soft",
                      )}
                      onClick={() => setSelected(d.key)}
                    >
                      <span className="w-full font-medium break-words">{d.title}</span>
                      <span className="w-full font-mono text-xs break-all text-muted-foreground">
                        {d.key} · v{d.version}
                      </span>
                      {d.paths?.length ? (
                        <span title={d.paths.join(", ")}>
                          <Badge tone="info">{t("docs.pathsBadge", { count: d.paths.length })}</Badge>
                        </span>
                      ) : null}
                    </button>
                  ))}
                </div>
              )) : null}
              {!list.loading && visibleCount === 0 ? (
                <Empty>
                  {filter.trim()
                    ? t("docs.noMatch")
                    : scope.kind === "all"
                      ? t("docs.none")
                      : t("docs.noneIn", { scope: scopeLabel(scope) })}
                </Empty>
              ) : null}
              {canCreate ? (
                <div className="flex flex-col gap-2 border-t pt-3">
                  <div className="text-xs font-semibold text-muted-foreground">{t("docs.newDoc")}</div>
                  <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2">
                    <Label htmlFor="new-doc-owner" className="text-xs text-muted-foreground">
                      {t("docs.owner")}
                    </Label>
                    <div className="min-w-0 *:data-[slot=native-select-wrapper]:w-full">
                      <NativeSelect
                        id="new-doc-owner"
                        size="sm"
                        value={newOwner}
                        onChange={(e) => {
                          setNewOwner(e.target.value);
                          setNewKeyError(null);
                        }}
                      >
                        {sharedOk ? <NativeSelectOption value="">{t("common.sharedTeam")}</NativeSelectOption> : null}
                        {ownerOptions.map((p) => (
                          <NativeSelectOption key={p} value={p}>
                            {p}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                    </div>
                    <Label htmlFor="new-doc-slug" className="text-xs text-muted-foreground">
                      {t("docs.slug")}
                    </Label>
                    <div className="flex min-w-0 gap-2">
                      <Input
                        id="new-doc-slug"
                        className="h-8 min-w-0 flex-1 font-mono text-xs md:text-xs"
                        placeholder="vd: security"
                        autoCapitalize="none"
                        spellCheck={false}
                        value={newSlug}
                        aria-describedby="new-doc-key-hint"
                        aria-invalid={newKeyError ? true : undefined}
                        onChange={(e) => setNewSlug(e.target.value.toLowerCase())}
                        onKeyDown={(e) => e.key === "Enter" && createDoc()}
                      />
                      <Button size="sm" variant="outline" onClick={createDoc} disabled={!newSlug.trim()}>
                        {t("docs.create")}
                      </Button>
                    </div>
                  </div>
                  <p id="new-doc-key-hint" className="font-mono text-xs break-all text-muted-foreground">
                    {newSlug.trim() ? newKey : `${keyPrefix}<${t("docs.slugPlaceholder")}>`}
                  </p>
                  <ErrorNote error={newKeyError} />
                </div>
              ) : null}
            </nav>
          </CardContent>
        </Card>
        <section className="min-w-0">
          <Card className="py-4">
            <CardContent className="px-4">
              {selected ? (
                <DocEditor
                  key={selected}
                  docKey={selected}
                  canEdit={allow(docOwner(selected), "manage")}
                  canPropose={allow(docOwner(selected), "contribute")}
                  onSaved={list.reload}
                />
              ) : (
                <Empty>{t("docs.pick")}</Empty>
              )}
            </CardContent>
          </Card>
        </section>
      </div>
    </Page>
  );
}

function DocEditor({ docKey, canEdit, canPropose, onSaved }: { docKey: string; canEdit: boolean; canPropose: boolean; onSaved: () => void }) {
  const { client } = useHive();
  const t = useT();
  const doc = useQuery(() => client.call("docs.get", { key: docKey }), [client, docKey]);
  const [draft, setDraft] = useState<Draft>(emptyDraft(docKey));
  const [tab, setTab] = useState<EditorTab>("edit");
  const [saved, setSaved] = useState<string | null>(null);
  const action = useAction();
  const owner = docOwner(docKey);
  const scope = docKey.startsWith("org/") ? "org" : "project";

  useEffect(() => {
    if (doc.data) {
      setDraft({ title: doc.data.title, content: doc.data.content, includeInAgents: doc.data.includeInAgents, paths: (doc.data.paths ?? []).join(", "), note: "" });
    } else if (!doc.loading) {
      setDraft(emptyDraft(docKey));
    }
  }, [doc.data, doc.loading, docKey]);

  const current: Doc | null = doc.data ?? null;
  const dirty =
    (current?.content ?? "") !== draft.content ||
    (!!current && current.title !== draft.title) ||
    (!!current && current.includeInAgents !== draft.includeInAgents) ||
    (current?.paths ?? []).join(",") !== parsePaths(draft.paths).join(",") ||
    (!current && draft.content.length > 0);

  const save = () =>
    action.run(async () => {
      const result = await client.call("docs.save", {
        key: docKey,
        content: draft.content,
        title: draft.title.trim() || undefined,
        includeInAgents: scope === "org" ? draft.includeInAgents : undefined,
        paths: wholeRepo(docKey) ? undefined : parsePaths(draft.paths),
        note: draft.note.trim() || undefined,
        baseVersion: current?.version ?? 0,
      });
      setSaved(t("docs.saved", { version: result.version }));
      doc.reload();
      onSaved();
    });

  // Contributors send the change as a proposal for someone who manages the project to approve.
  const propose = () =>
    action.run(async () => {
      await client.call("proposals.create", {
        docKey,
        baseVersion: current?.version ?? 0,
        content: draft.content,
        reason: draft.note.trim() || t("docs.proposeDefaultReason"),
      });
      setSaved(t("docs.proposed"));
      setDraft({ ...draft, content: current?.content ?? "", note: "" });
    });

  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as EditorTab)} className="gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <OwnerBadge owner={owner} />
            <span className="min-w-0 font-mono text-xs break-all text-muted-foreground">{docKey}</span>
          </div>
          <h2 className="text-lg font-semibold break-words">{current?.title ?? t("docs.newDoc")}</h2>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {owner === null ? (
              <Users className="size-3.5 shrink-0 text-brand" aria-hidden="true" />
            ) : (
              <FolderGit2 className="size-3.5 shrink-0" aria-hidden="true" />
            )}
            <span className="min-w-0 break-words">
              {owner === null ? t("docs.sharedDoc") : t("docs.projectDoc", { project: owner })}
            </span>
          </p>
          <div className="text-xs text-muted-foreground">
            {current ? (
              <>
                v{current.version} · {current.updatedBy} · {formatTime(current.updatedAt)}
              </>
            ) : (
              t("docs.unsaved")
            )}
          </div>
        </div>
        <TabsList>
          {(
            [
              ["edit", "docs.tabEdit"],
              ["preview-diff", "docs.tabChanges"],
              ["history", "docs.tabHistory"],
            ] as const
          ).map(([id, label]) => (
            <TabsTrigger key={id} value={id}>
              {t(label)}
              {id === "preview-diff" && dirty ? " •" : ""}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>

      <ErrorNote error={doc.error} />

      <TabsContent value="edit" className="flex flex-col gap-4">
        <div className="grid gap-2 sm:grid-cols-[110px_1fr] sm:items-center sm:gap-x-3">
          <Label htmlFor="doc-title" className="text-xs text-muted-foreground">
            {t("docs.docTitle")}
          </Label>
          <Input
            id="doc-title"
            value={draft.title}
            readOnly={!canEdit}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          />
        </div>
        {wholeRepo(docKey) ? null : (
          <div className="grid gap-2 sm:grid-cols-[110px_1fr] sm:items-start sm:gap-x-3">
            <Label htmlFor="doc-paths" className="text-xs text-muted-foreground sm:pt-2">
              {t("docs.paths")}
            </Label>
            <div className="flex min-w-0 flex-col gap-1">
              <Input
                id="doc-paths"
                className="font-mono text-xs md:text-xs"
                placeholder={t("docs.pathsPlaceholder")}
                value={draft.paths}
                readOnly={!canEdit}
                onChange={(e) => setDraft({ ...draft, paths: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">{t("docs.pathsHint")}</p>
            </div>
          </div>
        )}
        {scope === "org" ? (
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={draft.includeInAgents}
              disabled={!canEdit}
              onCheckedChange={(v) => setDraft({ ...draft, includeInAgents: v === true })}
            />
            {t("docs.includeInAgents")}
          </label>
        ) : null}
        <Textarea
          className="min-h-80 resize-y font-mono text-sm leading-relaxed field-sizing-fixed md:text-sm"
          value={draft.content}
          readOnly={!canEdit && !canPropose}
          spellCheck={false}
          aria-label={t("docs.content")}
          placeholder={t("docs.contentPlaceholder")}
          onChange={(e) => setDraft({ ...draft, content: e.target.value })}
        />
      </TabsContent>

      <TabsContent value="preview-diff" className="min-w-0">
        <Diff before={current?.content ?? ""} after={draft.content} />
      </TabsContent>
      <TabsContent value="history" className="min-w-0">
        <History docKey={docKey} version={current?.version ?? 0} />
      </TabsContent>

      {canEdit || canPropose ? (
        <HiddenChars
          fields={[
            { label: t("docs.docTitle"), text: draft.title },
            { label: t("docs.content"), text: draft.content },
            { label: t("docs.note"), text: draft.note },
          ]}
          onStrip={() =>
            setDraft({ ...draft, title: stripHidden(draft.title), content: stripHidden(draft.content), note: stripHidden(draft.note) })
          }
        />
      ) : null}
      {canEdit || canPropose ? (
        <div className="flex flex-wrap gap-2">
          <Input
            className="min-w-48 flex-1"
            placeholder={canEdit ? t("docs.notePlaceholder") : t("docs.reasonPlaceholder")}
            value={draft.note}
            onChange={(e) => setDraft({ ...draft, note: e.target.value })}
            aria-label={t("docs.note")}
          />
          {canEdit ? (
            <Button onClick={save} disabled={!dirty || action.busy}>
              {action.busy ? t("docs.saving") : t("docs.save", { version: (current?.version ?? 0) + 1 })}
            </Button>
          ) : (
            <Button onClick={propose} disabled={!dirty || action.busy}>
              {action.busy ? t("docs.sending") : t("docs.propose")}
            </Button>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t("docs.viewOnly")}</p>
      )}
      <ErrorNote error={action.error} />
      {saved && !dirty ? <Notice tone="ok" title={saved} /> : null}
    </Tabs>
  );
}

function History({ docKey, version }: { docKey: string; version: number }) {
  const { client } = useHive();
  const t = useT();
  const history = useQuery(() => client.call("docs.history", { key: docKey }), [client, docKey, version]);
  const [open, setOpen] = useState<number | null>(null);
  const versions: DocVersion[] = history.data ?? [];
  if (history.loading && !history.data) return <Empty>{t("common.loading")}</Empty>;
  if (!versions.length) return <Empty>{t("docs.noVersions")}</Empty>;
  return (
    <ol className="flex flex-col gap-2">
      {versions.map((v, i) => {
        const prev = versions[i + 1];
        return (
          <li key={v.version} className="flex min-w-0 flex-col gap-2">
            <button
              className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-muted px-3 py-2 text-left text-sm transition-colors outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
              onClick={() => setOpen(open === v.version ? null : v.version)}
              aria-expanded={open === v.version}
            >
              <Badge tone={i === 0 ? "accent" : "neutral"}>v{v.version}</Badge>
              <span className="min-w-0 flex-1 break-words">{v.note || <span className="text-muted-foreground">{t("docs.noNote")}</span>}</span>
              <span className="text-xs text-muted-foreground">
                {v.author} · {formatTime(v.createdAt)}
                {sourceText(v.source)}
              </span>
            </button>
            {open === v.version ? <Diff before={prev?.content ?? ""} after={v.content} /> : null}
          </li>
        );
      })}
    </ol>
  );
}
