import { Tabs } from "@base-ui/react/tabs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import type { Proposal, ProposalStatus } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Pill, type PillProps } from "@xdev-hive/ui/pill";
import { Textarea } from "@xdev-hive/ui/textarea";
import { useId, useState } from "react";
import { type Column, DataTable } from "@/components/data-table/data-table.tsx";
import { DescriptionList } from "@/components/ui/description-list.tsx";
import { Field, FieldLabel } from "@/components/ui/field.tsx";
import { LoadFailure, TableSkeleton } from "@/components/ui/query-state.tsx";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { useT } from "@/lib/i18n.ts";
import { contentDiff, useKnowledgeAccess } from "@/lib/knowledge.ts";
import type { ProposalsTab, ProposalTab } from "@/lib/route-search.ts";
import {
  authorLabel,
  DetailFallback,
  EmptyRows,
  offsetPaging,
  PAGE_SIZE,
  QueryState,
  ScopeBadge,
  useRowById,
  When,
} from "@/pages/knowledge/common.tsx";
import { knowledgeText } from "@/pages/knowledge/text.ts";
import { useOrg } from "@/shell/org-context.ts";
import { DetailHeader, PageBody, PageHeader, PageTab, PageTabList } from "@/shell/page-header.tsx";

const text = knowledgeText;
type Tab = "cho-duyet" | ProposalsTab;
const STATUS_OF: Record<Tab, ProposalStatus | "all"> = {
  "cho-duyet": "pending",
  "da-duyet": "approved",
  "tu-choi": "rejected",
  "tat-ca": "all",
};
const STATUS_TONE: Record<ProposalStatus, NonNullable<PillProps["tone"]>> = {
  pending: "warn",
  approved: "ok",
  rejected: "bad",
};

export function ProposalsPage() {
  const { org } = useOrg();
  return <ProposalsScreen key={org.id} />;
}
function ProposalsScreen() {
  const t = useT(text);
  const { api } = useOrg();
  const navigate = useNavigate();
  const { tab = "cho-duyet" } = useSearch({ from: "/session/app/in-org/knowledge/proposals" });
  const pending = useQuery(api.proposals.list.queryOptions({ input: { status: "pending", limit: 200 } }));
  const tabs: { value: Tab; label: string; count?: number | undefined }[] = [
    { value: "cho-duyet", label: t.pending, count: pending.data?.length },
    { value: "da-duyet", label: t.approved },
    { value: "tu-choi", label: t.rejected },
    { value: "tat-ca", label: t.all },
  ];
  return (
    <>
      <PageHeader title={t.proposalsTitle} description={t.proposalsLead} />
      <Tabs.Root
        value={tab}
        onValueChange={(value: Tab) =>
          navigate({ to: "/knowledge/proposals", search: value === "cho-duyet" ? {} : { tab: value }, replace: true })
        }
      >
        <PageTabList label={t.proposalsViews}>
          {tabs.map((item) => (
            <PageTab key={item.value} value={item.value} count={item.count} tone="warning">
              {item.label}
            </PageTab>
          ))}
        </PageTabList>
        {tabs.map((item) => (
          <Tabs.Panel key={item.value} value={item.value}>
            <PageBody>
              <ProposalList key={item.value} status={STATUS_OF[item.value]} />
            </PageBody>
          </Tabs.Panel>
        ))}
      </Tabs.Root>
    </>
  );
}

