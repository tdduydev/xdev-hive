import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import type { OrgMember, Plan, PlanContent, PlanDecision, Run, Task } from "@xdev-hive/contracts";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { PlanEditor } from "../components/plan-editor.tsx";
import { Alert } from "../components/ui/alert.tsx";
import { Button } from "../components/ui/button.tsx";
import { Card } from "../components/ui/card.tsx";
import { DescriptionList } from "../components/ui/description-list.tsx";
import { Dialog, DialogActions, DialogContent, DialogDescription, DialogTitle } from "../components/ui/dialog.tsx";
import { Pill } from "../components/ui/pill.tsx";
import { Textarea } from "../components/ui/textarea.tsx";
import { apiErrorMessage, formError } from "../lib/api-errors.ts";
import { cx } from "../lib/cx.ts";
import { formatDayTime } from "../lib/format.ts";
import { type Dict, useLang, useT } from "../lib/i18n.ts";
import {
  canDecidePlan,
  effectiveContent,
  fileChangeLabel,
  PLAN_STATUS_TONE,
  planStage,
  planStatusLabel,
  sameContent,
} from "../lib/plan-view.ts";
import { cliLabel, shortId } from "../lib/run-view.ts";
import { useOrg } from "../shell/org-context.ts";
import { PageBody, PageHeader } from "../shell/page-header.tsx";

const text: Dict<
  Record<
    | "member"
    | "submittedAt"
    | "planLog"
    | "stepsCount"
    | "versionsCount"
    | "version"
    | "submitted"
    | "approvedBy"
    | "rejectedBy"
    | "viewVersion"
    | "approveVersion"
    | "codeRunOf"
    | "queuedWith"
    | "yourDraft"
    | "editedVersion"
    | "submittedVersion"
    | "agentHas"
    | "answerQuestions"
    | "rejectVersion"
    | "waitingCodeRun"
    | "willCancel"
    | "notFound"
    | "notInTeam"
    | "openRun"
    | "approved"
    | "rejected"
    | "replanned"
    | "board"
    | "planCrumb"
    | "backToBoard"
    | "plan"
    | "loading"
    | "reject"
    | "edit"
    | "approve"
    | "emptyTitle"
    | "emptyDescription"
    | "viewOnly"
    | "details"
    | "draft"
    | "edited"
    | "versionLabel"
    | "submittedPlan"
    | "draftHint"
    | "discard"
    | "summary"
    | "steps"
    | "files"
    | "emptyFiles"
    | "risks"
    | "emptyRisks"
    | "questions"
    | "emptyQuestions"
    | "questionHint"
    | "info"
    | "revision"
    | "status"
    | "planRun"
    | "codeRun"
    | "reviewer"
    | "rejecter"
    | "at"
    | "reason"
    | "note"
    | "history"
    | "viewing"
    | "approvalNote"
    | "approvalPlaceholder"
    | "back"
    | "approving"
    | "approveRun"
    | "reasonRequired"
    | "rejectReason"
    | "rejectPlaceholder"
    | "replan"
    | "replanHint"
    | "rejecting"
    | "rejectPlan",
    string
  >
