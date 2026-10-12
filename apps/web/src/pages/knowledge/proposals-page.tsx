import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Proposal, ProposalStatus } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { NativeSelect } from "@xdev-hive/ui/native-select";
import { Textarea } from "@xdev-hive/ui/textarea";
import { useId, useState } from "react";
import { type Column, DataTable } from "@/components/data-table/data-table.tsx";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { useT } from "@/lib/i18n.ts";
import { contentDiff, useKnowledgeAccess } from "@/lib/knowledge.ts";
import {
  authorLabel,
  DataPages,
  DetailCard,
  KnowledgeLayout,
  QueryState,
  ScopeBadge,
} from "@/pages/knowledge/common.tsx";
import { knowledgeText } from "@/pages/knowledge/text.ts";
import { useOrg } from "@/shell/org-context.ts";

const text = knowledgeText;
const statuses: ProposalStatus[] = ["pending", "approved", "rejected"];
export function ProposalsPage() {
  const { org } = useOrg();
  return <ProposalsScreen key={org.id} />;
}
function ProposalsScreen() {
  const t = useT(text);
  const fieldId = useId();
  const { api } = useOrg();
  const [status, setStatus] = useState<ProposalStatus | "all">("pending");
  const [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState<string>();
  const list = useQuery(
    api.proposals.list.queryOptions({ input: { ...(status === "all" ? {} : { status }), offset, limit: 50 } }),
  );
  const selected = list.data?.find((row) => row.id === selectedId);
  const columns: Column<Proposal>[] = [
    {
      key: "target",
      label: t.original,
      value: (row) => row.target,
      sortable: true,
      cell: (row) => (
        <div>
          <strong className="font-mono">{row.target}</strong>
          <p className="text-xs text-muted-foreground">{row.reason}</p>
        </div>
      ),
    },
    { key: "reason", label: t.proposalsReason, value: (row) => row.reason, hidden: true },
    { key: "kind", label: t.kind, value: (row) => (row.kind === "doc" ? t.docsTitle : "Skill") },
    {
      key: "scope",
      label: t.scope,
      value: (row) => t[row.scope.level],
      cell: (row) => <ScopeBadge scope={row.scope} />,
    },
    { key: "version", label: t.version, value: (row) => row.baseVersion, sortable: true },
    {
      key: "status",
      label: t.status,
      value: (row) => t[row.status],
      cell: (row) => (
        <span
          className={`rounded-full px-2 py-1 text-xs ${row.status === "approved" ? "bg-success-soft text-success" : row.status === "rejected" ? "bg-destructive-soft text-destructive" : "bg-warning-soft text-warning"}`}
        >
          {t[row.status]}
        </span>
      ),
    },
    { key: "author", label: t.author, value: (row) => authorLabel(row.author) },
    { key: "created", label: t.updated, value: (row) => row.createdAt, sortable: true },
  ];
  return (
    <KnowledgeLayout title={t.proposalsTitle} lead={t.proposalsLead}>
      <label htmlFor={`${fieldId}-1`} className="block max-w-xs space-y-1">
        <span className="text-sm">{t.status}</span>
        <NativeSelect
          aria-label={t.status}
          id={`${fieldId}-1`}
          value={status}
          onChange={(event) => {
            setStatus(event.currentTarget.value as ProposalStatus | "all");
            setOffset(0);
            setSelectedId(undefined);
          }}
        >
          <option value="all">{t.all}</option>
          {statuses.map((value) => (
            <option key={value} value={value}>
              {t[value]}
            </option>
          ))}
        </NativeSelect>
      </label>
      <QueryState query={list} />
      {list.data && (
        <div className="grid min-w-0 items-start gap-4 xl:grid-cols-[3fr_2fr]">
          <div className="min-w-0 space-y-3">
            <DataTable
              columns={columns}
              rows={list.data}
              placeholder={t.proposalsSearch}
              selectable={false}
              facets={[{ key: "kind", label: t.kind, value: (row) => (row.kind === "doc" ? t.docsTitle : "Skill") }]}
              onRowClick={(row) => setSelectedId(row.id)}
              rowLabel={(row) => row.target}
              activeId={selectedId ?? ""}
              emptyContent={t.empty}
            />
            <DataPages
              offset={offset}
              count={list.data.length}
              onChange={(value) => {
                setOffset(value);
                setSelectedId(undefined);
              }}
            />
          </div>
          {selected ? <ProposalDetail key={selected.id} proposal={selected} /> : <DetailCard>{t.choose}</DetailCard>}
        </div>
      )}
    </KnowledgeLayout>
  );
}
function ProposalDetail({ proposal }: { proposal: Proposal }) {
  const t = useT(text);
  const fieldId = useId();
  const { api } = useOrg();
  const access = useKnowledgeAccess();
  const cache = useQueryClient();
  const [note, setNote] = useState("");
  const [decided, setDecided] = useState<Proposal>();
  const current = decided ?? proposal;
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
  async function decide(action: "approve" | "reject") {
    if (pending || !access.allowed(proposal.scope, "manage") || current.status !== "pending") return;
    try {
      const result = await (action === "approve" ? approve : reject).mutateAsync({
        id: proposal.id,
        note: note.trim(),
      });
      setDecided(result);
      await Promise.all(
        [api.proposals.key(), api.docs.key(), api.skills.key()].map((queryKey) =>
          cache.invalidateQueries({ queryKey }),
        ),
      );
    } catch {
      /* Preserve the note when the hub rejects a stale or conflicting decision. */
    }
  }
  const diff =
    baseContent === undefined
      ? []
      : contentDiff(baseContent, proposal.content).map((line, position) => ({ ...line, id: `diff-${position}` }));
  return (
    <DetailCard>
      <div className="flex flex-wrap gap-2">
        <ScopeBadge scope={proposal.scope} />
        <span className="text-xs text-muted-foreground">{t[current.status]}</span>
      </div>
      <h2 className="break-all font-mono text-base font-semibold">{proposal.target}</h2>
      <p className="text-xs text-muted-foreground">
        v{proposal.baseVersion} → v{current.resultVersion ?? proposal.baseVersion + 1} · {authorLabel(proposal.author)}
      </p>
      <p className="whitespace-pre-wrap break-words">
        {t.proposalsReason} {proposal.reason ?? "—"}
      </p>
      {proposal.baseVersion > 0 &&
        (proposal.kind === "skill" ? (
          <>
            <QueryState query={skillList} />
            {skillList.data && !skill && <Alert variant="destructive">{t.empty}</Alert>}
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
          {diff.map((line) => (
            <div
              key={line.id}
              className={`flex min-w-0 gap-2 px-3 py-1 ${line.kind === "added" ? "bg-success-soft text-success" : line.kind === "removed" ? "bg-destructive-soft text-destructive" : "text-muted-foreground"}`}
            >
              <span aria-hidden="true">{line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}</span>
              <span className="min-w-0 whitespace-pre-wrap break-all">{line.content || " "}</span>
            </div>
          ))}
        </section>
      )}
      {(approve.error || reject.error) && (
        <Alert variant="destructive">{apiErrorMessage(approve.error ?? reject.error)}</Alert>
      )}
      {current.status === "pending" && access.allowed(proposal.scope, "manage") && (
        <div className="space-y-3 border-t border-border pt-3">
          <label htmlFor={`${fieldId}-2`} className="block space-y-1">
            <span>{t.proposalsNote}</span>
            <Textarea
              id={`${fieldId}-2`}
              maxLength={500}
              placeholder={t.proposalsNotePh}
              value={note}
              disabled={pending}
              onChange={(event) => setNote(event.currentTarget.value)}
            />
          </label>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" disabled={pending} onClick={() => decide("reject")}>
              {t.proposalsReject}
            </Button>
            <Button disabled={pending || baseContent === undefined} onClick={() => decide("approve")}>
              {pending ? t.loading : t.approve}
            </Button>
          </div>
        </div>
      )}
      {current.decisionNote && (
        <p className="whitespace-pre-wrap break-words text-muted-foreground">
          {t.proposalsNote}: {current.decisionNote}
        </p>
      )}
    </DetailCard>
  );
}
