import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { cn } from "cn";
import {
  AGENT_ROLES,
  TASK_STATUSES,
  usageStop,
  type AgentProfileStatus,
  type AgentRole,
  type AgentRun,
  type Task,
} from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Card, CardContent } from "@xdev-hive/ui/components/ui/card";
import { Checkbox } from "@xdev-hive/ui/components/ui/checkbox";
import { Label } from "@xdev-hive/ui/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@xdev-hive/ui/components/ui/table";
import { Textarea } from "@xdev-hive/ui/components/ui/textarea";
import { Badge, Empty, ErrorNote, Notice, Page, PageHeader, STATUS_TONE, StatusDot } from "../components/common.tsx";
import { formatCount, formatTime, formatUsd, useAction, useHive, useProjects, useQuery } from "../hooks.ts";
import { rich, useT } from "../i18n/index.tsx";
import { projectScope, scopeProject } from "../lib/scope.ts";

const DANGER_GHOST = "text-destructive hover:bg-destructive/10 hover:text-destructive";

/** Re-renders every `ms` while `active`, for live run lists and logs. */
function usePulse(active: boolean, ms = 2000): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setN((x) => x + 1), ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return n;
}

function duration(run: AgentRun): string {
  if (!run.startedAt) return "";
  const end = run.finishedAt ? new Date(run.finishedAt) : new Date();
  const s = Math.max(0, Math.round((end.getTime() - new Date(run.startedAt).getTime()) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}`;
}

export function BoardPage() {
  const { client, scope, setScope } = useHive();
  const t = useT();
  const desktop = client.desktop!;
  const projects = useProjects();
  const settings = useQuery(() => desktop.settings(), [desktop]);
  const localProjects = settings.data?.projects.map((p) => p.name) ?? [];
  const options = [...new Set([...localProjects, ...projects])];
  // Follow the sidebar scope when it is a project with a repo on this machine; otherwise (all, shared,
  // a project not cloned here) keep the project shown last, or the first one.
  const scoped = scopeProject(scope);
  const scopeLocal = scoped !== null && localProjects.includes(scoped) ? scoped : null;
  const [project, setProject] = useState("");
  useEffect(() => {
    if (scopeLocal) setProject(scopeLocal);
  }, [scopeLocal]);
  const current = scopeLocal || (options.includes(project) ? project : "") || localProjects[0] || projects[0] || "";

  const [tick, setTick] = useState(0);
  const runs = useQuery(() => desktop.runs({ project: current || undefined, limit: 60 }), [desktop, current, tick]);
  const active = (runs.data ?? []).some((r) => r.status === "queued" || r.status === "running");
  const pulse = usePulse(active);
  useEffect(() => setTick((t) => t + 1), [pulse]);

  const tasks = useQuery(
    () => (current ? client.call("tasks.list", { project: current }) : Promise.resolve([] as Task[])),
    [client, current, tick],
  );
  const profiles = useQuery(() => desktop.profiles(), [desktop, tick]);
  const [selected, setSelected] = useState<string | null>(null);

  const latestRun = useMemo(() => {
    const map = new Map<string, AgentRun>();
    for (const r of runs.data ?? []) if (!map.has(r.taskId)) map.set(r.taskId, r);
    return map;
  }, [runs.data]);

  const counts = {
    running: (runs.data ?? []).filter((r) => r.status === "running").length,
    queued: (runs.data ?? []).filter((r) => r.status === "queued").length,
  };
  const refresh = () => setTick((t) => t + 1);
  const isLocalProject = localProjects.includes(current);
  const gitlabReady = !!settings.data?.gitlab.url && !!settings.data?.gitlab.hasToken;

  return (
    <Page wide>
      <PageHeader
        title={t("nav.board")}
        subtitle={t("board.subtitle")}
        actions={
          <>
            <Badge tone="info">{t("board.running", { count: counts.running })}</Badge>
            <Badge tone="neutral">{t("board.queued", { count: counts.queued })}</Badge>
            <Button asChild size="sm" variant="outline">
              <a href="#/agents">{t("board.profiles")}</a>
            </Button>
          </>
        }
      />
      <div className="flex flex-wrap items-center gap-3">
        <NativeSelect
          value={current}
          onChange={(e) => {
            setProject(e.target.value);
            setScope(projectScope(e.target.value));
          }}
          aria-label={t("tasks.colProject")}
        >
          {options.map((p) => (
            <NativeSelectOption key={p} value={p}>
              {p}
              {localProjects.includes(p) ? "" : ` (${t("board.noRepoHere")})`}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <ProfileStrip profiles={profiles.data ?? []} />
      </div>
      {!current && !settings.loading ? <Empty>{t("board.addProjectFirst")}</Empty> : null}
      {current && scoped !== null && scoped !== current && !settings.loading ? (
        <Notice tone="info">
          {rich(t("board.scopeNotLocal"), {
            scoped: <span className="font-mono">{scoped}</span>,
            current: <span className="font-mono">{current}</span>,
          })}
        </Notice>
      ) : null}
      {current && !isLocalProject ? (
        <Notice tone="warn">{t("board.cannotRun")}</Notice>
      ) : null}
      <ErrorNote error={tasks.error ?? runs.error} />

      <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5">
        {TASK_STATUSES.map((status) => {
          const column = (tasks.data ?? []).filter((task) => task.status === status);
          return (
            <section
              key={status}
              className="flex min-h-32 min-w-0 flex-col gap-2 rounded-lg border bg-muted/30 p-2"
              aria-label={t(`taskStatus.${status}`)}
            >
              <header className="flex items-center justify-between gap-2 px-1 py-0.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                <span>{t(`taskStatus.${status}`)}</span>
                <Badge tone="neutral">{column.length}</Badge>
              </header>
              {column.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  run={latestRun.get(task.id) ?? null}
                  profiles={profiles.data ?? []}
                  canRun={isLocalProject}
                  onStarted={(r) => {
                    setSelected(r.id);
                    refresh();
                  }}
                  onOpenRun={setSelected}
                />
              ))}
            </section>
          );
        })}
      </div>

      <RunsPanel runs={runs.data ?? []} selected={selected} onSelect={setSelected} onChanged={refresh} gitlabReady={gitlabReady} />
    </Page>
  );
}

function ProfileStrip({ profiles }: { profiles: AgentProfileStatus[] }) {
  const t = useT();
  if (!profiles.length) return null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5" aria-label={t("board.profileStatus")}>
      {profiles.map((p) => {
        const resting = p.cooldownUntil !== null;
        const signedOut = p.login?.loggedIn === false;
        const overLimit = usageStop(p, p.usage) !== null;
        const tone = !p.enabled ? "neutral" : signedOut ? "danger" : resting || overLimit ? "warn" : p.running ? "info" : "ok";
        const text = !p.enabled
          ? t("board.profileOff")
          : signedOut
            ? t("board.profileSignedOut")
            : overLimit
              ? t("board.profileOverLimit")
              : resting
            ? t("board.profileResting", { time: formatTime(p.cooldownUntil) })
            : p.running
              ? t("board.profileRunning", { running: p.running, max: p.maxConcurrent })
              : t("board.profileReady");
        return (
          <span key={p.id} className="inline-flex min-w-0 items-center gap-1.5" title={p.cooldownReason ?? p.label}>
            <StatusDot tone={tone} />
            <span className="font-mono text-xs break-all">{p.id}</span>
            <span className="text-xs text-muted-foreground">{text}</span>
          </span>
        );
      })}
    </div>
  );
}

function TaskCard({
  task,
  run,
  profiles,
  canRun,
  onStarted,
  onOpenRun,
}: {
  task: Task;
  run: AgentRun | null;
  profiles: AgentProfileStatus[];
  canRun: boolean;
  onStarted: (run: AgentRun) => void;
  onOpenRun: (id: string) => void;
}) {
  const { client, me } = useHive();
  const t = useT();
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<AgentRole>(task.status === "review" ? "review" : "implement");
  const [profileId, setProfileId] = useState("");
  const [instructions, setInstructions] = useState("");
  const [reviewAfter, setReviewAfter] = useState(true);
  const action = useAction();
  const busy = run?.status === "queued" || run?.status === "running";
  const allowed = me.role !== "viewer" && canRun && task.status !== "done";

  return (
    <Card className="gap-2 py-3">
      <CardContent className="flex flex-col gap-2 px-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs whitespace-nowrap">{task.id}</span>
          {run ? (
            <button
              className="cursor-pointer rounded-full outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              onClick={() => onOpenRun(run.id)}
              title={run.error ?? ""}
            >
              <Badge tone={STATUS_TONE[run.status] ?? "neutral"}>
                {t(`runStatus.${run.status}`)}
                {run.profileId ? ` · ${run.profileId}` : ""}
              </Badge>
            </button>
          ) : null}
          {run ? <MrLink run={run} /> : null}
        </div>
        <div className="text-sm font-medium wrap-anywhere">{task.title}</div>
        {task.owner ? <div className="text-xs text-muted-foreground">{t("board.claimedBy", { owner: task.owner })}</div> : null}
        {allowed && !busy && !open ? (
          <Button size="sm" variant="outline" className="self-start" onClick={() => setOpen(true)}>
            {t("board.runAgent")}
          </Button>
        ) : null}
        {open ? (
          <form
            className="flex flex-col gap-2 border-t pt-2"
            onSubmit={(e) => {
              e.preventDefault();
              void action.run(async () => {
                const started = await client.desktop!.startRun({
                  project: task.project,
                  taskId: task.id,
                  role,
                  profileId: profileId || null,
                  instructions,
                  reviewAfter: role !== "review" && reviewAfter,
                });
                setOpen(false);
                setInstructions("");
                onStarted(started);
              });
            }}
          >
            <Label htmlFor={`role-${task.id}`}>{t("board.role")}</Label>
            <NativeSelect id={`role-${task.id}`} size="sm" value={role} onChange={(e) => setRole(e.target.value as AgentRole)}>
              {AGENT_ROLES.map((r) => (
                <NativeSelectOption key={r} value={r}>
                  {t(`agentRole.${r}`)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <Label htmlFor={`profile-${task.id}`}>{t("board.profile")}</Label>
            <NativeSelect id={`profile-${task.id}`} size="sm" value={profileId} onChange={(e) => setProfileId(e.target.value)}>
              <NativeSelectOption value="">{t("board.rotate")}</NativeSelectOption>
              {profiles
                .filter((p) => p.enabled && p.roles.includes(role))
                .map((p) => (
                  <NativeSelectOption key={p.id} value={p.id}>
                    {p.label}
                    {p.cooldownUntil ? ` (${t("board.resting")})` : ""}
                  </NativeSelectOption>
                ))}
            </NativeSelect>
            <Textarea
              placeholder={t("board.instructionsPlaceholder")}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              aria-label={t("board.instructions")}
            />
            {role !== "review" ? (
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={reviewAfter} onCheckedChange={(v) => setReviewAfter(v === true)} />
                {t("board.reviewAfter")}
              </label>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" type="submit" disabled={action.busy}>
                {t("board.run")}
              </Button>
              <Button size="sm" variant="ghost" type="button" onClick={() => setOpen(false)}>
                {t("common.cancel")}
              </Button>
            </div>
            <ErrorNote error={action.error} />
          </form>
        ) : null}
      </CardContent>
    </Card>
  );
}

function RunsPanel({
  runs,
  selected,
  onSelect,
  onChanged,
  gitlabReady,
}: {
  runs: AgentRun[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  onChanged: () => void;
  gitlabReady: boolean;
}) {
  const t = useT();
  const run = runs.find((r) => r.id === selected) ?? null;
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold tracking-tight">{t("board.runs")}</h2>
      {runs.length === 0 ? <Empty>{t("board.noRuns")}</Empty> : null}
      <div className={cn("grid grid-cols-1 items-start gap-4", run ? "lg:grid-cols-2" : "")}>
        {runs.length ? (
          <div className="min-w-0 overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("board.colRun")}</TableHead>
                  <TableHead>{t("board.colTask")}</TableHead>
                  <TableHead>{t("board.role")}</TableHead>
                  <TableHead>{t("board.profile")}</TableHead>
                  <TableHead>{t("tasks.status")}</TableHead>
                  <TableHead>{t("board.colTime")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((r) => (
                  <TableRow
                    key={r.id}
                    data-state={r.id === selected ? "selected" : undefined}
                    className="cursor-pointer data-[state=selected]:bg-brand-soft/60"
                    onClick={() => onSelect(r.id)}
                  >
                    <TableCell className="font-mono text-xs">
                      {r.id}
                      {r.attempt > 1 ? <span className="text-muted-foreground"> · {t("board.attempt", { n: r.attempt })}</span> : null}
                    </TableCell>
                    <TableCell>
                      <div className="font-mono text-xs">{r.taskId}</div>
                      <div className="max-w-56 truncate text-xs">{r.taskTitle}</div>
                    </TableCell>
                    <TableCell className="text-xs">{t(`agentRole.${r.role}`)}</TableCell>
                    <TableCell className="font-mono text-xs">{r.profileId ?? r.preferredProfile ?? t("board.auto")}</TableCell>
                    <TableCell>
                      <Badge tone={STATUS_TONE[r.status] ?? "neutral"}>{t(`runStatus.${r.status}`)}</Badge>
                      {r.error ? <div className="max-w-64 truncate text-xs text-muted-foreground">{r.error}</div> : null}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatTime(r.createdAt)}
                      <div>{duration(r)}</div>
                      {r.costUsd !== null ? <div>{t("board.cost", { cost: formatUsd(r.costUsd) })}</div> : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : null}
        {run ? <RunDetail key={run.id} run={run} onClose={() => onSelect(null)} onChanged={onChanged} gitlabReady={gitlabReady} /> : null}
      </div>
    </section>
  );
}

function MrLink({ run }: { run: AgentRun }) {
  if (!run.mrUrl) return null;
  return (
    <a className="inline-flex no-underline" href={run.mrUrl} target="_blank" rel="noreferrer" title={run.mrNote ?? run.mrUrl}>
      <Badge tone={run.mrDraft ? "warn" : "accent"}>
        MR !{run.mrIid}
        {run.mrDraft ? " draft" : ""}
      </Badge>
    </a>
  );
}

function RunDetail({ run, onClose, onChanged, gitlabReady }: { run: AgentRun; onClose: () => void; onChanged: () => void; gitlabReady: boolean }) {
  const { client } = useHive();
  const t = useT();
  const desktop = client.desktop!;
  const live = run.status === "running" || run.status === "queued";
  const pulse = usePulse(live, 1500);
  const log = useQuery(() => desktop.runLog(run.id), [desktop, run.id, pulse, run.status]);
  const [diff, setDiff] = useState<string | null>(null);
  const action = useAction();
  const pre = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const el = pre.current;
    if (el && live) el.scrollTop = el.scrollHeight;
  }, [log.data, live]);

  return (
    <aside className="min-w-0 lg:sticky lg:top-3" aria-label={`Run ${run.id}`}>
      <Card className="gap-3 py-4">
        <CardContent className="flex flex-col gap-3 px-4">
          <div className="flex flex-wrap items-center gap-2">
            <b className="font-mono text-sm">{run.id}</b>
            <Badge tone={STATUS_TONE[run.status] ?? "neutral"}>{t(`runStatus.${run.status}`)}</Badge>
            <span className="min-w-0 flex-1 text-xs text-muted-foreground wrap-anywhere">
              {run.taskId} · {t(`agentRole.${run.role}`)} · {run.profileId ?? t("board.waitingProfile")} ·{" "}
              {t("board.attemptOf", { n: run.attempt, max: run.maxAttempts })}
            </span>
            <Button size="icon-sm" variant="ghost" onClick={onClose} aria-label={t("common.close")}>
              <X />
            </Button>
          </div>
          {run.branch ? (
            <div className="font-mono text-xs break-all text-muted-foreground">
              {run.branch} · {t("board.commits", { count: run.commits })}
              {run.headSha ? ` · ${run.headSha}` : ""}
            </div>
          ) : null}
          {run.costUsd !== null ? (
            <div className="text-xs text-muted-foreground">
              {t("board.costDetail", {
                cost: formatUsd(run.costUsd),
                input: run.inputTokens === null ? "?" : formatCount(run.inputTokens),
                output: run.outputTokens === null ? "?" : formatCount(run.outputTokens),
              })}
            </div>
          ) : null}
          {run.error ? (
            <Notice tone={run.status === "queued" ? "info" : "warn"} className="wrap-anywhere">
              {run.error}
            </Notice>
          ) : null}
          {run.mrUrl || run.mrState ? (
            <div className="flex flex-wrap items-center gap-2">
              <MrLink run={run} />
              {run.mrState ? <span className="text-xs text-muted-foreground">MR {run.mrState}</span> : null}
              {run.mrNote ? (
                <span className={cn("text-xs wrap-anywhere", run.mrState === "failed" ? "text-destructive" : "text-muted-foreground")}>{run.mrNote}</span>
              ) : null}
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {live ? (
              <Button
                size="sm"
                variant="ghost"
                className={DANGER_GHOST}
                disabled={action.busy}
                onClick={() => void action.run(async () => (await desktop.cancelRun(run.id), onChanged()))}
              >
                {t("board.cancelRun")}
              </Button>
            ) : null}
            {gitlabReady && run.status === "succeeded" && run.role !== "plan" && run.commits > 0 ? (
              <Button
                size="sm"
                variant="outline"
                disabled={action.busy}
                onClick={() => void action.run(async () => (await desktop.createMergeRequest(run.id), onChanged()))}
              >
                {run.mrUrl ? t("board.updateMr") : t("board.createMr")}
              </Button>
            ) : null}
            {run.worktree ? (
              <>
                <Button size="sm" variant="outline" onClick={() => void action.run(async () => setDiff(await desktop.runDiff(run.id)))}>
                  {t("proposals.showChanges")}
                </Button>
                <Button size="sm" variant="outline" onClick={() => void action.run(() => desktop.showInFolder(run.worktree!))}>
                  {t("board.openWorktree")}
                </Button>
                {!live ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      if (window.confirm(t("board.confirmRemoveWorktree"))) {
                        void action.run(async () => (await desktop.removeWorktree(run.id), onChanged()));
                      }
                    }}
                  >
                    {t("board.removeWorktree")}
                  </Button>
                ) : null}
              </>
            ) : null}
          </div>
          <ErrorNote error={action.error} />
          {diff !== null ? (
            <pre className="max-h-60 overflow-auto rounded-md border bg-muted/50 p-3 font-mono text-xs whitespace-pre-wrap wrap-anywhere">{diff}</pre>
          ) : null}
          <pre
            className="max-h-96 overflow-auto rounded-md border bg-muted/50 p-3 font-mono text-xs whitespace-pre-wrap wrap-anywhere"
            ref={pre}
            aria-label="Log"
          >
            {log.data || (live ? t("board.waitingOutput") : t("board.noLog"))}
          </pre>
        </CardContent>
      </Card>
    </aside>
  );
}
