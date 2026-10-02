// Spec (roadmap 20b): the Spec Kit features of the projects in scope, as machines read them from specs/<NNN-name>/ on
// the target branch and on the branches being worked on, and pushed to the hub. A list on the left (stage, progress,
// branch); the feature's spec.md, plan.md and tasks.md on the right. #/specs?project=&dir=&branch= opens one.
import { useEffect, useState } from "react";
import {
  nextSpecTaskId,
  SPEC_FILES,
  specNextStep,
  specRunTask,
  specTaskPrefix,
  type Machine,
  type SpecFeature,
  type SpecFile,
  type SpecStage,
  type SpecStep,
} from "@xdev-hive/core";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/components/ui/native-select";
import { Textarea } from "@xdev-hive/ui/components/ui/textarea";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@xdev-hive/ui/components/ui/tabs";
import { DocMarkdown } from "#ui/components/DocMarkdown.tsx";
import { ErrorNote } from "#ui/components/common.tsx";
import { FlowList } from "#ui/components/FlowCard.tsx";
import { Chip, DetailBody, DetailHeader, ListItem, ListPane, type ChipKind } from "#ui/components/panes.tsx";
import { formatTime, useAction, useCan, useHashParam, useHive, useQuery } from "#ui/hooks.ts";
import { useToast } from "#ui/shell/toast.tsx";
import { useT } from "#ui/i18n/index.tsx";
import { inScope, projectScope, scopeFilter, scopeKey } from "#ui/lib/scope.ts";
import { fold } from "#ui/lib/text.ts";

const STAGE_CHIP: Record<SpecStage, ChipKind> = { specify: "neutral", plan: "info", tasks: "info", implement: "running", done: "success" };

const idOf = (f: Pick<SpecFeature, "project" | "dir" | "branch">) => JSON.stringify([f.project, f.dir, f.branch]);

/** The link to one feature, in the frame it is shown in (the Web Admin has its own). */
function specHref(f: Pick<SpecFeature, "project" | "dir" | "branch">): string {
  const admin = window.location.hash.startsWith("#/admin/");
  const q = new URLSearchParams({ project: f.project, dir: f.dir, branch: f.branch });
  return `#/${admin ? "admin/" : ""}specs?${q}`;
}

