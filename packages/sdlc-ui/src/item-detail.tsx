import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SdlcItemDetail, SdlcItemTask } from "@xdev-hive/contracts";
import { Alert, AlertDescription, AlertTitle } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Pill } from "@xdev-hive/ui/pill";
import { Textarea } from "@xdev-hive/ui/textarea";
import { cn } from "cn";
import { lazy, type ReactNode, Suspense, useId, useState } from "react";
import { AutoApproval, AutoApprovalBadge } from "./auto-approval.tsx";
import { ContractsPanel } from "./contracts-panel.tsx";
import { type SdlcItemTab, useSdlcEnv, useText } from "./env.tsx";
import { formatUsd, formatWhen, type Tone } from "./format.ts";
import { OverrideDialog } from "./override-dialog.tsx";
import { EmptyState } from "./parts.tsx";
import { currentPhase, PhaseStepper } from "./phase-stepper.tsx";
import { ProjectsPanel } from "./projects-panel.tsx";
import { Questions } from "./questions.tsx";
import { StepsPanel } from "./steps-panel.tsx";
import { SyncStatus } from "./sync-status.tsx";
import { TraceMatrix } from "./trace-matrix.tsx";

// Bản tách kéo theo `@xyflow/react`; chỉ nạp khi người xem mở nó.
const BreakdownReview = lazy(() => import("./breakdown-review.tsx").then((m) => ({ default: m.BreakdownReview })));

export const ITEM_TABS: readonly SdlcItemTab[] = [
  "overview",
  "projects",
  "docs",
  "contracts",
  "questions",
  "tasks",
  "trace",
];

export interface ItemDetailProps {
  projectKey: string;
  number: number;
  /** Tab do app chủ giữ (đường dẫn web, hash app); bỏ trống thì màn tự giữ. */
  tab?: SdlcItemTab | undefined;
  onTabChange?: ((tab: SdlcItemTab) => void) | undefined;
}

/**
 * Chi tiết hạng mục (AppSdlcItem.dc.html): đầu trang có chế độ, cỡ, dự án chính, chủ và thao tác; thanh giai đoạn; bảy
 * tab. Mọi thao tác ghi đi qua hub, rồi làm mới cả nhóm `sdlc` vì bảng và câu hỏi cũng đổi theo.
 */