function ProposalList({ status }: { status: ProposalStatus | "all" }) {
  const t = useT(text);
  const { api } = useOrg();
  const navigate = useNavigate();
  const [offset, setOffset] = useState(0);
  const list = useQuery(
    api.proposals.list.queryOptions({
      input: { ...(status === "all" ? {} : { status }), offset, limit: PAGE_SIZE },
    }),
  );
  const kindLabel = (row: Proposal) => (row.kind === "doc" ? t.docsTitle : "Skill");
  const columns: Column<Proposal>[] = [
    {
      key: "target",
      label: t.original,
      value: (row) => row.target,
      sortable: true,
      pin: "start",
      cell: (row) => (
        <div className="min-w-0 space-y-0.5">
          <strong className="font-mono break-all">{row.target}</strong>
          {row.reason && <p className="line-clamp-2 text-xs text-muted-foreground">{row.reason}</p>}
        </div>
      ),
    },
    { key: "reason", label: t.proposalsReason, value: (row) => row.reason, hidden: true, hideable: false },
    { key: "kind", label: t.kind, value: kindLabel, cell: (row) => <Pill>{kindLabel(row)}</Pill> },
    {
      key: "scope",
      label: t.scope,
      value: (row) => t[row.scope.level],
      cell: (row) => <ScopeBadge scope={row.scope} />,
    },
    {
      key: "version",
      label: t.version,
      value: (row) => row.baseVersion,
      sortable: true,
      align: "end",
      cell: (row) => `v${row.baseVersion}`,
    },
    {
      key: "status",
      label: t.status,
      value: (row) => t[row.status],
      cell: (row) => (
        <Pill tone={STATUS_TONE[row.status]} dot>
          {t[row.status]}
        </Pill>
      ),
    },
    { key: "author", label: t.author, value: (row) => authorLabel(row.author), hidden: true },
    {
      key: "created",
      label: t.proposedAt,
      value: (row) => row.createdAt,
      sortable: true,
      cell: (row) => <When iso={row.createdAt} />,
    },
  ];
  if (list.isPending) return <TableSkeleton label={t.loading} columns={5} />;
  if (list.isError) return <LoadFailure error={list.error} retry={list.refetch} />;
  return (
    <DataTable
      columns={columns}
      rows={list.data}
      minWidth={680}
      placeholder={t.proposalsSearch}
      facets={[{ key: "kind", label: t.kind, value: kindLabel }]}
      onRowClick={(row) => navigate({ to: "/knowledge/proposals/$proposalId", params: { proposalId: row.id } })}
      rowLabel={(row) => row.target}
      emptyContent={
        <EmptyRows
          title={status === "pending" ? t.proposalsNoPending : t.proposalsNone}
          description={status === "pending" ? t.proposalsNoPendingHint : t.proposalsNoneHint}
        />
      }
      serverPaging={offsetPaging(t, offset, list.data.length, setOffset)}
    />
  );
}

export function ProposalDetailPage() {
  const { org } = useOrg();
  const { proposalId } = useParams({ from: "/session/app/in-org/knowledge/proposals/$proposalId" });
  return <ProposalDetailScreen key={`${org.id}:${proposalId}`} id={proposalId} />;
}

function ProposalDetailScreen({ id }: { id: string }) {
  const t = useT(text);
  const { api } = useOrg();
  const navigate = useNavigate();
  const { tab = "thay-doi" } = useSearch({ from: "/session/app/in-org/knowledge/proposals/$proposalId" });
  const found = useRowById(api.proposals.key(), id, [(page) => api.proposals.list.call(page)]);
  const proposal = found.data;
  if (!proposal) return <DetailFallback query={found} title={t.proposalsTitle} back="/knowledge/proposals" />;
  const kindLabel = proposal.kind === "doc" ? t.docsTitle : "Skill";
  return (
    <>
      <DetailHeader
        back={{ to: "/knowledge/proposals", label: t.proposalsTitle }}
        title={proposal.target}
        status={
          <Pill tone={STATUS_TONE[proposal.status]} dot>
            {t[proposal.status]}
          </Pill>
        }
        meta={
          <>
            <ScopeBadge scope={proposal.scope} />
            <span>{kindLabel}</span>
            <span className="font-mono">
              v{proposal.baseVersion} → v{proposal.resultVersion ?? proposal.baseVersion + 1}
            </span>
            <span>
              {authorLabel(proposal.author)} · <When iso={proposal.createdAt} />
            </span>
          </>
        }
      />
      <Tabs.Root
        value={tab}
        onValueChange={(value: ProposalTab | "thay-doi") =>
          navigate({
            to: "/knowledge/proposals/$proposalId",
            params: { proposalId: id },
            search: value === "thay-doi" ? {} : { tab: value },
            replace: true,
          })
        }
      >
        <PageTabList label={t.proposalViews}>
          <PageTab value="thay-doi">{t.changesTab}</PageTab>
          <PageTab value="lich-su">{t.history}</PageTab>
        </PageTabList>
        <Tabs.Panel value="thay-doi">
          <PageBody width="wide">
            <ProposalChanges proposal={proposal} />
          </PageBody>
        </Tabs.Panel>
        <Tabs.Panel value="lich-su">
          <PageBody width="wide">
            <ProposalHistory proposal={proposal} />
          </PageBody>
        </Tabs.Panel>
      </Tabs.Root>
    </>
  );
}