export function SpecsPage() {
  const { client, scope, setScope } = useHive();
  const t = useT();
  // Features are a project's: the team-wide scope has none.
  const list = useQuery(async () => (scope.kind === "shared" ? [] : client.call("specs.list", scopeFilter(scope))), [client, scopeKey(scope)]);
  const [linkProject, clearLink] = useHashParam("project");
  const [linkDir] = useHashParam("dir");
  const [linkBranch] = useHashParam("branch");
  const linked = linkProject && linkDir ? idOf({ project: linkProject, dir: linkDir, branch: linkBranch ?? "" }) : null;
  const [selected, setSelected] = useState<string | null>(linked);
  useEffect(() => {
    if (linked) setSelected(linked);
  }, [linked]);
  // A link to another project's feature moves the scope there, as a doc link does.
  useEffect(() => {
    if (linkProject && !inScope(scope, linkProject)) setScope(projectScope(linkProject));
  }, [linkProject, scope, setScope]);

  const [q, setQ] = useState("");
  const needle = fold(q.trim());
  const features = list.data ?? [];
  const shown = features.filter((f) => !needle || fold(`${f.dir} ${f.title} ${f.branch} ${f.project}`).includes(needle));
  const current = features.find((f) => idOf(f) === selected) ?? null;
  const manyProjects = scope.kind !== "project";
  useEffect(() => {
    if (list.data && !current && !linkProject) setSelected(list.data[0] ? idOf(list.data[0]) : null);
  }, [list.data, current, linkProject]);

  // Roadmap 20d: a new feature's spec written by an agent, in a project's scope (the run needs one repo).
  const allow = useCan();
  const newProject = scope.kind === "project" && allow(scope.project, "taskManage") && allow(scope.project, "runDispatch") ? scope.project : null;
  const [creating, setCreating] = useState(false);

  const pick = (f: SpecFeature) => {
    setCreating(false);
    setSelected(idOf(f));
    // Shareable: the address bar names the feature, without a hashchange that would reload the page.
    window.history.replaceState(null, "", specHref(f));
  };

  return (
    <div className="flex h-full min-h-0 w-full bg-surface">
      <ListPane
        label={t("nav.specs")}
        head={
          <div className="flex items-center gap-1.5">
            <Input className="h-7 text-xs" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("specs.search")} aria-label={t("specs.search")} />
            {newProject ? (
              <Button size="sm" variant={creating ? "ghost" : "outline"} className="h-7 shrink-0 text-xs" onClick={() => setCreating((v) => !v)}>
                {creating ? t("specs.import.close") : t("specs.run.new")}
              </Button>
            ) : null}
          </div>
        }
      >
        <ErrorNote error={list.error} />
        {shown.map((f) => (
          <ListItem
            key={idOf(f)}
            selected={idOf(f) === selected}
            onClick={() => pick(f)}
            title={f.title}
            chip={
              <Chip kind={STAGE_CHIP[f.stage]} small>
                {t(`specs.stage.${f.stage}`)}
              </Chip>
            }
            sub={
              <span className="flex flex-col gap-1">
                <span className="font-mono">
                  {manyProjects ? `${f.project} · ` : ""}
                  {f.dir} · {f.branch || t("specs.targetBranch")}
                </span>
                {f.tasksTotal ? <Progress done={f.tasksDone} total={f.tasksTotal} /> : null}
              </span>
            }
            meta={`${f.machine} · ${formatTime(f.pushedAt)} · ${f.commit}`}
          />
        ))}
        {list.data && !features.length ? <p className="m-0 px-3 py-8 text-center text-xs/5 text-fg-muted">{t("specs.empty")}</p> : null}
        {features.length && !shown.length ? <p className="m-0 px-3 py-8 text-center text-xs text-fg-muted">{t("specs.noMatch")}</p> : null}
      </ListPane>
      <div className="flex min-w-0 flex-1 flex-col">
        {creating && newProject ? (
          <>
            <DetailHeader scope={newProject} title={t("specs.run.newTitle")} />
            <DetailBody>
              <SpecRun project={newProject} step="specify" feature={null} onSent={() => setCreating(false)} />
              {/* New features have no folder until the specify run pushed one: their flows show here meanwhile. */}
              <FlowList project={newProject} openOnly />
            </DetailBody>
          </>
        ) : current ? (
          <SpecReader key={idOf(current)} feature={current} manyProjects={manyProjects} />
        ) : (
          <div className="grid flex-1 place-items-center p-6 text-[13px] text-fg-muted">
            {list.data && selected && linkProject ? (
              <span>
                {t("specs.notFound")}{" "}
                <button type="button" className="cursor-pointer text-fg-link underline" 
                  onClick={() => {
                    clearLink();
                    setSelected(null);
                  }}
                >
                  {t("specs.showAll")}
                </button>
              </span>
            ) : list.data && features.length ? (
              t("specs.pick")
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

function Progress({ done, total }: { done: number; total: number }) {
  const t = useT();
  return (
    <span className="flex items-center gap-2" title={t("specs.progress", { done, total })}>
      <span className="h-1 w-24 overflow-hidden rounded-full bg-neutral-soft">
        <span className="block h-full rounded-full bg-success-solid" style={{ width: `${Math.round((done / total) * 100)}%` }} />
      </span>
      <span className="text-[11px]/none tabular-nums text-fg-muted">
        {done}/{total}
      </span>
    </span>
  );
}

function SpecReader({ feature, manyProjects }: { feature: SpecFeature; manyProjects: boolean }) {
  const { client } = useHive();
  const t = useT();
  const detail = useQuery(() => client.call("specs.get", { project: feature.project, dir: feature.dir, branch: feature.branch }), [client, idOf(feature), feature.pushedAt]);
  const files = detail.data?.files;
  const [tab, setTab] = useState<SpecFile>("spec");
  // The furthest file there is, once it has loaded: what the feature is at now.
  useEffect(() => {
    if (files) setTab([...SPEC_FILES].reverse().find((f) => files[f] !== null) ?? "spec");
  }, [files]);
  const text = files?.[tab] ?? null;
  const allow = useCan();
  // Roadmap 20c: tasks.md into board tasks, from the Tasks tab.
  const [importing, setImporting] = useState(false);
  const canImport = tab === "tasks" && files?.tasks != null && allow(feature.project, "taskManage");
  // Roadmap 20d: the next Spec Kit step as an agent's run.
  const next = specNextStep(feature.stage);
  const [running, setRunning] = useState(false);
  const canRun = next !== null && allow(feature.project, "runDispatch") && allow(feature.project, "taskManage");
  // A feature on a run's branch is a flow's (roadmap 34b): its gates show here.
  const flowTask = /^ai\/(.+)$/.exec(feature.branch)?.[1] ?? null;
  return (
    <>
      <DetailHeader
        chips={
          <>
            <Chip kind={STAGE_CHIP[feature.stage]}>{t(`specs.stage.${feature.stage}`)}</Chip>
            <Chip kind={feature.branch ? "warning" : "neutral"}>{feature.branch || t("specs.targetBranch")}</Chip>
          </>
        }
        scope={`${manyProjects ? `${feature.project} · ` : ""}specs/${feature.dir}`}
        when={`${feature.machine} · ${formatTime(feature.pushedAt)} · ${feature.commit}`}
        title={feature.title}
      />
      <div className="flex shrink-0 items-center gap-3 border-b border-line-subtle px-6 py-2">
        <Tabs value={tab} onValueChange={(v) => setTab(v as SpecFile)}>
          <TabsList>
            {SPEC_FILES.map((f) => (
              <TabsTrigger key={f} value={f} className="px-3" disabled={!files || files[f] === null}>
                {t(`specs.file.${f}`)}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        {feature.tasksTotal ? <Progress done={feature.tasksDone} total={feature.tasksTotal} /> : null}
        <span className="ml-auto flex gap-1.5">
          {canRun ? (
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
        <ErrorNote error={detail.error} />
        {importing && canImport ? <ImportTasks feature={feature} onDone={() => setImporting(false)} /> : null}
        {running && canRun ? <SpecRun project={feature.project} step={next} feature={feature} onSent={() => setRunning(false)} /> : null}
        {flowTask ? <FlowList project={feature.project} taskId={flowTask} /> : null}
        {detail.data === null ? <p className="m-0 text-[13px] text-fg-muted">{t("specs.notFound")}</p> : null}
        {text !== null ? <DocMarkdown text={text} /> : files ? <p className="m-0 text-[13px] text-fg-muted">{t("specs.noFile", { file: `${tab}.md` })}</p> : null}
      </DetailBody>
    </>
  );
}

/**
 * tasks.md into board tasks (roadmap 20c): what the hub would make, with what each waits for, then the tasks. Lines
 * already done are left out, tasks already on the board stay as they are.
 */
function ImportTasks({ feature, onDone }: { feature: SpecFeature; onDone: () => void }) {
  const { client, bump } = useHive();
  const t = useT();
  const toast = useToast();
  const action = useAction();
  const [prefix, setPrefix] = useState(specTaskPrefix(feature.dir));
  const valid = /^[A-Za-z0-9._-]{1,40}$/.test(prefix);
  const input = { project: feature.project, dir: feature.dir, branch: feature.branch, prefix };
  const plan = useQuery(async () => (valid ? client.call("specs.importTasks", { ...input, dryRun: true }) : null), [client, idOf(feature), prefix, feature.pushedAt]);
  const fresh = plan.data?.tasks.filter((x) => !x.exists) ?? [];
  const short = (id: string) => id.slice(prefix.length + 1);
  return (
    <section className="mb-4 flex flex-col gap-3 rounded-md border border-line-default bg-surface p-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-xs text-fg-secondary">
          {t("specs.import.prefix")}
          <Input className="h-7 w-28 font-mono text-xs" value={prefix} onChange={(e) => setPrefix(e.target.value.trim())} aria-label={t("specs.import.prefix")} />
        </label>
        <span className="text-xs text-fg-muted">{t("specs.import.hint", { example: `${prefix}-T001` })}</span>
      </div>
      <ErrorNote error={plan.error ?? action.error} />
      {plan.data?.warnings.length ? <p className="m-0 text-xs text-warning">{t("specs.import.tooMany", { tasks: plan.data.warnings.join("; ") })}</p> : null}
      {plan.data ? (
        <div className="max-h-80 overflow-auto rounded-sm border border-line-subtle">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-surface text-left text-fg-muted">
              <tr>
                <th className="px-2 py-1 font-medium">{t("specs.import.colId")}</th>
                <th className="px-2 py-1 font-medium">{t("specs.import.colTitle")}</th>
                <th className="px-2 py-1 font-medium">{t("specs.import.colWaits")}</th>
              </tr>
            </thead>
            <tbody>
              {plan.data.tasks.map((x) => (
                <tr key={x.id} className="border-t border-line-subtle align-top">
                  <td className="px-2 py-1 font-mono whitespace-nowrap">
                    {x.id}
                    {x.exists ? <span className="ml-1.5 text-fg-muted">· {t("specs.import.exists")}</span> : null}
                  </td>
                  <td className="px-2 py-1">
                    <div className="text-fg-primary">{x.title}</div>
                    <div className="text-[11px] text-fg-muted">{x.phase}</div>
                  </td>
                  <td className="px-2 py-1 font-mono text-fg-muted">{x.dependsOn.map(short).join(", ") || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <div>
        <Button
          size="sm"
          disabled={action.busy || !fresh.length}
          onClick={() =>
            void action.run(async () => {
              const r = await client.call("specs.importTasks", input);
              toast(t("specs.import.done", { count: r.created.length }));
              bump();
              onDone();
            })
          }
        >
          {fresh.length ? t("specs.import.go", { count: fresh.length }) : t("specs.import.nothing")}
        </Button>
      </div>
    </section>
  );
}

/** Machines that can take a project's run now: online, taking runs from the hub, with the project's repo. */
const fits = (m: Machine, project: string) => m.online && m.acceptsRuns && m.projects.includes(project);

/**
 * One Spec Kit step as an agent's run (roadmap 20d): the feature's task (made when it has none), then the run, on a
 * machine that has the repo. The run's result is reviewed like any other: its branch, its MR, Merge.
 */
function SpecRun({ project, step, feature, onSent }: { project: string; step: SpecStep; feature: SpecFeature | null; onSent: () => void }) {
  const { client, bump } = useHive();
  const t = useT();
  const toast = useToast();
  const action = useAction();
  const machines = useQuery(() => client.call("machines.list", {}), [client]);
  const tasks = useQuery(() => client.call("tasks.list", { project }), [client, project]);
  const fit = (machines.data ?? []).filter((m) => fits(m, project));
  const [machineId, setMachineId] = useState("");
  const machine = fit.find((m) => m.id === machineId) ?? fit[0] ?? null;
  const [input, setInput] = useState("");
  const ids = new Set((tasks.data ?? []).map((x) => x.id));
  const target = feature ? specRunTask(feature, step, (id) => ids.has(id)) : { taskId: nextSpecTaskId([...ids]), title: null };
  const needsInput = step === "specify";
  const ready = tasks.data && machine && target && (!needsInput || input.trim());
  return (
    <section className="mb-4 flex flex-col gap-3 rounded-md border border-line-default bg-surface p-3">
      <p className="m-0 text-xs text-fg-muted">{t(`specs.run.hint.${step}`)}</p>
      <ErrorNote error={machines.error ?? tasks.error ?? action.error} />
      {feature && tasks.data && !target ? <p className="m-0 text-xs text-warning">{t("specs.run.otherBranch", { branch: feature.branch })}</p> : null}
      {machines.data && !fit.length ? <p className="m-0 text-xs text-warning">{t("tasks.dispatchNoMachine", { project })}</p> : null}
      <Textarea
        rows={step === "specify" ? 5 : 3}
        value={input}
        maxLength={3000}
        onChange={(e) => setInput(e.target.value)}
        placeholder={t(`specs.run.input.${step}`)}
        aria-label={t(`specs.run.input.${step}`)}
      />
      <div className="flex flex-wrap items-center gap-2">
        {fit.length ? (
          <NativeSelect size="sm" value={machine?.id ?? ""} onChange={(e) => setMachineId(e.target.value)} aria-label={t("tasks.dispatchMachine")}>
            {fit.map((m) => (
              <NativeSelectOption key={m.id} value={m.id}>
                {m.machine}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        ) : null}
        {target ? <span className="font-mono text-xs text-fg-muted">{target.taskId}</span> : null}
        <Button
          size="sm"
          disabled={action.busy || !ready}
          onClick={() =>
            void action.run(async () => {
              if (!machine || !target) return;
              const title = feature ? target.title : `Spec: ${input.trim().split("\n")[0]!.slice(0, 120)}`;
              // The hub makes the task when it has none, queues the step and drives the flow through the gates (roadmap 34b).
              const { request: req } = await client.call("specs.runStep", {
                project,
                step,
                taskId: target.taskId,
                ...(title ? { title } : {}),
                ...(feature ? { dir: feature.dir } : {}),
                input,
                machineId: machine.id,
                profileId: null,
              });
              toast(t("specs.run.sent", { task: target.taskId, machine: req.machine }));
              bump();
              onSent();
            })
          }
        >
          {t(`specs.run.step.${step}`)}
        </Button>
      </div>
    </section>
  );
}
