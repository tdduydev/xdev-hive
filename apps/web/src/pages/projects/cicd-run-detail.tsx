import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { CiActionResult, CiRunDetail, CiRunStatus, CiStep } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Input } from "@xdev-hive/ui/input";
import { Pill } from "@xdev-hive/ui/pill";
import { ArrowLeftIcon, ExternalLinkIcon } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { LogCard } from "@/components/log-card.tsx";
import { Card } from "@/components/ui/card.tsx";
import { LoadFailure, LoadingState } from "@/components/ui/query-state.tsx";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { CI_SOURCE_LABEL, CI_STATUS_LABEL, CI_STATUS_TONE } from "@/lib/delivery-text.ts";
import { formatDayTime, formatDuration } from "@/lib/format.ts";
import { type Dict, useT } from "@/lib/i18n.ts";
import type { StreamStatus } from "@/lib/use-run-stream.ts";
import { useOrg } from "@/shell/org-context.ts";
import { PageBody } from "@/shell/page-header.tsx";

/** Hỏi lại hub tối đa chừng này khi lần chạy còn đang chạy (FR-007: không quá 15 giây). */
export const CI_POLL_MS = 5_000;
const ACTIVE: readonly CiRunStatus[] = ["queued", "running", "waiting"];
export const isCiActive = (status: CiRunStatus) => ACTIVE.includes(status);

/** Chỉ mở link http(s) từ nguồn; chuỗi lạ (javascript:, data:) không thành link. */
export function safeHref(url: string | null): string | null {
  return url && /^https?:\/\//i.test(url) ? url : null;
}

const text: Dict<{
  back: string;
  loading: string;
  retryAction: string;
  cancelAction: string;
  stopAction: string;
  play: (name: string) => string;
  proceed: string;
  abort: string;
  approveDeployment: string;
  rejectDeployment: string;
  noToken: string;
  addToken: string;
  openOrigin: string;
  steps: string;
  stepsEmpty: string;
  stepKind: { job: string; stage: string };
  viewLog: (name: string) => string;
  retryStep: (name: string) => string;
  allowFailure: string;
  wholeLog: string;
  logOf: (name: string) => string;
  searchLog: string;
  searchHint: (count: number, total: number) => string;
  branch: string;
  commit: string;
  trigger: string;
  started: string;
  duration: string;
  pending: string;
  actionOk: string;
}> = {
  vi: {
    back: "Về danh sách",
    loading: "Đang tải lần chạy…",
    retryAction: "Chạy lại",
    cancelAction: "Huỷ lần chạy",
    stopAction: "Dừng build",
    play: (n) => `Chạy ${n}`,
    proceed: "Tiếp tục",
    abort: "Dừng ở bước này",
    approveDeployment: "Duyệt deployment",
    rejectDeployment: "Từ chối",
    noToken: "Thêm token Jenkins của bạn ở Cài đặt cá nhân",
    addToken: "Thêm token",
    openOrigin: "Mở trên nguồn",
    steps: "Giai đoạn và job",
    stepsEmpty: "Nguồn chưa trả giai đoạn hay job nào.",
    stepKind: { job: "Job", stage: "Giai đoạn" },
    viewLog: (n) => `Xem log ${n}`,
    retryStep: (n) => `Chạy lại ${n}`,
    allowFailure: "được phép lỗi",
    wholeLog: "Log cả lần chạy",
    logOf: (n) => `Log của ${n}`,
    searchLog: "Tìm trong log",
    searchHint: (c, t) => `${c}/${t} dòng khớp`,
    branch: "Nhánh",
    commit: "Commit",
    trigger: "Người kích hoạt",
    started: "Bắt đầu",
    duration: "Thời lượng",
    pending: "Đang chờ bạn",
    actionOk: "Đã gửi lệnh.",
  },
  en: {
    back: "Back to list",
    loading: "Loading run…",
    retryAction: "Re-run",
    cancelAction: "Cancel run",
    stopAction: "Stop build",
    play: (n) => `Run ${n}`,
    proceed: "Proceed",
    abort: "Stop at this step",
    approveDeployment: "Approve deployment",
    rejectDeployment: "Reject",
    noToken: "Add your Jenkins token in Personal settings",
    addToken: "Add token",
    openOrigin: "Open at source",
    steps: "Stages and jobs",
    stepsEmpty: "The source returned no stages or jobs.",
    stepKind: { job: "Job", stage: "Stage" },
    viewLog: (n) => `View log of ${n}`,
    retryStep: (n) => `Re-run ${n}`,
    allowFailure: "allowed to fail",
    wholeLog: "Whole run log",
    logOf: (n) => `Log of ${n}`,
    searchLog: "Search in log",
    searchHint: (c, t) => `${c}/${t} lines match`,
    branch: "Branch",
    commit: "Commit",
    trigger: "Triggered by",
    started: "Started",
    duration: "Duration",
    pending: "Waiting for you",
    actionOk: "Command sent.",
  },
};

