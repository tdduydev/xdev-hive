import { useEffect, useMemo, useState } from "react";
import { cn } from "cn";
import { parseDocKey, type Doc, type DocSummary, type DocVersion } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Card, CardContent } from "@xdev-hive/ui/components/ui/card";
import { Checkbox } from "@xdev-hive/ui/components/ui/checkbox";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { Label } from "@xdev-hive/ui/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@xdev-hive/ui/components/ui/tabs";
import { Textarea } from "@xdev-hive/ui/components/ui/textarea";
import { Diff } from "../components/Diff.tsx";
import { Badge, Empty, ErrorNote, Notice, Page, PageHeader } from "../components/common.tsx";
import { errorMessage, formatTime, useAction, useHive, useQuery } from "../hooks.ts";

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

export function DocsPage() {
  const { client, me } = useHive();
  const canEdit = me.role === "admin";
  const list = useQuery(() => client.call("docs.list", {}), [client]);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [newKey, setNewKey] = useState("");
  const [newKeyError, setNewKeyError] = useState<string | null>(null);

  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const docs = (list.data ?? []).filter((d) => !q || d.key.includes(q) || d.title.toLowerCase().includes(q));
    const map = new Map<string, DocSummary[]>();
    for (const d of docs) {
      const group = d.scope === "org" ? "Dùng chung (org)" : `Dự án: ${d.project}`;
      map.set(group, [...(map.get(group) ?? []), d]);
    }
    return [...map.entries()];
  }, [list.data, filter]);

  useEffect(() => {
    if (!selected && list.data?.[0]) setSelected(list.data[0].key);
  }, [list.data, selected]);

  const createDoc = () => {
    try {
      parseDocKey(newKey.trim());
      setNewKeyError(null);
      setSelected(newKey.trim());
      setNewKey("");
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
              {groups.map(([group, docs]) => (
                <div key={group} className="flex flex-col gap-0.5">
                  <div className="px-2 py-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{group}</div>
                  {docs.map((d) => (
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
              ))}
              {!list.loading && groups.length === 0 ? <Empty>Chưa có tài liệu.</Empty> : null}
              {canEdit ? (
                <div className="flex flex-col gap-2 border-t pt-3">
                  <Label htmlFor="new-doc-key" className="text-xs text-muted-foreground">
                    Tài liệu mới
                  </Label>
                  <div className="flex gap-2">
                    <Input
                      id="new-doc-key"
                      className="flex-1 font-mono text-xs md:text-xs"
                      placeholder="org/security hoặc project/app/agents"
                      value={newKey}
                      onChange={(e) => setNewKey(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && createDoc()}
                    />
                    <Button variant="outline" onClick={createDoc} disabled={!newKey.trim()}>
                      Tạo
                    </Button>
                  </div>
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
          <div className="font-mono text-xs break-all text-muted-foreground">{docKey}</div>
          <h2 className="text-lg font-semibold break-words">{current?.title ?? "Tài liệu mới"}</h2>
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
