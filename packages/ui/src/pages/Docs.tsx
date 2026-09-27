import { useEffect, useMemo, useState } from "react";
import { FolderGit2, Users } from "lucide-react";
import { cn } from "cn";
import { parseDocKey, type Doc, type DocSummary, type DocVersion } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Card, CardContent } from "@xdev-hive/ui/components/ui/card";
import { Checkbox } from "@xdev-hive/ui/components/ui/checkbox";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { Label } from "@xdev-hive/ui/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/components/ui/native-select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@xdev-hive/ui/components/ui/tabs";
import { Textarea } from "@xdev-hive/ui/components/ui/textarea";
import { Diff } from "../components/Diff.tsx";
import { Badge, Empty, ErrorNote, Notice, OwnerBadge, Page, PageHeader } from "../components/common.tsx";
import { errorMessage, formatTime, useAction, useHive, useQuery } from "../hooks.ts";
import { docOwner, inScope, projectScope, scopeLabel, scopeProject, type Scope } from "../lib/scope.ts";

interface Draft {
  title: string;
  content: string;
  includeInAgents: boolean;
  note: string;
}

type EditorTab = "edit" | "preview-diff" | "history";

const emptyDraft = (key: string): Draft => ({
  title: "",
  content: "",
  includeInAgents: key.startsWith("org/"),
  note: "",
});

/** Same shape as the slug part of a doc key in core (keys.ts). */
const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;

interface DocGroup {
  id: string;
  /** null = shared by every project (org/*). */
  owner: string | null;
  label: string;
  docs: DocSummary[];
}

/** The doc list for a scope, shared vs project kept in separate, clearly labelled groups. */
function groupDocs(all: DocSummary[], scope: Scope): DocGroup[] {
  const shared = all.filter((d) => docOwner(d.key) === null);
  if (scope.kind === "shared") return [{ id: "shared", owner: null, label: "Chung (cả team)", docs: shared }];
  if (scope.kind === "project") {
    const p = scope.project;
    return [
      { id: `project:${p}`, owner: p, label: `Riêng · ${p}`, docs: all.filter((d) => docOwner(d.key) === p) },
      { id: "shared", owner: null, label: "Chung · áp dụng cho mọi dự án", docs: shared },
    ];
  }
  const byProject = new Map<string, DocSummary[]>();
  for (const d of all) {
    const owner = docOwner(d.key);
    if (owner !== null) byProject.set(owner, [...(byProject.get(owner) ?? []), d]);
  }
  return [
    { id: "shared", owner: null, label: "Chung (cả team)", docs: shared },
    ...[...byProject.keys()].sort().map((p) => ({ id: `project:${p}`, owner: p, label: p, docs: byProject.get(p)! })),
  ];
}

