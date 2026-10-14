import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { LearnedSkillProposal, LearnTrigger, SkillProposalStatus } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Markdown } from "@xdev-hive/ui/markdown";
import { NativeSelect } from "@xdev-hive/ui/native-select";
import { Pill, type PillProps } from "@xdev-hive/ui/pill";
import { Textarea } from "@xdev-hive/ui/textarea";
import { useId, useState } from "react";
import { type Column, DataTable } from "@/components/data-table/data-table.tsx";
import { PageSection } from "@/components/page/page-section.tsx";
import { SegmentedControl } from "@/components/page/segmented-control.tsx";
import { StatCard, StatGrid } from "@/components/page/stat-card.tsx";
import { Field, FieldError, FieldLabel } from "@/components/ui/field.tsx";
import { LoadFailure, SectionsSkeleton, TableSkeleton } from "@/components/ui/query-state.tsx";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { type Dict, useT } from "@/lib/i18n.ts";
import { contentDiff, useKnowledgeAccess } from "@/lib/knowledge.ts";
import { shortId } from "@/lib/run-view.ts";
import { DetailDialog, EmptyRows, ScopeBadge, When } from "@/pages/knowledge/common.tsx";
import { useOrg } from "@/shell/org-context.ts";

const text: Dict<{
  lead: string;
  disabled: string;
  statsLabel: string;
  proposals: string;
  approvalRate: string;
  duplicates: string;
  cost: string;
  today: (used: number, limit: number) => string;
  windowDays: (days: number) => string;
  status: string;
  all: string;
  pending: string;
  approved: string;
  rejected: string;
  skill: string;
  project: string;
  kind: string;
  kindNew: string;
  kindEdit: string;
  reason: string;
  created: string;
  search: string;
  empty: string;
  emptyHint: string;
  loading: string;
  listTitle: string;
  triggers: Record<LearnTrigger, string>;
  sourceRuns: string;
  newScope: string;
  scopeProject: string;
  scopeTeam: string;
  scopeOrg: string;
  noteLabel: string;
  notePh: string;
  rejectLabel: string;
  rejectReason: string;
  rejectReasonPh: string;
  rejectNeeds: string;
  approve: string;
  approveToPr: string;
  working: string;
  diff: string;
  proposedContent: string;
  prOpened: (n: number) => string;
  prOpening: string;
  prFailed: string;
  saved: (v: number) => string;
  decidedNote: string;
  tokens: (n: number) => string;
  viewLabel: string;
}> = {
  vi: {
    lead: "Skill agent rút ra sau những việc khó (thử lại nhiều lần, tốn kém hoặc được đánh dấu). Duyệt thì hub mở PR vào kho skill Git, hoặc lưu thành skill nếu chưa nối kho.",
    disabled:
      "Tính năng đang tắt. Quản trị tổ chức bật ở Chính sách agent → Học skill; mỗi dự án chỉ chạy một lô mỗi ngày.",
    statsLabel: "Số liệu việc học skill",
    proposals: "Đề xuất",
    approvalRate: "Tỉ lệ duyệt",
    duplicates: "Bỏ vì trùng",
    cost: "Chi phí việc học",
    today: (used, limit) => `Hôm nay ${used}/${limit}`,
    windowDays: (days) => `${days} ngày gần nhất`,
    status: "Trạng thái",
    all: "Tất cả",
    pending: "Chờ duyệt",
    approved: "Đã duyệt",
    rejected: "Bị từ chối",
    skill: "Skill",
    project: "Dự án",
    kind: "Loại",
    kindNew: "Skill mới",
    kindEdit: "Sửa skill",
    reason: "Vì sao đáng học",
    created: "Đề xuất lúc",
    search: "Tìm skill, dự án, lý do…",
    empty: "Chưa có đề xuất nào từ agent.",
    emptyHint: "Khi agent rút ra một skill sau việc khó, đề xuất sẽ hiện ở đây để người quản trị duyệt.",
    loading: "Đang tải đề xuất skill…",
    listTitle: "Đề xuất từ agent",
    triggers: {
      retries: "Thử lại nhiều lần",
      cost: "Chi phí vượt p90",
      marked: "Được đánh dấu",
    },
    sourceRuns: "Run nguồn",
    newScope: "Lưu skill ở phạm vi",
    scopeProject: "Dự án nguồn",
    scopeTeam: "Cả đội",
    scopeOrg: "Cả tổ chức",
    noteLabel: "Ghi chú khi duyệt",
    notePh: "Không bắt buộc",
    rejectLabel: "Từ chối",
    rejectReason: "Lý do từ chối",
    rejectReasonPh: "Hub lưu để không đề xuất lại skill này",
    rejectNeeds: "Cần ghi lý do từ chối.",
    approve: "Duyệt và lưu skill",
    approveToPr: "Duyệt và mở PR",
    working: "Đang xử lý…",
    diff: "Thay đổi so với bản hiện tại",
    proposedContent: "SKILL.md đề xuất",
    prOpened: (n) => `Đã mở PR #${n}`,
    prOpening: "Đang mở PR vào kho skill…",
    prFailed: "Chưa mở được PR, hub sẽ thử lại:",
    saved: (v) => `Đã lưu thành skill, phiên bản ${v}`,
    decidedNote: "Ghi chú",
    tokens: (n) => `${n.toLocaleString("vi-VN")} token`,
    viewLabel: "Đề xuất skill từ agent",
  },
  en: {
    lead: "Skills agents distilled from hard tasks (retried, expensive or marked). Approving opens a PR in the skills Git repo, or saves a hub skill when no repo is connected.",
    disabled:
      "This feature is off. An org admin turns it on in Agent policy → Skill learning; each project runs one batch a day.",
    statsLabel: "Skill learning metrics",
    proposals: "Proposals",
    approvalRate: "Approval rate",
    duplicates: "Dropped as duplicates",
    cost: "Learning cost",
    today: (used, limit) => `Today ${used}/${limit}`,
    windowDays: (days) => `Last ${days} days`,
    status: "Status",
    all: "All",
    pending: "Pending",
    approved: "Approved",
    rejected: "Rejected",
    skill: "Skill",
    project: "Project",
    kind: "Kind",
    kindNew: "New skill",
    kindEdit: "Skill edit",
    reason: "Why it is worth learning",
    created: "Proposed",
    search: "Search skill, project, reason…",
    empty: "No agent proposals yet.",
    emptyHint: "When an agent distils a skill after a hard task, the proposal shows up here for an admin to review.",
    loading: "Loading skill proposals…",
    listTitle: "Agent proposals",
    triggers: {
      retries: "Retried a lot",
      cost: "Cost above p90",
      marked: "Marked",
    },
    sourceRuns: "Source runs",
    newScope: "Save the skill at scope",
    scopeProject: "Source project",
    scopeTeam: "Whole team",
    scopeOrg: "Whole organization",
    noteLabel: "Decision note",
    notePh: "Optional",
    rejectLabel: "Reject",
    rejectReason: "Reason for rejecting",
    rejectReasonPh: "The hub keeps it so this skill is not proposed again",
    rejectNeeds: "Give a reason for rejecting.",
    approve: "Approve and save skill",
    approveToPr: "Approve and open PR",
    working: "Working…",
    diff: "Changes against the current version",
    proposedContent: "Proposed SKILL.md",
    prOpened: (n) => `PR #${n} opened`,
    prOpening: "Opening the PR in the skills repo…",
    prFailed: "Could not open the PR yet; the hub will retry:",
    saved: (v) => `Saved as a skill, version ${v}`,
    decidedNote: "Note",
    tokens: (n) => `${n.toLocaleString("en-US")} tokens`,
    viewLabel: "Agent skill proposals",
  },
};