> = {
  vi: {
    member: "một thành viên",
    submittedAt: "nộp lúc",
    planLog: "Log run lập kế hoạch",
    stepsCount: "bước",
    versionsCount: "lần",
    version: "Lần",
    submitted: "nộp",
    approvedBy: "duyệt bởi",
    rejectedBy: "từ chối bởi",
    viewVersion: "Xem kế hoạch lần",
    approveVersion: "Duyệt kế hoạch lần",
    codeRunOf: "Run code của",
    queuedWith: "vào hàng ngay và agent làm theo",
    yourDraft: "bản bạn vừa sửa",
    editedVersion: "bản đã sửa",
    submittedVersion: "kế hoạch agent nộp",
    agentHas: "Agent có",
    answerQuestions: "câu hỏi; trả lời trong ghi chú:",
    rejectVersion: "Từ chối kế hoạch lần",
    waitingCodeRun: "Run code đang chờ kế hoạch của",
    willCancel: "sẽ bị huỷ.",
    notFound: "Không tìm thấy việc",
    notInTeam: ", hoặc bạn không ở trong đội sở hữu việc này.",
    openRun: "Mở run",
    approved: "Đã duyệt kế hoạch. Run code đã vào hàng và sẽ làm theo kế hoạch.",
    rejected: "Đã từ chối kế hoạch. Việc quay về chưa giao.",
    replanned: "Đã từ chối kế hoạch. Agent đang lập lại kế hoạch có tính tới lý do của bạn.",
    board: "Bảng việc",
    planCrumb: " / Kế hoạch",
    backToBoard: "Về bảng việc",
    plan: "Kế hoạch",
    loading: "Đang tải…",
    reject: "Từ chối",
    edit: "Sửa kế hoạch",
    approve: "Duyệt kế hoạch",
    emptyTitle: "Chưa có kế hoạch",
    emptyDescription:
      "Việc này chưa có kế hoạch nào. Khi dự án bật plan mode, agent đọc code, lập kế hoạch rồi chờ người duyệt trước khi viết code.",
    viewOnly:
      "Bạn chỉ có quyền xem việc của đội này. Thành viên hoặc quản trị đội mới duyệt hay từ chối được kế hoạch.",
    details: "Thông tin kế hoạch",
    draft: "Bản bạn vừa sửa (chưa gửi)",
    edited: "Bản người duyệt đã sửa",
    versionLabel: "Bản kế hoạch đang xem",
    submittedPlan: "Bản agent nộp",
    draftHint: "Bản sửa được gửi khi bạn duyệt.",
    discard: "Bỏ bản sửa",
    summary: "Tóm tắt",
    steps: "Các bước",
    files: "File dự kiến đụng",
    emptyFiles: "Agent không liệt kê file nào.",
    risks: "Rủi ro",
    emptyRisks: "Agent không nêu rủi ro nào.",
    questions: "Câu hỏi cho người duyệt",
    emptyQuestions: "Agent không có câu hỏi nào.",
    questionHint: "Trả lời trong ô ghi chú khi duyệt; agent đọc ghi chú trước khi viết code.",
    info: "Thông tin",
    revision: "Lần lập",
    status: "Trạng thái",
    planRun: "Run lập",
    codeRun: "Run code",
    reviewer: "Người duyệt",
    rejecter: "Người từ chối",
    at: "Lúc",
    reason: "Lý do",
    note: "Ghi chú",
    history: "Các lần lập",
    viewing: "đang xem",
    approvalNote: "Ghi chú cho agent (không bắt buộc)",
    approvalPlaceholder: "Ví dụ: Làm tròn theo từng dòng hoá đơn; giữ nguyên API cũ.",
    back: "Quay lại",
    approving: "Đang duyệt…",
    approveRun: "Duyệt và chạy",
    reasonRequired: "Cần ghi lý do từ chối để agent biết phải lập lại thế nào.",
    rejectReason: "Lý do từ chối",
    rejectPlaceholder: "Ví dụ: Thiếu bước migration cho bảng hoá đơn cũ.",
    replan: "Lập lại kế hoạch",
    replanHint: "Agent lập kế hoạch mới, có đọc bản này và lý do của bạn. Không chọn thì việc quay về chưa giao.",
    rejecting: "Đang từ chối…",
    rejectPlan: "Từ chối kế hoạch",
  },
  en: {
    member: "a member",
    submittedAt: "submitted",
    planLog: "Planning run log",
    stepsCount: "steps",
    versionsCount: "versions",
    version: "Version",
    submitted: "submitted",
    approvedBy: "approved by",
    rejectedBy: "rejected by",
    viewVersion: "View version",
    approveVersion: "Approve version",
    codeRunOf: "The code run for",
    queuedWith: "is queued now and the agent follows",
    yourDraft: "your edited draft",
    editedVersion: "the edited version",
    submittedVersion: "the submitted plan",
    agentHas: "The agent asked",
    answerQuestions: "questions; answer them in the note:",
    rejectVersion: "Reject version",
    waitingCodeRun: "The code run waiting on the plan for",
    willCancel: "will be cancelled.",
    notFound: "Cannot find task",
    notInTeam: ", or you are not in the team that owns it.",
    openRun: "Open run",
    approved: "Plan approved. The code run is queued and will follow it.",
    rejected: "Plan rejected. The task is unassigned again.",
    replanned: "Plan rejected. The agent is planning again with your reason in mind.",
    board: "Board",
    planCrumb: " / Plan",
    backToBoard: "Back to board",
    plan: "Plan",
    loading: "Loading…",
    reject: "Reject",
    edit: "Edit plan",
    approve: "Approve plan",
    emptyTitle: "No plan yet",
    emptyDescription:
      "This task has no plan yet. With plan mode enabled, the agent reads the code and waits for approval before writing code.",
    viewOnly: "You can only view this team’s tasks. A team member or admin can approve or reject the plan.",
    details: "Plan details",
    draft: "Your edited draft (not submitted)",
    edited: "Reviewer’s edited version",
    versionLabel: "Plan version shown",
    submittedPlan: "Submitted version",
    draftHint: "Your edits are submitted on approval.",
    discard: "Discard edits",
    summary: "Summary",
    steps: "Steps",
    files: "Files it expects to touch",
    emptyFiles: "The agent listed no files.",
    risks: "Risks",
    emptyRisks: "The agent listed no risks.",
    questions: "Questions for the reviewer",
    emptyQuestions: "The agent has no questions.",
    questionHint: "Answer in the note when you approve; the agent reads it before writing code.",
    info: "Details",
    revision: "Version",
    status: "Status",
    planRun: "Planning run",
    codeRun: "Code run",
    reviewer: "Approved by",
    rejecter: "Rejected by",
    at: "At",
    reason: "Reason",
    note: "Note",
    history: "Versions",
    viewing: "viewing",
    approvalNote: "Note for the agent (optional)",
    approvalPlaceholder: "e.g. Round each invoice line; keep the existing API.",
    back: "Back",
    approving: "Approving…",
    approveRun: "Approve and run",
    reasonRequired: "Give a reason so the agent knows how to plan again.",
    rejectReason: "Reason for rejecting",
    rejectPlaceholder: "e.g. Missing a migration for the old invoices table.",
    replan: "Plan again",
    replanHint:
      "The agent writes a new plan using this one and your reason. Otherwise, the task returns to unassigned.",
    rejecting: "Rejecting…",
    rejectPlan: "Reject plan",
  },
};