export function DocsPage() {
  const { client, me, scope, setScope, projects } = useHive();
  const canEdit = me.role === "admin";
  const list = useQuery(() => client.call("docs.list", {}), [client]);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  // "" = Chung (org/…); otherwise the project the new doc belongs to.
  const [newOwner, setNewOwner] = useState(() => scopeProject(scope) ?? "");
  const [newSlug, setNewSlug] = useState("");
  const [newKeyError, setNewKeyError] = useState<string | null>(null);

  // Every doc in scope, in display order (ignores the text filter).
  const scoped = useMemo(() => groupDocs(list.data ?? [], scope), [list.data, scope]);
  const firstInScope = scoped.flatMap((g) => g.docs)[0]?.key ?? null;

  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return scoped
      .map((g) => ({ ...g, docs: g.docs.filter((d) => !q || d.key.includes(q) || d.title.toLowerCase().includes(q)) }))
      .filter((g) => g.docs.length > 0 || (!q && scope.kind === "project" && g.owner !== null));
  }, [scoped, filter, scope.kind]);
  const visibleCount = groups.reduce((n, g) => n + g.docs.length, 0);

  // Keep the selection inside the scope: pick the first doc in scope (or none) when it falls out.
  useEffect(() => {
    if (!list.data) return;
    if (selected && inScope(scope, docOwner(selected))) return;
    setSelected(firstInScope);
  }, [list.data, scope, selected, firstInScope]);

  // New docs default to the project being looked at (Chung for all / shared).
  useEffect(() => {
    setNewOwner(scopeProject(scope) ?? "");
  }, [scope]);

  const ownerOptions = useMemo(
    () => [...new Set([...projects, ...(newOwner ? [newOwner] : [])])].sort(),
    [projects, newOwner],
  );
  const keyPrefix = newOwner ? `project/${newOwner}/` : "org/";
  const newKey = keyPrefix + newSlug.trim();

  const createDoc = () => {
    const slug = newSlug.trim();
    if (!SLUG.test(slug)) {
      setNewKeyError('Tên không hợp lệ: chỉ dùng chữ thường, số và dấu "-", bắt đầu bằng chữ hoặc số.');
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
        title="Tài liệu"
        subtitle="Bản gốc của AGENTS.md, quy chuẩn chung và nhật ký quyết định. Agent chỉ được đề xuất sửa, admin duyệt."
      />
      <div className="grid items-start gap-4 lg:grid-cols-[280px_1fr]">
        <Card className="min-w-0 py-3 lg:sticky lg:top-4 lg:max-h-[calc(100vh-8rem)] lg:overflow-y-auto">
          <CardContent className="px-3">
            <nav className="flex flex-col gap-3" aria-label="Danh sách tài liệu">
              <Input placeholder="Lọc tài liệu…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Lọc tài liệu" />
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
                    <span className={cn("min-w-0 flex-1 truncate", scope.kind === "all" && g.owner !== null && "font-mono")}>
                      {g.label}
                    </span>
                    <span className="font-normal text-muted-foreground tabular-nums">{g.docs.length}</span>
                  </div>
                  {g.docs.length === 0 ? (
                    <p className="px-2 pb-1 text-xs text-muted-foreground">Chưa có tài liệu riêng cho dự án này.</p>
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
                    </button>
                  ))}
                </div>
              )) : null}
              {!list.loading && visibleCount === 0 ? (
                <Empty>
                  {filter.trim()
                    ? "Không có tài liệu nào khớp bộ lọc."
                    : scope.kind === "all"
                      ? "Chưa có tài liệu."
                      : `Chưa có tài liệu trong phạm vi “${scopeLabel(scope)}”.`}
                </Empty>
              ) : null}
              {canEdit ? (
                <div className="flex flex-col gap-2 border-t pt-3">
                  <div className="text-xs font-semibold text-muted-foreground">Tài liệu mới</div>
                  <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2">
                    <Label htmlFor="new-doc-owner" className="text-xs text-muted-foreground">
                      Thuộc
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
                        <NativeSelectOption value="">Chung (cả team)</NativeSelectOption>
                        {ownerOptions.map((p) => (
                          <NativeSelectOption key={p} value={p}>
                            {p}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                    </div>
                    <Label htmlFor="new-doc-slug" className="text-xs text-muted-foreground">
                      Tên
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
                        Tạo
                      </Button>
                    </div>
                  </div>
                  <p id="new-doc-key-hint" className="font-mono text-xs break-all text-muted-foreground">
                    {newSlug.trim() ? newKey : `${keyPrefix}<tên>`}
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
                <DocEditor key={selected} docKey={selected} canEdit={canEdit} onSaved={list.reload} />
              ) : (
                <Empty>Chọn một tài liệu.</Empty>
              )}
            </CardContent>
          </Card>
        </section>
      </div>
    </Page>
  );
}

function DocEditor({ docKey, canEdit, onSaved }: { docKey: string; canEdit: boolean; onSaved: () => void }) {
  const { client } = useHive();
  const doc = useQuery(() => client.call("docs.get", { key: docKey }), [client, docKey]);
  const [draft, setDraft] = useState<Draft>(emptyDraft(docKey));
  const [tab, setTab] = useState<EditorTab>("edit");
  const [saved, setSaved] = useState<string | null>(null);
  const action = useAction();
  const owner = docOwner(docKey);
  const scope = docKey.startsWith("org/") ? "org" : "project";

  useEffect(() => {
    if (doc.data) {
      setDraft({ title: doc.data.title, content: doc.data.content, includeInAgents: doc.data.includeInAgents, note: "" });
    } else if (!doc.loading) {
      setDraft(emptyDraft(docKey));
    }
  }, [doc.data, doc.loading, docKey]);

  const current: Doc | null = doc.data ?? null;
  const dirty =
    (current?.content ?? "") !== draft.content ||
    (!!current && current.title !== draft.title) ||
    (!!current && current.includeInAgents !== draft.includeInAgents) ||
    (!current && draft.content.length > 0);

  const save = () =>
    action.run(async () => {
      const result = await client.call("docs.save", {
        key: docKey,
        content: draft.content,
        title: draft.title.trim() || undefined,
        includeInAgents: scope === "org" ? draft.includeInAgents : undefined,
        note: draft.note.trim() || undefined,
        baseVersion: current?.version ?? 0,
      });
      setSaved(`Đã lưu v${result.version}`);
      doc.reload();
      onSaved();
    });

  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as EditorTab)} className="gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <OwnerBadge owner={owner} />
            <span className="min-w-0 font-mono text-xs break-all text-muted-foreground">{docKey}</span>
          </div>
          <h2 className="text-lg font-semibold break-words">{current?.title ?? "Tài liệu mới"}</h2>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {owner === null ? (
              <Users className="size-3.5 shrink-0 text-brand" aria-hidden="true" />
            ) : (
              <FolderGit2 className="size-3.5 shrink-0" aria-hidden="true" />
            )}
            <span className="min-w-0 break-words">
              {owner === null ? "Tài liệu chung: áp dụng cho mọi dự án" : `Chỉ dùng cho dự án ${owner}`}
            </span>
          </p>
          <div className="text-xs text-muted-foreground">
            {current ? (
              <>
                v{current.version} · {current.updatedBy} · {formatTime(current.updatedAt)}
              </>
            ) : (
              "Chưa lưu"
            )}
          </div>
        </div>
        <TabsList>
          {(
            [
              ["edit", "Soạn"],
              ["preview-diff", "Thay đổi"],
              ["history", "Lịch sử"],
            ] as const
          ).map(([id, label]) => (
            <TabsTrigger key={id} value={id}>
              {label}
              {id === "preview-diff" && dirty ? " •" : ""}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>

      <ErrorNote error={doc.error} />

      <TabsContent value="edit" className="flex flex-col gap-4">
        <div className="grid gap-2 sm:grid-cols-[110px_1fr] sm:items-center sm:gap-x-3">
          <Label htmlFor="doc-title" className="text-xs text-muted-foreground">
            Tiêu đề
          </Label>
          <Input
            id="doc-title"
            value={draft.title}
            readOnly={!canEdit}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          />
        </div>
        {scope === "org" ? (
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={draft.includeInAgents}
              disabled={!canEdit}
              onCheckedChange={(v) => setDraft({ ...draft, includeInAgents: v === true })}
            />
            Đưa vào AGENTS.md của mọi dự án khi đồng bộ
          </label>
        ) : null}
        <Textarea
          className="min-h-80 resize-y font-mono text-sm leading-relaxed field-sizing-fixed md:text-sm"
          value={draft.content}
          readOnly={!canEdit}
          spellCheck={false}
          aria-label="Nội dung (Markdown)"
          placeholder="Nội dung Markdown…"
          onChange={(e) => setDraft({ ...draft, content: e.target.value })}
        />
      </TabsContent>

      <TabsContent value="preview-diff" className="min-w-0">
        <Diff before={current?.content ?? ""} after={draft.content} />
      </TabsContent>
      <TabsContent value="history" className="min-w-0">
        <History docKey={docKey} version={current?.version ?? 0} />
      </TabsContent>

      {canEdit ? (
        <div className="flex flex-wrap gap-2">
          <Input
            className="min-w-48 flex-1"
            placeholder="Ghi chú thay đổi (tuỳ chọn)"
            value={draft.note}
            onChange={(e) => setDraft({ ...draft, note: e.target.value })}
            aria-label="Ghi chú thay đổi"
          />
          <Button onClick={save} disabled={!dirty || action.busy}>
            {action.busy ? "Đang lưu…" : `Lưu v${(current?.version ?? 0) + 1}`}
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Bạn chỉ có quyền xem. Agent đề xuất thay đổi qua tool doc_propose.</p>
      )}
      <ErrorNote error={action.error} />
      {saved && !dirty ? <Notice tone="ok" title={saved} /> : null}
    </Tabs>
  );
}

function History({ docKey, version }: { docKey: string; version: number }) {
  const { client } = useHive();
  const history = useQuery(() => client.call("docs.history", { key: docKey }), [client, docKey, version]);
  const [open, setOpen] = useState<number | null>(null);
  const versions: DocVersion[] = history.data ?? [];
  if (history.loading && !history.data) return <Empty>Đang tải…</Empty>;
  if (!versions.length) return <Empty>Chưa có phiên bản nào.</Empty>;
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
              <span className="min-w-0 flex-1 break-words">{v.note || <span className="text-muted-foreground">Không có ghi chú</span>}</span>
              <span className="text-xs text-muted-foreground">
                {v.author} · {formatTime(v.createdAt)}
              </span>
            </button>
            {open === v.version ? <Diff before={prev?.content ?? ""} after={v.content} /> : null}
          </li>
        );
      })}
    </ol>
  );
}
