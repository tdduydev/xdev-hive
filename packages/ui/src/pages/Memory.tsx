import { useState } from "react";
import { MEMORY_KINDS, type Memory, type MemoryKind } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Card, CardContent } from "@xdev-hive/ui/components/ui/card";
import { Checkbox } from "@xdev-hive/ui/components/ui/checkbox";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/components/ui/native-select";
import { Badge, Empty, ErrorNote, Page, PageHeader, STATUS_TONE } from "../components/common.tsx";
import { formatTime, useAction, useHive, useProjects, useQuery } from "../hooks.ts";

const KIND_LABEL: Record<MemoryKind, string> = {
  decision: "Quyết định",
  convention: "Quy ước",
  gotcha: "Lưu ý",
  context: "Bối cảnh",
};

export function MemoryPage() {
  const { client, me } = useHive();
  const projects = useProjects();
  const [project, setProject] = useState("");
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [pendingOnly, setPendingOnly] = useState(false);

  const list = useQuery(() => {
    if (pendingOnly) return client.call("memory.list", { project: project || undefined, status: "pending" });
    if (project && submitted) return client.call("memory.search", { project, query: submitted, limit: 50 });
    return client.call("memory.list", { project: project || undefined });
  }, [client, project, submitted, pendingOnly]);

  return (
    <Page>
      <PageHeader
        title="Memory dùng chung"
        subtitle="Mọi agent ghi bằng memory_write và đọc bằng memory_search. Admin dọn các mục sai để chúng không lan sang agent khác."
      />
      <div className="flex flex-wrap items-center gap-2">
        <NativeSelect value={project} onChange={(e) => setProject(e.target.value)} aria-label="Dự án">
          <NativeSelectOption value="">Tất cả dự án</NativeSelectOption>
          {projects.map((p) => (
            <NativeSelectOption key={p} value={p}>
              {p}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <form
          className="flex min-w-64 flex-1 gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setSubmitted(query.trim());
          }}
        >
          <Input
            className="flex-1"
            placeholder={project ? "Tìm (có dấu hay không dấu đều được)…" : "Chọn dự án để tìm kiếm"}
            value={query}
            disabled={!project}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Tìm memory"
          />
          <Button variant="outline" type="submit" disabled={!project}>
            Tìm
          </Button>
        </form>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={pendingOnly} onCheckedChange={(v) => setPendingOnly(v === true)} />
          Chỉ mục chờ duyệt
        </label>
      </div>
      {me.role === "admin" && project ? <AddMemory project={project} onAdded={list.reload} /> : null}
      <ErrorNote error={list.error} />
      {list.data?.length === 0 ? <Empty>Không có mục nào.</Empty> : null}
      <div className="flex flex-col gap-3">
        {list.data?.map((m) => <MemoryRow key={m.id} memory={m} onChanged={list.reload} />)}
      </div>
    </Page>
  );
}

function MemoryRow({ memory: m, onChanged }: { memory: Memory; onChanged: () => void }) {
  const { client, me } = useHive();
  const action = useAction();
  return (
    <article>
      <Card className="py-4">
        <CardContent className="flex flex-col gap-2 px-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="accent">{KIND_LABEL[m.kind]}</Badge>
            {m.status === "pending" ? <Badge tone={STATUS_TONE.pending}>Chờ duyệt</Badge> : null}
            <span className="font-mono text-xs">{m.project}</span>
            {m.taskId ? <span className="font-mono text-xs text-muted-foreground">{m.taskId}</span> : null}
            <span className="min-w-0 flex-1 text-xs text-muted-foreground">
              {m.author} · {formatTime(m.createdAt)}
            </span>
            {me.role === "admin" ? (
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

function AddMemory({ project, onAdded }: { project: string; onAdded: () => void }) {
  const { client } = useHive();
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
              await client.call("memory.write", { project, kind, content: content.trim() });
              setContent("");
              onAdded();
            });
          }}
        >
          <NativeSelect value={kind} onChange={(e) => setKind(e.target.value as MemoryKind)} aria-label="Loại">
            {MEMORY_KINDS.map((k) => (
              <NativeSelectOption key={k} value={k}>
                {KIND_LABEL[k]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <Input
            className="min-w-48 flex-1"
            placeholder={`Thêm memory cho ${project}…`}
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
