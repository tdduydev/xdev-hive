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
import {
  canDecidePlan,
  effectiveContent,
  FILE_CHANGE_LABEL,
  PLAN_STATUS_LABEL,
  PLAN_STATUS_TONE,
  planStage,
  sameContent,
} from "../lib/plan-view.ts";
import { shortId } from "../lib/run-view.ts";
import { useOrg } from "../shell/org-context.ts";
import { PageBody, PageHeader } from "../shell/page-header.tsx";

/** Đang chờ người hay chờ agent thì tự làm mới, để người duyệt thấy kế hoạch mới mà không phải tải lại trang. */
const REFRESH_MS = 15_000;

/** Task theo key; key chép lúc tạo nên có thể trùng sau khi dự án đổi key, lấy task mới nhất như hub (taskByKey). */
function taskByKey(tasks: Task[] | undefined, key: string): Task | undefined {
  return tasks?.filter((t) => t.key === key).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

/** /tasks/$key/plan: kế hoạch agent lập cho task, lịch sử các lần lập, duyệt hay từ chối. */
export function PlanPage() {
  const { key } = useParams({ from: "/session/app/in-org/tasks/$key/plan" });
  const { api } = useOrg();
  // Cùng khoá cache với bảng việc chung, nên mở từ bảng việc không tải lại danh sách task.
  const tasks = useQuery(api.tasks.list.queryOptions({ input: {} }));
  const task = taskByKey(tasks.data, key);

  const crumb = (
    <>
      <Link to="/tasks" className="text-accent hover:text-accent-hover">
        Bảng việc
      </Link>
      {" / "}
      <span className="font-mono">{key}</span>
      {" / Kế hoạch"}
    </>
  );

  if (tasks.isPending) return <Shell crumb={crumb} body={<Loading />} />;
  if (tasks.isError || !task) {
    return (
      <Shell
        crumb={crumb}
        body={
          <>
            <Alert>
              {tasks.isError
                ? apiErrorMessage(tasks.error)
                : `Không tìm thấy việc ${key}, hoặc bạn không ở trong đội sở hữu việc này.`}
            </Alert>
            <Link to="/tasks" className="text-accent hover:text-accent-hover">
              Về bảng việc
            </Link>
          </>
        }
      />
    );
  }
  return <TaskPlan task={task} crumb={crumb} />;
}

function Shell({ crumb, title = "Kế hoạch", body }: { crumb: ReactNode; title?: string; body: ReactNode }) {
  return (
    <>
      <PageHeader crumb={crumb} title={title} />
      <PageBody>{body}</PageBody>
    </>
  );
}

function Loading() {
  return (
    <div aria-busy="true" className="grid gap-3">
      <span className="sr-only">Đang tải…</span>
      <div className="h-6 w-1/3 rounded bg-subtle" />
      <div className="h-40 rounded-xl bg-subtle" />
      <div className="h-24 rounded-xl bg-subtle" />
    </div>
  );
}

type Outcome = { kind: "approved" | "rejected" | "replanned"; run: Run };

const OUTCOME_TEXT: Record<Outcome["kind"], string> = {
  approved: "Đã duyệt kế hoạch. Run code đã vào hàng và sẽ làm theo kế hoạch.",
  rejected: "Đã từ chối kế hoạch. Việc quay về chưa giao.",
  replanned: "Đã từ chối kế hoạch. Agent đang lập lại kế hoạch có tính tới lý do của bạn.",
};

function TaskPlan({ task, crumb }: { task: Task; crumb: ReactNode }) {
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
  // Chỉ để hiện tên người quyết; không đọc được (lỗi mạng, quyền) thì hiện chung chung, không chặn màn.
  const members = useQuery(api.orgMembers.list.queryOptions({ retry: false }));
  const [draft, setDraft] = useState<PlanContent | null>(null);
  const [editing, setEditing] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);
  const [dialog, setDialog] = useState<"approve" | "reject" | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  if (history.isPending) return <Shell crumb={crumb} title={task.title} body={<Loading />} />;
  if (history.isError) {
    return <Shell crumb={crumb} title={task.title} body={<Alert>{apiErrorMessage(history.error)}</Alert>} />;
  }

  const { plans, canDecide } = history.data;
  const latest = plans[0];
  const stage = planStage(task, latest, run);
  const decidable = canDecidePlan(latest, canDecide);
  const nameOf = (userId: string | null) => personName(members.data, userId);

  const header = (
    <PageHeader crumb={crumb} title={task.title}>
      {decidable && !editing && (
        <>
          <Button variant="danger" onClick={() => setDialog("reject")} aria-haspopup="dialog">
            Từ chối
          </Button>
          <Button onClick={() => setEditing(true)}>Sửa kế hoạch</Button>
          <Button variant="primary" onClick={() => setDialog("approve")} aria-haspopup="dialog">
            Duyệt kế hoạch
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
            <h2 className="text-lg font-semibold text-ink">Chưa có kế hoạch</h2>
            <p className="max-w-md text-muted">
              {stage ??
                "Việc này chưa có kế hoạch nào. Khi dự án bật plan mode, agent đọc code, lập kế hoạch rồi chờ người duyệt trước khi viết code."}
            </p>
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
          <p role="status" className="rounded-lg bg-ok-bg px-3.5 py-2.5 text-label text-ok">
            {OUTCOME_TEXT[outcome.kind]}{" "}
            <Link to="/runs/$id" params={{ id: outcome.run.id }} className="font-medium underline">
              Mở run {shortId(outcome.run.id)}
            </Link>
          </p>
        )}
        <PlanMeta plan={latest} />
        {stage && <p className="text-muted">{stage}</p>}
        {latest.status === "awaiting" && !canDecide && (
          <p className="rounded-lg border border-line bg-sunken px-3.5 py-2.5 text-label text-body">
            Bạn chỉ có quyền xem việc của đội này. Thành viên hoặc quản trị đội mới duyệt hay từ chối được kế hoạch.
          </p>
        )}
        <div className="grid items-start gap-5 app:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
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
          <aside aria-label="Thông tin kế hoạch" className="grid min-w-0 gap-4">
            <DecisionCard plan={latest} nameOf={nameOf} />
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

function personName(members: OrgMember[] | undefined, userId: string | null): string {
  if (!userId) return "—";
  return members?.find((m) => m.userId === userId)?.name ?? "một thành viên";
}

function PlanMeta({ plan }: { plan: Plan }) {
  return (
    <div className="flex flex-wrap items-center gap-2.5 text-sm text-muted">
      <Pill tone={PLAN_STATUS_TONE[plan.status]} dot>
        {PLAN_STATUS_LABEL[plan.status]}
      </Pill>
      <span>Lần lập {plan.revision}</span>
      <span>
        nộp lúc <time dateTime={plan.createdAt}>{formatDayTime(plan.createdAt)}</time>
      </span>
      <Link to="/runs/$id" params={{ id: plan.planRunId }} className="text-accent hover:text-accent-hover">
        Log run lập kế hoạch <span className="font-mono">{shortId(plan.planRunId)}</span>
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
  if (!draft && !plan.editedContent) return null;
  const current = draft ? "Bản bạn vừa sửa (chưa gửi)" : "Bản người duyệt đã sửa";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <fieldset className="contents">
        <legend className="sr-only">Bản kế hoạch đang xem</legend>
        <Button
          size="sm"
          variant={showOriginal ? "ghost" : "default"}
          aria-pressed={!showOriginal}
          onClick={() => onShowOriginal(false)}
        >
          {current}
        </Button>
        <Button
          size="sm"
          variant={showOriginal ? "default" : "ghost"}
          aria-pressed={showOriginal}
          onClick={() => onShowOriginal(true)}
        >
          Bản agent nộp
        </Button>
      </fieldset>
      {draft && (
        <>
          <span className="text-xs text-muted">Bản sửa được gửi khi bạn duyệt.</span>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={onDiscardDraft}>
            Bỏ bản sửa
          </Button>
        </>
      )}
    </div>
  );
}

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  const headingId = useId();
  return (
    <Card>
      <section aria-labelledby={headingId} className="grid gap-2.5 px-5 py-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id={headingId} className="text-lg font-semibold text-ink">
            {title}
          </h2>
          {aside}
        </div>
        {children}
      </section>
    </Card>
  );
}

const Empty = ({ children }: { children: ReactNode }) => <p className="text-muted">{children}</p>;

export function PlanContentView({ content }: { content: PlanContent }) {
  return (
    <>
      <Section title="Tóm tắt">
        <p className="whitespace-pre-wrap break-words text-body">{content.summary}</p>
      </Section>
      <Section title="Các bước" aside={<span className="text-xs text-muted">{content.steps.length} bước</span>}>
        <ol className="grid gap-2.5">
          {content.steps.map((s, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: thứ tự bước là một phần nội dung, không đổi khi đang xem.
            <li key={i} className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-2">
              <span className="grid size-6 place-items-center rounded-full bg-sel text-xs font-semibold text-sel-fg tabular-nums">
                {i + 1}
              </span>
              <span className="grid gap-0.5">
                <span className="font-medium break-words text-ink">{s.title}</span>
                {s.detail && <span className="whitespace-pre-wrap break-words text-label text-body">{s.detail}</span>}
              </span>
            </li>
          ))}
        </ol>
      </Section>
      <Section
        title="File dự kiến đụng"
        aside={<span className="text-xs text-muted">{content.files.length} file</span>}
      >
        {content.files.length === 0 ? (
          <Empty>Agent không liệt kê file nào.</Empty>
        ) : (
          <ul className="grid gap-2">
            {content.files.map((f, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: danh sách chỉ đọc, có thể trùng đường dẫn.
              <li key={i} className="grid gap-0.5">
                <span className="flex flex-wrap items-center gap-2">
                  {f.change && (
                    <Pill tone={f.change === "delete" ? "bad" : "neutral"}>{FILE_CHANGE_LABEL[f.change]}</Pill>
                  )}
                  <span className="font-mono text-sm break-all text-ink">{f.path}</span>
                </span>
                {f.reason && <span className="break-words text-label text-muted">{f.reason}</span>}
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="Rủi ro">
        {content.risks.length === 0 ? (
          <Empty>Agent không nêu rủi ro nào.</Empty>
        ) : (
          <ul className="grid list-disc gap-1.5 pl-5">
            {content.risks.map((r, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: danh sách chỉ đọc.
              <li key={i} className="whitespace-pre-wrap break-words text-body">
                {r}
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="Câu hỏi cho người duyệt">
        {content.questions.length === 0 ? (
          <Empty>Agent không có câu hỏi nào.</Empty>
        ) : (
          <>
            <ol className="grid list-decimal gap-1.5 pl-5">
              {content.questions.map((q, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: danh sách chỉ đọc.
                <li key={i} className="whitespace-pre-wrap break-words text-body">
                  {q}
                </li>
              ))}
            </ol>
            <p className="text-xs text-muted">
              Trả lời trong ô ghi chú khi duyệt; agent đọc ghi chú trước khi viết code.
            </p>
          </>
        )}
      </Section>
    </>
  );
}

function DecisionCard({ plan, nameOf }: { plan: Plan; nameOf: (id: string | null) => string }) {
  return (
    <Section title="Thông tin">
      <DescriptionList
        items={[
          { term: "Lần lập", detail: String(plan.revision) },
          { term: "Trạng thái", detail: PLAN_STATUS_LABEL[plan.status] },
          {
            term: "Run lập",
            detail: (
              <Link to="/runs/$id" params={{ id: plan.planRunId }} className="text-accent hover:text-accent-hover">
                {shortId(plan.planRunId)}
              </Link>
            ),
            mono: true,
          },
          {
            term: "Run code",
            detail: (
              <Link to="/runs/$id" params={{ id: plan.runId }} className="text-accent hover:text-accent-hover">
                {shortId(plan.runId)}
              </Link>
            ),
            mono: true,
          },
          ...(plan.decidedAt
            ? [
                { term: plan.status === "approved" ? "Người duyệt" : "Người từ chối", detail: nameOf(plan.decidedBy) },
                { term: "Lúc", detail: formatDayTime(plan.decidedAt) },
              ]
            : []),
          ...(plan.note ? [{ term: plan.status === "rejected" ? "Lý do" : "Ghi chú", detail: plan.note }] : []),
        ]}
      />
    </Section>
  );
}

function HistoryCard({ plans, nameOf }: { plans: Plan[]; nameOf: (id: string | null) => string }) {
  return (
    <Section title="Các lần lập" aside={<span className="text-xs text-muted">{plans.length} lần</span>}>
      <ol className="grid gap-3">
        {plans.map((p, i) => (
          <li key={p.id} className={cx("grid gap-1", i > 0 && "border-t border-line pt-3")}>
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-ink">Lần {p.revision}</span>
              <Pill tone={PLAN_STATUS_TONE[p.status]}>{PLAN_STATUS_LABEL[p.status]}</Pill>
              {i === 0 && <span className="text-xs text-muted">đang xem</span>}
            </span>
            <span className="text-xs text-muted">
              nộp <time dateTime={p.createdAt}>{formatDayTime(p.createdAt)}</time>
              {p.decidedAt && (
                <>
                  {" · "}
                  {p.status === "approved" ? "duyệt" : "từ chối"} bởi {nameOf(p.decidedBy)}
                </>
              )}
            </span>
            {p.note && (
              <span className={cx("break-words text-label", p.status === "rejected" ? "text-bad" : "text-body")}>
                {p.status === "rejected" ? "Lý do: " : "Ghi chú: "}
                {p.note}
              </span>
            )}
            <Link
              to="/runs/$id"
              params={{ id: p.planRunId }}
              className="text-label text-accent hover:text-accent-hover"
            >
              Log run lập kế hoạch
            </Link>
            {i > 0 && (
              <details className="text-label">
                <summary className="cursor-pointer text-accent hover:text-accent-hover">
                  Xem kế hoạch lần {p.revision}
                </summary>
                <div className="mt-1.5 grid gap-1.5 rounded-lg bg-sunken px-3 py-2">
                  <p className="whitespace-pre-wrap break-words text-body">{effectiveContent(p).summary}</p>
                  <ol className="grid list-decimal gap-0.5 pl-5 text-body">
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
      <DialogTitle>Duyệt kế hoạch lần {plan.revision}?</DialogTitle>
      <DialogDescription>
        Run code của <span className="font-mono">{task.key}</span> vào hàng ngay và agent làm theo{" "}
        {draft ? "bản bạn vừa sửa" : plan.editedContent ? "bản đã sửa" : "kế hoạch agent nộp"}.
      </DialogDescription>
      {questions.length > 0 && (
        <div className="grid gap-1 rounded-lg bg-warn-bg px-3.5 py-2.5 text-label text-warn">
          <span className="font-medium">Agent có {questions.length} câu hỏi; trả lời trong ghi chú:</span>
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
        <label htmlFor={noteId} className="text-label font-medium text-ink">
          Ghi chú cho agent (không bắt buộc)
        </label>
        <Textarea
          id={noteId}
          name="note"
          rows={4}
          maxLength={10_000}
          disabled={approve.isPending}
          placeholder="Ví dụ: Làm tròn theo từng dòng hoá đơn; giữ nguyên API cũ."
        />
      </div>
      {error && <Alert>{error}</Alert>}
      <DialogActions>
        <Button onClick={onCancel}>Quay lại</Button>
        <Button type="submit" variant="primary" disabled={approve.isPending}>
          {approve.isPending ? "Đang duyệt…" : "Duyệt và chạy"}
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
      setReasonError("Cần ghi lý do từ chối để agent biết phải lập lại thế nào.");
      return;
    }
    setReasonError(null);
    reject.mutate({ reason, replan: form.get("replan") === "on" });
  }

  return (
    <form noValidate onSubmit={onSubmit} className="grid gap-3.5">
      <DialogTitle>Từ chối kế hoạch lần {plan.revision}?</DialogTitle>
      <DialogDescription>
        Run code đang chờ kế hoạch của <span className="font-mono">{task.key}</span> sẽ bị huỷ.
      </DialogDescription>
      <div className="grid gap-1.5">
        <label htmlFor={reasonId} className="text-label font-medium text-ink">
          Lý do từ chối
        </label>
        <Textarea
          id={reasonId}
          name="reason"
          rows={4}
          maxLength={10_000}
          disabled={reject.isPending}
          aria-invalid={reasonError ? true : undefined}
          aria-describedby={reasonError ? reasonErrorId : undefined}
          placeholder="Ví dụ: Thiếu bước migration cho bảng hoá đơn cũ."
          autoFocus
        />
        {reasonError && (
          <p id={reasonErrorId} className="text-xs text-bad">
            {reasonError}
          </p>
        )}
      </div>
      <label htmlFor={replanId} className="flex items-start gap-2 text-label text-ink">
        <input
          id={replanId}
          type="checkbox"
          name="replan"
          disabled={reject.isPending}
          className="mt-0.5 size-4 accent-accent"
        />
        <span className="grid gap-0.5">
          <span>Lập lại kế hoạch</span>
          <span className="text-xs text-muted">
            Agent lập kế hoạch mới, có đọc bản này và lý do của bạn. Không chọn thì việc quay về chưa giao.
          </span>
        </span>
      </label>
      {error && <Alert>{error}</Alert>}
      <DialogActions>
        <Button onClick={onCancel}>Quay lại</Button>
        <Button type="submit" variant="dangerSolid" disabled={reject.isPending}>
          {reject.isPending ? "Đang từ chối…" : "Từ chối kế hoạch"}
        </Button>
      </DialogActions>
    </form>
  );
}

function invalidatePlanViews(queryClient: ReturnType<typeof useQueryClient>, api: ReturnType<typeof useOrg>["api"]) {
  return Promise.all([api.tasks.key(), api.runs.key()].map((queryKey) => queryClient.invalidateQueries({ queryKey })));
}