/** Đang chờ người hay chờ agent thì tự làm mới, để người duyệt thấy kế hoạch mới mà không phải tải lại trang. */
const REFRESH_MS = 15_000;

/** Task theo key; key chép lúc tạo nên có thể trùng sau khi dự án đổi key, lấy task mới nhất như hub (taskByKey). */
function taskByKey(tasks: Task[] | undefined, key: string): Task | undefined {
  return tasks?.filter((t) => t.key === key).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

/** /tasks/$key/plan: kế hoạch agent lập cho task, lịch sử các lần lập, duyệt hay từ chối. */
export function PlanPage() {
  const t = useT(text);
  const { key } = useParams({ from: "/session/app/in-org/tasks/$key/plan" });
  const { api } = useOrg();
  // Cùng khoá cache với bảng việc chung, nên mở từ bảng việc không tải lại danh sách task.
  const tasks = useQuery(api.tasks.list.queryOptions({ input: {} }));
  const task = taskByKey(tasks.data, key);

  const crumb = (
    <>
      <Link to="/tasks" className="text-primary hover:text-primary/90">
        {t.board}
      </Link>
      {" / "}
      <span className="font-mono">{key}</span>
      {t.planCrumb}
    </>
  );

  if (tasks.isPending) return <Shell crumb={crumb} body={<Loading />} />;
  if (tasks.isError || !task) {
    return (
      <Shell
        crumb={crumb}
        body={
          <>
            <Alert variant="destructive">
              {tasks.isError ? apiErrorMessage(tasks.error) : `${t.notFound} ${key}${t.notInTeam}`}
            </Alert>
            <Link to="/tasks" className="text-primary hover:text-primary/90">
              {t.backToBoard}
            </Link>
          </>
        }
      />
    );
  }
  return <TaskPlan task={task} crumb={crumb} />;
}

function Shell({ crumb, title, body }: { crumb: ReactNode; title?: string; body: ReactNode }) {
  const t = useT(text);
  return (
    <>
      <PageHeader crumb={crumb} title={title ?? t.plan} />
      <PageBody>{body}</PageBody>
    </>
  );
}

function Loading() {
  const t = useT(text);
  return (
    <div aria-busy="true" className="grid gap-3">
      <span className="sr-only">{t.loading}</span>
      <div className="h-6 w-1/3 rounded bg-muted" />
      <div className="h-40 rounded-xl bg-muted" />
      <div className="h-24 rounded-xl bg-muted" />
    </div>
  );
}

type Outcome = { kind: "approved" | "rejected" | "replanned"; run: Run };

function TaskPlan({ task, crumb }: { task: Task; crumb: ReactNode }) {
  const t = useT(text);
  const lang = useLang();
  const { api } = useOrg();
  const runs = useQuery(
    api.runs.latest.queryOptions({ input: { projectId: task.projectId }, refetchInterval: REFRESH_MS }),
  );
  const run = runs.data?.find((r) => r.taskId === task.id) ?? null;
  const history = useQuery(
    api.tasks.plans.list.queryOptions({
      input: { id: task.id },
      // Chỉ tự làm mới khi còn đợi: agent đang lập, hoặc kế hoạch đang chờ người khác duyệt.
      refetchInterval: (q) =>
        run?.state === "planning" || q.state.data?.plans[0]?.status === "awaiting" ? REFRESH_MS : false,
    }),
  );
  const planRunId = history.data?.plans[0]?.planRunId;
  const planningRun = useQuery({
    ...api.runs.get.queryOptions({ input: { id: planRunId ?? "00000000-0000-4000-8000-000000000000" } }),
    enabled: Boolean(planRunId),
    retry: false,
  });
  // Chỉ để hiện tên người quyết; không đọc được (lỗi mạng, quyền) thì hiện chung chung, không chặn màn.
  const members = useQuery(api.orgMembers.list.queryOptions({ retry: false }));
  const [draft, setDraft] = useState<PlanContent | null>(null);
  const [editing, setEditing] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);
  const [dialog, setDialog] = useState<"approve" | "reject" | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  if (history.isPending) return <Shell crumb={crumb} title={task.title} body={<Loading />} />;
  if (history.isError) {
    return (
      <Shell
        crumb={crumb}
        title={task.title}
        body={<Alert variant="destructive">{apiErrorMessage(history.error)}</Alert>}
      />
    );
  }

  const { plans, canDecide } = history.data;
  const latest = plans[0];
  const stage = planStage(task, latest, run, lang);
  const decidable = canDecidePlan(latest, canDecide);
  const nameOf = (userId: string | null) => personName(members.data, userId, t.member);

  const header = (
    <PageHeader crumb={crumb} title={task.title}>
      {decidable && !editing && (
        <>
          <Button variant="destructive" onClick={() => setDialog("reject")} aria-haspopup="dialog">
            {t.reject}
          </Button>
          <Button variant="outline" onClick={() => setEditing(true)}>
            {t.edit}
          </Button>
          <Button variant="default" onClick={() => setDialog("approve")} aria-haspopup="dialog">
            {t.approve}
          </Button>
        </>
      )}
    </PageHeader>
  );

  if (!latest) {
    return (
      <>
        {header}
        <PageBody>
          <Card className="grid justify-items-center gap-2 px-6 py-10 text-center">
            <h2 className="text-base font-semibold text-foreground">{t.emptyTitle}</h2>
            <p className="max-w-md text-muted-foreground">{stage ?? t.emptyDescription}</p>
          </Card>
        </PageBody>
      </>
    );
  }

  const shown = showOriginal ? latest.content : (draft ?? effectiveContent(latest));
  const settled = (o: Outcome) => {
    setDialog(null);
    setDraft(null);
    setShowOriginal(false);
    setOutcome(o);
  };

  return (
    <>
      {header}
      <PageBody>
        {outcome && (
          <p role="status" className="rounded-lg bg-success-soft px-3.5 py-2.5 text-sm text-success">
            {t[outcome.kind]}{" "}
            <Link to="/runs/$id" params={{ id: outcome.run.id }} className="font-medium underline">
              {t.openRun} {shortId(outcome.run.id)}
            </Link>
          </p>
        )}
        <PlanMeta plan={latest} />
        {stage && (
          <Alert
            role="status"
            className={latest.status === "awaiting" ? "border-transparent bg-accent text-accent-foreground" : undefined}
            variant={latest.status === "rejected" ? "destructive" : "default"}
          >
            {stage}
          </Alert>
        )}
        {latest.status === "awaiting" && !canDecide && (
          <p className="rounded-lg border border-border bg-muted px-3.5 py-2.5 text-sm text-foreground">{t.viewOnly}</p>
        )}
        <div className="grid items-start gap-5 app:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <div className="grid min-w-0 gap-4">
            {editing ? (
              <PlanEditor
                initial={draft ?? effectiveContent(latest)}
                onCancel={() => setEditing(false)}
                onSave={(content) => {
                  // Sửa xong mà không khác bản đang hiệu lực thì coi như không sửa, duyệt nguyên bản.
                  setDraft(sameContent(content, effectiveContent(latest)) ? null : content);
                  setShowOriginal(false);
                  setEditing(false);
                }}
              />
            ) : (
              <>
                <VersionSwitch
                  plan={latest}
                  draft={draft}
                  showOriginal={showOriginal}
                  onShowOriginal={setShowOriginal}
                  onDiscardDraft={() => setDraft(null)}
                />
                <PlanContentView content={shown} />
              </>
            )}
          </div>
          <aside aria-label={t.details} className="grid min-w-0 gap-4">
            <DecisionCard plan={latest} planningRun={planningRun.data} nameOf={nameOf} />
            <HistoryCard plans={plans} nameOf={nameOf} />
          </aside>
        </div>
      </PageBody>
      <Dialog open={dialog === "approve"} onOpenChange={(open) => setDialog(open ? "approve" : null)}>
        <DialogContent>
          <ApproveConfirm
            task={task}
            plan={latest}
            draft={draft}
            onCancel={() => setDialog(null)}
            onDone={(d) => settled({ kind: "approved", run: d.run })}
          />
        </DialogContent>
      </Dialog>
      <Dialog open={dialog === "reject"} onOpenChange={(open) => setDialog(open ? "reject" : null)}>
        <DialogContent>
          <RejectConfirm
            task={task}
            plan={latest}
            onCancel={() => setDialog(null)}
            onDone={(d, replan) => settled({ kind: replan ? "replanned" : "rejected", run: d.run })}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

function personName(members: OrgMember[] | undefined, userId: string | null, fallback: string): string {
  if (!userId) return "—";
  return members?.find((m) => m.userId === userId)?.name ?? fallback;
}

function PlanMeta({ plan }: { plan: Plan }) {
  const t = useT(text);
  const lang = useLang();
  return (
    <div className="flex flex-wrap items-center gap-2.5 text-xs text-muted-foreground">
      <Pill tone={PLAN_STATUS_TONE[plan.status]} dot>
        {planStatusLabel(plan.status, lang)}
      </Pill>
      <span>
        {t.revision} {plan.revision}
      </span>
      <span>
        {t.submittedAt} <time dateTime={plan.createdAt}>{formatDayTime(plan.createdAt)}</time>
      </span>
      <Link to="/runs/$id" params={{ id: plan.planRunId }} className="text-primary hover:text-primary/90">
        {t.planLog} <span className="font-mono">{shortId(plan.planRunId)}</span>
      </Link>
    </div>
  );
}

/** Chọn xem bản nào khi có hơn một bản: bản sửa chưa gửi, bản người duyệt đã sửa, hay bản agent nộp. */
function VersionSwitch({
  plan,
  draft,
  showOriginal,
  onShowOriginal,
  onDiscardDraft,
}: {
  plan: Plan;
  draft: PlanContent | null;
  showOriginal: boolean;
  onShowOriginal: (v: boolean) => void;
  onDiscardDraft: () => void;
}) {
  const t = useT(text);
  if (!draft && !plan.editedContent) return null;
  const current = draft ? t.draft : t.edited;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <fieldset className="contents">
        <legend className="sr-only">{t.versionLabel}</legend>
        <Button
          size="sm"
          variant={showOriginal ? "ghost" : "outline"}
          aria-pressed={!showOriginal}
          onClick={() => onShowOriginal(false)}
        >
          {current}
        </Button>
        <Button
          size="sm"
          variant={showOriginal ? "outline" : "ghost"}
          aria-pressed={showOriginal}
          onClick={() => onShowOriginal(true)}
        >
          {t.submittedPlan}
        </Button>
      </fieldset>
      {draft && (
        <>
          <span className="text-xs text-muted-foreground">{t.draftHint}</span>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={onDiscardDraft}>
            {t.discard}
          </Button>
        </>
      )}
    </div>
  );
}

function Section({
  title,
  aside,
  children,
  warning = false,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
  warning?: boolean;
}) {
  const headingId = useId();
  return (
    <Card className={cx("py-0", warning && "ring-warning")}>
      <section aria-labelledby={headingId} className="grid gap-3 px-4 py-4 sm:px-5">
        <div className="-mx-4 -mt-4 flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-4 py-3 sm:-mx-5 sm:px-5">
          <h2 id={headingId} className="text-base font-semibold text-foreground">
            {title}
          </h2>
          {aside}
        </div>
        {children}
      </section>
    </Card>
  );
}

const Empty = ({ children }: { children: ReactNode }) => <p className="text-muted-foreground">{children}</p>;

export function PlanContentView({ content }: { content: PlanContent }) {
  const t = useT(text);
  const lang = useLang();
  return (
    <>
      <Section title={t.summary}>
        <p className="whitespace-pre-wrap break-words text-foreground">{content.summary}</p>
      </Section>
      <Section
        title={t.steps}
        aside={
          <span className="text-xs text-muted-foreground">
            {content.steps.length} {t.stepsCount}
          </span>
        }
      >
        <ol className="grid gap-2.5">
          {content.steps.map((s, i) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: thứ tự bước là một phần nội dung, không đổi khi đang xem.
              key={i}
              className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-3 border-b border-dashed border-border py-2 last:border-0"
            >
              <span className="grid size-6 place-items-center rounded-full bg-foreground text-xs font-semibold text-background tabular-nums">
                {i + 1}
              </span>
              <span className="grid gap-0.5">
                <span className="font-medium break-words text-foreground">{s.title}</span>
                {s.detail && (
                  <span className="whitespace-pre-wrap break-words text-sm text-foreground">{s.detail}</span>
                )}
              </span>
            </li>
          ))}
        </ol>
      </Section>
      <Section
        title={t.files}
        aside={<span className="text-xs text-muted-foreground">{content.files.length} file</span>}
      >
        {content.files.length === 0 ? (
          <Empty>{t.emptyFiles}</Empty>
        ) : (
          <ul className="grid gap-2">
            {content.files.map((f, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: danh sách chỉ đọc, có thể trùng đường dẫn.
              <li key={i} className="grid gap-0.5 border-b border-border py-2 last:border-0">
                <span className="flex flex-wrap items-center gap-2">
                  {f.change && (
                    <Pill tone={f.change === "delete" ? "bad" : f.change === "add" ? "ok" : "sel"}>
                      {fileChangeLabel(f.change, lang)}
                    </Pill>
                  )}
                  <span className="font-mono text-xs break-all text-foreground">{f.path}</span>
                </span>
                {f.reason && <span className="break-words text-sm text-muted-foreground">{f.reason}</span>}
              </li>
            ))}
          </ul>
        )}
      </Section>
      <div className="grid gap-4 xl:grid-cols-2">
        <Section title={t.risks}>
          {content.risks.length === 0 ? (
            <Empty>{t.emptyRisks}</Empty>
          ) : (
            <ul className="grid list-disc gap-1.5 pl-5">
              {content.risks.map((r, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: danh sách chỉ đọc.
                <li key={i} className="whitespace-pre-wrap break-words text-foreground">
                  {r}
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section
          title={t.questions}
          warning={content.questions.length > 0}
          aside={content.questions.length > 0 ? <Pill tone="warn">{content.questions.length}</Pill> : undefined}
        >
          {content.questions.length === 0 ? (
            <Empty>{t.emptyQuestions}</Empty>
          ) : (
            <>
              <ol className="grid list-decimal gap-1.5 pl-5">
                {content.questions.map((q, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: danh sách chỉ đọc.
                  <li key={i} className="whitespace-pre-wrap break-words text-foreground">
                    {q}
                  </li>
                ))}
              </ol>
              <p className="text-xs text-muted-foreground">{t.questionHint}</p>
            </>
          )}
        </Section>
      </div>
    </>
  );
}

function DecisionCard({
  plan,
  planningRun,
  nameOf,
}: {
  plan: Plan;
  planningRun: Run | undefined;
  nameOf: (id: string | null) => string;
}) {
  const t = useT(text);
  const lang = useLang();
  return (
    <Section title={t.info}>
      <DescriptionList
        items={[
          { term: t.revision, detail: String(plan.revision) },
          { term: t.status, detail: planStatusLabel(plan.status, lang) },
          {
            term: t.planRun,
            detail: (
              <Link to="/runs/$id" params={{ id: plan.planRunId }} className="text-primary hover:text-primary/90">
                {shortId(plan.planRunId)}
              </Link>
            ),
            mono: true,
          },
          {
            term: t.codeRun,
            detail: (
              <Link to="/runs/$id" params={{ id: plan.runId }} className="text-primary hover:text-primary/90">
                {shortId(plan.runId)}
              </Link>
            ),
            mono: true,
          },
          ...(planningRun
            ? [
                {
                  term: "Agent",
                  detail: `${cliLabel(planningRun.cli)}${planningRun.machineName ? ` · ${planningRun.machineName}` : ""}`,
                },
              ]
            : []),
          ...(plan.decidedAt
            ? [
                { term: plan.status === "approved" ? t.reviewer : t.rejecter, detail: nameOf(plan.decidedBy) },
                { term: t.at, detail: formatDayTime(plan.decidedAt) },
              ]
            : []),
          ...(plan.note ? [{ term: plan.status === "rejected" ? t.reason : t.note, detail: plan.note }] : []),
        ]}
      />
    </Section>
  );
}

function HistoryCard({ plans, nameOf }: { plans: Plan[]; nameOf: (id: string | null) => string }) {
  const t = useT(text);
  const lang = useLang();
  return (
    <Section
      title={t.history}
      aside={
        <span className="text-xs text-muted-foreground">
          {plans.length} {t.versionsCount}
        </span>
      }
    >
      <ol className="grid gap-3">
        {plans.map((p, i) => (
          <li key={p.id} className={cx("grid gap-1 border-l-2 pl-3", i === 0 ? "border-primary" : "border-border")}>
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-foreground">
                {t.version} {p.revision}
              </span>
              <Pill tone={PLAN_STATUS_TONE[p.status]}>{planStatusLabel(p.status, lang)}</Pill>
              {i === 0 && <span className="text-xs text-muted-foreground">{t.viewing}</span>}
            </span>
            <span className="text-xs text-muted-foreground">
              {t.submitted} <time dateTime={p.createdAt}>{formatDayTime(p.createdAt)}</time>
              {p.decidedAt && (
                <>
                  {" · "}
                  {p.status === "approved" ? t.approvedBy : t.rejectedBy} {nameOf(p.decidedBy)}
                </>
              )}
            </span>
            {p.note && (
              <span
                className={cx("break-words text-sm", p.status === "rejected" ? "text-destructive" : "text-foreground")}
              >
                {p.status === "rejected" ? `${t.reason}: ` : `${t.note}: `}
                {p.note}
              </span>
            )}
            <Link to="/runs/$id" params={{ id: p.planRunId }} className="text-sm text-primary hover:text-primary/90">
              {t.planLog}
            </Link>
            {i > 0 && (
              <details className="text-sm">
                <summary className="cursor-pointer text-primary hover:text-primary/90">
                  {t.viewVersion} {p.revision}
                </summary>
                <div className="mt-1.5 grid gap-1.5 rounded-lg bg-muted px-3 py-2">
                  <p className="whitespace-pre-wrap break-words text-foreground">{effectiveContent(p).summary}</p>
                  <ol className="grid list-decimal gap-0.5 pl-5 text-foreground">
                    {effectiveContent(p).steps.map((s, j) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: danh sách chỉ đọc.
                      <li key={j} className="break-words">
                        {s.title}
                      </li>
                    ))}
                  </ol>
                </div>
              </details>
            )}
          </li>
        ))}
      </ol>
    </Section>
  );
}

function ApproveConfirm({
  task,
  plan,
  draft,
  onCancel,
  onDone,
}: {
  task: Task;
  plan: Plan;
  draft: PlanContent | null;
  onCancel: () => void;
  onDone: (d: PlanDecision) => void;
}) {
  const t = useT(text);
  const { api } = useOrg();
  const queryClient = useQueryClient();
  const noteId = useId();
  const [error, setError] = useState<string | null>(null);
  // Câu hỏi của bản sẽ được duyệt: người duyệt có thể đã thêm hay bớt câu hỏi khi sửa.
  const questions = (draft ?? effectiveContent(plan)).questions;
  const approve = useMutation({
    mutationFn: (note: string) =>
      api.tasks.plans.approve.call({
        id: task.id,
        planId: plan.id,
        ...(note ? { note } : {}),
        ...(draft ? { content: draft } : {}),
      }),
    onSuccess: onDone,
    onError: (e) => setError(formError(e).message),
    // Thành công hay hỏng (vd. người khác vừa quyết) đều tải lại để màn sau đóng dialog là bản mới nhất.
    onSettled: () => invalidatePlanViews(queryClient, api),
  });

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    approve.mutate(String(new FormData(e.currentTarget).get("note") ?? "").trim());
  }

  return (
    <form noValidate onSubmit={onSubmit} className="grid gap-3.5">
      <DialogTitle>
        {t.approveVersion} {plan.revision}?
      </DialogTitle>
      <DialogDescription>
        {t.codeRunOf} <span className="font-mono">{task.key}</span> {t.queuedWith}{" "}
        {draft ? t.yourDraft : plan.editedContent ? t.editedVersion : t.submittedVersion}.
      </DialogDescription>
      {questions.length > 0 && (
        <div className="grid gap-1 rounded-lg bg-warning-soft px-3.5 py-2.5 text-sm text-warning">
          <span className="font-medium">
            {t.agentHas} {questions.length} {t.answerQuestions}
          </span>
          <ol className="grid list-decimal gap-0.5 pl-5">
            {questions.map((q, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: danh sách chỉ đọc.
              <li key={i} className="break-words">
                {q}
              </li>
            ))}
          </ol>
        </div>
      )}
      <div className="grid gap-1.5">
        <label htmlFor={noteId} className="text-sm font-medium text-foreground">
          {t.approvalNote}
        </label>
        <Textarea
          id={noteId}
          name="note"
          rows={4}
          maxLength={10_000}
          disabled={approve.isPending}
          placeholder={t.approvalPlaceholder}
        />
      </div>
      {error && <Alert variant="destructive">{error}</Alert>}
      <DialogActions>
        <Button variant="outline" onClick={onCancel}>
          {t.back}
        </Button>
        <Button type="submit" variant="default" disabled={approve.isPending}>
          {approve.isPending ? t.approving : t.approveRun}
        </Button>
      </DialogActions>
    </form>
  );
}

function RejectConfirm({
  task,
  plan,
  onCancel,
  onDone,
}: {
  task: Task;
  plan: Plan;
  onCancel: () => void;
  onDone: (d: PlanDecision, replan: boolean) => void;
}) {
  const t = useT(text);
  const { api } = useOrg();
  const queryClient = useQueryClient();
  const reasonId = useId();
  const reasonErrorId = useId();
  const replanId = useId();
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reject = useMutation({
    mutationFn: (input: { reason: string; replan: boolean }) =>
      api.tasks.plans.reject.call({ id: task.id, planId: plan.id, ...input }),
    onSuccess: (d, input) => onDone(d, input.replan),
    onError: (e) => {
      const f = formError(e);
      if (f.field === "reason") setReasonError(f.message);
      else setError(f.message);
    },
    onSettled: () => invalidatePlanViews(queryClient, api),
  });

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const reason = String(form.get("reason") ?? "").trim();
    setError(null);
    if (!reason) {
      setReasonError(t.reasonRequired);
      return;
    }
    setReasonError(null);
    reject.mutate({ reason, replan: form.get("replan") === "on" });
  }

  return (
    <form noValidate onSubmit={onSubmit} className="grid gap-3.5">
      <DialogTitle>
        {t.rejectVersion} {plan.revision}?
      </DialogTitle>
      <DialogDescription>
        {t.waitingCodeRun} <span className="font-mono">{task.key}</span> {t.willCancel}
      </DialogDescription>
      <div className="grid gap-1.5">
        <label htmlFor={reasonId} className="text-sm font-medium text-foreground">
          {t.rejectReason}
        </label>
        <Textarea
          id={reasonId}
          name="reason"
          rows={4}
          maxLength={10_000}
          disabled={reject.isPending}
          aria-invalid={reasonError ? true : undefined}
          aria-describedby={reasonError ? reasonErrorId : undefined}
          placeholder={t.rejectPlaceholder}
          autoFocus
        />
        {reasonError && (
          <p id={reasonErrorId} className="text-xs text-destructive">
            {reasonError}
          </p>
        )}
      </div>
      <label htmlFor={replanId} className="flex items-start gap-2 text-sm text-foreground">
        <input
          id={replanId}
          type="checkbox"
          name="replan"
          disabled={reject.isPending}
          className="mt-0.5 size-4 accent-accent"
        />
        <span className="grid gap-0.5">
          <span>{t.replan}</span>
          <span className="text-xs text-muted-foreground">{t.replanHint}</span>
        </span>
      </label>
      {error && <Alert variant="destructive">{error}</Alert>}
      <DialogActions>
        <Button variant="outline" onClick={onCancel}>
          {t.back}
        </Button>
        <Button type="submit" variant="destructive-solid" disabled={reject.isPending}>
          {reject.isPending ? t.rejecting : t.rejectPlan}
        </Button>
      </DialogActions>
    </form>
  );
}

function invalidatePlanViews(queryClient: ReturnType<typeof useQueryClient>, api: ReturnType<typeof useOrg>["api"]) {
  return Promise.all([api.tasks.key(), api.runs.key()].map((queryKey) => queryClient.invalidateQueries({ queryKey })));
}