export function ItemDetail({ projectKey, number, tab, onTabChange }: ItemDetailProps) {
  const { api, link, errorMessage } = useSdlcEnv();
  const t = useText();
  const d = t.detail;
  const ids = useId();
  const [ownTab, setOwnTab] = useState<SdlcItemTab>("overview");
  const current = tab ?? ownTab;
  const select = (next: SdlcItemTab) => {
    setOwnTab(next);
    onTabChange?.(next);
  };
  const query = useQuery(api.sdlc.items.get.queryOptions({ input: { projectKey, number } }));

  if (query.isPending)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {d.loading}
      </p>
    );
  if (query.isError)
    return (
      <Alert variant="destructive">
        <AlertTitle>{d.errTitle}</AlertTitle>
        <AlertDescription className="flex flex-col items-start gap-2">
          {errorMessage(query.error)}
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
              {t.retry}
            </Button>
            {link({
              to: { kind: "board" },
              className: "inline-flex h-7 items-center text-sm underline",
              children: d.back,
            })}
          </div>
        </AlertDescription>
      </Alert>
    );

  const item = query.data;
  const counts: Partial<Record<SdlcItemTab, number>> = {
    projects: item.projectsDetail.length,
    docs: item.artifacts.filter((a) => a.scope !== "contract").length,
    contracts: item.artifacts.filter((a) => a.scope === "contract").length,
    questions: item.questions.filter((q) => q.status === "open").length,
    tasks: item.tasks.length,
  };

  const panels: Record<SdlcItemTab, () => ReactNode> = {
    overview: () => <Overview item={item} />,
    projects: () => <ProjectsPanel item={item} />,
    docs: () => <Docs item={item} />,
    contracts: () => <ContractsPanel item={item} />,
    questions: () => <Questions itemId={item.id} embedded />,
    tasks: () => <TasksTab item={item} />,
    trace: () => <TraceMatrix item={item} />,
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Header item={item} />
      {item.warnings.length > 0 && (
        <Alert>
          <AlertTitle>{d.warningsTitle}</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-4">
              {item.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
      <PhaseStepper phases={item.phases} />
      <div role="tablist" aria-label={d.tabsAria} className="flex gap-1 overflow-x-auto border-b border-border">
        {ITEM_TABS.map((key) => (
          <button
            key={key}
            id={`${ids}-tab-${key}`}
            type="button"
            role="tab"
            aria-selected={current === key}
            aria-controls={`${ids}-panel`}
            onClick={() => select(key)}
            className={cn(
              "-mb-px inline-flex min-h-9 shrink-0 items-center gap-1.5 border-b-2 px-3 text-sm",
              current === key ? "border-primary font-semibold" : "border-transparent text-muted-foreground",
            )}
          >
            {d.tabs[key]}
            {counts[key] ? <span className="font-mono text-xs text-muted-foreground">{counts[key]}</span> : null}
          </button>
        ))}
      </div>
      <div id={`${ids}-panel`} role="tabpanel" aria-labelledby={`${ids}-tab-${current}`}>
        {panels[current]()}
      </div>
    </div>
  );
}

function Header({ item }: { item: SdlcItemDetail }) {
  const { api, lang, link, errorMessage } = useSdlcEnv();
  const t = useText();
  const d = t.detail;
  const queryClient = useQueryClient();
  const [exception, setException] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const onSuccess = () => void queryClient.invalidateQueries({ queryKey: api.sdlc.key() });
  const waves = useMutation(api.sdlc.waves.run.mutationOptions({ onSuccess }));
  const pause = useMutation(api.sdlc.items.pause.mutationOptions({ onSuccess }));
  const resume = useMutation(api.sdlc.items.resume.mutationOptions({ onSuccess }));
  const cancel = useMutation(
    api.sdlc.items.cancel.mutationOptions({
      onSuccess: () => {
        setCancelling(false);
        onSuccess();
      },
    }),
  );
  const error = waves.error ?? pause.error ?? resume.error ?? cancel.error;
  const home = item.projectsDetail.find((p) => p.role === "home");
  const active = item.status === "active";
  const readOnly = !item.can.write;

  return (
    <header className="flex flex-col gap-3">
      <nav className="text-sm text-muted-foreground">
        {link({ to: { kind: "board" }, className: "hover:underline", children: t.board.title })} /{" "}
        <span className="font-mono">{item.project.key}</span>
      </nav>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-2">
          <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold">
            <span className="font-mono text-muted-foreground">{item.ref}</span> {item.title}
            {item.status !== "active" && (
              <Pill tone={item.status === "done" ? "ok" : item.status === "paused" ? "warn" : "neutral"}>
                {t.itemStatus[item.status]}
              </Pill>
            )}
            {readOnly && <Pill>{t.readOnly}</Pill>}
          </h1>
          <dl className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            <div className="flex gap-1">
              <dt className="text-muted-foreground">{d.mode}</dt>
              <dd>{item.modeName}</dd>
            </div>
            <div className="flex gap-1">
              <dt className="text-muted-foreground">{t.size}</dt>
              <dd className="font-mono">{item.size}</dd>
            </div>
            <div className="flex gap-1">
              <dt className="text-muted-foreground">{d.primaryProject}</dt>
              <dd className="font-mono">{home?.key ?? item.project.key}</dd>
            </div>
            <div className="flex gap-1">
              <dt className="text-muted-foreground">{d.owner}</dt>
              <dd>{item.owner.name}</dd>
            </div>
            <div className="flex gap-1">
              <dt className="text-muted-foreground">{t.board.cost}</dt>
              <dd>{formatUsd(item.costUsd, lang)}</dd>
            </div>
          </dl>
        </div>
        <fieldset className="flex flex-wrap gap-2">
          <legend className="sr-only">{d.actions}</legend>
          {item.can.runWaves && active && (
            <Button disabled={waves.isPending} onClick={() => waves.mutate({ id: item.id })}>
              {d.runWave}
            </Button>
          )}
          {item.can.override && active && (
            <Button variant="outline" onClick={() => setException(true)}>
              {d.makeExc}
            </Button>
          )}
          {item.can.manage && active && (
            <Button variant="outline" disabled={pause.isPending} onClick={() => pause.mutate({ id: item.id })}>
              {d.pause}
            </Button>
          )}
          {item.can.manage && item.status === "paused" && (
            <Button variant="outline" disabled={resume.isPending} onClick={() => resume.mutate({ id: item.id })}>
              {d.resume}
            </Button>
          )}
          {item.can.manage && (active || item.status === "paused") && (
            <Button variant="ghost" onClick={() => setCancelling(true)}>
              {d.cancelItem}
            </Button>
          )}
        </fieldset>
      </div>
      {waves.data && (
        <p role="status" className="text-sm text-muted-foreground">
          {d.waveResult(waves.data.started.length, waves.data.skipped.length)}
          {waves.data.skipped.length > 0 && (
            <span className="block text-xs">{waves.data.skipped.map((s) => `${s.key}: ${s.reason}`).join(" · ")}</span>
          )}
        </p>
      )}
      {cancelling && (
        <form
          className="flex flex-col gap-2 rounded-md bg-warning-soft p-3 text-sm"
          onSubmit={(e) => {
            e.preventDefault();
            cancel.mutate({ id: item.id, ...(cancelReason.trim() ? { reason: cancelReason.trim() } : {}) });
          }}
        >
          <p>{d.cancelConfirm}</p>
          <Textarea
            rows={2}
            aria-label={d.reason}
            value={cancelReason}
            onChange={(e) => setCancelReason(e.target.value)}
          />
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setCancelling(false)}>
              {d.cancel}
            </Button>
            <Button type="submit" variant="destructive-solid" size="sm" disabled={cancel.isPending}>
              {d.cancelItem}
            </Button>
          </div>
        </form>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(error)}
        </p>
      )}
      {exception && <OverrideDialog item={item} open={exception} onOpenChange={setException} />}
    </header>
  );
}