const STATUSES: SkillProposalStatus[] = ["pending", "approved", "rejected"];
const STATUS_TONE: Record<SkillProposalStatus, NonNullable<PillProps["tone"]>> = {
  pending: "warn",
  approved: "ok",
  rejected: "bad",
};

/** Số đề xuất đang chờ, để hiện trên nhãn tab ở trang Skills. */
export function usePendingLearned() {
  const { api } = useOrg();
  return useQuery(api.skillLearning.list.queryOptions({ input: { status: "pending", limit: 200 } }));
}

export function SkillLearningTab() {
  const t = useT(text);
  const { api } = useOrg();
  const [status, setStatus] = useState<SkillProposalStatus | "all">("pending");
  const [picked, setPicked] = useState<LearnedSkillProposal>();
  const stats = useQuery(api.skillLearning.stats.queryOptions({ input: { days: 30 } }));
  const list = useQuery(
    api.skillLearning.list.queryOptions({ input: { ...(status === "all" ? {} : { status }), limit: 100 } }),
  );
  // Duyệt xong thì dòng rời bộ lọc "chờ duyệt"; giữ dòng đã chọn để kết quả quyết không biến mất cùng lúc tải lại.
  const selected = list.data?.find((row) => row.id === picked?.id) ?? picked;
  const columns: Column<LearnedSkillProposal>[] = [
    {
      key: "name",
      label: t.skill,
      value: (row) => row.name,
      sortable: true,
      pin: "start",
      cell: (row) => (
        <div className="min-w-0 space-y-0.5">
          <strong className="font-mono">{row.name}</strong>
          <p className="line-clamp-2 text-xs text-muted-foreground">{row.description}</p>
        </div>
      ),
    },
    { key: "reason", label: t.reason, value: (row) => row.reason, hidden: true, hideable: false },
    { key: "project", label: t.project, value: (row) => row.projectKey },
    { key: "kind", label: t.kind, value: (row) => (row.kind === "new" ? t.kindNew : t.kindEdit) },
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
    {
      key: "created",
      label: t.created,
      value: (row) => row.createdAt,
      sortable: true,
      cell: (row) => <When iso={row.createdAt} />,
    },
  ];
  return (
    <>
      {stats.data && !stats.data.enabled && <Alert>{t.disabled}</Alert>}
      {stats.isPending && <SectionsSkeleton sections={1} label={t.loading} />}
      {stats.isError && <LoadFailure error={stats.error} retry={stats.refetch} />}
      {stats.data && (
        <section aria-label={t.statsLabel}>
          <StatGrid>
            <StatCard
              label={t.proposals}
              value={String(stats.data.proposals)}
              hint={`${t.windowDays(stats.data.days)} · ${t.today(stats.data.today.used, stats.data.today.limit)}`}
            />
            <StatCard
              label={t.approvalRate}
              value={stats.data.approvalRate === null ? "—" : `${Math.round(stats.data.approvalRate * 100)}%`}
              hint={`${stats.data.approved} ${t.approved.toLowerCase()} · ${stats.data.rejected} ${t.rejected.toLowerCase()}`}
            />
            <StatCard label={t.duplicates} value={String(stats.data.duplicates)} hint={t.windowDays(stats.data.days)} />
            <StatCard
              label={t.cost}
              value={stats.data.costUsd === null ? "—" : `${stats.data.costUsd.toFixed(2)} USD`}
              hint={t.tokens(stats.data.tokens)}
            />
          </StatGrid>
        </section>
      )}
      <PageSection
        title={t.listTitle}
        description={t.lead}
        actions={
          <SegmentedControl
            label={t.status}
            value={status}
            onChange={(value) => {
              setStatus(value);
              setPicked(undefined);
            }}
            options={[...STATUSES, "all" as const].map((value) => ({
              value,
              label: value === "all" ? t.all : t[value],
            }))}
          />
        }
      >
        {list.isPending && <TableSkeleton label={t.loading} columns={5} />}
        {list.isError && <LoadFailure error={list.error} retry={list.refetch} />}
        {list.data && (
          <DataTable
            columns={columns}
            rows={list.data}
            minWidth={640}
            placeholder={t.search}
            selectable={false}
            rowLabel={(row) => row.name}
            activeId={picked?.id ?? ""}
            onRowClick={setPicked}
            emptyContent={<EmptyRows title={t.empty} description={t.emptyHint} />}
          />
        )}
      </PageSection>
      {selected && <LearnedDetail key={selected.id} proposal={selected} onClose={() => setPicked(undefined)} />}
    </>
  );
}

