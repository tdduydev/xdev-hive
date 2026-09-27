import { useEffect, useMemo, useState } from "react";
import { parseDocKey, type Doc, type DocSummary, type DocVersion } from "@xdev-hive/core";
import { Diff } from "../components/Diff.tsx";
import { Badge, Empty, ErrorNote, PageHeader } from "../components/ui.tsx";
import { errorMessage, formatTime, useAction, useHive, useQuery } from "../hooks.ts";

interface Draft {
  title: string;
  content: string;
  includeInAgents: boolean;
  note: string;
}

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
    <div className="page">
      <PageHeader
        title="Tài liệu"
        subtitle="Bản gốc của AGENTS.md, quy chuẩn chung và nhật ký quyết định. Agent chỉ được đề xuất sửa, admin duyệt."
      />
      <div className="split">
        <nav className="panel list-panel" aria-label="Danh sách tài liệu">
          <input
            className="input"
            placeholder="Lọc tài liệu…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Lọc tài liệu"
          />
          <ErrorNote error={list.error} />
          {groups.map(([group, docs]) => (
            <div key={group} className="list-group">
              <div className="list-group-title">{group}</div>
              {docs.map((d) => (
                <button
                  key={d.key}
                  className={`list-item ${selected === d.key ? "active" : ""}`}
                  onClick={() => setSelected(d.key)}
                >
                  <span className="list-item-title">{d.title}</span>
                  <span className="list-item-meta">
                    {d.key} · v{d.version}
                  </span>
                </button>
              ))}
            </div>
          ))}
          {!list.loading && groups.length === 0 ? <Empty>Chưa có tài liệu.</Empty> : null}
          {canEdit ? (
            <div className="new-doc">
              <label className="label" htmlFor="new-doc-key">
                Tài liệu mới
              </label>
              <div className="row">
                <input
                  id="new-doc-key"
                  className="input mono"
                  placeholder="org/security hoặc project/app/agents"
                  value={newKey}
                  onChange={(e) => setNewKey(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && createDoc()}
                />
                <button className="btn" onClick={createDoc} disabled={!newKey.trim()}>
                  Tạo
                </button>
              </div>
              <ErrorNote error={newKeyError} />
            </div>
          ) : null}
        </nav>
        <section className="panel editor-panel">
          {selected ? (
            <DocEditor key={selected} docKey={selected} canEdit={canEdit} onSaved={list.reload} />
          ) : (
            <Empty>Chọn một tài liệu.</Empty>
          )}
        </section>
      </div>
    </div>
  );
}

function DocEditor({ docKey, canEdit, onSaved }: { docKey: string; canEdit: boolean; onSaved: () => void }) {
  const { client } = useHive();
  const doc = useQuery(() => client.call("docs.get", { key: docKey }), [client, docKey]);
  const [draft, setDraft] = useState<Draft>(emptyDraft(docKey));
  const [tab, setTab] = useState<"edit" | "preview-diff" | "history">("edit");
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
    <div className="editor">
      <div className="editor-head">
        <div>
          <div className="mono muted small">{docKey}</div>
          <h2>{current?.title ?? "Tài liệu mới"}</h2>
          <div className="muted small">
            {current ? (
              <>
                v{current.version} · {current.updatedBy} · {formatTime(current.updatedAt)}
              </>
            ) : (
              "Chưa lưu"
            )}
          </div>
        </div>
        <div className="tabs" role="tablist">
          {(
            [
              ["edit", "Soạn"],
              ["preview-diff", "Thay đổi"],
              ["history", "Lịch sử"],
            ] as const
          ).map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} className={`tab ${tab === id ? "active" : ""}`} onClick={() => setTab(id)}>
              {label}
              {id === "preview-diff" && dirty ? " •" : ""}
            </button>
          ))}
        </div>
      </div>

      <ErrorNote error={doc.error} />

      {tab === "edit" ? (
        <>
          <div className="form-grid">
            <label className="label" htmlFor="doc-title">
              Tiêu đề
            </label>
            <input
              id="doc-title"
              className="input"
              value={draft.title}
              readOnly={!canEdit}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          </div>
          {scope === "org" ? (
            <label className="check">
              <input
                type="checkbox"
                checked={draft.includeInAgents}
                disabled={!canEdit}
                onChange={(e) => setDraft({ ...draft, includeInAgents: e.target.checked })}
              />
              Đưa vào AGENTS.md của mọi dự án khi đồng bộ
            </label>
          ) : null}
          <textarea
            className="textarea mono"
            value={draft.content}
            readOnly={!canEdit}
            spellCheck={false}
            aria-label="Nội dung (Markdown)"
            placeholder="Nội dung Markdown…"
            onChange={(e) => setDraft({ ...draft, content: e.target.value })}
          />
        </>
      ) : null}

      {tab === "preview-diff" ? <Diff before={current?.content ?? ""} after={draft.content} /> : null}
      {tab === "history" ? <History docKey={docKey} version={current?.version ?? 0} /> : null}

      {canEdit ? (
        <div className="editor-foot">
          <input
            className="input"
            placeholder="Ghi chú thay đổi (tuỳ chọn)"
            value={draft.note}
            onChange={(e) => setDraft({ ...draft, note: e.target.value })}
            aria-label="Ghi chú thay đổi"
          />
          <button className="btn btn-primary" onClick={save} disabled={!dirty || action.busy}>
            {action.busy ? "Đang lưu…" : `Lưu v${(current?.version ?? 0) + 1}`}
          </button>
        </div>
      ) : (
        <p className="muted small">Bạn chỉ có quyền xem. Agent đề xuất thay đổi qua tool doc_propose.</p>
      )}
      <ErrorNote error={action.error} />
      {saved && !dirty ? <div className="note note-ok">{saved}</div> : null}
    </div>
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
    <ol className="history">
      {versions.map((v, i) => {
        const prev = versions[i + 1];
        return (
          <li key={v.version}>
            <button className="history-row" onClick={() => setOpen(open === v.version ? null : v.version)} aria-expanded={open === v.version}>
              <Badge tone={i === 0 ? "accent" : "neutral"}>v{v.version}</Badge>
              <span className="grow">{v.note || <span className="muted">Không có ghi chú</span>}</span>
              <span className="muted small">
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
