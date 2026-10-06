// Tính năng on the web (roadmap 49d, docs/specs/49-ux-roles.md "Trang Tính năng"), in place of the Spec page there:
// a board by step (Spec → Plan → Tasks → Đang làm → Review → Xong), a card per 34b flow or per specs/ folder no flow
// made, and a feature's own page with its files, a Kiểm thử checklist, its runs and its gates. A gate's buttons sit
// beside what it decides on. #/features?project=&flow= opens a flow's, ?project=&dir=&branch= a folder's (the Spec
// page's links, #/specs?…, come here). The desktop app keeps its Spec page (pages/Specs.tsx).
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { cn } from "cn";
import { SPEC_FILES, specNextStep, type RunRecord, type SdlcGateRecord, type SpecFile } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Checkbox } from "@xdev-hive/ui/components/ui/checkbox";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@xdev-hive/ui/components/ui/tabs";
import { Textarea } from "@xdev-hive/ui/components/ui/textarea";
import { Badge, ErrorNote, STATUS_TONE } from "#ui/components/common.tsx";
import { DocMarkdown } from "#ui/components/DocMarkdown.tsx";
import { FlowTasks, MOVING, STATE_CHIP } from "#ui/components/FlowCard.tsx";
import { Chip, DetailBody, DetailHeader, PaneEmpty } from "#ui/components/panes.tsx";
import { formatTime, useAction, useCan, useHashParam, useHive, usePoll, useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import {
  checkedCount,
  checksKey,
  FEATURE_COLUMNS,
  FEATURE_TABS,
  featureChecks,
  featureHref,
  featureItems,
  featureTaskIds,
  findFeature,
  gateTab,
  isWaiting,
  mayDecide,
  noteRequired,
  ownsTask,
  readChecks,
  writeChecks,
  type CheckItem,
  type CheckMarks,
  type FeatureColumn,
  type FeatureItem,
  type FeatureTab,
} from "#ui/lib/features.ts";
import { runLabel, runOutcome } from "#ui/lib/runs.ts";
import { inScope, projectScope, scopeFilter, scopeKey } from "#ui/lib/scope.ts";
import { fold } from "#ui/lib/text.ts";
import { useToast } from "#ui/shell/toast.tsx";
import { ImportTasks, Progress, SpecRun, STAGE_CHIP } from "./Specs.tsx";

/** The right sdlc.decide asks for at a gate, named for the person who lacks it. */
const gateRight = (g: Pick<SdlcGateRecord, "gate">): "codeReview" | "taskManage" | "runDispatch" => (g.gate === "review" || g.gate === "merge" ? "codeReview" : g.gate === "tasks" ? "taskManage" : "runDispatch");

export function FeaturesPage() {
  const { client, scope, setScope } = useHive();
  const t = useT();
  const allow = useCan();
  const [linkProject] = useHashParam("project");
  const [linkFlow] = useHashParam("flow");
  const [linkDir] = useHashParam("dir");
  const [linkBranch] = useHashParam("branch");
  // + Mới's "Tính năng mới" (roadmap 49c) lands here with ?newWork=<key>, a new key per opening.
  const [newWork] = useHashParam("newWork");
  const linked = !!linkProject && (!!linkFlow || linkDir !== null);
  // A link to another project's feature moves the scope there, as the Spec page did.
  useEffect(() => {
    if (linkProject && !inScope(scope, linkProject)) setScope(projectScope(linkProject));
  }, [linkProject, scope, setScope]);

  // Features are a project's: the team-wide scope has none.
  const shared = scope.kind === "shared";
  const [moving, setMoving] = useState(false);
  // A flow that runs or waits for an agent moves by itself; one at a gate or done only when someone acts.
  const poll = usePoll(moving ? 5000 : 30_000);
  const data = useQuery(async () => {
    if (shared) return [];
    const filter = scopeFilter(scope);
    const [specs, flows, flowTasks, tasks] = await Promise.all([
      client.call("specs.list", filter),
      client.call("sdlc.flows", { ...filter, limit: 200 }),
      client.call("sdlc.flowTasks", filter),
      client.call("tasks.list", filter),
    ]);
    return featureItems(flows, specs, flowTasks, tasks);
  }, [client, scopeKey(scope), poll]);
  const items = data.data ?? [];
  useEffect(() => setMoving((data.data ?? []).some((x) => x.flow && (MOVING.has(x.flow.state) || x.column === "doing"))), [data.data]);
  const current = linked ? findFeature(items, { project: linkProject, flow: linkFlow, dir: linkDir, branch: linkBranch }) : null;
  const manyProjects = scope.kind !== "project";

  if (linked) {
    return (
      <div className="mobile-master-detail flex h-full min-h-0 w-full flex-col bg-surface" data-feature-title={current?.title}>
        <BackBar />
        {current ? (
          <FeatureView key={current.key} item={current} manyProjects={manyProjects} onChanged={data.reload} />
        ) : data.data ? (
          <PaneEmpty>{t("specs.notFound")}</PaneEmpty>
        ) : (
          <ErrorNote error={data.error} />
        )}
      </div>
    );
  }
  // Roadmap 20d: a new feature's spec written by an agent, in a project's scope (the run needs one repo).
  const newProject = scope.kind === "project" && allow(scope.project, "taskManage") && allow(scope.project, "runDispatch") ? scope.project : null;
  return <Board items={items} loaded={!!data.data} error={data.error} shared={shared} manyProjects={manyProjects} newProject={newProject} newWork={newWork} />;
}

/** Back to the board, at every width: the board and a feature are two pages of one entry. */
function BackBar() {
  const t = useT();
  return (
    <div className="shrink-0 border-b border-line-subtle px-3 py-1.5 md:px-4">
      <Button variant="ghost" size="sm" className="max-md:min-h-11" onClick={() => (window.location.hash = "#/features")}>
        <ArrowLeft />
        {t("common.backToList")}
      </Button>
    </div>
  );
}

/** Whether any gate of the card waits for this person. */
function useMine() {
  const allow = useCan();
  return (item: FeatureItem) => item.waiting.some((g) => mayDecide(allow, g));
}

function Board({ items, loaded, error, shared, manyProjects, newProject, newWork }: { items: FeatureItem[]; loaded: boolean; error: string | null; shared: boolean; manyProjects: boolean; newProject: string | null; newWork: string | null }) {
  const t = useT();
  const mine = useMine();
  const [q, setQ] = useState("");
  const [onlyMine, setOnlyMine] = useState(false);
  const [creating, setCreating] = useState(!!newWork);
  // The board stays mounted when + Mới opens another feature: its new key opens the form again.
  useEffect(() => {
    if (newWork) setCreating(true);
  }, [newWork]);
  const needle = fold(q.trim());
  const mineCount = items.filter(mine).length;
  const shown = items.filter((x) => (!needle || fold(`${x.title} ${x.project} ${x.flow?.taskId ?? ""} ${x.spec?.dir ?? ""} ${x.spec?.branch ?? ""}`).includes(needle)) && (!onlyMine || mine(x)));
  const inColumn = (c: FeatureColumn) => shown.filter((x) => x.column === c);
  // On a phone one column at a time: the first with something waiting for you, else the first with anything.
  const [picked, setPicked] = useState<FeatureColumn | null>(null);
  const active = picked ?? FEATURE_COLUMNS.find((c) => inColumn(c).some(mine)) ?? FEATURE_COLUMNS.find((c) => inColumn(c).length) ?? "spec";

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-surface" data-features-board>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line-subtle px-4 py-2 md:px-6">
        <Input className="h-11 w-full text-xs sm:w-64 md:h-7" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("features.search")} aria-label={t("features.search")} />
        <Button
          size="sm"
          variant={onlyMine ? "default" : "outline"}
          className="max-md:min-h-11"
          aria-pressed={onlyMine}
          title={t("features.onlyMineHint")}
          onClick={() => setOnlyMine((v) => !v)}
          data-features-mine
        >
          {t("features.onlyMine")} · {mineCount}
        </Button>
        {newProject ? (
          <Button size="sm" variant={creating ? "ghost" : "outline"} className="max-md:min-h-11 md:ml-auto" onClick={() => setCreating((v) => !v)}>
            {creating ? t("specs.import.close") : t("specs.run.new")}
          </Button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 md:px-6">
        {creating && newProject ? (
          <div className="max-w-[760px]" data-feature-new={newProject}>
            {/* Keyed by the opening, so a second + Mới starts from an empty draft rather than the previous one's. */}
            <SpecRun key={`${newWork ?? "draft"}:${newProject}`} project={newProject} step="specify" feature={null} onSent={() => setCreating(false)} />
          </div>
        ) : null}
        <ErrorNote error={error} />
        {shared ? (
          <PaneEmpty>{t("specs.sharedScope")}</PaneEmpty>
        ) : loaded && !items.length ? (
          <PaneEmpty
            action={
              newProject && !creating ? (
                <Button size="sm" data-empty-action onClick={() => setCreating(true)}>
                  {t("specs.newFirst")}
                </Button>
              ) : null
            }
          >
            {t("specs.empty")}
            <span className="mt-1.5 block text-[11px]/4">{t("specs.emptyHow")}</span>
          </PaneEmpty>
        ) : loaded && !shown.length ? (
          <PaneEmpty>{t(onlyMine && !needle ? "features.noneMine" : "specs.noMatch")}</PaneEmpty>
        ) : loaded ? (
          <>
            <div role="tablist" aria-label={t("features.board")} className="mb-2 flex gap-1 overflow-x-auto pb-1 md:hidden">
              {FEATURE_COLUMNS.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="tab"
                  id={`feature-tab-${c}`}
                  aria-selected={active === c}
                  aria-controls={`feature-column-${c}`}
                  onClick={() => setPicked(c)}
                  className={cn("min-h-11 shrink-0 rounded-md px-3 text-xs font-semibold outline-none focus-visible:focus-ring", active === c ? "bg-selected text-fg-strong" : "bg-subtle text-fg-secondary")}
                >
                  {t(`features.column.${c}`)} · {inColumn(c).length}
                </button>
              ))}
            </div>
            <div className="overflow-x-auto max-md:overflow-x-visible">
              <div className="grid gap-2.5 max-md:block md:min-w-[960px] md:grid-cols-6">
                {FEATURE_COLUMNS.map((c) => {
                  const cards = inColumn(c);
                  return (
                    <section
                      key={c}
                      id={`feature-column-${c}`}
                      aria-label={t("features.columnTitle", { column: t(`features.column.${c}`), count: cards.length })}
                      data-feature-column={c}
                      className={cn("flex min-h-40 min-w-0 flex-col gap-1.5 rounded-[10px] bg-subtle p-2", active !== c && "max-md:hidden")}
                    >
                      <h3 className="m-0 flex items-center gap-1.5 px-1 pt-0.5 pb-1 text-xs font-semibold text-fg-strong max-md:hidden">
                        {t(`features.column.${c}`)}
                        <span className="font-normal text-fg-muted tabular-nums">{cards.length}</span>
                      </h3>
                      {cards.map((x) => (
                        <FeatureCard key={x.key} item={x} mine={mine(x)} manyProjects={manyProjects} />
                      ))}
                      {!cards.length ? <p className="m-0 px-1 py-2 text-xs text-fg-muted">{t("features.columnEmpty")}</p> : null}
                    </section>
                  );
                })}
              </div>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

/** Where a card stands, in one chip: the flow's state, or the folder's stage when no flow drives it. */
function StandChip({ item }: { item: FeatureItem }) {
  const t = useT();
  const f = item.flow;
  if (f) return <Chip kind={STATE_CHIP[f.state]} small>{t(`flow.state.${f.state}`, { step: t(`flow.step.${f.step}`), gate: f.gate ? t(`sdlc.gate.${f.gate.gate}`) : "" })}</Chip>;
  return item.spec ? <Chip kind={STAGE_CHIP[item.spec.stage]} small>{t(`specs.stage.${item.spec.stage}`)}</Chip> : null;
}

function WaitChip({ item, mine }: { item: FeatureItem; mine: boolean }) {
  const t = useT();
  const g = item.waiting[0];
  if (!g) return null;
  const gate = t(`sdlc.gate.${g.gate}`);
  return mine ? (
    <Chip kind="warning" small title={t("features.waitingYouHint", { gate })}>
      {t("features.waitingYou")}
    </Chip>
  ) : (
    <Chip kind="neutral" small title={t("features.waitingOtherHint", { gate })}>
      {t("features.waitingOther")}
    </Chip>
  );
}

function FeatureCard({ item: x, mine, manyProjects }: { item: FeatureItem; mine: boolean; manyProjects: boolean }) {
  const t = useT();
  const merged = x.tasks.filter((k) => k.stage === "done").length;
  return (
    <a
      href={featureHref(x)}
      data-feature-card={x.flow?.taskId ?? x.spec?.dir}
      data-feature-mine={mine ? "" : undefined}
      className="flex min-h-11 flex-col gap-1.5 rounded-md border border-line-default bg-surface p-2.5 text-fg-primary no-underline outline-none hover:bg-hover focus-visible:focus-ring"
    >
      <span className="flex flex-wrap items-center gap-1">
        <WaitChip item={x} mine={mine} />
        <StandChip item={x} />
        {!x.flow ? (
          <Chip kind="neutral" small title={t("features.noFlowHint")}>
            {t("features.noFlow")}
          </Chip>
        ) : null}
      </span>
      <span className="line-clamp-3 text-[13px]/[18px] font-semibold text-pretty text-fg-strong [overflow-wrap:anywhere]">{x.title}</span>
      <span className="truncate font-mono text-[11px]/[14px] text-fg-muted max-md:text-xs">
        {manyProjects ? `${x.project} · ` : ""}
        {x.flow?.taskId ?? x.spec?.dir}
        {x.spec?.branch && !x.flow ? ` · ${x.spec.branch}` : ""}
      </span>
      {x.tasks.length ? (
        <span className="text-[11px]/[14px] text-fg-muted max-md:text-xs">{t("features.tasksDone", { done: merged, total: x.tasks.length })}</span>
      ) : x.spec?.tasksTotal ? (
        <Progress done={x.spec.tasksDone} total={x.spec.tasksTotal} />
      ) : null}
    </a>
  );
}

/** The tab to open on: the one a waiting gate decides on, else the furthest file there is. */
function firstTab(item: FeatureItem, files: Record<SpecFile, string | null> | undefined): FeatureTab {
  if (item.waiting[0]) return gateTab(item.waiting[0]);
  const last = files ? [...SPEC_FILES].reverse().find((f) => files[f] !== null) : undefined;
  if (last) return last === "tasks" && item.tasks.length ? "tasks" : last;
  return item.tasks.length ? "tasks" : "runs";
}

function FeatureView({ item, manyProjects, onChanged }: { item: FeatureItem; manyProjects: boolean; onChanged: () => void }) {
  const { client } = useHive();
  const t = useT();
  const allow = useCan();
  const spec = item.spec;
  const detail = useQuery(async () => (spec ? client.call("specs.get", { project: spec.project, dir: spec.dir, branch: spec.branch }) : null), [client, spec?.project, spec?.dir, spec?.branch, spec?.pushedAt]);
  const files = detail.data?.files;
  const [view] = useHashParam("view");
  const [tab, setTab] = useState<FeatureTab | null>((FEATURE_TABS as readonly string[]).includes(view ?? "") ? (view as FeatureTab) : null);
  const shown: FeatureTab = tab ?? (spec && !files ? "spec" : firstTab(item, files));
  const pick = (next: FeatureTab) => {
    setTab(next);
    // Shareable: the address names the tab, without a hashchange that would reload the page.
    const q = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
    q.set("view", next);
    window.history.replaceState(null, "", `#/features?${q}`);
  };
  // Roadmap 20c and 20d, as on the Spec page: tasks.md into board tasks, and the next Spec Kit step as a run.
  const [importing, setImporting] = useState(false);
  const [running, setRunning] = useState(false);
  const retry = useAction();
  const canImport = !!spec && shown === "tasks" && files?.tasks != null && allow(spec.project, "taskManage");
  const next = spec ? specNextStep(spec.stage) : null;
  const canRun = !!spec && !item.flow && next !== null && allow(spec.project, "runDispatch") && allow(spec.project, "taskManage");
  const decidingHere = item.waiting.filter((g) => gateTab(g) === shown);
  const fileOf = (tab: FeatureTab): SpecFile | null => (tab === "spec" || tab === "plan" || tab === "tasks" ? tab : null);
  const has = (f: SpecFile) => !!files && files[f] !== null;
  const enabled = (tab: FeatureTab) => {
    const file = fileOf(tab);
    if (!file) return true;
    return has(file) || item.waiting.some((g) => gateTab(g) === tab) || (tab === "tasks" && item.tasks.length > 0);
  };
  const file = fileOf(shown);
  const text = file && files ? files[file] : null;

  return (
    <>
      <DetailHeader
        chips={
          <>
            <WaitChip item={item} mine={item.waiting.some((g) => mayDecide(allow, g))} />
            <Chip kind="info">{t(`features.column.${item.column}`)}</Chip>
            <StandChip item={item} />
            {spec ? <Chip kind={spec.branch ? "warning" : "neutral"}>{spec.branch || t("specs.targetBranch")}</Chip> : null}
          </>
        }
        scope={`${manyProjects ? `${item.project} · ` : ""}${spec ? `specs/${spec.dir}` : (item.flow?.taskId ?? "")}`}
        when={spec ? `${spec.machine} · ${formatTime(spec.pushedAt)} · ${spec.commit}` : item.flow ? `${item.flow.machine} · ${formatTime(item.flow.updatedAt)}` : undefined}
        title={item.title}
      />
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line-subtle px-4 py-2 md:px-6">
        <Tabs value={shown} onValueChange={(v) => pick(v as FeatureTab)} className="min-w-0 max-w-full">
          <div className="max-w-full overflow-x-auto [scrollbar-width:none]">
            <TabsList aria-label={t("features.tabsLabel")}>
              {FEATURE_TABS.map((tab) => (
                <TabsTrigger key={tab} value={tab} className="px-3 max-md:min-h-11" disabled={!enabled(tab)} data-feature-tab={tab}>
                  {t(`features.tab.${tab}`)}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
        </Tabs>
        {spec?.tasksTotal ? <Progress done={spec.tasksDone} total={spec.tasksTotal} /> : null}
        <span className="flex flex-wrap gap-1.5 md:ml-auto md:flex-nowrap">
          {item.flow?.state === "stopped" && allow(item.project, "runDispatch") ? (
            <Button size="sm" variant="outline" disabled={retry.busy} onClick={() => void retry.run(async () => (await client.call("sdlc.retry", { taskId: item.flow!.taskId }), onChanged()))}>
              {t("flow.retry", { step: t(`flow.step.${item.flow.step}`) })}
            </Button>
          ) : null}
          {canRun && next ? (
            <Button size="sm" variant={running ? "ghost" : "outline"} onClick={() => (setRunning((v) => !v), setImporting(false))}>
              {running ? t("specs.import.close") : t(`specs.run.step.${next}`)}
            </Button>
          ) : null}
          {canImport ? (
            <Button size="sm" variant={importing ? "ghost" : "outline"} onClick={() => (setImporting((v) => !v), setRunning(false))}>
              {importing ? t("specs.import.close") : t("specs.import.open")}
            </Button>
          ) : null}
        </span>
      </div>
      <DetailBody>
        <ErrorNote error={detail.error ?? retry.error} />
        {/* Why the flow stopped, or what its last check said. */}
        {item.flow?.note && item.flow.state !== "gate" ? <p className="m-0 text-xs wrap-anywhere text-fg-muted">{item.flow.note}</p> : null}
        {importing && canImport && spec ? <ImportTasks feature={spec} onDone={() => setImporting(false)} /> : null}
        {running && canRun && spec && next ? <SpecRun project={spec.project} step={next} feature={spec} onSent={() => setRunning(false)} /> : null}
        {/* The gate's buttons beside what it decides on: the file, or the flow's tasks. */}
        {decidingHere.map((g) => (
          <GateDecision key={g.id} gate={g} task={g.taskId} item={item} onDone={onChanged} />
        ))}
        {file ? (
          <>
            {shown === "tasks" && item.flow ? <FlowTasks project={item.project} flowTask={item.flow.taskId} /> : null}
            {!spec ? (
              <p className="m-0 text-[13px] text-fg-muted">{t("features.writing")}</p>
            ) : text !== null ? (
              <DocMarkdown text={text} />
            ) : files ? (
              <p className="m-0 text-[13px] text-fg-muted">{t("specs.noFile", { file: `${file}.md` })}</p>
            ) : null}
          </>
        ) : shown === "checks" ? (
          <Checks item={item} spec={files ? files.spec : spec ? undefined : null} />
        ) : shown === "runs" ? (
          <FeatureRuns item={item} />
        ) : (
          <GateHistory item={item} />
        )}
      </DetailBody>
    </>
  );
}

/** Cho qua / Yêu cầu sửa at one gate, with the AI check's word when there is one. */
function GateDecision({ gate: g, task, item, onDone }: { gate: SdlcGateRecord; task: string; item: FeatureItem; onDone: () => void }) {
  const { client, bump } = useHive();
  const t = useT();
  const allow = useCan();
  const action = useAction();
  const toast = useToast();
  const [note, setNote] = useState("");
  const may = mayDecide(allow, g);
  const needsNote = noteRequired(g);
  const gate = t(`sdlc.gate.${g.gate}`);
  // Passing a fix gate queues the fix and passing merge merges: their own words, so nobody passes one by mistake.
  const passLabel = g.gate === "fix" || g.gate === "merge" ? t(`flow.taskPass.${g.gate}`) : t("features.decide.pass");
  const changesLabel = g.gate === "fix" || g.gate === "merge" ? t(`flow.taskChanges.${g.gate}`) : t("features.decide.changes");
  const passWhat = g.gate === "review" ? t("flow.taskPass.review") : g.gate === "tasks" || g.gate === "dispatch" ? t(`flow.pass.${g.gate}`) : g.gate === "spec" || g.gate === "plan" ? t("flow.pass.next") : passLabel;
  const run = item.tasks.find((x) => x.taskId === task)?.runId ?? null;
  const decide = (decision: "pass" | "changes") =>
    void action.run(async () => {
      if (decision === "changes" && needsNote && !note.trim()) throw new Error(t("features.decide.needNote"));
      await client.call("sdlc.decide", { gateId: g.id, decision, note });
      toast(t(decision === "pass" ? "features.decide.passed" : "features.decide.changed", { gate, task }));
      setNote("");
      bump();
      onDone();
    });
  const noteId = `gate-note-${g.id}`;
  return (
    <section className="flex flex-col gap-2 rounded-md border border-line-default bg-sunken p-3" data-gate-decision={g.id} aria-label={t("features.decide.title", { gate, task })}>
      <div className="flex flex-wrap items-center gap-2">
        <b className="text-[13px] font-semibold text-fg-strong">{t("features.decide.title", { gate, task })}</b>
        <Chip kind={g.status === "escalated" ? "danger" : "warning"} small>
          {t(`flow.gateStatus.${g.status}`)}
        </Chip>
        {run ? (
          <a className="ml-auto text-xs text-fg-link underline underline-offset-2" href={`#/runs?run=${encodeURIComponent(run)}`}>
            {t("features.decide.openRun")}
          </a>
        ) : null}
      </div>
      <p className="m-0 text-xs text-fg-secondary">{t(g.status === "escalated" ? "flow.escalated" : "flow.waiting", { gate, mode: t(`sdlc.mode.${g.mode}`) })}</p>
      {g.note ? <pre className="m-0 max-h-48 overflow-auto rounded border border-line-subtle bg-code p-2 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">{g.note}</pre> : null}
      {may ? (
        <>
          <label htmlFor={noteId} className="text-xs font-medium text-fg-secondary">
            {t("features.decide.noteLabel")}
          </label>
          <Textarea id={noteId} rows={2} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} placeholder={t(needsNote ? "features.decide.noteRequired" : "features.decide.noteOptional")} />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" className="max-md:min-h-11" disabled={action.busy} title={passWhat} onClick={() => decide("pass")} data-feature-pass={g.id}>
              {passLabel}
            </Button>
            <Button size="sm" variant="outline" className="max-md:min-h-11" disabled={action.busy || (needsNote && !note.trim())} onClick={() => decide("changes")} data-feature-changes={g.id}>
              {changesLabel}
            </Button>
          </div>
        </>
      ) : (
        <p className="m-0 text-xs text-fg-muted">{t("features.decide.noRight", { right: t(`features.right.${gateRight(g)}`), project: g.project })}</p>
      )}
      <ErrorNote error={action.error} />
    </section>
  );
}

/**
 * Kiểm thử: the criteria and scenarios of spec.md, each ticked when tried. Kept in this browser (localStorage), the
 * lightest place there is: a shared record needs a hub method, which waits for the QA role spec 49 left for later.
 */
function Checks({ item, spec }: { item: FeatureItem; spec: string | null | undefined }) {
  const t = useT();
  const list = useMemo(() => featureChecks(spec ?? null), [spec]);
  const key = item.spec ? checksKey(item.project, item.spec.dir) : null;
  const [marks, setMarks] = useState<CheckMarks>(() => (key ? readChecks(key) : {}));
  if (spec === undefined) return null;
  if (spec === null) return <PaneEmpty>{t("features.checks.noSpec")}</PaneEmpty>;
  if (!list.length) return <PaneEmpty>{t("features.checks.none")}</PaneEmpty>;
  const toggle = (id: string, on: boolean) => {
    const next = { ...marks };
    if (on) next[id] = new Date().toISOString();
    else delete next[id];
    setMarks(next);
    if (key) writeChecks(key, next);
  };
  const clear = () => {
    setMarks({});
    if (key) writeChecks(key, {});
  };
  return (
    <div className="flex flex-col gap-4" data-feature-checks>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-semibold text-fg-strong" data-checks-progress>
          {t("features.checks.progress", { done: checkedCount(list, marks), total: list.length })}
        </span>
        {Object.keys(marks).length ? (
          <Button size="sm" variant="ghost" className="max-md:min-h-11" onClick={clear}>
            {t("features.checks.reset")}
          </Button>
        ) : null}
        <span className="w-full text-xs text-fg-muted">{t("features.checks.stored")}</span>
      </div>
      {(["done", "check"] as const).map((group) => {
        const rows = list.filter((x) => x.group === group);
        if (!rows.length) return null;
        return (
          <fieldset key={group} className="m-0 flex flex-col gap-1 border-0 p-0">
            <legend className="mb-1 p-0 text-[13px] font-semibold text-fg-strong">{t(`features.checks.${group}`)}</legend>
            <p className="m-0 mb-1 text-xs text-fg-muted">{t(`features.checks.${group}Hint`)}</p>
            {rows.map((x) => (
              <CheckRow key={x.id} item={x} at={marks[x.id]} onChange={(on) => toggle(x.id, on)} />
            ))}
          </fieldset>
        );
      })}
    </div>
  );
}

function CheckRow({ item: x, at, onChange }: { item: CheckItem; at: string | undefined; onChange: (on: boolean) => void }) {
  const t = useT();
  const id = `check-${x.id}`;
  const on = x.inFile || !!at;
  return (
    <div className="flex min-h-11 items-start gap-2.5 rounded-sm px-1 py-1.5 hover:bg-hover md:min-h-8" data-check={x.id} data-checked={on ? "" : undefined}>
      <Checkbox id={id} className="mt-0.5" checked={on} disabled={x.inFile} onCheckedChange={(v) => onChange(v === true)} />
      <label htmlFor={id} className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 text-[13px]/5 text-fg-primary [overflow-wrap:anywhere]">
        <span className={on ? "text-fg-secondary" : undefined}>{x.text}</span>
        {x.under || x.inFile || at ? (
          <span className="text-[11px]/4 text-fg-muted max-md:text-xs">
            {[x.under, x.inFile ? t("features.checks.inFile") : at ? t("features.checks.checkedAt", { time: formatTime(at) }) : null].filter(Boolean).join(" · ")}
          </span>
        ) : null}
      </label>
    </div>
  );
}

/** The runs of the feature's tasks: the flow's steps and reviews, and each task's builds and fixes. */
function FeatureRuns({ item }: { item: FeatureItem }) {
  const { client } = useHive();
  const t = useT();
  const runs = useQuery(() => client.call("runs.list", { project: item.project, limit: 200 }), [client, item.project, item.updatedAt]);
  const owned = featureTaskIds(item);
  const shown = (runs.data ?? []).filter((r) => ownsTask(owned, r.taskId));
  if (runs.error) return <ErrorNote error={runs.error} />;
  if (!runs.data) return null;
  if (!shown.length) return <PaneEmpty>{t("features.runs.none")}</PaneEmpty>;
  return (
    <ul className="m-0 flex list-none flex-col gap-1.5 p-0" data-feature-runs>
      {shown.map((r) => (
        <RunRow key={`${r.machineId}/${r.runId}`} run={r} />
      ))}
    </ul>
  );
}

function RunRow({ run: r }: { run: RunRecord }) {
  return (
    <li>
      <a
        href={`#/runs?run=${encodeURIComponent(r.runId)}`}
        data-feature-run={r.runId}
        className="flex min-h-11 flex-col gap-1 rounded-md border border-line-default bg-surface px-3 py-2 text-fg-primary no-underline outline-none hover:bg-hover focus-visible:focus-ring"
      >
        <span className="flex flex-wrap items-center gap-2">
          <Badge tone={STATUS_TONE[r.status] ?? "neutral"}>{runLabel("runStatus", r.status)}</Badge>
          <span className="font-mono text-xs text-fg-strong">{r.taskId}</span>
          <span className="text-xs text-fg-muted">{runLabel("agentRole", r.role)}</span>
          <span className="ml-auto font-mono text-[11px] text-fg-muted max-md:text-xs">
            {r.machine} · {formatTime(r.finishedAt ?? r.startedAt ?? r.createdAt)}
          </span>
        </span>
        <span className="truncate text-xs text-fg-secondary">{runOutcome(r)}</span>
      </a>
    </li>
  );
}

/** Every gate the feature reached, the newest first: who decided, how, and what they wrote. */
function GateHistory({ item }: { item: FeatureItem }) {
  const { client } = useHive();
  const t = useT();
  const gates = useQuery(() => client.call("sdlc.gates", { project: item.project, limit: 200 }), [client, item.project, item.updatedAt]);
  const owned = featureTaskIds(item);
  const shown = (gates.data ?? []).filter((g) => ownsTask(owned, g.taskId)).sort((a, b) => (b.decidedAt ?? b.createdAt).localeCompare(a.decidedAt ?? a.createdAt));
  if (gates.error) return <ErrorNote error={gates.error} />;
  if (!gates.data) return null;
  if (!shown.length) return <PaneEmpty>{t("features.gates.none")}</PaneEmpty>;
  return (
    <ol className="m-0 flex list-none flex-col gap-1.5 p-0" data-feature-gates>
      {shown.map((g) => (
        <li key={g.id} className="flex flex-col gap-1 rounded-md border border-line-subtle bg-surface px-3 py-2" data-feature-gate={g.id} data-gate-status={g.status}>
          <span className="flex flex-wrap items-center gap-2 text-xs">
            <b className="font-semibold text-fg-strong">{t("features.gates.of", { gate: t(`sdlc.gate.${g.gate}`), task: g.taskId })}</b>
            <Chip kind={g.status === "passed" ? "success" : g.status === "rejected" ? "danger" : isWaiting(g) ? "warning" : "info"} small>
              {t(`flow.gateStatus.${g.status}`)}
            </Chip>
            <span className="text-fg-muted">{t(`sdlc.mode.${g.mode}`)}</span>
            {g.decidedBy ? <span className="font-mono text-fg-muted">{t("features.gates.by", { who: g.decidedBy })}</span> : null}
            <span className="ml-auto text-fg-muted">{formatTime(g.decidedAt ?? g.createdAt)}</span>
          </span>
          {g.note ? <p className="m-0 text-xs whitespace-pre-wrap text-fg-secondary [overflow-wrap:anywhere]">{g.note}</p> : null}
        </li>
      ))}
    </ol>
  );
}
