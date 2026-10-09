import { useChatPageContext } from "#ui/components/ChatSession.tsx";
// Tính năng on the web (roadmap 49d, docs/specs/49-ux-roles.md "Trang Tính năng"), in place of the Spec page there:
// a board by step (Spec → Plan → Tasks → Đang làm → Review → Xong), a card per 34b flow or per specs/ folder no flow
// made, and a feature's own page with its files, a Kiểm thử checklist, its runs and its gates. A gate's buttons sit
// beside what it decides on. #/features?project=&flow= opens a flow's, ?project=&dir=&branch= a folder's (the Spec
// page's links, #/specs?…, come here). The desktop app keeps its Spec page (pages/Specs.tsx).
import { useEffect, useMemo, useState } from "react";
import { SPEC_FILES, specNextStep, type RunRecord, type SdlcGateRecord, type SpecFile } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Checkbox } from "@xdev-hive/ui/components/ui/checkbox";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { Tag } from "@xdev-hive/ui/components/ui/primitives";
import "./pipeline-features.css";
import { Textarea } from "@xdev-hive/ui/components/ui/textarea";
import { ErrorNote } from "#ui/components/common.tsx";
import { DocMarkdown } from "#ui/components/DocMarkdown.tsx";
import { AcceptanceEvidence } from "#ui/components/AcceptanceEvidence.tsx";
import { MOVING } from "#ui/components/FlowCard.tsx";
import { PaneEmpty } from "#ui/components/panes.tsx";
import { MobileBack } from "#ui/components/MobileDetail.tsx";
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
import { fold } from "#ui/lib/text.ts";
import { inScope, projectScope, scopeFilter, scopeKey } from "#ui/lib/scope.ts";
import { flowStep, taskStep, allPipelineFlows } from "#ui/lib/pipeline.ts";
import { useToast } from "#ui/shell/toast.tsx";
import { ImportTasks, Progress, SpecRun } from "./Specs.tsx";

/** The right sdlc.decide asks for at a gate, named for the person who lacks it. */
const gateRight = (g: Pick<SdlcGateRecord, "gate">): "codeReview" | "qaVerify" | "taskManage" | "runDispatch" => (g.gate === "test" ? "qaVerify" : g.gate === "review" || g.gate === "merge" ? "codeReview" : g.gate === "tasks" ? "taskManage" : "runDispatch");

export function FeaturesPage() {
  const { client, scope, setScope } = useHive();
  const t = useT();
  const allow = useCan();
  const [linkProject] = useHashParam("project");
  const [linkFlow] = useHashParam("flow");
  const [linkStep] = useHashParam("pipelineStep");
  const [linkColumn] = useHashParam("column");
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
      allPipelineFlows(client, filter),
      client.call("sdlc.flowTasks", filter),
      client.call("tasks.list", filter),
    ]);
    return featureItems(flows, specs, flowTasks, tasks);
  }, [client, scopeKey(scope), poll]);
  const items = data.data ?? [];
  useEffect(() => setMoving((data.data ?? []).some((x) => x.flow && (MOVING.has(x.flow.state) || x.column === "doing"))), [data.data]);
  const current = linked ? findFeature(items, { project: linkProject, flow: linkFlow, dir: linkDir, branch: linkBranch }) : null;
  const manyProjects = scope.kind !== "project";
  useChatPageContext(current ? { id: current.flow?.taskId ?? current.spec?.dir ?? current.key, href: featureHref(current), project: current.project } : null);

  // Roadmap 20d: a new feature's spec written by an agent, in a project's scope (the run needs one repo).
  const newProject = scope.kind === "project" && allow(scope.project, "taskManage") && allow(scope.project, "runDispatch") ? scope.project : null;
  return <Board items={items.filter((item) => (!linkColumn || item.column === linkColumn) && (!linkStep || (item.flow?.step !== "dispatch" && item.flow && flowStep(item.flow) === linkStep) || item.tasks.some((task) => taskStep(task) === linkStep)))} loaded={!!data.data} error={data.error} shared={shared} manyProjects={manyProjects} newProject={newProject} newWork={newWork} initialBoard={!!linkStep || !!linkColumn} selected={current} notFound={linked && !current && !!data.data} onChanged={data.reload} />;
}

/** Whether any gate of the card waits for this person. */
function useMine() {
  const allow = useCan();
  return (item: FeatureItem) => item.waiting.some((g) => mayDecide(allow, g));
}

