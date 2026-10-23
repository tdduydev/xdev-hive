import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import type { Run, RunEventView, RunExplore, RunSteerStatus, Task } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button, buttonVariants } from "@xdev-hive/ui/button";
import { Dialog, DialogActions, DialogContent, DialogDescription, DialogTitle } from "@xdev-hive/ui/dialog";
import { Pill } from "@xdev-hive/ui/pill";
import { Textarea } from "@xdev-hive/ui/textarea";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { LogCard } from "@/components/log-card.tsx";
import { TaskHistory } from "@/components/task-history.tsx";
import { TreeLinks } from "@/components/tree-links.tsx";
import { Card } from "@/components/ui/card.tsx";
import { DescriptionList } from "@/components/ui/description-list.tsx";
import { Meter } from "@/components/ui/meter.tsx";
import { Steps } from "@/components/ui/steps.tsx";
import { apiErrorMessage, formError } from "@/lib/api-errors.ts";
import { cx } from "@/lib/cx.ts";
import { formatCacheHit, formatClock, formatDayTime, formatDuration, formatInt, formatUsd } from "@/lib/format.ts";
import { teamRoleLookup } from "@/lib/projects.ts";
import {
  budgetPercent,
  canCancel,
  canSteer,
  checkRows,
  cliLabel,
  describeEvent,
  exploreTokens,
  isTerminal,
  prLabel,
  RUN_STATE_LABEL,
  routingRows,
  runAccess,
  runPhases,
  runStateTone,
  shortId,
  tokenGuardSummary,
} from "@/lib/run-view.ts";
import { useNow } from "@/lib/use-now.ts";
import { useRunStream } from "@/lib/use-run-stream.ts";
import { LinkedArtifactsSection, useCanWriteTeam } from "@/pages/artifacts/linked-section.tsx";
import { useMe } from "@/shell/me-context.ts";
import { useOrg } from "@/shell/org-context.ts";
import { PageBody, PageHeader } from "@/shell/page-header.tsx";

/** Màn chi tiết run theo thiết kế RunDetail.dc.html: pha, log trực tiếp, chi tiết, chi phí, chính sách kết quả. */
export function RunPage() {
  const { id } = useParams({ from: "/session/app/in-org/runs/$id" });
  const { org, api } = useOrg();
  const queryClient = useQueryClient();
  const run = useQuery(api.runs.get.queryOptions({ input: { id } }));
  const task = useQuery(api.tasks.get.queryOptions({ input: { id: run.data?.taskId ?? "" }, enabled: !!run.data }));
  const project = useQuery(
    api.projects.get.queryOptions({ input: { id: run.data?.projectId ?? "" }, enabled: !!run.data }),
  );
  const canLinkArtifacts = useCanWriteTeam(run.data?.teamId);
  // Sự kiện `state` qua SSE nghĩa là trạng thái, kết quả hay chi phí trong runs.get đã đổi.
  const stream = useRunStream(org.id, id, () => {
    void queryClient.invalidateQueries({ queryKey: api.runs.get.key({ input: { id } }) });
  });
  const running = !!run.data && !isTerminal(run.data.state);
  const now = useNow(1000, running);
  const [steerOpen, setSteerOpen] = useState(false);
  const steerPanelId = useId();

  const crumb = (
    <>
      <Link to="/tasks" className="text-primary hover:text-primary/90">
        Bảng việc
      </Link>
      {task.data && (
        <>
          {" / "}
          <span className="font-mono">{task.data.key}</span>
        </>
      )}
    </>
  );

  if (run.isPending) {
    return (
      <>
        <PageHeader crumb={crumb} title="Lượt chạy" />
        <PageBody>
          <p aria-busy="true" className="text-muted-foreground">
            Đang tải…
          </p>
        </PageBody>
      </>
    );
  }
  if (run.isError) {
    return (
      <>
        <PageHeader crumb={crumb} title="Lượt chạy" />
        <PageBody>
          <Alert variant="destructive">{apiErrorMessage(run.error)}</Alert>
        </PageBody>
      </>
    );
  }

  const r = run.data;
  return (
    <>
      <PageHeader crumb={crumb} title={task.data?.title ?? `Run ${shortId(r.id)}`}>
        <RunActions
          run={r}
          steerOpen={steerOpen}
          steerPanelId={steerPanelId}
          onToggleSteer={() => setSteerOpen((open) => !open)}
        />
      </PageHeader>
      <PageBody>
        <RunMeta run={r} task={task.data} />
        {task.data && <PlanNotice run={r} task={task.data} />}
        {steerOpen && canSteer(r.state) && <SteerPanel id={steerPanelId} run={r} onClose={() => setSteerOpen(false)} />}
        <Steps label="Các pha của run" steps={runPhases(r, stream.events, now)} />
        <div className="grid items-start gap-5 app:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
          <div className="grid min-w-0 gap-5">
            <LogCard log={stream.log} status={stream.status} onRetry={stream.retry} />
            <EventsCard events={stream.events} />
            {/* Chưa có trang task riêng: trang run là nơi người xem mở từ bảng việc. */}
            {task.data && <TaskHistory taskId={task.data.id} />}
          </div>
          <aside aria-label="Thông tin run" className="grid min-w-0 gap-4">
            <DetailsCard run={r} now={now} />
            {r.routing && <RoutingCard routing={r.routing} />}
            <CostCard run={r} capUsd={project.data?.settings.budget?.perRunUsd} />
            {r.explore && <ExploreCard explore={r.explore} />}
            <PolicyCard run={r} />
            <LinkedArtifactsSection target={{ kind: "run", id: r.id }} canLink={canLinkArtifacts} />
          </aside>
        </div>
      </PageBody>
    </>
  );
}

