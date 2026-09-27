import { useState } from "react";
import type { Proposal } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Card, CardContent } from "@xdev-hive/ui/components/ui/card";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@xdev-hive/ui/components/ui/toggle-group";
import { Diff } from "../components/Diff.tsx";
import { Badge, Empty, ErrorNote, Notice, Page, PageHeader, STATUS_TONE } from "../components/common.tsx";
import { formatTime, useAction, useHive, useQuery } from "../hooks.ts";

const STATUS_LABEL: Record<Proposal["status"], string> = {
  pending: "Chờ duyệt",
  approved: "Đã duyệt",
  rejected: "Từ chối",
  conflict: "Xung đột",
};

const SEGMENT = "data-[state=on]:bg-brand-soft data-[state=on]:font-semibold data-[state=on]:text-brand-soft-foreground";

export function ProposalsPage() {
  const { client } = useHive();
  const [onlyPending, setOnlyPending] = useState(true);
  const list = useQuery(
    () => client.call("proposals.list", onlyPending ? { status: "pending" } : {}),
    [client, onlyPending],
  );

  return (
    <Page>
      <PageHeader
        title="Đề xuất sửa tài liệu"
        subtitle="Agent gửi qua doc_propose. Duyệt thì tạo phiên bản mới. Nếu tài liệu đã đổi sau khi agent đọc, đề xuất sẽ bị đánh dấu xung đột."
        actions={
          <ToggleGroup
            type="single"
            variant="outline"
            value={onlyPending ? "pending" : "all"}
            onValueChange={(v) => {
              if (v) setOnlyPending(v === "pending");
            }}
            aria-label="Lọc trạng thái"
          >
            <ToggleGroupItem value="pending" className={SEGMENT}>
              Chờ duyệt
            </ToggleGroupItem>
            <ToggleGroupItem value="all" className={SEGMENT}>
              Tất cả
            </ToggleGroupItem>
          </ToggleGroup>
        }
      />
      <ErrorNote error={list.error} />
      {list.data?.length === 0 ? <Empty>{onlyPending ? "Không có đề xuất nào đang chờ." : "Chưa có đề xuất nào."}</Empty> : null}
      <div className="flex flex-col gap-4">
        {list.data?.map((p) => <ProposalCard key={p.id} proposal={p} onChanged={list.reload} />)}
      </div>
    </Page>
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
    <article>
      <Card className="py-4">
        <CardContent className="flex flex-col gap-4 px-4">
          <div className="flex flex-wrap items-start gap-3">
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={STATUS_TONE[p.status]}>{STATUS_LABEL[p.status]}</Badge>
                <span className="font-mono text-xs break-all">{p.docKey}</span>
                <span className="text-xs text-muted-foreground">
                  #{p.id} · dựa trên v{p.baseVersion}
                </span>
              </div>
              <p className="font-semibold break-words">{p.reason}</p>
              <div className="text-xs text-muted-foreground">
                {p.author} · {formatTime(p.createdAt)}
                {p.reviewer ? ` · ${STATUS_LABEL[p.status].toLowerCase()} bởi ${p.reviewer} ${formatTime(p.decidedAt)}` : ""}
              </div>
              {p.reviewNote ? <Notice tone="info">{p.reviewNote}</Notice> : null}
            </div>
            <Button variant="ghost" onClick={() => setOpen(!open)} aria-expanded={open}>
              {open ? "Ẩn thay đổi" : "Xem thay đổi"}
            </Button>
          </div>
          {open ? (
            <>
              {stale && p.status === "pending" ? (
                <Notice tone="warn">
                  Tài liệu đã lên v{current.data?.version ?? 0}. Duyệt lúc này sẽ bị đánh dấu xung đột. Agent cần đọc lại và đề xuất lại.
                </Notice>
              ) : null}
              <ErrorNote error={current.error} />
              {current.loading ? <Empty>Đang tải…</Empty> : <Diff before={current.data?.content ?? ""} after={p.content} />}
            </>
          ) : null}
          {p.status === "pending" && me.role === "admin" ? (
            <div className="flex flex-wrap items-center gap-2">
              <Input
                className="min-w-48 flex-1"
                placeholder="Lý do từ chối (tuỳ chọn)"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                aria-label="Lý do từ chối"
              />
              <Button
                variant="ghost"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => decide("reject")}
                disabled={action.busy}
              >
                Từ chối
              </Button>
              <Button onClick={() => decide("approve")} disabled={action.busy}>
                Duyệt
              </Button>
            </div>
          ) : null}
          <ErrorNote error={action.error} />
        </CardContent>
      </Card>
    </article>
  );
}