/**
 * Log đọc theo đoạn từ nguồn (hub không lưu). Còn chạy thì hỏi lại mỗi `CI_POLL_MS`; khi lần chạy vừa xong, đọc thêm
 * một lần để lấy đoạn cuối. Đổi lần chạy hay job thì đọc lại từ đầu.
 */
export function useCiLog(projectId: string, runId: string, stepId: string | undefined, live: boolean) {
  const { api } = useOrg();
  const [log, setLog] = useState("");
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const [attempt, setAttempt] = useState(0);
  const offset = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: đổi nguồn log hay bấm thử lại là đọc lại từ đầu.
  useEffect(() => {
    offset.current = 0;
    setLog("");
    setStatus("connecting");
  }, [projectId, runId, stepId, attempt]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `live` đổi thì chạy lại để đọc đoạn cuối.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const chunk = await api.ci.log.call({ projectId, runId, ...(stepId ? { stepId } : {}), from: offset.current });
        if (cancelled) return;
        if (chunk.text) setLog((prev) => prev + chunk.text);
        offset.current = chunk.next;
        if (chunk.more || live) {
          setStatus("live");
          timer = setTimeout(tick, CI_POLL_MS);
        } else setStatus("ended");
      } catch {
        if (!cancelled) setStatus("error");
      }
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [api, projectId, runId, stepId, attempt, live]);

  return { log, status, retry: () => setAttempt((n) => n + 1) };
}

/** Giữ các dòng chứa `query` (không phân biệt hoa thường). */
export function filterLog(log: string, query: string): { text: string; matched: number; total: number } {
  const lines = log.split("\n");
  const q = query.trim().toLowerCase();
  if (!q) return { text: log, matched: lines.length, total: lines.length };
  const hit = lines.filter((l) => l.toLowerCase().includes(q));
  return { text: hit.join("\n"), matched: hit.length, total: lines.length };
}