function RunMeta({ run, task }: { run: Run; task: Task | undefined }) {
  return (
    <div className="flex flex-wrap items-center gap-2.5 text-xs text-muted-foreground">
      <Pill tone={runStateTone(run.state)} dot>
        {RUN_STATE_LABEL[run.state]}
      </Pill>
      <span className="font-mono">run {shortId(run.id)}</span>
      <span>
        lần thử {run.attempt}/{run.maxAttempts}
      </span>
      <span className="font-mono break-all">{run.branch}</span>
      {run.kind === "review" && <span>Review chéo</span>}
      {run.kind === "plan" && <span>Lập kế hoạch (chỉ đọc)</span>}
      {run.kind === "doccheck" && <span>Kiểm tài liệu cho quy trình duyệt (chỉ đọc)</span>}
      {run.kind === "brief" && <span>Viết lại brief dự án (chỉ đọc)</span>}
      {run.kind === "skill_proposal" && <span>Đề xuất skill từ các việc khó (chỉ đọc)</span>}
      {run.kind === "code" && isTerminal(run.state) && <LearnMark runId={run.id} />}
      {run.kind === "docassist" && <span>Trợ lý của trình soạn tài liệu (chỉ đọc, góp ý thành đề xuất)</span>}
      {run.kind === "plan" && task && (
        <Link to="/tasks/$key/plan" params={{ key: task.key }} className="text-primary hover:text-primary/90">
          Xem kế hoạch
        </Link>
      )}
      {run.parentRunId && (
        <Link to="/runs/$id" params={{ id: run.parentRunId }} className="text-primary hover:text-primary/90">
          Run cha <span className="font-mono">{shortId(run.parentRunId)}</span>
        </Link>
      )}
      {run.prUrl && (
        <a href={run.prUrl} target="_blank" rel="noreferrer" className="text-primary hover:text-primary/90">
          PR {prLabel(run.prUrl)}
        </a>
      )}
      <TreeLinks runId={run.id} />
    </div>
  );
}

