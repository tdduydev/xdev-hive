import { useState } from "react";
import type { Proposal } from "@xdev-hive/core";
import { Diff } from "../components/Diff.tsx";
import { Badge, Empty, ErrorNote, PageHeader, STATUS_TONE } from "../components/ui.tsx";
import { formatTime, useAction, useHive, useQuery } from "../hooks.ts";

const STATUS_LABEL: Record<Proposal["status"], string> = {
  pending: "Chờ duyệt",
  approved: "Đã duyệt",
  rejected: "Từ chối",
  conflict: "Xung đột",
};

export function ProposalsPage() {
  const { client } = useHive();
  const [onlyPending, setOnlyPending] = useState(true);
  const list = useQuery(
    () => client.call("proposals.list", onlyPending ? { status: "pending" } : {}),
    [client, onlyPending],
  );

  return (
    <div className="page">
      <PageHeader
        title="Đề xuất sửa tài liệu"
        subtitle="Agent gửi qua doc_propose. Duyệt thì tạo phiên bản mới. Nếu tài liệu đã đổi sau khi agent đọc, đề xuất sẽ bị đánh dấu xung đột."
        actions={
          <div className="segmented" role="group" aria-label="Lọc trạng thái">
            <button className={onlyPending ? "active" : ""} onClick={() => setOnlyPending(true)}>
              Chờ duyệt
            </button>
            <button className={!onlyPending ? "active" : ""} onClick={() => setOnlyPending(false)}>
              Tất cả
            </button>
          </div>
        }
      />
      <ErrorNote error={list.error} />
      {list.data?.length === 0 ? <Empty>{onlyPending ? "Không có đề xuất nào đang chờ." : "Chưa có đề xuất nào."}</Empty> : null}
      <div className="stack">
        {list.data?.map((p) => <ProposalCard key={p.id} proposal={p} onChanged={list.reload} />)}
      </div>
    </div>
  );
}

function ProposalCard({ proposal: p, onChanged }: { proposal: Proposal; onChanged: () => void }) {
  const { client, me, bump } = useHive();
  const [open, setOpen] = useState(p.status === "pending");
  const [note, setNote] = useState("");
  const current = useQuery(
    () => (open ? client.call("docs.get", { key: p.docKey }) : Promise.resolve(undefined)),
    [client, p.docKey, open],
  );
  const action = useAction();
  const stale = current.data !== undefined && (current.data?.version ?? 0) !== p.baseVersion;

  const decide = (kind: "approve" | "reject") =>
    action.run(async () => {
      if (kind === "approve") await client.call("proposals.approve", { id: p.id });
      else await client.call("proposals.reject", { id: p.id, note: note.trim() || undefined });
      bump();
      onChanged();
    });

  return (
    <article className="card">
      <div className="card-head">
        <div className="grow">
          <div className="row gap-s">
            <Badge tone={STATUS_TONE[p.status]}>{STATUS_LABEL[p.status]}</Badge>
            <span className="mono">{p.docKey}</span>
            <span className="muted small">
              #{p.id} · dựa trên v{p.baseVersion}
            </span>
          </div>
          <p className="card-title">{p.reason}</p>
          <div className="muted small">
            {p.author} · {formatTime(p.createdAt)}
            {p.reviewer ? ` · ${STATUS_LABEL[p.status].toLowerCase()} bởi ${p.reviewer} ${formatTime(p.decidedAt)}` : ""}
          </div>
          {p.reviewNote ? <div className="note">{p.reviewNote}</div> : null}
        </div>
        <button className="btn btn-ghost" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? "Ẩn thay đổi" : "Xem thay đổi"}
        </button>
      </div>
      {open ? (
        <>
          {stale && p.status === "pending" ? (
            <div className="note note-warn">
              Tài liệu đã lên v{current.data?.version ?? 0}. Duyệt lúc này sẽ bị đánh dấu xung đột. Agent cần đọc lại và đề xuất lại.
            </div>
          ) : null}
          <ErrorNote error={current.error} />
          {current.loading ? <Empty>Đang tải…</Empty> : <Diff before={current.data?.content ?? ""} after={p.content} />}
        </>
      ) : null}
      {p.status === "pending" && me.role === "admin" ? (
        <div className="card-foot">
          <input
            className="input"
            placeholder="Lý do từ chối (tuỳ chọn)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            aria-label="Lý do từ chối"
          />
          <button className="btn btn-danger" onClick={() => decide("reject")} disabled={action.busy}>
            Từ chối
          </button>
          <button className="btn btn-primary" onClick={() => decide("approve")} disabled={action.busy}>
            Duyệt
          </button>
        </div>
      ) : null}
      <ErrorNote error={action.error} />
    </article>
  );
}
