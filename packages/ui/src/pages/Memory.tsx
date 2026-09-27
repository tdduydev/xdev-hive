import { useState } from "react";
import { MEMORY_KINDS, type Memory, type MemoryKind } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Card, CardContent } from "@xdev-hive/ui/components/ui/card";
import { Checkbox } from "@xdev-hive/ui/components/ui/checkbox";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { Label } from "@xdev-hive/ui/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/components/ui/native-select";
import { Badge, Empty, ErrorNote, OwnerBadge, Page, PageHeader, STATUS_TONE } from "../components/common.tsx";
import type { HiveClient } from "../client.ts";
import { formatTime, useAction, useCan, useHive, useQuery } from "../hooks.ts";
import { scopeProject, type Scope } from "../lib/scope.ts";

const KIND_LABEL: Record<MemoryKind, string> = {
  decision: "Quyết định",
  convention: "Quy ước",
  gotcha: "Lưu ý",
  context: "Bối cảnh",
};

/** Value of the "Chung" option in the owner select (project keys are never empty). */
const SHARED_OPTION = "";

/** memory.list / memory.search input for the scope: all → everything, shared → team-wide only, project → its entries + shared. */
function loadMemory(client: HiveClient, scope: Scope, query: string, pendingOnly: boolean) {
  const status = pendingOnly ? ("pending" as const) : undefined;
  if (scope.kind === "project") {
    return !pendingOnly && query
      ? client.call("memory.search", { project: scope.project, query, limit: 50 })
      : client.call("memory.list", { project: scope.project, includeShared: true, status });
  }
  if (scope.kind === "shared") {
    return !pendingOnly && query ? client.call("memory.search", { query, limit: 50 }) : client.call("memory.list", { project: null, status });
  }
  return !pendingOnly && query ? client.call("memory.search", { anyProject: true, query, limit: 50 }) : client.call("memory.list", { status });
}

export function MemoryPage() {
  const { client, scope, projects } = useHive();
  const allow = useCan();
  const scoped = scopeProject(scope);
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [pendingOnly, setPendingOnly] = useState(false);

  const list = useQuery(() => loadMemory(client, scope, submitted, pendingOnly), [client, scope.kind, scoped, submitted, pendingOnly]);

  // In a project, its own entries come first, then the team-wide ones it also sees.
  const rows = list.data ?? [];
  const groups: Array<{ owner: string | null; title: string | null; items: Memory[] }> =
    scope.kind === "project"
      ? [
          { owner: scope.project, title: "Riêng của dự án", items: rows.filter((m) => m.project !== null) },
          { owner: null, title: "Chung — áp dụng cho mọi dự án", items: rows.filter((m) => m.project === null) },
        ]
      : [{ owner: null, title: null, items: rows }];

  // New entries default to the scope: its project, Chung for the shared scope, the first project when looking at all.
  const defaultOwner = scope.kind === "project" ? scope.project : scope.kind === "shared" ? null : (projects[0] ?? null);

  return (
    <Page>
      <PageHeader
        title="Memory"
        subtitle="Memory chung áp dụng cho mọi dự án, còn memory riêng chỉ áp dụng cho một dự án. Mọi agent ghi bằng memory_write và đọc bằng memory_search. Admin dọn các mục sai để chúng không lan sang agent khác."
      />
      <div className="flex flex-wrap items-center gap-2">
        <form
          className="flex min-w-64 flex-1 gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setSubmitted(query.trim());
          }}
        >
          <Input
            className="flex-1"
            placeholder="Tìm (có dấu hay không dấu đều được)…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Tìm memory"
          />
          <Button variant="outline" type="submit">
            Tìm
          </Button>
        </form>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={pendingOnly} onCheckedChange={(v) => setPendingOnly(v === true)} />
          Chỉ mục chờ duyệt
        </label>
      </div>
      {allow(null, "contribute") || projects.some((p) => allow(p, "contribute")) ? (
        <AddMemory key={scoped === null ? scope.kind : `project:${scoped}`} defaultOwner={defaultOwner} projects={projects} onAdded={list.reload} />
      ) : null}
      <ErrorNote error={list.error} />
      {list.data?.length === 0 ? <Empty>Không có mục nào.</Empty> : null}
      {groups
        .filter((g) => g.items.length > 0)
        .map((g) => (
          <section key={g.title ?? "all"} className="flex flex-col gap-3" aria-label={g.title ?? undefined}>
            {g.title ? (
              <h2 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-muted-foreground">
                <OwnerBadge owner={g.owner} />
                <span>{g.title}</span>
                <Badge tone="neutral">{g.items.length}</Badge>
              </h2>
            ) : null}
            {g.items.map((m) => (
              <MemoryRow key={m.id} memory={m} onChanged={list.reload} />
            ))}
          </section>
        ))}
    </Page>
  );
}