export function CiRunDetailView({
  projectId,
  runId,
  canOperate,
  tokenMissing,
  onBack,
  onOpenRun,
}: {
  projectId: string;
  runId: string;
  /** `ci.operate`. */
  canOperate: boolean;
  /** Run Jenkins mà người xem chưa có token của mình: nút thao tác tắt kèm lý do. */
  tokenMissing: boolean;
  onBack: () => void;
  onOpenRun: (runId: string) => void;
}) {
  const { api } = useOrg();
  const t = useT(text);
  const queryClient = useQueryClient();
  const [stepId, setStepId] = useState<string | undefined>(undefined);
  const [search, setSearch] = useState("");
  const searchId = useId();
  const reasonId = useId();
  const [notice, setNotice] = useState<{ ok: boolean; message: string } | null>(null);

  const detail = useQuery({
    ...api.ci.detail.queryOptions({ input: { projectId, runId } }),
    refetchInterval: (query) => {
      const data = query.state.data as CiRunDetail | undefined;
      return !data || isCiActive(data.run.status) ? CI_POLL_MS : false;
    },
  });
  const live = detail.data ? isCiActive(detail.data.run.status) : true;
  const { log, status, retry } = useCiLog(projectId, runId, stepId, live);
  const shown = useMemo(() => filterLog(log, search), [log, search]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: api.ci.key() });
  const done = (result: CiActionResult) => {
    setNotice({ ok: true, message: t.actionOk });
    void refresh();
    if (result.runId && result.runId !== runId) onOpenRun(result.runId);
  };
  const failed = (error: unknown) => setNotice({ ok: false, message: apiErrorMessage(error) });
  const run = (call: () => Promise<CiActionResult>) => {
    setNotice(null);
    return call();
  };
  const retryRun = useMutation({
    mutationFn: (step?: string) =>
      run(() => api.ci.retry.call({ projectId, runId, ...(step ? { stepId: step } : {}) })),
    onSuccess: done,
    onError: failed,
  });
  const cancelRun = useMutation({
    mutationFn: () => run(() => api.ci.cancel.call({ projectId, runId })),
    onSuccess: done,
    onError: failed,
  });
  const stopRun = useMutation({
    mutationFn: () => run(() => api.ci.stop.call({ projectId, runId })),
    onSuccess: done,
    onError: failed,
  });
  const playStep = useMutation({
    mutationFn: (step: string) => run(() => api.ci.play.call({ projectId, runId, stepId: step })),
    onSuccess: done,
    onError: failed,
  });
  const answer = useMutation({
    mutationFn: (v: { inputId: string; action: "proceed" | "abort" }) =>
      run(() => api.ci.input.call({ projectId, runId, ...v })),
    onSuccess: done,
    onError: failed,
  });

  const review = useMutation({
    mutationFn: (v: { environment: string; decision: "approve" | "reject" }) =>
      run(() =>
        api.ci.approveDeployment.call({ projectId, runId, environments: [v.environment], decision: v.decision }),
      ),
    onSuccess: done,
    onError: failed,
  });

  if (detail.isPending)
    return (
      <PageBody>
        <LoadingState label={t.loading} />
      </PageBody>
    );
  if (detail.isError)
    return (
      <PageBody>
        <BackButton label={t.back} onBack={onBack} />
        <LoadFailure error={detail.error} retry={() => detail.refetch()} />
      </PageBody>
    );

  const { run: info, steps, pendingInputs } = detail.data;
  const active = isCiActive(info.status);
  const jenkins = info.source === "jenkins";
  const blocked = jenkins && tokenMissing;
  // Với GitHub, ô chờ là deployment chờ duyệt (id là tên environment), không phải bước input của Jenkins.
  const github = info.source === "github";
  const busy =
    retryRun.isPending ||
    cancelRun.isPending ||
    stopRun.isPending ||
    playStep.isPending ||
    answer.isPending ||
    review.isPending;
  const href = safeHref(info.url);
  const selected = steps.find((s) => s.id === stepId);
  const describedBy = blocked ? reasonId : undefined;

  return (
    <PageBody>
      <div className="grid gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <BackButton label={t.back} onBack={onBack} />
          {href && (
            <a
              href={href}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex h-7 items-center gap-1 text-sm text-primary hover:text-primary/90"
            >
              {t.openOrigin}
              <span className="sr-only"> ({CI_SOURCE_LABEL[info.source]})</span>
              <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
            </a>
          )}
        </div>

        <Card>
          <div className="grid gap-3 px-4">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="min-w-0 flex-1 text-lg font-semibold break-words">{info.title}</h2>
              <Pill tone={CI_STATUS_TONE[info.status]} dot>
                {CI_STATUS_LABEL[info.status]}
              </Pill>
              <Pill>{CI_SOURCE_LABEL[info.source]}</Pill>
            </div>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <Meta label={t.branch} value={info.branch ?? "—"} mono />
              <Meta label={t.commit} value={info.sha ? info.sha.slice(0, 8) : "—"} mono />
              <Meta label={t.trigger} value={info.triggeredBy ?? "—"} />
              <Meta label={t.started} value={info.startedAt ? formatDayTime(info.startedAt) : "—"} />
              <Meta
                label={t.duration}
                value={info.durationSec === null ? "—" : formatDuration(info.durationSec * 1000)}
              />
            </dl>
            {canOperate && (
              <div className="grid gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={blocked || busy}
                    aria-describedby={describedBy}
                    onClick={() => retryRun.mutate(undefined)}
                  >
                    {t.retryAction}
                  </Button>
                  {active && !jenkins && (
                    <Button variant="outline" size="sm" disabled={busy} onClick={() => cancelRun.mutate()}>
                      {t.cancelAction}
                    </Button>
                  )}
                  {active && jenkins && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={blocked || busy}
                      aria-describedby={describedBy}
                      onClick={() => stopRun.mutate()}
                    >
                      {t.stopAction}
                    </Button>
                  )}
                </div>
                {blocked && <NoTokenReason id={reasonId} reason={t.noToken} link={t.addToken} />}
              </div>
            )}
            {pendingInputs.length > 0 && (
              <ul className="grid gap-2" aria-label={t.pending}>
                {pendingInputs.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-2.5">
                    <span className="min-w-0 flex-1 text-sm break-words">{p.message}</span>
                    {canOperate && github && (
                      <>
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={() => review.mutate({ environment: p.id, decision: "approve" })}
                        >
                          {t.approveDeployment}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => review.mutate({ environment: p.id, decision: "reject" })}
                        >
                          {t.rejectDeployment}
                        </Button>
                      </>
                    )}
                    {canOperate && !github && (
                      <>
                        <Button
                          size="sm"
                          disabled={blocked || busy}
                          aria-describedby={describedBy}
                          onClick={() => answer.mutate({ inputId: p.id, action: "proceed" })}
                        >
                          {t.proceed}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={blocked || busy}
                          aria-describedby={describedBy}
                          onClick={() => answer.mutate({ inputId: p.id, action: "abort" })}
                        >
                          {t.abort}
                        </Button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {notice && (
              <Alert variant={notice.ok ? "default" : "destructive"} role={notice.ok ? "status" : "alert"}>
                {notice.message}
              </Alert>
            )}
          </div>
        </Card>

        <Card>
          <div className="grid gap-2 px-4">
            <h3 className="text-base font-semibold">{t.steps}</h3>
            {steps.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t.stepsEmpty}</p>
            ) : (
              <ul className="grid gap-1.5">
                {steps.map((s) => (
                  <StepRow
                    key={s.id}
                    step={s}
                    selected={stepId === s.id}
                    canOperate={canOperate}
                    blocked={blocked}
                    busy={busy}
                    t={t}
                    onSelect={() => setStepId(stepId === s.id ? undefined : s.id)}
                    onPlay={() => playStep.mutate(s.id)}
                    onRetry={() => retryRun.mutate(s.id)}
                  />
                ))}
              </ul>
            )}
          </div>
        </Card>

        <div className="grid gap-2">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <p className="text-sm font-medium">{selected ? t.logOf(selected.name) : t.wholeLog}</p>
            <div className="grid min-w-0 flex-1 basis-56 gap-1 sm:max-w-sm">
              <label htmlFor={searchId} className="sr-only">
                {t.searchLog}
              </label>
              <Input
                id={searchId}
                type="search"
                placeholder={t.searchLog}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            {search.trim() && (
              <span role="status" className="text-xs text-muted-foreground">
                {t.searchHint(shown.matched, shown.total)}
              </span>
            )}
          </div>
          <LogCard
            log={shown.text}
            status={status}
            onRetry={retry}
            endedText="Lần chạy đã xong"
            emptyEndedText="Lần chạy không có log."
          />
        </div>
      </div>
    </PageBody>
  );
}

