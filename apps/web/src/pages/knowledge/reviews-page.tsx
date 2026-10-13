import { useInfiniteQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { ReviewStatus, ReviewSummary, SlaState } from "@xdev-hive/contracts";
import {
  DocEditorProvider,
  ReviewPane,
  ReviewStatusPill,
  reviewText,
  SlaBadge,
  useReviewFormat,
} from "@xdev-hive/doc-editor";
import { Button } from "@xdev-hive/ui/button";
import { NativeSelect } from "@xdev-hive/ui/native-select";
import { BotIcon } from "lucide-react";
import { useId, useState } from "react";
import { type Column, DataTable } from "@/components/data-table/data-table.tsx";
import { GateKindBadge } from "@/components/gate-kind-badge.tsx";
import { FilterChips } from "@/components/ui/filter-chips.tsx";
import { LoadFailure, LoadingState } from "@/components/ui/query-state.tsx";
import { useWebDocEnv } from "@/lib/doc-editor-env.tsx";
import { useLang, useT } from "@/lib/i18n.ts";
import { useNow } from "@/lib/use-now.ts";
import { useOrg } from "@/shell/org-context.ts";
import { PageBody, PageHeader } from "@/shell/page-header.tsx";

type Scope = "mine" | "all";
const STATUSES: ReviewStatus[] = ["in_review", "changes_requested", "approved", "cancelled"];
const SLA_STATES: SlaState[] = ["overdue", "due-soon", "on-time", "none"];

/** Hàng chờ duyệt tài liệu (DocReview.dc.html): bảng phiên duyệt, thay đổi so với bản đã duyệt, quyết định. */
export function ReviewsPage() {
  const { org } = useOrg();
  return (
    <DocEditorProvider env={useWebDocEnv()}>
      <ReviewsScreen key={org.id} />
    </DocEditorProvider>
  );
}

function ReviewsScreen() {
  const { api } = useOrg();
  const t = useT(reviewText);
  const lang = useLang();
  const fmt = useReviewFormat(lang);
  const now = useNow(60_000);
  const search = useSearch({ from: "/session/app/in-org/knowledge/reviews" });
  const navigate = useNavigate({ from: "/knowledge/reviews" });
  const [scope, setScope] = useState<Scope>("mine");
  const [status, setStatus] = useState<ReviewStatus | "">("");
  const ids = useId();
  const list = useInfiniteQuery(
    api.reviews.list.infiniteOptions({
      input: (cursor: string | undefined) => ({
        scope,
        ...(status ? { status } : {}),
        limit: 50,
        ...(cursor ? { cursor } : {}),
      }),
      initialPageParam: undefined,
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    }),
  );
  const items = [
    ...new Map((list.data?.pages.flatMap((page) => page.items) ?? []).map((row) => [row.id, row])).values(),
  ];
  const selectedId = search.id ?? items[0]?.id;
  const select = (id: string) => navigate({ search: { id }, replace: true });

  const slaOptions = SLA_STATES.map((s) => ({ value: s, label: t.slaText[s] }));
  const columns: Column<ReviewSummary>[] = [
    {
      key: "doc",
      label: t.doc,
      value: (row) => `${row.docTitle} ${row.docKey}`,
      sortable: true,
      hideable: false,
      cell: (row) => (
        <div className="flex min-w-0 flex-col">
          <strong className="font-medium">{row.docTitle}</strong>
          <span className="font-mono text-xs text-muted-foreground">{row.docKey}</span>
        </div>
      ),
    },
    {
      key: "type",
      label: t.type,
      value: (row) => row.docType,
      cell: (row) => (
        <span className="inline-flex h-5.5 items-center rounded-full bg-secondary px-2 font-mono text-xs text-secondary-foreground">
          {row.docType}
        </span>
      ),
    },
    { key: "workflow", label: t.workflow, value: (row) => row.workflowName, className: "whitespace-nowrap" },
    {
      key: "gate",
      label: t.gate,
      value: (row) => row.gate?.name ?? t.statusText[row.status],
      cell: (row) =>
        row.gate ? (
          <span className="flex flex-col items-start gap-0.5">
            <span className="flex items-center gap-1.5">
              <GateKindBadge kind={row.gate.kind} />
              <span className="font-mono text-xs text-muted-foreground">
                {row.gate.index + 1}/{row.gate.total}
              </span>
            </span>
            <span className="text-sm">{row.gate.name}</span>
          </span>
        ) : (
          <ReviewStatusPill status={row.status} />
        ),
    },
    {
      key: "by",
      label: t.by,
      value: (row) => row.author.name,
      cell: (row) => (
        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
          {row.author.runId && <BotIcon className="size-3.5" aria-label={t.agent} />}
          {row.author.name}
        </span>
      ),
    },
    {
      key: "sla",
      label: t.sla,
      value: (row) => (row.gate?.dueAt ? new Date(row.gate.dueAt).getTime() : null),
      sortable: true,
      cell: (row) => <SlaBadge gate={row.gate} now={now} />,
    },
    {
      key: "ai",
      label: t.aiScore,
      value: (row) => row.aiScore,
      sortable: true,
      className: "text-right tabular-nums",
      cell: (row) => <span className="font-mono">{fmt.score(row.aiScore)}</span>,
    },
    {
      key: "lines",
      label: t.lines,
      value: (row) => row.addedLines + row.deletedLines,
      sortable: true,
      cell: (row) => (
        <span className="font-mono text-xs whitespace-nowrap">
          <span className="text-success">+{row.addedLines}</span>{" "}
          <span className="text-destructive">−{row.deletedLines}</span>
        </span>
      ),
    },
    {
      key: "updated",
      label: t.updated,
      value: (row) => row.updatedAt,
      sortable: true,
      cell: (row) => (
        <span className="text-xs whitespace-nowrap text-muted-foreground">{fmt.ago(row.updatedAt, now)}</span>
      ),
    },
  ];

  return (
    <>
      <PageHeader crumb={t.knowledge} title={t.title} />
      <PageBody>
        <div className="flex flex-wrap items-center gap-3">
          <FilterChips
            label={t.scope}
            chips={[
              { key: "mine", label: t.mine },
              { key: "all", label: t.all },
            ]}
            value={scope}
            onChange={setScope}
          />
          <label htmlFor={`${ids}-status`} className="flex items-center gap-2 text-sm font-medium">
            {t.status}
            <NativeSelect
              id={`${ids}-status`}
              size="sm"
              className="w-44"
              value={status}
              onChange={(e) => setStatus(e.target.value as ReviewStatus | "")}
            >
              <option value="">{t.anyStatus}</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t.statusText[s]}
                </option>
              ))}
            </NativeSelect>
          </label>
        </div>
        {list.isPending && <LoadingState />}
        {list.isError && <LoadFailure error={list.error} retry={() => list.refetch()} />}
        {list.data && (
          <div className="grid min-w-0 gap-2">
            <DataTable
              columns={columns}
              rows={items}
              pageSize={5}
              caption={t.queue}
              placeholder={t.search}
              selectable={false}
              facets={[
                { key: "type", label: t.type, value: (row) => row.docType },
                { key: "gate", label: t.gate, value: (row) => row.gate?.name ?? null },
                { key: "sla", label: t.sla, value: (row) => row.gate?.sla ?? "none", options: slaOptions },
                {
                  key: "author",
                  label: t.by,
                  value: (row) => (row.author.runId ? "ai" : "person"),
                  options: [
                    { value: "ai", label: t.agent },
                    { value: "person", label: t.person },
                  ],
                },
              ]}
              onRowClick={(row) => select(row.id)}
              rowLabel={(row) => row.docTitle}
              activeId={selectedId ?? ""}
              emptyContent={scope === "mine" ? t.emptyMine : t.emptyAll}
            />
            {list.hasNextPage && (
              <Button
                variant="outline"
                size="sm"
                className="justify-self-center"
                disabled={list.isFetchingNextPage}
                onClick={() => list.fetchNextPage()}
              >
                {t.loadMore}
              </Button>
            )}
          </div>
        )}
        {selectedId ? (
          <ReviewPane
            key={selectedId}
            id={selectedId}
            now={now}
            // Quyết định xong thì tài liệu rời hàng "chờ tôi"; ghim lựa chọn để người duyệt vẫn thấy kết quả.
            onDecided={() => select(selectedId)}
          />
        ) : (
          list.data && items.length > 0 && <p className="text-muted-foreground">{t.pick}</p>
        )}
      </PageBody>
    </>
  );
}