function MemoryRow({ memory: m, onChanged }: { memory: Memory; onChanged: () => void }) {
  const { client } = useHive();
  const allow = useCan();
  const action = useAction();
  return (
    <article>
      <Card className="py-4">
        <CardContent className="flex flex-col gap-2 px-4">
          <div className="flex flex-wrap items-center gap-2">
            <OwnerBadge owner={m.project} />
            <Badge tone="accent">{KIND_LABEL[m.kind]}</Badge>
            {m.status === "pending" ? <Badge tone={STATUS_TONE.pending}>Chờ duyệt</Badge> : null}
            {m.taskId ? <span className="font-mono text-xs text-muted-foreground">{m.taskId}</span> : null}
            <span className="min-w-0 flex-1 text-xs text-muted-foreground">
              {m.author} · {formatTime(m.createdAt)}
            </span>
            {allow(m.project, "manage") ? (
              <>
                {m.status === "pending" ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={action.busy}
                    onClick={() => action.run(async () => (await client.call("memory.approve", { id: m.id }), onChanged()))}
                  >
                    Duyệt
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  disabled={action.busy}
                  onClick={() => {
                    if (window.confirm("Xoá mục memory này? Mọi agent sẽ không còn thấy nó.")) {
                      void action.run(async () => (await client.call("memory.remove", { id: m.id }), onChanged()));
                    }
                  }}
                >
                  Xoá
                </Button>
              </>
            ) : null}
          </div>
          <p className="text-sm break-words whitespace-pre-wrap">{m.content}</p>
          <ErrorNote error={action.error} />
        </CardContent>
      </Card>
    </article>
  );
}

function AddMemory({ defaultOwner, projects, onAdded }: { defaultOwner: string | null; projects: string[]; onAdded: () => void }) {
  const { client } = useHive();
  const allow = useCan();
  const sharedOk = allow(null, "contribute");
  // undefined: not picked yet, so it follows the scope's default (the project list may still be loading).
  const [picked, setPicked] = useState<string | null>();
  const writable = projects.filter((p) => allow(p, "contribute"));
  const fallback = defaultOwner !== null && !allow(defaultOwner, "contribute") ? (sharedOk ? null : (writable[0] ?? null)) : defaultOwner;
  const owner = picked === undefined ? fallback : picked;
  const options = owner !== null && !writable.includes(owner) ? [owner, ...writable] : writable;
  const [kind, setKind] = useState<MemoryKind>("decision");
  const [content, setContent] = useState("");
  const action = useAction();
  return (
    <Card className="py-4">
      <CardContent className="flex flex-col gap-2 px-4">
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(async () => {
              const text = content.trim();
              await client.call("memory.write", owner === null ? { shared: true, kind, content: text } : { project: owner, kind, content: text });
              setContent("");
              onAdded();
            });
          }}
        >
          <div className="flex max-w-full min-w-0 items-center gap-2">
            <Label htmlFor="memory-owner" className="shrink-0">
              Thuộc
            </Label>
            <NativeSelect
              id="memory-owner"
              value={owner ?? SHARED_OPTION}
              onChange={(e) => setPicked(e.target.value === SHARED_OPTION ? null : e.target.value)}
            >
              {sharedOk ? <NativeSelectOption value={SHARED_OPTION}>Chung (cả team — áp dụng cho mọi dự án)</NativeSelectOption> : null}
              {options.map((p) => (
                <NativeSelectOption key={p} value={p}>
                  {p}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <NativeSelect value={kind} onChange={(e) => setKind(e.target.value as MemoryKind)} aria-label="Loại">
            {MEMORY_KINDS.map((k) => (
              <NativeSelectOption key={k} value={k}>
                {KIND_LABEL[k]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <Input
            className="min-w-48 flex-1"
            placeholder={owner === null ? "Thêm memory chung cho cả team…" : `Thêm memory cho ${owner}…`}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            aria-label="Nội dung memory"
          />
          <Button variant="outline" type="submit" disabled={!content.trim() || action.busy}>
            Thêm
          </Button>
        </form>
        <ErrorNote error={action.error} />
      </CardContent>
    </Card>
  );
}
