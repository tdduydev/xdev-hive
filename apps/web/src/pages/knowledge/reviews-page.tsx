import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
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
import { AutoApproval, SdlcProvider } from "@xdev-hive/sdlc-ui";
import { Button } from "@xdev-hive/ui/button";
import { NativeSelect } from "@xdev-hive/ui/native-select";
import { BotIcon } from "lucide-react";
import { lazy, type ReactNode, Suspense, useId, useState } from "react";
import { type Column, DataTable } from "@/components/data-table/data-table.tsx";
import { GateKindBadge } from "@/components/gate-kind-badge.tsx";
import { FilterChips } from "@/components/ui/filter-chips.tsx";
import { LoadFailure, LoadingState } from "@/components/ui/query-state.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.tsx";
import { awaitingCount, countLabel, useAwaitingCodeReviews } from "@/lib/code-reviews.ts";
import { useWebDocEnv } from "@/lib/doc-editor-env.tsx";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import { useWebSdlcEnv } from "@/lib/sdlc-env.tsx";
import { useNow } from "@/lib/use-now.ts";
import { useOrg } from "@/shell/org-context.ts";
import { PageBody, PageHeader } from "@/shell/page-header.tsx";
import { CodeReviewsTab } from "./code-reviews-tab.tsx";

// Bản tách kéo theo `@xyflow/react`; chỉ tải khi phiên duyệt là tài liệu tách việc của AI SDLC.
const BreakdownReview = lazy(() =>
  import("@xdev-hive/sdlc-ui/breakdown").then((m) => ({ default: m.BreakdownReview })),
);

type Scope = "mine" | "all";
const STATUSES: ReviewStatus[] = ["in_review", "changes_requested", "approved", "cancelled"];
const SLA_STATES: SlaState[] = ["overdue", "due-soon", "on-time", "none"];

const tabText: Dict<{ tabs: string; docs: string; code: string; awaiting: (n: number) => string }> = {
  vi: { tabs: "Loại duyệt", docs: "Tài liệu", code: "Code", awaiting: (n) => `${n} đang chờ bạn` },
  en: { tabs: "Review type", docs: "Docs", code: "Code", awaiting: (n) => `${n} awaiting you` },
};

/** Số chờ tôi trên nhãn tab; ẩn khi chưa biết hoặc bằng 0 để tab không báo việc không có. */
function TabCount({ n }: { n: number | undefined }) {
  const t = useT(tabText);
  if (!n) return null;
  return (
    <span className="rounded-sm bg-foreground/5 px-1 font-mono text-2xs tabular-nums">
      <span className="sr-only">{t.awaiting(n)}</span>
      <span aria-hidden="true">{countLabel(n)}</span>
    </span>
  );
}

/**
 * "Chờ tôi duyệt": hai tab, Tài liệu (DocReview.dc.html) và Code (CodeReview.dc.html), mỗi tab có số phiên chờ tôi.
 * `?tab=code&id=` dẫn thẳng tới một PR; URL cũ `?id=` vẫn là tài liệu.
 */
export function ReviewsPage() {
  const { org, api } = useOrg();
  const t = useT(tabText);
  const reviewsText = useT(reviewText);
  const search = useSearch({ from: "/session/app/in-org/knowledge/reviews" });
  const navigate = useNavigate({ from: "/knowledge/reviews" });
  const docEnv = useWebDocEnv();
  const tab = search.tab ?? "docs";
  // Hub chưa có route đếm tài liệu; danh sách "chờ tôi" tối đa 100 phiên đủ cho số hiện trên tab.
  const docs = useQuery(api.reviews.list.queryOptions({ input: { scope: "mine", limit: 100 } }));
  const codeAwaiting = useAwaitingCodeReviews();
  return (
    <>
      <PageHeader crumb={reviewsText.knowledge} title={reviewsText.title} />
      <PageBody>
        <Tabs
          key={org.id}
          value={tab}
          onValueChange={(value) => navigate({ search: value === "code" ? { tab: "code" } : {}, replace: true })}
        >
          <TabsList variant="line" aria-label={t.tabs}>
            <TabsTrigger value="docs">
              {t.docs}
              <TabCount n={docs.data ? awaitingCount(docs.data.items) : undefined} />
            </TabsTrigger>
            <TabsTrigger value="code">
              {t.code}
              <TabCount n={codeAwaiting} />
            </TabsTrigger>
          </TabsList>
          <TabsContent value="docs" className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4">
            <DocEditorProvider env={docEnv}>
              <DocReviews />
            </DocEditorProvider>
          </TabsContent>
          <TabsContent value="code" className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4">
            <CodeReviewsTab
              selectedId={search.id}
              onSelect={(id) => navigate({ search: { tab: "code", id }, replace: true })}
            />
          </TabsContent>
        </Tabs>
      </PageBody>
    </>
  );
}

/** Hàng chờ duyệt tài liệu (DocReview.dc.html): bảng phiên duyệt, thay đổi so với bản đã duyệt, quyết định. */
function DocReviews(): ReactNode {
  const { api } = useOrg();
  const t = useT(reviewText);
  const lang = useLang();
  const fmt = useReviewFormat(lang);
  const now = useNow(60_000);
  const sdlcEnv = useWebSdlcEnv();
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
          sdlc={{
            breakdown: (item) => (
              <SdlcProvider env={sdlcEnv}>
                <Suspense fallback={null}>
                  <BreakdownReview item={item} />
                </Suspense>
              </SdlcProvider>
            ),
            revoke: (approval) => (
              <SdlcProvider env={sdlcEnv}>
                <AutoApproval approval={approval} />
              </SdlcProvider>
            ),
          }}
          // Quyết định xong thì tài liệu rời hàng "chờ tôi"; ghim lựa chọn để người duyệt vẫn thấy kết quả.
          onDecided={() => select(selectedId)}
        />
      ) : (
        list.data && items.length > 0 && <p className="text-muted-foreground">{t.pick}</p>
      )}
    </>
  );
}