/** Mọi đề xuất cho cùng tài liệu hay skill (cùng phạm vi), để người duyệt thấy bản này nằm đâu trong chuỗi sửa. */
function ProposalHistory({ proposal }: { proposal: Proposal }) {
  const t = useT(text);
  const { api } = useOrg();
  const navigate = useNavigate();
  const list = useQuery(api.proposals.list.queryOptions({ input: { kind: proposal.kind, limit: 200 } }));
  const rows = (list.data ?? []).filter(
    (row) =>
      row.target === proposal.target &&
      row.scope.level === proposal.scope.level &&
      row.scope.teamId === proposal.scope.teamId &&
      row.scope.projectId === proposal.scope.projectId,
  );
  const columns: Column<Proposal>[] = [
    {
      key: "created",
      label: t.proposedAt,
      value: (row) => row.createdAt,
      pin: "start",
      cell: (row) => (
        <span className="flex flex-wrap items-center gap-1.5">
          <When iso={row.createdAt} />
          {row.id === proposal.id && <Pill tone="sel">{t.thisProposal}</Pill>}
        </span>
      ),
    },
    {
      key: "version",
      label: t.version,
      value: (row) => row.baseVersion,
      align: "end",
      cell: (row) => `v${row.baseVersion} → v${row.resultVersion ?? row.baseVersion + 1}`,
    },
    {
      key: "status",
      label: t.status,
      value: (row) => t[row.status],
      cell: (row) => (
        <Pill tone={STATUS_TONE[row.status]} dot>
          {t[row.status]}
        </Pill>
      ),
    },
    { key: "author", label: t.author, value: (row) => authorLabel(row.author) },
    { key: "reason", label: t.proposalsReasonTitle, value: (row) => row.reason ?? "—" },
    { key: "note", label: t.proposalsNote, value: (row) => row.decisionNote ?? "—", hidden: true },
  ];
  if (list.isPending) return <TableSkeleton label={t.loading} columns={5} />;
  if (list.isError) return <LoadFailure error={list.error} retry={list.refetch} />;
  return (
    <>
      <p className="text-sm text-muted-foreground">{t.proposalHistoryLead(proposal.target)}</p>
      <DataTable
        columns={columns}
        rows={rows}
        minWidth={640}
        search={false}
        activeId={proposal.id}
        rowLabel={(row) => `${row.target} · ${t[row.status]}`}
        onRowClick={(row) => navigate({ to: "/knowledge/proposals/$proposalId", params: { proposalId: row.id } })}
        emptyContent={<EmptyRows title={t.proposalsNone} description={t.proposalHistoryEmpty} />}
      />
    </>
  );
}