/**
 * Đánh dấu run “nên thành skill” (specs/014): lô học của ngày sau sẽ xét run này dù nó không thử lại hay đắt. Hub chưa
 * trả trạng thái đã đánh dấu, nên nút chỉ nhớ trong phiên xem; đánh dấu lại là an toàn.
 */
function LearnMark({ runId }: { runId: string }) {
  const { api } = useOrg();
  const [marked, setMarked] = useState(false);
  const mark = useMutation(api.skillLearning.mark.mutationOptions());
  async function toggle() {
    try {
      const res = await mark.mutateAsync({ runId, marked: !marked });
      setMarked(res.marked);
    } catch {
      /* Lỗi hiện ở dưới nút. */
    }
  }
  return (
    <span className="inline-flex items-center gap-2">
      <Button variant="outline" size="sm" disabled={mark.isPending} aria-pressed={marked} onClick={toggle}>
        {marked ? "Đã đánh dấu nên thành skill" : "Nên thành skill"}
      </Button>
      {mark.error && <span className="text-destructive">{apiErrorMessage(mark.error)}</span>}
    </span>
  );
}

/**
 * Run code của dự án bật plan mode dừng ở `planning` (run plan con đang lập) rồi `awaiting_plan` (chờ người duyệt).
 * Người mở run lúc này cần biết vì sao run chưa chạy và đi đâu để duyệt.
 */
function PlanNotice({ run, task }: { run: Run; task: Task }) {
  const { api } = useOrg();
  const planning = run.kind === "code" && run.state === "planning";
  // Tìm run plan con để mở log của nó; chỉ cần khi đang lập, danh sách run của một task thì ngắn.
  const runs = useQuery(api.runs.list.queryOptions({ input: { taskId: task.id }, enabled: planning }));
  const child = runs.data?.find((r) => r.kind === "plan" && r.parentRunId === run.id);
  if (run.kind !== "code" || (run.state !== "planning" && run.state !== "awaiting_plan")) return null;
  return (
    <Card className="flex flex-wrap items-center gap-3 border-warning-soft px-4 py-3">
      <p className="min-w-0 flex-1 text-foreground">
        {planning
          ? "Agent đang lập kế hoạch trong một run riêng chỉ đọc. Lập xong thì kế hoạch chờ người duyệt, run này mới chạy."
          : "Kế hoạch đang chờ duyệt. Run này chỉ chạy tiếp sau khi kế hoạch được duyệt."}
      </p>
      {planning && child && (
        <Link to="/runs/$id" params={{ id: child.id }} className={buttonVariants({ variant: "outline" })}>
          Xem log lập kế hoạch
        </Link>
      )}
      {!planning && (
        <Link to="/tasks/$key/plan" params={{ key: task.key }} className={buttonVariants({ variant: "default" })}>
          Xem và duyệt kế hoạch
        </Link>
      )}
    </Card>
  );
}