// The design's five stages: review counts as being worked on, as the board's Review column sits between doing and done.
const STAGE_OF: Record<FeatureColumn, number> = { spec: 1, plan: 2, tasks: 3, doing: 4, review: 4, done: 5 };
const STAGE_NAME = ["specify", "plan", "tasks", "implement", "done"] as const;

function Board({ items, loaded, error, shared, manyProjects, newProject, newWork, initialBoard, selected, notFound, onChanged }: { items: FeatureItem[]; loaded: boolean; error: string | null; shared: boolean; manyProjects: boolean; newProject: string | null; newWork: string | null; initialBoard: boolean; selected: FeatureItem | null; notFound: boolean; onChanged: () => void }) {
  const t = useT();
  const mine = useMine();
  const [q, setQ] = useState("");
  const [onlyMine, setOnlyMine] = useState(false);
  const [mode, setMode] = useState<"list" | "board">(initialBoard ? "board" : "list");
  const [creating, setCreating] = useState(!!newWork);
  // The board stays mounted when + Mới opens another feature: its new key opens the form again.
  useEffect(() => {
    if (newWork) setCreating(true);
  }, [newWork]);
  // A card of the board opens its feature, which only the two-column view shows: the mode follows the address.
  useEffect(() => {
    if (selected) setMode("list");
  }, [selected?.key]);
  const needle = fold(q.trim());
  const mineCount = items.filter(mine).length;
  const shown = items.filter((x) => (!needle || fold(`${x.title} ${x.project} ${x.flow?.taskId ?? ""} ${x.spec?.dir ?? ""} ${x.spec?.branch ?? ""}`).includes(needle)) && (!onlyMine || mine(x)));
  const inColumn = (c: FeatureColumn) => shown.filter((x) => x.column === c);
  // On a phone one column at a time: the first with something waiting for you, else the first with anything.
  const [picked, setPicked] = useState<FeatureColumn | null>(null);
  const active = picked ?? FEATURE_COLUMNS.find((c) => inColumn(c).some(mine)) ?? FEATURE_COLUMNS.find((c) => inColumn(c).length) ?? "spec";
  const board = mode === "board" && !selected;
  const current = selected ?? shown[0] ?? null;
  const pickMode = (next: "list" | "board") => {
    setMode(next);
    // Leaving a feature for the board: the address drops its link, or the feature would pull the view back.
    if (next === "board" && selected) window.location.hash = "#/features";
  };
  const form = creating && newProject ? (
    <div className="max-w-[760px]" data-feature-new={newProject}>
      {/* Keyed by the opening, so a second + Mới starts from an empty draft rather than the previous one's. */}
      <SpecRun key={`${newWork ?? "draft"}:${newProject}`} project={newProject} step="specify" feature={null} onSent={() => setCreating(false)} />
    </div>
  ) : null;
  const newButton = newProject ? (
    <Button size="sm" variant="glass" className="self-start" onClick={() => setCreating((v) => !v)}>
      {creating ? t("specs.import.close") : t("specs.run.new")}
    </Button>
  ) : null;
  const empty = shared ? (
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
  ) : notFound ? (
    <PaneEmpty>{t("specs.notFound")}</PaneEmpty>
  ) : null;
  const filters = (
    <div className="ft-filters">
      <Input controlSize="sm" className="ft-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("features.search")} aria-label={t("features.search")} data-features-search />
      <button type="button" className="pf-tagbtn" aria-pressed={onlyMine} title={t("features.onlyMineHint")} onClick={() => setOnlyMine((v) => !v)} data-features-mine>
        <Tag active={onlyMine}>{t("features.onlyMine")} · {mineCount}</Tag>
      </button>
      <span className="pf-spacer" />
      {(["list", "board"] as const).map((m) => (
        <button key={m} type="button" className="pf-tagbtn" aria-pressed={board ? m === "board" : m === "list"} onClick={() => pickMode(m)} data-features-view={m}>
          <Tag active={board ? m === "board" : m === "list"}>{t(`features.view.${m}`)}</Tag>
        </button>
      ))}
    </div>
  );
  return (
    <div className="w-full" data-features-board data-feature-title={current?.title}>
      {form}
      <ErrorNote error={error} />
      {empty ?? (loaded ? (
        <>
          {filters}
          {board ? (
            <>
              {shown.length ? (
                <>
                  <div role="tablist" aria-label={t("features.board")} className="ft-coltabs">
                    {FEATURE_COLUMNS.map((c) => (
                      <button key={c} type="button" role="tab" id={`feature-tab-${c}`} aria-selected={active === c} aria-controls={`feature-column-${c}`} onClick={() => setPicked(c)} className="pf-tab">
                        {t(`features.column.${c}`)} · {inColumn(c).length}
                      </button>
                    ))}
                  </div>
                  <div className="ft-cols">
                    {FEATURE_COLUMNS.map((c) => {
                      const cards = inColumn(c);
                      return (
                        <section key={c} id={`feature-column-${c}`} aria-label={t("features.columnTitle", { column: t(`features.column.${c}`), count: cards.length })} data-feature-column={c} className="ft-col" data-hidden={active !== c ? "" : undefined}>
                          <h3>
                            {t(`features.column.${c}`)}
                            <span>{cards.length}</span>
                          </h3>
                          {cards.map((x) => (
                            <FeatureCard key={x.key} item={x} mine={mine(x)} manyProjects={manyProjects} current={false} />
                          ))}
                          {!cards.length ? <p className="pf-empty m-0 px-1 py-2">{t("features.columnEmpty")}</p> : null}
                        </section>
                      );
                    })}
                  </div>
                </>
              ) : (
                <PaneEmpty>{t(onlyMine && !needle ? "features.noneMine" : "specs.noMatch")}</PaneEmpty>
              )}
              {newButton}
            </>
          ) : current ? (
            <div className="ft-grid" data-detail={selected ? "" : undefined}>
              {selected ? <div className="basis-full md:hidden"><MobileBack onClick={() => { window.location.hash = "#/features"; }} /></div> : null}
              <nav className="ft-list" aria-label={t("features.board")}>
                {shown.map((x) => (
                  <FeatureCard key={x.key} item={x} mine={mine(x)} manyProjects={manyProjects} current={x.key === current.key} />
                ))}
                {!shown.length ? <p className="pf-empty m-0 px-2 py-2">{t(onlyMine && !needle ? "features.noneMine" : "specs.noMatch")}</p> : null}
                {newButton}
              </nav>
              <FeatureView key={current.key} item={current} manyProjects={manyProjects} onChanged={onChanged} />
            </div>
          ) : (
            <>
              <PaneEmpty>{t(onlyMine && !needle ? "features.noneMine" : "specs.noMatch")}</PaneEmpty>
              {newButton}
            </>
          )}
        </>
      ) : null)}
    </div>
  );
}