function ProposalChanges({ proposal }: { proposal: Proposal }) {
  const t = useT(text);
  const fieldId = useId();
  const { api } = useOrg();
  const access = useKnowledgeAccess();
  const cache = useQueryClient();
  const [note, setNote] = useState("");
  const skillList = useQuery({
    ...api.skills.list.queryOptions({ input: {} }),
    enabled: proposal.kind === "skill" && proposal.baseVersion > 0,
  });
  // Names can repeat across scopes; selecting by id preserves the proposal's exact base.
  const skill = skillList.data?.find(
    (item) =>
      item.name === proposal.target &&
      item.scope.level === proposal.scope.level &&
      item.scope.teamId === proposal.scope.teamId &&
      item.scope.projectId === proposal.scope.projectId,
  );
  const originalDoc = useQuery({
    ...api.docs.get.queryOptions({
      input: { key: proposal.kind === "doc" ? proposal.target : "org/placeholder", version: proposal.baseVersion || 1 },
    }),
    enabled: proposal.kind === "doc" && proposal.baseVersion > 0,
  });
  const originalSkill = useQuery({
    ...api.skills.get.queryOptions({
      input: { id: skill?.id, name: skill ? undefined : proposal.target, version: proposal.baseVersion || 1 },
    }),
    enabled: proposal.kind === "skill" && proposal.baseVersion > 0 && !!skill,
  });
  const original = proposal.kind === "doc" ? originalDoc : originalSkill;
  const baseContent = proposal.baseVersion === 0 ? "" : original.data?.content;
  const approve = useMutation(api.proposals.approve.mutationOptions());
  const reject = useMutation(api.proposals.reject.mutationOptions());
  const pending = approve.isPending || reject.isPending;
  const canDecide = proposal.status === "pending" && access.allowed(proposal.scope, "manage");
  async function decide(action: "approve" | "reject") {
    if (pending || !canDecide) return;
    try {
      await (action === "approve" ? approve : reject).mutateAsync({ id: proposal.id, note: note.trim() });
      await Promise.all(
        [api.proposals.key(), api.docs.key(), api.skills.key()].map((queryKey) =>
          cache.invalidateQueries({ queryKey }),
        ),
      );
      // Trang ở lại: trạng thái mới hiện ở đầu trang sau khi danh sách tải lại.
    } catch {
      /* Preserve the note when the hub rejects a stale or conflicting decision. */
    }
  }
  const diff =
    baseContent === undefined
      ? []
      : contentDiff(baseContent, proposal.content).map((line, position) => ({ ...line, id: `diff-${position}` }));
  return (
    <>
      {proposal.reason && (
        <section className="grid gap-1">
          <h2 className="text-sm font-medium">{t.proposalsReasonTitle}</h2>
          <p className="whitespace-pre-wrap break-words">{proposal.reason}</p>
        </section>
      )}
      {proposal.decidedAt && (
        <DescriptionList
          items={[
            { term: t.decidedBy, detail: proposal.decidedBy ?? "—", mono: true },
            { term: t.decidedAt, detail: <When iso={proposal.decidedAt} /> },
            ...(proposal.decisionNote ? [{ term: t.proposalsNote, detail: proposal.decisionNote }] : []),
          ]}
        />
      )}
      {proposal.baseVersion > 0 &&
        (proposal.kind === "skill" ? (
          <>
            <QueryState query={skillList} />
            {skillList.data && !skill && <Alert variant="destructive">{t.skillMissing}</Alert>}
            {skill && <QueryState query={originalSkill} />}
          </>
        ) : (
          <QueryState query={originalDoc} />
        ))}
      {baseContent !== undefined && (
        <section aria-label={t.diff} className="overflow-hidden rounded-lg border border-border font-mono text-xs">
          <div className="flex flex-wrap gap-2 border-b border-border bg-muted p-2">
            <span>
              − {t.original} · v{proposal.baseVersion}
            </span>
            <span>+ {t.proposed}</span>
          </div>
          {baseContent === proposal.content && <p className="p-2 text-muted-foreground">{t.noChanges}</p>}
          <div>
            {diff.map((line) => (
              <div
                key={line.id}
                className={`flex min-w-0 gap-2 px-3 py-1 ${line.kind === "added" ? "bg-success-soft text-success" : line.kind === "removed" ? "bg-destructive-soft text-destructive" : "text-muted-foreground"}`}
              >
                <span aria-hidden="true">{line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}</span>
                <span className="min-w-0 whitespace-pre-wrap break-all">{line.content || " "}</span>
              </div>
            ))}
          </div>
        </section>
      )}
      {(approve.error || reject.error) && (
        <Alert variant="destructive">{apiErrorMessage(approve.error ?? reject.error)}</Alert>
      )}
      {canDecide && (
        // Dính đáy khung cuộn: bản diff dài vẫn thấy nút quyết định như ở hộp thoại cũ.
        <section className="sticky bottom-4 z-10 grid gap-3 rounded-xl border border-border bg-card p-4 shadow-sm">
          <Field>
            <FieldLabel htmlFor={`${fieldId}-note`}>{t.proposalsNote}</FieldLabel>
            <Textarea
              id={`${fieldId}-note`}
              maxLength={500}
              placeholder={t.proposalsNotePh}
              value={note}
              disabled={pending}
              onChange={(event) => setNote(event.currentTarget.value)}
            />
          </Field>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" disabled={pending} onClick={() => decide("reject")}>
              {t.proposalsReject}
            </Button>
            <Button disabled={pending || baseContent === undefined} onClick={() => decide("approve")}>
              {pending ? t.loading : t.approve}
            </Button>
          </div>
        </section>
      )}
    </>
  );
}
