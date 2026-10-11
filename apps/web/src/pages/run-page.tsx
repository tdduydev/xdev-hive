import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import type { Run, RunEventView, RunSteerStatus, Task } from "@xdev-hive/contracts";
import { type FormEvent, type ReactNode, useId, useLayoutEffect, useRef, useState } from "react";
import { Alert } from "../components/ui/alert.tsx";
import { Button, buttonClass } from "../components/ui/button.tsx";
import { Card } from "../components/ui/card.tsx";
import { DescriptionList } from "../components/ui/description-list.tsx";
import { Dialog, DialogActions, DialogContent, DialogDescription, DialogTitle } from "../components/ui/dialog.tsx";
import { Meter } from "../components/ui/meter.tsx";
import { Pill } from "../components/ui/pill.tsx";
import { Steps } from "../components/ui/steps.tsx";
import { Textarea } from "../components/ui/textarea.tsx";
import { apiErrorMessage, formError } from "../lib/api-errors.ts";
import { cx } from "../lib/cx.ts";
import { formatClock, formatDayTime, formatDuration, formatInt, formatUsd } from "../lib/format.ts";
import {
  budgetPercent,
  canCancel,
  canSteer,
  checkRows,
  cliLabel,
  describeEvent,
  isTerminal,
  prLabel,
  RUN_STATE_LABEL,
  runPhases,
  runStateTone,
  shortId,
} from "../lib/run-view.ts";
import { useNow } from "../lib/use-now.ts";
import { type StreamStatus, useRunStream } from "../lib/use-run-stream.ts";
import { useOrg } from "../shell/org-context.ts";
import { PageBody, PageHeader } from "../shell/page-header.tsx";

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
      <Link to="/tasks" className="text-accent hover:text-accent-hover">
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
          <p aria-busy="true" className="text-muted">
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
          <Alert>{apiErrorMessage(run.error)}</Alert>
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
          </div>
          <aside aria-label="Thông tin run" className="grid min-w-0 gap-4">
            <DetailsCard run={r} now={now} />
            <CostCard run={r} capUsd={project.data?.settings.budget?.perRunUsd} />
            <PolicyCard run={r} />
          </aside>
        </div>
      </PageBody>
    </>
  );
}

