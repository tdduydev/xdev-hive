import { useState } from "react";
import { MEMORY_KINDS, type Memory, type MemoryKind } from "@xdev-hive/core";
import { Badge, Empty, ErrorNote, PageHeader, STATUS_TONE } from "../components/ui.tsx";
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
    <div className="page">
      <PageHeader
        title="Memory dùng chung"
        subtitle="Mọi agent ghi bằng memory_write và đọc bằng memory_search. Admin dọn các mục sai để chúng không lan sang agent khác."
      />
      <div className="toolbar">
        <select className="input" value={project} onChange={(e) => setProject(e.target.value)} aria-label="Dự án">
          <option value="">Tất cả dự án</option>
          {projects.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <form
          className="row grow"
          onSubmit={(e) => {
            e.preventDefault();
            setSubmitted(query.trim());
          }}
        >
          <input
            className="input grow"
            placeholder={project ? "Tìm (có dấu hay không dấu đều được)…" : "Chọn dự án để tìm kiếm"}
            value={query}
            disabled={!project}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Tìm memory"
          />
          <button className="btn" type="submit" disabled={!project}>
            Tìm
          </button>
        </form>
        <label className="check">
          <input type="checkbox" checked={pendingOnly} onChange={(e) => setPendingOnly(e.target.checked)} />
          Chỉ mục chờ duyệt
        </label>
      </div>
      {me.role === "admin" && project ? <AddMemory project={project} onAdded={list.reload} /> : null}
      <ErrorNote error={list.error} />
      {list.data?.length === 0 ? <Empty>Không có mục nào.</Empty> : null}
      <div className="stack">
        {list.data?.map((m) => <MemoryRow key={m.id} memory={m} onChanged={list.reload} />)}
      </div>
    </div>
  );
}

function MemoryRow({ memory: m, onChanged }: { memory: Memory; onChanged: () => void }) {
  const { client, me } = useHive();
  const action = useAction();
  return (
    <article className="card card-compact">
      <div className="row gap-s wrap">
        <Badge tone="accent">{KIND_LABEL[m.kind]}</Badge>
        {m.status === "pending" ? <Badge tone={STATUS_TONE.pending}>Chờ duyệt</Badge> : null}
        <span className="mono small">{m.project}</span>
        {m.taskId ? <span className="mono small muted">{m.taskId}</span> : null}
        <span className="muted small grow">
          {m.author} · {formatTime(m.createdAt)}
        </span>
        {me.role === "admin" ? (
          <>
            {m.status === "pending" ? (
              <button
                className="btn btn-small"
                disabled={action.busy}
                onClick={() => action.run(async () => (await client.call("memory.approve", { id: m.id }), onChanged()))}
              >
                Duyệt
              </button>
            ) : null}
            <button
              className="btn btn-small btn-danger"
              disabled={action.busy}
              onClick={() => {
                if (window.confirm("Xoá mục memory này? Mọi agent sẽ không còn thấy nó.")) {
                  void action.run(async () => (await client.call("memory.remove", { id: m.id }), onChanged()));
                }
              }}
            >
              Xoá
            </button>
          </>
        ) : null}
      </div>
      <p className="memory-content">{m.content}</p>
      <ErrorNote error={action.error} />
    </article>
  );
}

function AddMemory({ project, onAdded }: { project: string; onAdded: () => void }) {
  const { client } = useHive();
  const [kind, setKind] = useState<MemoryKind>("decision");
  const [content, setContent] = useState("");
  const action = useAction();
  return (
    <form
      className="card card-compact row gap-s"
      onSubmit={(e) => {
        e.preventDefault();
        void action.run(async () => {
          await client.call("memory.write", { project, kind, content: content.trim() });
          setContent("");
          onAdded();
        });
      }}
    >
      <select className="input" value={kind} onChange={(e) => setKind(e.target.value as MemoryKind)} aria-label="Loại">
        {MEMORY_KINDS.map((k) => (
          <option key={k} value={k}>
            {KIND_LABEL[k]}
          </option>
        ))}
      </select>
      <input
        className="input grow"
        placeholder={`Thêm memory cho ${project}…`}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        aria-label="Nội dung memory"
      />
      <button className="btn" type="submit" disabled={!content.trim() || action.busy}>
        Thêm
      </button>
      <ErrorNote error={action.error} />
    </form>
  );
}