function BackButton({ label, onBack }: { label: string; onBack: () => void }) {
  return (
    <Button variant="outline" size="sm" onClick={onBack}>
      <ArrowLeftIcon aria-hidden="true" />
      {label}
    </Button>
  );
}

function Meta({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={mono ? "font-mono text-sm break-all" : "text-sm break-words"}>{value}</dd>
    </div>
  );
}

/** Lý do nút Jenkins tắt, kèm đường tới trang token. */
export function NoTokenReason({ id, reason, link }: { id: string; reason: string; link: string }) {
  return (
    <p id={id} className="text-xs text-muted-foreground">
      {reason}.{" "}
      <Link to="/settings/jenkins-tokens" className="text-primary hover:text-primary/90">
        {link}
      </Link>
    </p>
  );
}

function StepRow({
  step,
  selected,
  canOperate,
  blocked,
  busy,
  t,
  onSelect,
  onPlay,
  onRetry,
}: {
  step: CiStep;
  selected: boolean;
  canOperate: boolean;
  blocked: boolean;
  busy: boolean;
  t: (typeof text)["vi"];
  onSelect: () => void;
  onPlay: () => void;
  onRetry: () => void;
}) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-border px-3 py-2">
      <div className="min-w-0 flex-1 basis-48">
        <p className="text-sm font-medium break-words">{step.name}</p>
        <p className="text-xs text-muted-foreground">
          {step.group ? `${step.group} · ` : ""}
          {t.stepKind[step.kind]}
          {step.allowFailure ? ` · ${t.allowFailure}` : ""}
          {step.durationSec !== null ? ` · ${formatDuration(step.durationSec * 1000)}` : ""}
        </p>
      </div>
      <Pill tone={CI_STATUS_TONE[step.status]} small>
        {CI_STATUS_LABEL[step.status]}
      </Pill>
      <div className="flex flex-wrap items-center gap-1.5">
        {step.hasLog && (
          <Button variant={selected ? "default" : "outline"} size="sm" aria-pressed={selected} onClick={onSelect}>
            {t.viewLog(step.name)}
          </Button>
        )}
        {canOperate && step.playable && (
          <Button size="sm" disabled={busy} onClick={onPlay}>
            {t.play(step.name)}
          </Button>
        )}
        {canOperate && step.kind === "job" && step.hasLog && !blocked && (
          <Button variant="outline" size="sm" disabled={busy} onClick={onRetry}>
            {t.retryStep(step.name)}
          </Button>
        )}
      </div>
    </li>
  );
}