function LearnedDetail({ proposal, onClose }: { proposal: LearnedSkillProposal; onClose: () => void }) {
  const t = useT(text);
  const fieldId = useId();
  const { api } = useOrg();
  const access = useKnowledgeAccess();
  const cache = useQueryClient();
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [scope, setScope] = useState<"project" | "team" | "org">("project");
  const [decided, setDecided] = useState<LearnedSkillProposal>();
  const [needReason, setNeedReason] = useState(false);
  const current = decided ?? proposal;
  const approve = useMutation(api.skillLearning.approve.mutationOptions());
  const reject = useMutation(api.skillLearning.reject.mutationOptions());
  const pending = approve.isPending || reject.isPending;
  const target =
    proposal.kind === "edit"
      ? proposal.scope
      : { level: scope, teamId: proposal.scope.teamId, projectId: proposal.scope.projectId };
  const repo = useQuery(api.skillRepo.get.queryOptions());
  const canDecide = current.status === "pending" && access.allowed(target, "manage");
  const skills = useQuery({ ...api.skills.list.queryOptions({ input: {} }), enabled: proposal.kind === "edit" });
  const existing = skills.data?.find(
    (s) =>
      s.name === proposal.name &&
      s.scope.level === proposal.scope.level &&
      s.scope.teamId === proposal.scope.teamId &&
      s.scope.projectId === proposal.scope.projectId,
  );
  const base = useQuery({
    ...api.skills.get.queryOptions({ input: { id: existing?.id ?? "" } }),
    enabled: !!existing,
  });
  const diff =
    proposal.kind === "edit" && base.data
      ? contentDiff(base.data.content, proposal.content).map((line, position) => ({ ...line, id: `diff-${position}` }))
      : null;
  async function refresh() {
    await Promise.all(
      [api.skillLearning.key(), api.skills.key()].map((queryKey) => cache.invalidateQueries({ queryKey })),
    );
  }
  async function decideApprove() {
    if (pending) return;
    try {
      setDecided(
        await approve.mutateAsync({
          id: proposal.id,
          ...(proposal.kind === "new" ? { scope } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
        }),
      );
      await refresh();
    } catch {
      /* Giữ ghi chú khi hub từ chối vì xung đột phiên bản hay thiếu quyền. */
    }
  }
  async function decideReject() {
    if (pending) return;
    if (reason.trim().length < 3) {
      setNeedReason(true);
      return;
    }
    try {
      setDecided(await reject.mutateAsync({ id: proposal.id, reason: reason.trim() }));
      await refresh();
    } catch {
      /* Giữ lý do đã nhập. */
    }
  }
  return (
    <DetailDialog
      title={proposal.name}
      onClose={onClose}
      badges={
        <>
          <ScopeBadge scope={proposal.scope} />
          <Pill>{proposal.kind === "new" ? t.kindNew : t.kindEdit}</Pill>
          <Pill tone={STATUS_TONE[current.status]} dot>
            {t[current.status]}
          </Pill>
        </>
      }
      description={
        <>
          {proposal.projectKey}
          {proposal.kind === "edit" && ` · v${proposal.baseVersion}`}
        </>
      }
      footer={
        canDecide && (
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" disabled={pending} onClick={decideReject}>
              {t.rejectLabel}
            </Button>
            <Button disabled={pending} onClick={decideApprove}>
              {pending ? t.working : repo.data ? t.approveToPr : t.approve}
            </Button>
          </div>
        )
      }
    >
      <p className="text-sm text-muted-foreground">{proposal.description}</p>
      <section className="grid gap-1.5">
        <h3 className="text-sm font-medium">{t.reason}</h3>
        <p className="whitespace-pre-wrap break-words">{proposal.reason}</p>
        <div className="flex flex-wrap gap-1">
          {proposal.triggers.map((trigger) => (
            <Pill key={trigger} small>
              {t.triggers[trigger]}
            </Pill>
          ))}
        </div>
        {proposal.sourceRunIds.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {t.sourceRuns}:{" "}
            {proposal.sourceRunIds.map((id) => (
              <Link key={id} to="/runs/$id" params={{ id }} className="mr-2 font-mono underline">
                {shortId(id)}
              </Link>
            ))}
          </p>
        )}
      </section>
      {diff ? (
        <section aria-label={t.diff} className="overflow-hidden rounded-lg border border-border font-mono text-xs">
          <div className="border-b border-border bg-muted p-2">{t.diff}</div>
          <div className="max-h-80 overflow-y-auto overscroll-contain">
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
      ) : (
        <section aria-label={t.proposedContent} className="grid gap-1.5">
          <h3 className="text-sm font-medium">{t.proposedContent}</h3>
          <Markdown content={proposal.content} />
        </section>
      )}
      {current.delivery && <Delivery delivery={current.delivery} />}
      {current.decisionNote && (
        <p className="whitespace-pre-wrap break-words text-muted-foreground">
          {t.decidedNote}: {current.decisionNote}
        </p>
      )}
      {(approve.error || reject.error) && (
        <Alert variant="destructive">{apiErrorMessage(approve.error ?? reject.error)}</Alert>
      )}
      {canDecide && (
        <div className="grid gap-3 border-t border-border pt-4">
          {proposal.kind === "new" && (
            <Field>
              <FieldLabel htmlFor={`${fieldId}-scope`}>{t.newScope}</FieldLabel>
              <NativeSelect
                id={`${fieldId}-scope`}
                value={scope}
                disabled={pending}
                onChange={(event) => setScope(event.currentTarget.value as "project" | "team" | "org")}
              >
                <option value="project">{t.scopeProject}</option>
                <option value="team">{t.scopeTeam}</option>
                <option value="org">{t.scopeOrg}</option>
              </NativeSelect>
            </Field>
          )}
          <Field>
            <FieldLabel htmlFor={`${fieldId}-note`}>{t.noteLabel}</FieldLabel>
            <Textarea
              id={`${fieldId}-note`}
              maxLength={500}
              placeholder={t.notePh}
              value={note}
              disabled={pending}
              onChange={(event) => setNote(event.currentTarget.value)}
            />
          </Field>
          <Field invalid={needReason && reason.trim().length < 3}>
            <FieldLabel htmlFor={`${fieldId}-reason`}>{t.rejectReason}</FieldLabel>
            <Textarea
              id={`${fieldId}-reason`}
              maxLength={500}
              placeholder={t.rejectReasonPh}
              value={reason}
              disabled={pending}
              onChange={(event) => {
                setReason(event.currentTarget.value);
                setNeedReason(false);
              }}
            />
            {needReason && <FieldError>{t.rejectNeeds}</FieldError>}
          </Field>
        </div>
      )}
    </DetailDialog>
  );
}

function Delivery({ delivery }: { delivery: NonNullable<LearnedSkillProposal["delivery"]> }) {
  const t = useT(text);
  if (delivery.mode === "saved") return <Alert>{t.saved(delivery.version ?? 1)}</Alert>;
  if (delivery.prNumber !== null)
    return (
      <Alert>
        {delivery.prUrl ? (
          <a href={delivery.prUrl} target="_blank" rel="noreferrer" className="underline">
            {t.prOpened(delivery.prNumber)}
          </a>
        ) : (
          t.prOpened(delivery.prNumber)
        )}
      </Alert>
    );
  if (delivery.error)
    return (
      <Alert variant="destructive">
        {t.prFailed} {delivery.error}
      </Alert>
    );
  return <Alert>{t.prOpening}</Alert>;
}