function RunMeta({ run, task }: { run: Run; task: Task | undefined }) {
  return (
    <div className="flex flex-wrap items-center gap-2.5 text-sm text-muted">
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
      {run.kind === "plan" && task && (
        <Link to="/tasks/$key/plan" params={{ key: task.key }} className="text-accent hover:text-accent-hover">
          Xem kế hoạch
        </Link>
      )}
      {run.parentRunId && (
        <Link to="/runs/$id" params={{ id: run.parentRunId }} className="text-accent hover:text-accent-hover">
          Run cha <span className="font-mono">{shortId(run.parentRunId)}</span>
        </Link>
      )}
      {run.prUrl && (
        <a href={run.prUrl} target="_blank" rel="noreferrer" className="text-accent hover:text-accent-hover">
          PR {prLabel(run.prUrl)}
        </a>
      )}
    </div>
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
    <Card className="flex flex-wrap items-center gap-3 border-warn-bg px-4 py-3">
      <p className="min-w-0 flex-1 text-body">
        {planning
          ? "Agent đang lập kế hoạch trong một run riêng chỉ đọc. Lập xong thì kế hoạch chờ người duyệt, run này mới chạy."
          : "Kế hoạch đang chờ duyệt. Run này chỉ chạy tiếp sau khi kế hoạch được duyệt."}
      </p>
      {planning && child && (
        <Link to="/runs/$id" params={{ id: child.id }} className={buttonClass()}>
          Xem log lập kế hoạch
        </Link>
      )}
      {!planning && (
        <Link to="/tasks/$key/plan" params={{ key: task.key }} className={buttonClass({ variant: "primary" })}>
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

const STREAM_TEXT: Record<StreamStatus, string> = {
  connecting: "Đang kết nối…",
  live: "Trực tiếp · tự cuộn",
  ended: "Run đã xong",
  error: "Mất kết nối",
};

/** Log terminal. Tự cuộn xuống cuối khi có log mới, trừ khi người xem đang cuộn lên đọc phần trên. */
function LogCard({ log, status, onRetry }: { log: string; status: StreamStatus; onRetry: () => void }) {
  const ref = useRef<HTMLElement>(null);
  const stick = useRef(true);
  const headingId = useId();
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current && log) el.scrollTop = el.scrollHeight;
  }, [log]);
  return (
    <Card className="overflow-hidden">
      <section aria-labelledby={headingId}>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5">
          <h2 id={headingId} className="text-lg font-semibold text-ink">
            Log trực tiếp
          </h2>
          <span role="status" className="text-xs text-muted">
            {STREAM_TEXT[status]}
          </span>
        </div>
        {status === "error" && (
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
            <Alert className="flex-1">Không nhận được log trực tiếp từ hub. Kiểm tra mạng rồi thử lại.</Alert>
            <Button size="sm" onClick={onRetry}>
              Thử lại
            </Button>
          </div>
        )}
        {/* Vùng cuộn nhận focus để đọc log bằng bàn phím; có tên để trình đọc màn hình biết đang ở đâu. */}
        <section
          ref={ref}
          aria-label="Nội dung log"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: vùng cuộn cần focus để cuộn bằng bàn phím.
          tabIndex={0}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
          className="max-h-160 min-h-80 overflow-auto bg-sunken px-4 py-3.5"
        >
          <pre className="font-mono text-sm leading-relaxed whitespace-pre-wrap break-words text-body">
            {log || (status === "ended" ? "Run không có log." : "Chưa có log.")}
          </pre>
        </section>
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
        <p className="text-muted">Chưa có sự kiện.</p>
      ) : (
        <ol className="grid gap-1 text-label">
          {lines.map((l) => (
            <li key={l.id} className="grid grid-cols-[auto_minmax(0,1fr)] gap-3">
              <time dateTime={l.at} className="font-mono text-sm text-muted tabular-nums">
                {formatClock(l.at)}
              </time>
              <span className="break-words text-ink">
                {l.text}
                {l.attempt > 1 && <span className="text-muted"> · lần thử {l.attempt}</span>}
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
  return (
    <SectionCard
      title="Token và chi phí"
      aside={
        <span className="font-display text-4xl font-semibold text-ink tabular-nums">{formatUsd(run.cost.costUsd)}</span>
      }
    >
      {percent !== null && capUsd !== undefined && (
        <>
          <Meter value={percent} label={`Đã dùng ${percent}% trần chi phí của run`} />
          <p className="text-xs text-muted">
            {percent}% trần {formatUsd(capUsd)} mỗi run. Vượt trần thì hub dừng run và ghi lý do.
          </p>
        </>
      )}
      {run.cost.costUsd === null && (
        <p className="text-xs text-muted">CLI này không báo chi phí USD; xem số token bên dưới.</p>
      )}
      <DescriptionList
        alignEnd
        items={[
          { term: "Token vào", detail: formatInt(run.cost.tokensIn) },
          { term: "Đọc từ cache", detail: formatInt(run.cost.cacheRead) },
          { term: "Ghi cache", detail: formatInt(run.cost.cacheWrite) },
          { term: "Token ra", detail: formatInt(run.cost.tokensOut) },
          { term: "Số lượt", detail: run.cost.turns === null ? "—" : formatInt(run.cost.turns) },
        ]}
      />
    </SectionCard>
  );
}

const CHECK_TONE = { ok: "font-medium text-ok", bad: "font-medium text-bad", muted: "text-muted" } as const;

function PolicyCard({ run }: { run: Run }) {
  const rows = checkRows(run);
  return (
    <SectionCard title="Chính sách kết quả">
      {rows.length === 0 ? (
        <p className="text-muted">Dự án không đặt bước kiểm tra nào cho run này.</p>
      ) : (
        <ul className="grid gap-2 text-label">
          {rows.map((row, i) => (
            // Một chính sách có thể có hai bước cùng loại (hai lệnh command), nên khoá theo vị trí.
            // biome-ignore lint/suspicious/noArrayIndexKey: danh sách cố định theo policySnapshot của run.
            <li key={i} className="grid gap-0.5">
              <span className="text-ink">{row.label}</span>
              <span className={cx("break-words", CHECK_TONE[row.tone])}>{row.state}</span>
            </li>
          ))}
        </ul>
      )}
      {run.result && run.result.reasons.length > 0 && (
        <Alert>
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
  const steerable = canSteer(run.state);
  const cancellable = canCancel(run.state);
  if (!steerable && !cancellable) return null;
  return (
    <>
      {steerable && (
        <Button onClick={onToggleSteer} aria-expanded={steerOpen} aria-controls={steerOpen ? steerPanelId : undefined}>
          Gửi chỉ dẫn
        </Button>
      )}
      {cancellable && (
        <Button variant="danger" onClick={() => setCancelling(true)} aria-haspopup="dialog">
          Huỷ run
        </Button>
      )}
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
    <Card id={id} className="border-sel-line">
      <form noValidate onSubmit={onSubmit} className="grid gap-2 p-4">
        <label htmlFor={fieldId} className="text-label font-medium text-ink">
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
        {error && <Alert>{error}</Alert>}
        <p role="status" className={cx("text-label", result === "closing" ? "text-bad" : "text-ok")}>
          {result ? STEER_RESULT[result] : ""}
        </p>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span id={hintId} className="text-xs text-muted">
            Agent nhận chỉ dẫn ở lượt kế tiếp. Run chưa tới máy thì chỉ dẫn vào đề bài khi giao.
          </span>
          <span className="flex gap-2">
            <Button onClick={onClose}>Đóng</Button>
            <Button type="submit" variant="primary" disabled={steer.isPending}>
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
      {error && <Alert>{error}</Alert>}
      <DialogActions>
        <Button onClick={onDone}>Không huỷ</Button>
        <Button variant="dangerSolid" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
          {cancel.isPending ? "Đang huỷ…" : "Huỷ run"}
        </Button>
      </DialogActions>
    </div>
  );
}