function SectionCard({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  const headingId = useId();
  return (
    <Card>
      <section aria-labelledby={headingId} className="grid gap-2.5 px-5 py-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
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

function EventsCard({ events }: { events: RunEventView[] }) {
  const lines = events.flatMap((e) => {
    const text = describeEvent(e);
    return text ? [{ id: e.id, at: e.createdAt, attempt: e.attempt, text }] : [];
  });
  return (
    <SectionCard title="Sự kiện">
      {lines.length === 0 ? (
        <p className="text-muted-foreground">Chưa có sự kiện.</p>
      ) : (
        <ol className="grid gap-1 text-sm">
          {lines.map((l) => (
            <li key={l.id} className="grid grid-cols-[auto_minmax(0,1fr)] gap-3">
              <time dateTime={l.at} className="font-mono text-xs text-muted-foreground tabular-nums">
                {formatClock(l.at)}
              </time>
              <span className="break-words text-foreground">
                {l.text}
                {l.attempt > 1 && <span className="text-muted-foreground"> · lần thử {l.attempt}</span>}
              </span>
            </li>
          ))}
        </ol>
      )}
    </SectionCard>
  );
}

function DetailsCard({ run, now }: { run: Run; now: number }) {
  const end = run.finishedAt ? Date.parse(run.finishedAt) : now;
  return (
    <SectionCard title="Chi tiết">
      <DescriptionList
        items={[
          { term: "Agent", detail: run.model ? `${cliLabel(run.cli)} · ${run.model}` : cliLabel(run.cli) },
          {
            term: "Máy",
            detail: run.machineName ?? (run.machineId ? shortId(run.machineId) : "Chưa có máy"),
            mono: !!run.machineId,
          },
          { term: "Bắt đầu", detail: run.startedAt ? formatDayTime(run.startedAt) : "Chưa bắt đầu" },
          {
            term: "Thời gian",
            detail: run.startedAt ? formatDuration(end - Date.parse(run.startedAt)) : "—",
          },
          { term: "Giới hạn", detail: formatDuration(run.timeoutSec * 1000) },
        ]}
      />
    </SectionCard>
  );
}

function CostCard({ run, capUsd }: { run: Run; capUsd: number | undefined }) {
  const percent = budgetPercent(run.cost.costUsd, capUsd);
  const guard = tokenGuardSummary(run.tokenGuard);
  return (
    <SectionCard
      title="Token và chi phí"
      aside={
        <span className="font-heading text-2xl font-semibold text-foreground tabular-nums">
          {formatUsd(run.cost.costUsd)}
        </span>
      }
    >
      {percent !== null && capUsd !== undefined && (
        <>
          <Meter value={percent} label={`Đã dùng ${percent}% trần chi phí của run`} />
          <p className="text-xs text-muted-foreground">
            {percent}% trần {formatUsd(capUsd)} mỗi run. Vượt trần thì hub dừng run và ghi lý do.
          </p>
        </>
      )}
      {run.cost.costUsd === null && (
        <p className="text-xs text-muted-foreground">CLI này không báo chi phí USD; xem số token bên dưới.</p>
      )}
      <DescriptionList
        alignEnd
        items={[
          { term: "Token vào", detail: formatInt(run.cost.tokensIn) },
          { term: "Đọc từ cache", detail: formatInt(run.cost.cacheRead) },
          { term: "Ghi cache", detail: formatInt(run.cost.cacheWrite) },
          {
            term: "Cache trúng",
            detail: formatCacheHit(run.cost.cacheRead, run.cost.cacheWrite, run.cost.tokensIn),
          },
          { term: "Token ra", detail: formatInt(run.cost.tokensOut) },
          ...(run.cost.accountId ? [{ term: "Gói", detail: run.cost.accountId, mono: true }] : []),
          { term: "Số lượt", detail: run.cost.turns === null ? "—" : formatInt(run.cost.turns) },
        ]}
      />
      {run.rtk && run.rtk.savedTokens > 0 && (
        <p className="text-xs text-muted-foreground">
          RTK tiết kiệm ~{formatInt(run.rtk.savedTokens)} token ({formatInt(run.rtk.commands)} lệnh)
        </p>
      )}
      {guard && <p className="text-xs text-muted-foreground">{guard}</p>}
    </SectionCard>
  );
}

/** Model và effort hub đã chọn cho lần thử đang giao, kèm từng lý do (định tuyến theo cấp độ task). */
function RoutingCard({ routing }: { routing: NonNullable<Run["routing"]> }) {
  return (
    <SectionCard title="Model đã chọn và vì sao">
      <DescriptionList alignEnd items={routingRows(routing)} />
      <ul className="grid list-disc gap-1 pl-4 text-xs text-muted-foreground">
        {routing.reasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
    </SectionCard>
  );
}

/** Phần usage agent dùng để đọc repo trước lần sửa file đầu tiên; cho thấy brief có bớt được việc khảo sát không. */
function ExploreCard({ explore }: { explore: RunExplore }) {
  return (
    <SectionCard title="Khảo sát trước khi sửa">
      {!explore.edited && <p className="text-xs text-muted-foreground">Agent chưa sửa file nào; số dưới là cả run.</p>}
      <DescriptionList
        alignEnd
        items={[
          { term: "Số lượt", detail: formatInt(explore.turns) },
          { term: "Token", detail: formatInt(exploreTokens(explore)) },
        ]}
      />
    </SectionCard>
  );
}

const CHECK_TONE = {
  ok: "font-medium text-success",
  bad: "font-medium text-destructive",
  muted: "text-muted-foreground",
} as const;

function PolicyCard({ run }: { run: Run }) {
  const rows = checkRows(run);
  return (
    <SectionCard title="Chính sách kết quả">
      {rows.length === 0 ? (
        <p className="text-muted-foreground">Dự án không đặt bước kiểm tra nào cho run này.</p>
      ) : (
        <ul className="grid gap-2 text-sm">
          {rows.map((row, i) => (
            // Một chính sách có thể có hai bước cùng loại (hai lệnh command), nên khoá theo vị trí.
            // biome-ignore lint/suspicious/noArrayIndexKey: danh sách cố định theo policySnapshot của run.
            <li key={i} className="grid gap-0.5">
              <span className="text-foreground">{row.label}</span>
              <span className={cx("break-words", CHECK_TONE[row.tone])}>{row.state}</span>
            </li>
          ))}
        </ul>
      )}
      {run.result?.secretsInjected !== undefined && run.result.secretsInjected > 0 && (
        <p className="text-xs text-muted-foreground">Dùng {formatInt(run.result.secretsInjected)} bí mật tại máy</p>
      )}
      {run.result && run.result.reasons.length > 0 && (
        <Alert variant="destructive">
          <ul className="grid gap-1">
            {run.result.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </Alert>
      )}
    </SectionCard>
  );
}

/** Nút gửi chỉ dẫn và huỷ run; chỉ hiện khi trạng thái còn nhận (hub vẫn kiểm lại quyền và trạng thái). */
function RunActions({
  run,
  steerOpen,
  steerPanelId,
  onToggleSteer,
}: {
  run: Run;
  steerOpen: boolean;
  steerPanelId: string;
  onToggleSteer: () => void;
}) {
  const [cancelling, setCancelling] = useState(false);
  const me = useMe();
  const { org, api } = useOrg();
  // Hub kiểm lại; danh sách thành viên chỉ để biết người xem có phải quản trị đội của run không.
  const members = useQuery(api.orgMembers.list.queryOptions());
  const teamAdmin = teamRoleLookup(org.role, members.data, me.id)(run.teamId) === "admin";
  const access = runAccess(run, me.id, teamAdmin);
  const steerable = canSteer(run.state);
  const cancellable = canCancel(run.state);
  if (!steerable && !cancellable) return null;
  return (
    <>
      {steerable && (
        <Button
          variant="outline"
          onClick={onToggleSteer}
          disabled={!access.steer}
          title={access.reason ?? undefined}
          aria-expanded={steerOpen}
          aria-controls={steerOpen ? steerPanelId : undefined}
        >
          Gửi chỉ dẫn
        </Button>
      )}
      {cancellable && (
        <Button
          variant="destructive"
          onClick={() => setCancelling(true)}
          disabled={!access.cancel}
          aria-haspopup="dialog"
        >
          Huỷ run
        </Button>
      )}
      {steerable && access.reason && <span className="text-xs text-muted-foreground">{access.reason}</span>}
      <Dialog open={cancelling} onOpenChange={setCancelling}>
        <DialogContent>
          <CancelConfirm run={run} onDone={() => setCancelling(false)} />
        </DialogContent>
      </Dialog>
    </>
  );
}

const STEER_RESULT: Record<RunSteerStatus, string> = {
  sent: "Đã gửi. Agent nhận chỉ dẫn ở lượt kế tiếp.",
  pending: "Đã ghi. Run chưa tới máy; agent nhận chỉ dẫn khi run được giao.",
  closing: "Run đang kiểm kết quả, đang huỷ hoặc đã xong nên không nhận chỉ dẫn nữa.",
};

/** Ô gửi chỉ dẫn mở ngay dưới tiêu đề như thiết kế; gửi xong giữ ô mở để gửi tiếp, báo kết quả trong vùng status. */
function SteerPanel({ id, run, onClose }: { id: string; run: Run; onClose: () => void }) {
  const { api } = useOrg();
  const queryClient = useQueryClient();
  const fieldId = useId();
  const hintId = useId();
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RunSteerStatus | null>(null);
  const steer = useMutation({
    mutationFn: (input: string) => api.runs.steer.call({ id: run.id, input }),
    onSuccess: async ({ status }) => {
      setResult(status);
      await queryClient.invalidateQueries({ queryKey: api.runs.get.key({ input: { id: run.id } }) });
    },
    onError: (e) => setError(formError(e).message),
  });

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const input = String(new FormData(form).get("input") ?? "").trim();
    setResult(null);
    if (!input) {
      setError("Chỉ dẫn không được để trống.");
      return;
    }
    setError(null);
    steer.mutate(input, { onSuccess: () => form.reset() });
  }

  return (
    <Card id={id} className="border-primary/40">
      <form noValidate onSubmit={onSubmit} className="grid gap-2 p-4">
        <label htmlFor={fieldId} className="text-sm font-medium text-foreground">
          Chỉ dẫn cho agent đang chạy
        </label>
        <Textarea
          id={fieldId}
          name="input"
          rows={3}
          maxLength={4000}
          aria-describedby={hintId}
          aria-invalid={error ? true : undefined}
          placeholder="Ví dụ: Giữ nguyên chữ ký hàm round(); thêm test cho số âm."
          disabled={steer.isPending}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
          }}
        />
        {error && <Alert variant="destructive">{error}</Alert>}
        <p role="status" className={cx("text-sm", result === "closing" ? "text-destructive" : "text-success")}>
          {result ? STEER_RESULT[result] : ""}
        </p>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span id={hintId} className="text-xs text-muted-foreground">
            Agent nhận chỉ dẫn ở lượt kế tiếp. Run chưa tới máy thì chỉ dẫn vào đề bài khi giao.
          </span>
          <span className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              Đóng
            </Button>
            <Button type="submit" variant="default" disabled={steer.isPending}>
              {steer.isPending ? "Đang gửi…" : "Gửi"}
            </Button>
          </span>
        </div>
      </form>
    </Card>
  );
}

function CancelConfirm({ run, onDone }: { run: Run; onDone: () => void }) {
  const { api } = useOrg();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const cancel = useMutation({
    mutationFn: () => api.runs.cancel.call({ id: run.id }),
    onSuccess: async () => {
      await Promise.all(
        [api.runs.key(), api.tasks.key()].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      );
      onDone();
    },
    onError: (e) => setError(apiErrorMessage(e)),
  });
  return (
    <div className="grid gap-3.5">
      <DialogTitle>Huỷ run {shortId(run.id)}?</DialogTitle>
      <DialogDescription>
        Máy đang chạy sẽ dừng agent và gỡ worktree. Việc quay về trạng thái chưa giao; giao lại sẽ tạo run mới.
      </DialogDescription>
      {error && <Alert variant="destructive">{error}</Alert>}
      <DialogActions>
        <Button variant="outline" onClick={onDone}>
          Không huỷ
        </Button>
        <Button variant="destructive-solid" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
          {cancel.isPending ? "Đang huỷ…" : "Huỷ run"}
        </Button>
      </DialogActions>
    </div>
  );
}