function FeatureCard({ item: x, mine, manyProjects, current }: { item: FeatureItem; mine: boolean; manyProjects: boolean; current: boolean }) {
  const t = useT();
  const stage = STAGE_OF[x.column];
  const waiting = x.waiting.length > 0;
  return (
    <a href={featureHref(x)} data-feature-card={x.flow?.taskId ?? x.spec?.dir} data-feature-mine={mine ? "" : undefined} aria-current={current} className="ft-card outline-none focus-visible:focus-ring">
      <span className="ft-card-top">
        <b>{x.title}</b>
        <span>{manyProjects ? x.project : x.flow?.taskId ?? x.spec?.dir}{!x.flow && x.spec?.branch ? ` · ${x.spec.branch}` : ""}</span>
      </span>
      <span className="ft-bar" aria-hidden="true">
        {[1, 2, 3, 4, 5].map((i) => (
          <i key={i} data-on={i < stage || stage === 5 ? "done" : i === stage ? "now" : undefined} />
        ))}
      </span>
      <span className="ft-stage" data-tone={stage === 5 ? "done" : waiting ? "gate" : undefined} title={waiting ? t(mine ? "features.waitingYou" : "features.waitingOther") : undefined}>
        {t(`specs.stage.${STAGE_NAME[stage - 1]!}`)}
        {waiting ? ` · ${t(mine ? "features.waitingYou" : "features.waitingOther")}` : ""}
      </span>
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
  const canRun = !!spec && ["spec", "plan", "tasks"].includes(shown) && !item.flow && next !== null && allow(spec.project, "runDispatch") && allow(spec.project, "taskManage");
  const fileOf = (tab: FeatureTab): SpecFile | null => (tab === "spec" || tab === "plan" || tab === "tasks" ? tab : null);
  const has = (f: SpecFile) => !!files && files[f] !== null;
  const enabled = (tab: FeatureTab) => {
    const file = fileOf(tab);
    if (!file) return true;
    return has(file) || item.waiting.some((g) => gateTab(g) === tab) || (tab === "tasks" && item.tasks.length > 0);
  };
  const file = fileOf(shown);
  const text = file && files ? files[file] : null;

  const scope = `${manyProjects ? `${item.project} · ` : ""}${spec ? `specs/${spec.dir}` : (item.flow?.taskId ?? "")}`;
  return (
    <div className="ft-main" data-feature-view={item.key}>
      <div className="flex flex-col gap-2">
        <span className="ft-branch">{spec?.branch ? `${scope} · ${spec.branch}` : scope}</span>
        <h2 className="ft-h2">{item.title}</h2>
      </div>
      {/* The gate's buttons sit at the top whatever the tab: it is what the feature waits for. */}
      {item.waiting.map((g) => (
        <GateDecision key={g.id} gate={g} task={g.taskId} item={item} onDone={onChanged} />
      ))}
      <div className="ft-tabs" role="tablist" aria-label={t("features.tabsLabel")}>
        {FEATURE_TABS.map((tab) => (
          <button key={tab} type="button" role="tab" className="pf-tagbtn" aria-selected={shown === tab} disabled={!enabled(tab)} onClick={() => pick(tab)} data-feature-tab={tab}>
            <Tag active={shown === tab}>{t(`features.tab.${tab}`)}</Tag>
          </button>
        ))}
      </div>
      {spec?.tasksTotal || (item.flow?.state === "stopped" && allow(item.project, "runDispatch")) || (canRun && next) || canImport ? (
        <div className="ft-tools">
          {spec?.tasksTotal ? <Progress done={spec.tasksDone} total={spec.tasksTotal} /> : null}
          {item.flow?.state === "stopped" && allow(item.project, "runDispatch") ? (
            <Button size="sm" variant="glass" disabled={retry.busy} onClick={() => void retry.run(async () => (await client.call("sdlc.retry", { taskId: item.flow!.taskId }), onChanged()))}>
              {t("flow.retry", { step: t(`flow.step.${item.flow.step}`) })}
            </Button>
          ) : null}
          {canRun && next ? (
            <Button size="sm" variant="glass" onClick={() => (setRunning((v) => !v), setImporting(false))}>
              {running ? t("specs.import.close") : t(`specs.run.step.${next}`)}
            </Button>
          ) : null}
          {canImport ? (
            <Button size="sm" variant="glass" onClick={() => (setImporting((v) => !v), setRunning(false))}>
              {importing ? t("specs.import.close") : t("specs.import.open")}
            </Button>
          ) : null}
        </div>
      ) : null}
      <ErrorNote error={detail.error ?? retry.error} />
      {/* Why the flow stopped, or what its last check said. */}
      {item.flow?.note && item.flow.state !== "gate" ? <p className="m-0 text-xs wrap-anywhere text-fg-muted">{item.flow.note}</p> : null}
      {importing && canImport && spec ? <ImportTasks feature={spec} onDone={() => setImporting(false)} /> : null}
      {running && canRun && spec && next ? <SpecRun project={spec.project} step={next} feature={spec} onSent={() => setRunning(false)} /> : null}
      {file ? (
        <>
          {shown === "tasks" && item.tasks.length ? (
            <ol className="ft-rows" data-flow-tasks={item.flow?.taskId}>
              {item.tasks.map((x, i) => (
                <li key={x.taskId} className="ft-row">
                  <span className="ft-mark">{i + 1}</span>
                  <span className="ft-row-text">
                    <a className="hover:underline" href={`#/tasks?task=${encodeURIComponent(x.taskId)}`}>{x.taskId}</a>
                    <span>{t(`flow.stage.${x.stage}`, { gate: x.gate ? t(`sdlc.gate.${x.gate.gate}`) : "" })}{x.fixRounds ? ` · ${t("flow.fixRounds", { count: x.fixRounds })}` : ""}</span>
                  </span>
                </li>
              ))}
            </ol>
          ) : null}
          {!spec ? (
            <p className="m-0 text-[13px] text-fg-muted">{t("features.writing")}</p>
          ) : text !== null ? (
            <DocMarkdown text={text} />
          ) : files ? (
            shown === "tasks" && item.tasks.length ? null : <p className="m-0 text-[13px] text-fg-muted">{t("specs.noFile", { file: `${file}.md` })}</p>
          ) : null}
        </>
      ) : shown === "checks" ? (
        <>
          <AcceptanceEvidence key={item.key} item={item} />
          <details className="ft-row block"><summary className="min-h-11 cursor-pointer text-sm font-medium">{t("evidence.personal")}</summary><Checks item={item} spec={files ? files.spec : spec ? undefined : null} canVerify={allow(item.project, "qaVerify")} /></details>
        </>
      ) : shown === "runs" ? (
        <FeatureRuns item={item} />
      ) : (
        <GateHistory item={item} />
      )}
    </div>
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
  const [asking, setAsking] = useState(false);
  const may = mayDecide(allow, g);
  const needsNote = noteRequired(g);
  const gate = t(`sdlc.gate.${g.gate}`);
  // Passing a fix gate queues the fix and passing merge merges: their own words, so nobody passes one by mistake.
  const passLabel = g.gate === "fix" || g.gate === "merge" || g.gate === "test" ? t(`flow.taskPass.${g.gate}`) : t("features.decide.pass");
  const changesLabel = g.gate === "fix" || g.gate === "merge" || g.gate === "test" ? t(`flow.taskChanges.${g.gate}`) : t("features.decide.changes");
  const passWhat = g.gate === "review" ? t("flow.taskPass.review") : g.gate === "tasks" || g.gate === "dispatch" ? t(`flow.pass.${g.gate}`) : g.gate === "spec" || g.gate === "plan" ? t("flow.pass.next") : passLabel;
  const run = item.tasks.find((x) => x.taskId === task)?.runId ?? null;
  const decide = (decision: "pass" | "changes") =>
    void action.run(async () => {
      if (decision === "changes" && needsNote && !note.trim()) throw new Error(t("features.decide.needNote"));
      await client.call("sdlc.decide", { gateId: g.id, decision, note });
      toast(t(decision === "pass" ? "features.decide.passed" : "features.decide.changed", { gate, task }));
      setNote("");
      setAsking(false);
      bump();
      onDone();
    });
  const noteId = `gate-note-${g.id}`;
  return (
    <section className="ft-gate" data-gate-decision={g.id} aria-label={t("features.decide.title", { gate, task })}>
      <p>
        <b>{t("features.decide.title", { gate, task })}</b> · {t(g.status === "escalated" ? "flow.escalated" : "flow.waiting", { gate, mode: t(`sdlc.mode.${g.mode}`) })}
      </p>
      {may ? (
        <>
          <Button size="sm" variant="solid" disabled={action.busy} title={passWhat} onClick={() => decide("pass")} data-feature-pass={g.id}>
            {passLabel}
          </Button>
          {/* The design's banner has two buttons and no note box: asking for changes opens the box the agent's redo needs. */}
          <Button size="sm" variant="glass" disabled={action.busy || (asking && needsNote && !note.trim())} onClick={() => (asking ? decide("changes") : setAsking(true))} data-feature-changes={g.id}>
            {changesLabel}
          </Button>
          {asking ? (
            <div className="ft-gate-wide flex flex-col gap-1.5">
              <label htmlFor={noteId} className="text-xs font-medium text-fg-secondary">
                {t("features.decide.noteLabel")}
              </label>
              <Textarea id={noteId} rows={2} autoFocus value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} placeholder={t(needsNote ? "features.decide.noteRequired" : "features.decide.noteOptional")} />
            </div>
          ) : null}
        </>
      ) : (
        <p className="ft-gate-wide text-xs text-fg-muted">{t("features.decide.noRight", { right: t(`features.right.${gateRight(g)}`), project: g.project })}</p>
      )}
      {run ? (
        <a className="ft-gate-wide text-xs text-fg-link underline underline-offset-2" href={`#/runs?run=${encodeURIComponent(run)}`}>
          {t("features.decide.openRun")}
        </a>
      ) : null}
      {g.note ? <pre className="ft-gate-wide m-0 max-h-48 overflow-auto rounded bg-code p-2 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">{g.note}</pre> : null}
      <ErrorNote error={action.error} />
    </section>
  );
}

/**
 * Kiểm thử: the criteria and scenarios of spec.md, each ticked when tried. Marks remain browser-local as specified
 * for 49d; qaVerify controls who can change them and decide the separate test gate.
 */
function Checks({ item, spec, canVerify }: { item: FeatureItem; spec: string | null | undefined; canVerify: boolean }) {
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
    if (!canVerify) return;
    setMarks(next);
    if (key) writeChecks(key, next);
  };
  const clear = () => {
    if (!canVerify) return;
    setMarks({});
    if (key) writeChecks(key, {});
  };
  return (
    <div className="flex flex-col gap-4" data-feature-checks>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-semibold text-fg-strong" data-checks-progress>
          {t("features.checks.progress", { done: checkedCount(list, marks), total: list.length })}
        </span>
        {Object.keys(marks).length && canVerify ? (
          <Button size="sm" variant="ghost" className="max-md:min-h-11" onClick={clear}>
            {t("features.checks.reset")}
          </Button>
        ) : null}
        <span className="w-full text-xs text-fg-muted">{t("features.checks.stored")}</span>
        {!canVerify ? <span className="w-full text-xs text-fg-muted">{t("features.checks.noRight")}</span> : null}
      </div>
      {(["done", "check"] as const).map((group) => {
        const rows = list.filter((x) => x.group === group);
        if (!rows.length) return null;
        return (
          <fieldset key={group} className="m-0 flex flex-col gap-1 border-0 p-0">
            <legend className="mb-1 p-0 text-[13px] font-semibold text-fg-strong">{t(`features.checks.${group}`)}</legend>
            <p className="m-0 mb-1 text-xs text-fg-muted">{t(`features.checks.${group}Hint`)}</p>
            {rows.map((x) => (
              <CheckRow key={x.id} item={x} at={marks[x.id]} canVerify={canVerify} onChange={(on) => toggle(x.id, on)} />
            ))}
          </fieldset>
        );
      })}
    </div>
  );
}