function Overview({ item }: { item: SdlcItemDetail }) {
  const { api, lang, errorMessage } = useSdlcEnv();
  const t = useText();
  const d = t.detail;
  const queryClient = useQueryClient();
  const [skipping, setSkipping] = useState(false);
  const [skipReason, setSkipReason] = useState("");
  const onSuccess = () => void queryClient.invalidateQueries({ queryKey: api.sdlc.key() });
  const skip = useMutation(
    api.sdlc.items.skipPhase.mutationOptions({
      onSuccess: () => {
        setSkipping(false);
        onSuccess();
      },
    }),
  );
  const revokeOverride = useMutation(api.sdlc.overrides.revoke.mutationOptions({ onSuccess }));
  const phase = currentPhase(item.phases);
  const overrides = item.overrides.filter((o) => o.active);
  const keyOf = (id: string) => item.projectsDetail.find((p) => p.id === id)?.key ?? id;
  const taskOf = (id: string) => item.tasks.find((task) => task.taskId === id)?.key ?? id;
  const section = "flex flex-col gap-2 rounded-xl border border-border bg-card p-4";

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-4">
        <section className={section}>
          <h2 className="text-base font-semibold">{d.gateTitle}</h2>
          {phase ? (
            <>
              <p className="text-sm">
                <span className="font-medium">{phase.name}</span> · {t.phaseStatus[phase.status]}
                {phase.requiredTotal > 0 && ` · ${d.docsApproved(phase.requiredApproved, phase.requiredTotal)}`}
              </p>
              {phase.note && <p className="text-sm text-muted-foreground">{phase.note}</p>}
              {item.waitingFor && <p className="text-sm text-muted-foreground">{item.waitingFor}</p>}
              <p className="text-xs text-muted-foreground">{d.gateRule}</p>
              {phase.optional && item.can.manage && !skipping && (
                <Button variant="outline" size="sm" className="self-start" onClick={() => setSkipping(true)}>
                  {d.skipPhase}
                </Button>
              )}
              {skipping && (
                <form
                  className="flex flex-col gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (skipReason.trim().length >= 3)
                      skip.mutate({ id: item.id, phaseId: phase.id, reason: skipReason.trim() });
                  }}
                >
                  <Textarea
                    rows={2}
                    aria-label={d.reason}
                    placeholder={d.skipReason}
                    value={skipReason}
                    onChange={(e) => setSkipReason(e.target.value)}
                  />
                  {skip.isError && <p className="text-xs text-destructive">{errorMessage(skip.error)}</p>}
                  <div className="flex gap-2">
                    <Button type="button" variant="outline" size="sm" onClick={() => setSkipping(false)}>
                      {d.cancel}
                    </Button>
                    <Button type="submit" size="sm" disabled={skipReason.trim().length < 3 || skip.isPending}>
                      {d.skipPhase}
                    </Button>
                  </div>
                </form>
              )}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{d.allPhasesDone}</p>
          )}
        </section>
        <section className={section}>
          <h2 className="flex flex-wrap items-baseline gap-2 text-base font-semibold">
            {d.agentTitle} <span className="text-xs font-normal text-muted-foreground">{d.agentMeta}</span>
          </h2>
          <StepsPanel item={item} />
        </section>
        {item.autoApprovals.length > 0 && (
          <section className={section}>
            <h2 className="text-base font-semibold">{d.autoTitle}</h2>
            {item.autoApprovals.map((a) => (
              <AutoApproval key={a.id} approval={a} />
            ))}
          </section>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        <section className={section}>
          <h2 className="text-base font-semibold">{d.ideaTitle}</h2>
          <p className="text-sm whitespace-pre-wrap">{item.idea}</p>
          {item.source.url && (
            <a href={item.source.url} target="_blank" rel="noreferrer" className="text-xs underline">
              {d.openIssue}
            </a>
          )}
        </section>
        <section className={section}>
          <h2 className="text-base font-semibold">{d.excListTitle}</h2>
          <p className="text-xs text-muted-foreground">{d.excListLead}</p>
          {overrides.length === 0 ? (
            <p className="text-sm text-muted-foreground">{d.noExc}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {overrides.map((o) => (
                <li key={o.id} className="flex flex-col gap-1 rounded-md bg-muted/50 p-2 text-sm">
                  <span className="font-medium">
                    {o.taskId
                      ? d.scopeTaskOf(taskOf(o.taskId))
                      : o.projectId
                        ? d.scopeProjectOf(keyOf(o.projectId))
                        : d.scopeItem}
                  </span>
                  <span>{o.reason}</span>
                  <span className="text-xs text-muted-foreground">
                    {o.decidedBy.name} · {o.expiresAt ? d.until(formatWhen(o.expiresAt, lang)) : d.noExpiry}
                  </span>
                  {item.can.override && (
                    <Button
                      variant="outline"
                      size="xs"
                      className="self-start"
                      disabled={revokeOverride.isPending}
                      onClick={() => revokeOverride.mutate({ id: o.id })}
                    >
                      {d.revokeExc}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {revokeOverride.isError && <p className="text-xs text-destructive">{errorMessage(revokeOverride.error)}</p>}
        </section>
      </div>
    </div>
  );
}

const approvalTone = { none: "neutral", human: "ok", auto: "sel", revoked: "warn", reaffirmed: "ok" } as const;

function Docs({ item }: { item: SdlcItemDetail }) {
  const { link } = useSdlcEnv();
  const t = useText();
  const d = t.detail;
  const docs = item.artifacts.filter((a) => a.scope !== "contract");
  if (!docs.length) return <EmptyState title={d.docsEmptyTitle} text={d.docsEmptyText} />;
  return (
    <div className="flex flex-col gap-4">
      {item.phases.map((phase) => {
        const list = docs.filter((a) => a.phaseId === phase.id);
        if (!list.length) return null;
        return (
          <section key={phase.id} className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold">
              {phase.name} <span className="font-normal text-muted-foreground">· {t.phaseKind[phase.kind]}</span>
            </h2>
            <ul className="flex flex-col gap-2">
              {list.map((a) => {
                const auto = item.autoApprovals.find((x) => x.artifactId === a.id && !x.rereviewId);
                return (
                  <li key={a.id} className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{a.name}</span>
                      {a.instance && <span className="font-mono text-xs text-muted-foreground">{a.instance}</span>}
                      <Pill small>{a.required ? d.required : d.optional}</Pill>
                      <Pill small tone={approvalTone[a.approval] as Tone}>
                        {d.approval[a.approval]}
                      </Pill>
                      {a.baselineVersion !== null && <Pill small>{d.baseline(a.baselineVersion)}</Pill>}
                      {a.hasDraft && (
                        <Pill small tone="warn">
                          {d.draft}
                        </Pill>
                      )}
                      {auto && <AutoApprovalBadge approval={auto} />}
                    </div>
                    <span className="font-mono text-xs text-muted-foreground">{a.repoPath}</span>
                    <div className="flex flex-wrap gap-3 text-xs">
                      {link({ to: { kind: "doc", key: a.docKey }, className: "underline", children: d.openDoc })}
                      {a.reviewId &&
                        link({
                          to: { kind: "review", id: a.reviewId },
                          className: "underline",
                          children: d.openReview,
                        })}
                    </div>
                    <SyncStatus itemId={item.id} syncs={a.syncs} canManage={item.can.manage} />
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/** Tab Task: task hub đã tạo, hoặc bản tách đang soạn (gộp/tách, phụ thuộc, độ phủ) trước khi có baseline. */
function TasksTab({ item }: { item: SdlcItemDetail }) {
  const t = useText();
  const d = t.detail;
  const [view, setView] = useState<"tasks" | "breakdown">(item.tasks.length ? "tasks" : "breakdown");
  return (
    <div className="flex flex-col gap-3">
      <fieldset className="inline-flex self-start rounded-lg bg-muted p-0.5">
        <legend className="sr-only">{d.tasksViewAria}</legend>
        {(
          [
            ["tasks", d.tasksCreated],
            ["breakdown", d.tasksBreakdown],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            aria-pressed={view === key}
            onClick={() => setView(key)}
            className={cn(
              "h-7 rounded-md px-3 text-sm",
              view === key ? "bg-card font-semibold shadow-sm" : "text-muted-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </fieldset>
      {view === "tasks" ? (
        <TaskList item={item} />
      ) : (
        <Suspense
          fallback={
            <p role="status" className="text-sm text-muted-foreground">
              {t.breakdown.loading}
            </p>
          }
        >
          <BreakdownReview item={item} />
        </Suspense>
      )}
    </div>
  );
}

const taskTone: Record<SdlcItemTask["status"], Tone> = {
  todo: "neutral",
  queued: "warn",
  running: "sel",
  awaiting_plan: "warn",
  review: "warn",
  done: "ok",
  cancelled: "neutral",
};

/** Task hub của hạng mục theo đợt (D24): đợt sau chờ đợt trước merge, task bị chặn ghi rõ task chặn ở dự án nào. */
export function TaskList({ item }: { item: SdlcItemDetail }) {
  const { link } = useSdlcEnv();
  const d = useText().detail;
  if (!item.tasks.length) return <EmptyState title={d.tkEmptyTitle} text={d.tkEmptyText} />;
  const waves = [...new Set(item.tasks.map((task) => task.wave))].sort((a, b) => a - b);
  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">{d.wavesMeta}</p>
      {waves.map((wave) => (
        <section key={wave} className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold">{d.wave(wave + 1)}</h2>
          <ul className="flex flex-col gap-2">
            {item.tasks
              .filter((task) => task.wave === wave)
              .map((task) => {
                const done = task.checklist.filter((c) => c.done).length;
                return (
                  <li
                    key={task.taskId}
                    className="flex flex-col gap-1.5 rounded-lg border border-border bg-card p-3 text-sm"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      {link({
                        to: { kind: "task", id: task.taskId },
                        className: "font-mono font-medium hover:underline",
                        children: task.key,
                      })}
                      <span className="min-w-0 flex-1">{task.title}</span>
                      <span className="font-mono text-xs text-muted-foreground">{task.projectKey}</span>
                      <Pill small tone={taskTone[task.status]} dot>
                        {d.taskStatus[task.status]}
                      </Pill>
                    </div>
                    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      {task.requirementIds.length > 0 && <span>{task.requirementIds.join(", ")}</span>}
                      {task.checklist.length > 0 && <span>{d.checklist(done, task.checklist.length)}</span>}
                      {task.run &&
                        link({ to: { kind: "run", id: task.run.id }, className: "underline", children: d.openRun })}
                      {task.run?.prUrl && (
                        <a href={task.run.prUrl} target="_blank" rel="noreferrer" className="underline">
                          {d.openPr}
                        </a>
                      )}
                    </div>
                    {task.blockedBy.length > 0 && (
                      <p className="text-xs text-warning">
                        {d.blockedBy(task.blockedBy.map((b) => `${b.projectKey} ${b.key}`).join(", "))}
                      </p>
                    )}
                    {task.removed && <p className="text-xs text-warning">{d.orphan}</p>}
                  </li>
                );
              })}
          </ul>
        </section>
      ))}
    </div>
  );
}