function CheckRow({ item: x, at, canVerify, onChange }: { item: CheckItem; at: string | undefined; canVerify: boolean; onChange: (on: boolean) => void }) {
  const t = useT();
  const id = `check-${x.id}`;
  const on = x.inFile || !!at;
  return (
    <div className="flex min-h-11 items-start gap-2.5 rounded-sm px-1 py-1.5 hover:bg-hover md:min-h-8" data-check={x.id} data-checked={on ? "" : undefined}>
      <Checkbox id={id} className="mt-0.5" checked={on} disabled={x.inFile || !canVerify} onCheckedChange={(v) => onChange(v === true)} />
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
    <ul className="ft-rows" data-feature-runs>
      {shown.map((r) => (
        <RunRow key={`${r.machineId}/${r.runId}`} run={r} />
      ))}
    </ul>
  );
}

function RunRow({ run: r }: { run: RunRecord }) {
  const mark = r.status === "succeeded" ? "✓" : r.status === "failed" ? "✕" : "·";
  return (
    <li>
      <a href={`#/runs?run=${encodeURIComponent(r.runId)}`} data-feature-run={r.runId} className="ft-row outline-none focus-visible:focus-ring">
        <span className="ft-mark" data-tone={mark === "✓" ? "ok" : mark === "✕" ? "bad" : undefined}>{mark}</span>
        <span className="ft-row-text">
          <span>{r.taskId} · {runLabel("agentRole", r.role)} · {r.machine}</span>
          <span>{runLabel("runStatus", r.status)} · {formatTime(r.finishedAt ?? r.startedAt ?? r.createdAt)} · {runOutcome(r)}</span>
        </span>
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
    <ol className="ft-rows" data-feature-gates>
      {shown.map((g) => (
        <li key={g.id} className="ft-row" data-feature-gate={g.id} data-gate-status={g.status}>
          <span className="ft-mark" data-tone={g.status === "passed" ? "ok" : g.status === "rejected" ? "bad" : undefined}>{g.status === "passed" ? "✓" : g.status === "rejected" ? "✕" : "·"}</span>
          <span className="ft-row-text">
            <span>{t("features.gates.of", { gate: t(`sdlc.gate.${g.gate}`), task: g.taskId })} · {t(`flow.gateStatus.${g.status}`)} · {t(`sdlc.mode.${g.mode}`)}{g.decidedBy ? ` · ${t("features.gates.by", { who: g.decidedBy })}` : ""}</span>
            <span>{formatTime(g.decidedAt ?? g.createdAt)}{g.note ? ` · ${g.note}` : ""}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}
