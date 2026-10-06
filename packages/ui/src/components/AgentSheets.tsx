// The forms that give work to agents (roadmaps 31a, 31c, 31d, 31e, 32b): one prompt for one or several agents, picked
// tasks for several at once, a big job in parts, and a chain of roles on one task. The Task page and the agent map (31b)
// open them.
import { useState } from "react";
import { cn } from "cn";
import { Plus, Send } from "lucide-react";
import {
  WORK_ROLES,
  type WorkRole,
  type PreferKind,
  MAX_MAP_PART,
  MAX_MAP_PARTS,
  MAX_MAP_PROMPT,
  MAX_ROLE_INSTRUCTIONS,
  MAX_ROLE_STEPS,
  MIN_ROLE_STEPS,
  ROLE_STEPS,
  type Machine,
  type RoleStep,
  type RunGroup,
  type Task,
} from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Checkbox } from "@xdev-hive/ui/components/ui/checkbox";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { Label } from "@xdev-hive/ui/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/components/ui/native-select";
import { SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@xdev-hive/ui/components/ui/sheet";
import { Textarea } from "@xdev-hive/ui/components/ui/textarea";
import { ErrorNote, Notice } from "#ui/components/common.tsx";
import { MachineSelect, PreferKindSelect, ProfileSelect, takesRunsOf } from "#ui/components/MachinePicker.tsx";
import { useAction, useHive, useQuery } from "#ui/hooks.ts";
import { useT, type TFunction } from "#ui/i18n/index.tsx";
import type { AgentTarget } from "#ui/lib/agentmap.ts";

/**
 * A free prompt for an agent (roadmap 32b): the hub makes task P-<n> for it and asks the chosen machine to run it,
 * with the chosen profile or rotating. Then the task's panel shows the request as for any dispatched run.
 */
/** Agents one prompt goes to at most (roadmap 31e); runs.fanout takes 2–8. */
const MAX_AGENTS = 8;

export function PromptSheet({
  projects,
  defaultProject,
  initialTargets = [],
  onSent,
  onGroup,
}: {
  projects: string[];
  defaultProject: string;
  /** Agents picked beforehand (on the agent map, roadmap 31b): one is a prompt, more a fan-out. */
  initialTargets?: AgentTarget[];
  onSent: (task: Task) => void;
  /** Several agents: the run group it made (roadmap 31e). */
  onGroup: (groupId: number) => void;
}) {
  const { client } = useHive();
  const t = useT();
  const machines = useQuery(() => client.call("machines.list", {}), [client]);
  const [project, setProject] = useState(defaultProject);
  const fit = (machines.data ?? []).filter((m) => takesRunsOf(m, project));
  // One agent: a machine and profile, as before. More: each its own, and a machine may be left to the hub ("").
  const [targets, setTargets] = useState<AgentTarget[]>(() => (initialTargets.length ? initialTargets.slice(0, MAX_AGENTS) : [{ machineId: "", profileId: "" }]));
  const several = targets.length > 1;
  const machineOf = (id: string) => fit.find((m) => m.id === id) ?? null;
  const machine = machineOf(targets[0]!.machineId) ?? fit[0] ?? null;
  const profileId = targets[0]!.profileId;
  const setTarget = (i: number, patch: Partial<{ machineId: string; profileId: string }>) => setTargets((all) => all.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const setMachineId = (id: string) => setTarget(0, { machineId: id, profileId: "" });
  const setProfileId = (id: string) => setTarget(0, { profileId: id });
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [reviewAfter, setReviewAfter] = useState(true);
  const [preferKind, setPreferKind] = useState<PreferKind | "">("");
  const action = useAction();
  return (
    <SheetContent className="w-full overflow-y-auto sm:w-[36rem] sm:max-w-[calc(100vw-2rem)]">
      <SheetHeader>
        <SheetTitle>{t("tasks.promptTitle")}</SheetTitle>
        <SheetDescription>{t("tasks.promptHint")}</SheetDescription>
      </SheetHeader>
      <form
        className="flex flex-col gap-3 px-4 pb-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!machine) return;
          void action.run(async () => {
            if (several) {
              const group = await client.call("runs.fanout", {
                project,
                ...(title.trim() ? { title: title.trim() } : {}),
                prompt,
                targets: targets.map((x) => ({ machineId: x.machineId || null, profileId: x.profileId || null })),
                reviewAfter,
              });
              onGroup(group.id);
              return;
            }
            const { task } = await client.call("runs.prompt", {
              project,
              machineId: machine.id,
              profileId: profileId || null,
              preferKind: (!profileId && preferKind) || null,
              ...(title.trim() ? { title: title.trim() } : {}),
              prompt,
              reviewAfter,
            });
            onSent(task);
          });
        }}
      >
        {projects.length > 1 ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="prompt-project">{t("tasks.colProject")}</Label>
            <NativeSelect id="prompt-project" size="sm" className="w-full" value={project} onChange={(e) => (setProject(e.target.value), setTargets((all) => all.map(() => ({ machineId: "", profileId: "" }))))}>
              {projects.map((p) => (
                <NativeSelectOption key={p} value={p}>
                  {p}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        ) : null}
        <ErrorNote error={machines.error} />
        {machines.data && !machine ? <Notice tone="info">{t("tasks.dispatchNoMachine", { project })}</Notice> : null}
        {machine && !several ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <MachineSelect id="prompt-machine" machines={fit} value={machine.id} onChange={setMachineId} />
            <ProfileSelect id="prompt-profile" machine={machine} value={profileId} onChange={setProfileId} />
            {!profileId ? <PreferKindSelect id="prompt-prefer" machine={machine} value={preferKind} onChange={setPreferKind} /> : null}
          </div>
        ) : null}
        {machine && several ? (
          <div className="flex flex-col gap-1.5">
            <Label>{t("tasks.promptAgents", { count: targets.length })}</Label>
            <div className="flex flex-col divide-y rounded-lg border">
              {targets.map((x, i) => (
                <div key={i} className="grid items-center gap-2 p-2 sm:grid-cols-[1.5rem_minmax(0,1fr)_minmax(0,1fr)_auto]" data-prompt-agent-row={i}>
                  <span className="font-mono text-xs text-muted-foreground">{String.fromCharCode(97 + i)}</span>
                  <MachineSelect id={`prompt-machine-${i}`} machines={fit} value={x.machineId} any label={false} onChange={(id) => setTarget(i, { machineId: id, profileId: "" })} />
                  <ProfileSelect id={`prompt-profile-${i}`} machine={machineOf(x.machineId)} value={x.profileId} label={false} onChange={(id) => setTarget(i, { profileId: id })} />
                  <Button type="button" size="sm" variant="ghost" onClick={() => setTargets((all) => all.filter((_, j) => j !== i))}>
                    {t("tasks.promptRemove")}
                  </Button>
                </div>
              ))}
            </div>
          </div>
        ) : null}
        {machine && targets.length < MAX_AGENTS ? (
          <div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-prompt-add-agent
              // The first row keeps its machine; a new one starts on any free machine.
              onClick={() => setTargets((all) => [...all.map((x, j) => (j === 0 && !x.machineId ? { ...x, machineId: machine.id } : x)), { machineId: "", profileId: "" }])}
            >
              <Plus />
              {t("tasks.promptAddAgent")}
            </Button>
            {several ? <p className="mt-1.5 text-xs text-muted-foreground">{t("tasks.promptSeveralHint")}</p> : null}
          </div>
        ) : null}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="prompt-title">{t("tasks.promptTaskTitle")}</Label>
          <Input id="prompt-title" maxLength={120} placeholder={t("tasks.promptTaskTitleHint")} value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="prompt-text">{t("tasks.promptText")}</Label>
          <Textarea
            id="prompt-text"
            className="min-h-40"
            maxLength={4000}
            required
            placeholder={t("tasks.promptPlaceholder")}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <span className="text-xs text-muted-foreground">{t("tasks.promptCount", { count: prompt.length, max: 4000 })}</span>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={reviewAfter} onCheckedChange={(v) => setReviewAfter(v === true)} />
          {t("board.reviewAfter")}
        </label>
        <div>
          <Button size="sm" type="submit" disabled={action.busy || !machine || !prompt.trim()}>
            <Send />
            {several ? t("tasks.promptSendMany", { count: targets.length }) : t("tasks.promptSend")}
          </Button>
        </div>
        <ErrorNote error={action.error} />
      </form>
    </SheetContent>
  );
}

/**
 * Gives the picked tasks of one project to agents at once (roadmap 31a): each a machine (or any free one, which the
 * hub picks when the task's turn comes) and a profile; the hub sends at most "at most in parallel" at a time.
 */
export function BatchSheet({ tasks, targets = [], onSent }: { tasks: Task[]; targets?: AgentTarget[]; onSent: (groupId: number) => void }) {
  const { client } = useHive();
  const t = useT();
  const project = tasks[0]!.project;
  const machines = useQuery(() => client.call("machines.list", {}), [client]);
  const fit = (machines.data ?? []).filter((m) => takesRunsOf(m, project));
  // Agents picked on the map take the tasks in turn, the first task the first agent.
  const [rows, setRows] = useState(() =>
    tasks.map((task, i) => ({ taskId: task.id, ...(targets.length ? targets[i % targets.length]! : { machineId: "", profileId: "" }), role: (task.status === "review" ? "review" : "implement") as WorkRole })),
  );
  const [title, setTitle] = useState("");
  const [parallel, setParallel] = useState("");
  const [reviewAfter, setReviewAfter] = useState(true);
  const [instructions, setInstructions] = useState("");
  // One for the group: every row that rotates waits for this kind first (roadmap 24c).
  const [preferKind, setPreferKind] = useState<PreferKind | "">("");
  const action = useAction();
  const set = (i: number, patch: Partial<(typeof rows)[number]>) => setRows((r) => r.map((row, j) => (j === i ? { ...row, ...patch } : row)));
  const max = parallel.trim() ? Math.max(1, Math.min(20, Number.parseInt(parallel, 10) || 1)) : null;
  return (
    <SheetContent className="w-full overflow-y-auto sm:w-[52rem] sm:max-w-[calc(100vw-2rem)]">
      <SheetHeader>
        <SheetTitle>{t("tasks.batchTitle")}</SheetTitle>
        <SheetDescription>{t("tasks.batchHint")}</SheetDescription>
      </SheetHeader>
      <form
        className="flex flex-col gap-3 px-4 pb-4"
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            const group = await client.call("runs.dispatchMany", {
              project,
              title: title.trim(),
              items: rows.map((r) => ({ taskId: r.taskId, machineId: r.machineId || null, profileId: r.profileId || null, preferKind: (!r.profileId && preferKind) || null, role: r.role })),
              maxParallel: max,
              reviewAfter,
              instructions,
            });
            onSent(group.id);
          });
        }}
      >
        <ErrorNote error={machines.error} />
        {machines.data && !fit.length ? <Notice tone="info">{t("tasks.dispatchNoMachine", { project })}</Notice> : null}
        <div className="flex flex-col divide-y rounded-lg border">
          {rows.map((row, i) => {
            const task = tasks[i]!;
            const machine = fit.find((m) => m.id === row.machineId) ?? null;
            return (
              <div key={row.taskId} className="grid gap-2 p-3 sm:grid-cols-[minmax(0,1fr)_10rem_10rem_8rem] sm:items-center" data-batch-row={row.taskId}>
                <div className="min-w-0 text-sm">
                  <span className="mr-2 font-mono text-xs text-muted-foreground">{task.id}</span>
                  <span className="wrap-anywhere">{task.title}</span>
                </div>
                <MachineSelect id={`batch-machine-${i}`} machines={fit} value={row.machineId} any label={false} onChange={(id) => set(i, { machineId: id, profileId: "" })} />
                <ProfileSelect id={`batch-profile-${i}`} machine={machine} value={row.profileId} label={false} onChange={(id) => set(i, { profileId: id })} />
                <NativeSelect size="sm" className="w-full" value={row.role} onChange={(e) => set(i, { role: e.target.value as WorkRole })} aria-label={t("board.role")}>
                  {WORK_ROLES.map((r) => (
                    <NativeSelectOption key={r} value={r}>
                      {t(`agentRole.${r}`)}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
            );
          })}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="batch-title">{t("tasks.batchName")}</Label>
            <Input id="batch-title" maxLength={120} placeholder={t("tasks.batchNamePlaceholder")} value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="batch-parallel">{t("tasks.batchParallel")}</Label>
            <Input id="batch-parallel" inputMode="numeric" placeholder={t("tasks.batchParallelHint")} value={parallel} onChange={(e) => setParallel(e.target.value.replace(/\D/g, ""))} />
          </div>
          <PreferKindSelect id="batch-prefer" machine={null} value={preferKind} onChange={setPreferKind} />
        </div>
        <Textarea placeholder={t("board.instructionsPlaceholder")} value={instructions} onChange={(e) => setInstructions(e.target.value)} aria-label={t("board.instructions")} />
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={reviewAfter} onCheckedChange={(v) => setReviewAfter(v === true)} />
          {t("board.reviewAfter")}
        </label>
        <div>
          <Button size="sm" type="submit" disabled={action.busy || !fit.length}>
            <Send />
            {t("tasks.batchSend", { count: rows.length })}
          </Button>
        </div>
        <ErrorNote error={action.error} />
      </form>
    </SheetContent>
  );
}

/** The parts written in a box, one a line; a list marker the person or the agent put in front is not part of it. */
export function partLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d{1,2}[.)])\s+/, "").trim())
    .filter(Boolean);
}

/**
 * A big job in parts (roadmap 31c): the person lists the parts, or asks an agent to (runs.mapSplit) and checks its list
 * here once it is ready (`ready`, runs.mapReduce with the group). Every part and the merge run on one machine, so the
 * merge run finds every part's branch in its repository.
 */
export function SplitSheet({
  projects,
  defaultProject,
  ready = null,
  onGroup,
}: {
  projects: string[];
  defaultProject: string;
  /** A group whose split run listed its parts: they wait for this person to check them, on the group's machine. */
  ready?: RunGroup | null;
  onGroup: (groupId: number) => void;
}) {
  const { client } = useHive();
  const t = useT();
  const machines = useQuery(() => client.call("machines.list", {}), [client]);
  const [project, setProject] = useState(ready?.project ?? defaultProject);
  const fit = (machines.data ?? []).filter((m) => takesRunsOf(m, project));
  const [mode, setMode] = useState<"list" | "agent">("list");
  const [machineId, setMachineId] = useState("");
  // The group's machine is fixed: its split ran there, and the parts and merge will.
  const machine: Machine | null = (ready ? machines.data?.find((m) => m.id === ready.machineId) : fit.find((m) => m.id === machineId)) ?? null;
  const [profiles, setProfiles] = useState<string[]>([]);
  const [profileId, setProfileId] = useState("");
  const [title, setTitle] = useState("");
  const [job, setJob] = useState("");
  const [partsText, setPartsText] = useState(() => (ready?.parts ?? []).join("\n"));
  const [parallel, setParallel] = useState("");
  const [reviewAfter, setReviewAfter] = useState(true);
  const action = useAction();
  const parts = partLines(partsText);
  const tooLong = parts.some((p) => p.length > MAX_MAP_PART);
  const partsOk = parts.length >= 2 && parts.length <= MAX_MAP_PARTS && !tooLong;
  const max = parallel.trim() ? Math.max(1, Math.min(20, Number.parseInt(parallel, 10) || 1)) : null;
  const byAgent = !ready && mode === "agent";
  const enabled = machine?.profiles.filter((p) => p.enabled) ?? [];
  const toggleProfile = (id: string) => setProfiles((all) => (all.includes(id) ? all.filter((x) => x !== id) : [...all, id]));
  const canSend = !action.busy && (ready ? !!ready.machineId : fit.length > 0) && (byAgent ? !!job.trim() : partsOk && (!!ready || !!job.trim()));
  return (
    <SheetContent className="w-full overflow-y-auto sm:w-[40rem] sm:max-w-[calc(100vw-2rem)]">
      <SheetHeader>
        <SheetTitle>{t("tasks.mapTitle")}</SheetTitle>
        <SheetDescription>{ready ? t("tasks.mapReadyHint", { task: ready.parentTask ?? "", machine: machine?.machine ?? ready.machineId ?? "?" }) : t("tasks.mapHint")}</SheetDescription>
      </SheetHeader>
      <form
        className="flex flex-col gap-3 px-4 pb-4 max-md:[&_button]:min-h-11 max-md:[&_select]:min-h-11 max-md:[&_input]:min-h-11 max-md:[&_input]:text-base! max-md:[&_select]:text-base! max-md:[&_textarea]:text-base!"
        data-map-form={ready ? ready.id : "new"}
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            const heading = title.trim() ? { title: title.trim() } : {};
            const group = byAgent
              ? await client.call("runs.mapSplit", { project, ...heading, prompt: job, machineId: machineId || null, profileId: profileId || null })
              : await client.call("runs.mapReduce", {
                  project,
                  ...(ready ? { groupId: ready.id } : { ...heading, prompt: job }),
                  parts,
                  machineId: ready ? null : machineId || null,
                  // Profiles are a machine's: none when the hub picks the machine.
                  profiles: machine ? profiles.filter((id) => enabled.some((p) => p.id === id)) : [],
                  maxParallel: max,
                  reviewAfter,
                });
            onGroup(group.id);
          });
        }}
      >
        {!ready && projects.length > 1 ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="map-project">{t("tasks.colProject")}</Label>
            <NativeSelect id="map-project" size="sm" className="w-full" value={project} onChange={(e) => (setProject(e.target.value), setMachineId(""), setProfiles([]), setProfileId(""))}>
              {projects.map((p) => (
                <NativeSelectOption key={p} value={p}>
                  {p}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        ) : null}
        {!ready ? (
          <div role="radiogroup" aria-label={t("tasks.mapMode")} className="flex w-fit gap-0.5 rounded-[7px] bg-sunken p-0.5">
            {(["list", "agent"] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                onClick={() => setMode(m)}
                data-map-mode={m}
                className={cn("h-7 cursor-pointer rounded-[5px] px-2.5 text-xs/none font-semibold outline-none focus-visible:focus-ring", mode === m ? "bg-surface text-fg-strong shadow-e1" : "text-fg-secondary")}
              >
                {t(m === "list" ? "tasks.mapModeList" : "tasks.mapModeAgent")}
              </button>
            ))}
          </div>
        ) : null}
        <ErrorNote error={machines.error} />
        {!ready && machines.data && !fit.length ? <Notice tone="info">{t("tasks.dispatchNoMachine", { project })}</Notice> : null}
        {!ready && fit.length ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <MachineSelect id="map-machine" machines={fit} value={machineId} any onChange={(id) => (setMachineId(id), setProfiles([]), setProfileId(""))} />
            {byAgent ? <ProfileSelect id="map-profile" machine={machine} value={profileId} onChange={setProfileId} /> : null}
            <p className="text-xs text-muted-foreground sm:col-span-2">{t("tasks.mapMachineHint")}</p>
          </div>
        ) : null}
        {!ready ? (
          <>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="map-title">{t("tasks.promptTaskTitle")}</Label>
              <Input id="map-title" maxLength={120} placeholder={t("tasks.promptTaskTitleHint")} value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="map-job">{t("tasks.mapJob")}</Label>
              <Textarea id="map-job" className="min-h-28" maxLength={MAX_MAP_PROMPT} placeholder={t("tasks.mapJobPlaceholder")} value={job} onChange={(e) => setJob(e.target.value)} />
              <span className="text-xs text-muted-foreground">{t("tasks.promptCount", { count: job.length, max: MAX_MAP_PROMPT })}</span>
            </div>
          </>
        ) : (
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">{t("tasks.mapJob")}</span>
            <p className="max-h-40 overflow-y-auto rounded-lg border bg-sunken p-2 text-sm whitespace-pre-wrap wrap-anywhere">{ready.instructions}</p>
          </div>
        )}
        {byAgent ? (
          <p className="text-xs text-muted-foreground">{t("tasks.mapAgentHint")}</p>
        ) : (
          <>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="map-parts">{t("tasks.mapParts")}</Label>
              <Textarea id="map-parts" className="min-h-32 font-mono text-xs" placeholder={t("tasks.mapPartsPlaceholder")} value={partsText} onChange={(e) => setPartsText(e.target.value)} />
              <span className={tooLong || parts.length > MAX_MAP_PARTS ? "text-xs text-danger" : "text-xs text-muted-foreground"}>
                {t("tasks.mapPartsCount", { count: parts.length, max: MAX_MAP_PARTS, each: MAX_MAP_PART })}
              </span>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">{t("tasks.mapProfiles")}</span>
              {machine && enabled.length ? (
                <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                  {enabled.map((p) => (
                    <label key={p.id} className="flex items-center gap-2 text-sm max-md:min-h-11">
                      <Checkbox checked={profiles.includes(p.id)} onCheckedChange={() => toggleProfile(p.id)} data-map-profile={p.id} />
                      {p.label}
                    </label>
                  ))}
                </div>
              ) : null}
              <span className="text-xs text-muted-foreground">{machine ? t("tasks.mapProfilesHint") : t("tasks.mapProfilesNeedMachine")}</span>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="map-parallel">{t("tasks.batchParallel")}</Label>
              <Input id="map-parallel" inputMode="numeric" placeholder={t("tasks.batchParallelHint")} value={parallel} onChange={(e) => setParallel(e.target.value.replace(/\D/g, ""))} />
            </div>
            <label className="flex items-center gap-2 text-sm max-md:min-h-11">
              <Checkbox checked={reviewAfter} onCheckedChange={(v) => setReviewAfter(v === true)} />
              {t("tasks.mapReviewAfter")}
            </label>
          </>
        )}
        <div>
          <Button size="sm" type="submit" disabled={!canSend} data-map-send>
            <Send aria-hidden="true" />
            {byAgent ? t("tasks.mapSendAgent") : t("tasks.mapSendList", { count: parts.length })}
          </Button>
        </div>
        <ErrorNote error={action.error} />
      </form>
    </SheetContent>
  );
}

/** What a writing step is asked when the person writes nothing else; the code and the review need only the task's note. */
const roleTemplate = (t: TFunction, step: RoleStep) => (step === "test" || step === "docs" ? t(`tasks.rolesTemplate.${step}`) : "");

/**
 * A chain of roles on one task (roadmap 31d): each step an agent with its role and profile, one after the other on the
 * task's branch. Every step runs on one machine, so each finds the commits of the steps before it.
 */
export function RolesSheet({ task, initialMachineId = "", onSent }: { task: Task; initialMachineId?: string; onSent: (groupId: number) => void }) {
  const { client } = useHive();
  const t = useT();
  const machines = useQuery(() => client.call("machines.list", {}), [client]);
  const fit = (machines.data ?? []).filter((m) => takesRunsOf(m, task.project));
  const [machineId, setMachineId] = useState(initialMachineId);
  const machine = fit.find((m) => m.id === machineId) ?? null;
  const [steps, setSteps] = useState(() => (["code", "test", "review"] as const).map((step) => ({ step: step as RoleStep, profileId: "", instructions: roleTemplate(t, step) })));
  const [title, setTitle] = useState("");
  const action = useAction();
  const set = (i: number, patch: Partial<(typeof steps)[number]>) => setSteps((all) => all.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  // A new role brings its own template, unless the person wrote instructions of their own.
  const setStep = (i: number, step: RoleStep) => {
    const cur = steps[i]!;
    set(i, { step, ...(cur.instructions.trim() === roleTemplate(t, cur.step) ? { instructions: roleTemplate(t, step) } : {}) });
  };
  return (
    <SheetContent className="w-full overflow-y-auto sm:w-[40rem] sm:max-w-[calc(100vw-2rem)]">
      <SheetHeader>
        <SheetTitle>{t("tasks.rolesTitle", { task: task.id })}</SheetTitle>
        <SheetDescription>{t("tasks.rolesHint", { task: task.id })}</SheetDescription>
      </SheetHeader>
      <form
        className="flex flex-col gap-3 px-4 pb-4 max-md:[&_button]:min-h-11 max-md:[&_select]:min-h-11 max-md:[&_input]:min-h-11 max-md:[&_input]:text-base! max-md:[&_select]:text-base! max-md:[&_textarea]:text-base!"
        data-roles-form={task.id}
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            const group = await client.call("runs.roles", {
              project: task.project,
              taskId: task.id,
              title: title.trim(),
              machineId: machineId || null,
              // Profiles are a machine's: none when the hub picks the machine.
              steps: steps.map((s) => ({ step: s.step, profileId: machine ? s.profileId || null : null, instructions: s.instructions.trim() })),
            });
            onSent(group.id);
          });
        }}
      >
        <p className="text-sm">
          <span className="mr-2 font-mono text-xs text-muted-foreground">{task.id}</span>
          <span className="wrap-anywhere">{task.title}</span>
        </p>
        <ErrorNote error={machines.error} />
        {machines.data && !fit.length ? <Notice tone="info">{t("tasks.dispatchNoMachine", { project: task.project })}</Notice> : null}
        {fit.length ? (
          <div className="flex flex-col gap-1.5">
            <MachineSelect id="roles-machine" machines={fit} value={machineId} any onChange={(id) => (setMachineId(id), setSteps((all) => all.map((s) => ({ ...s, profileId: "" }))))} />
            <p className="text-xs text-muted-foreground">{t("tasks.rolesMachineHint")}</p>
          </div>
        ) : null}
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">{t("tasks.rolesSteps")}</span>
          <ol className="flex flex-col divide-y rounded-lg border">
            {steps.map((s, i) => (
              <li key={i} className="flex flex-col gap-2 p-3" data-roles-step-row={i}>
                <div className="grid items-center gap-2 sm:grid-cols-[4rem_minmax(0,1fr)_minmax(0,1fr)_auto]">
                  <span className="text-xs font-medium text-muted-foreground">{t("tasks.rolesStep", { n: i + 1 })}</span>
                  <NativeSelect size="sm" className="w-full" value={s.step} onChange={(e) => setStep(i, e.target.value as RoleStep)} aria-label={t("board.role")} data-roles-step={i}>
                    {ROLE_STEPS.map((r) => (
                      <NativeSelectOption key={r} value={r}>
                        {t(`roleStep.${r}`)}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                  <ProfileSelect id={`roles-profile-${i}`} machine={machine} value={s.profileId} label={false} onChange={(id) => set(i, { profileId: id })} />
                  <Button type="button" size="sm" variant="ghost" disabled={steps.length <= MIN_ROLE_STEPS} onClick={() => setSteps((all) => all.filter((_, j) => j !== i))}>
                    {t("tasks.rolesRemoveStep")}
                  </Button>
                </div>
                <Textarea
                  className="min-h-16 text-[13px]"
                  maxLength={MAX_ROLE_INSTRUCTIONS}
                  placeholder={t("tasks.rolesInstructionsPlaceholder")}
                  aria-label={t("tasks.rolesInstructions", { n: i + 1 })}
                  value={s.instructions}
                  onChange={(e) => set(i, { instructions: e.target.value })}
                />
              </li>
            ))}
          </ol>
          {steps.length < MAX_ROLE_STEPS ? (
            <div>
              <Button type="button" size="sm" variant="outline" data-roles-add onClick={() => setSteps((all) => [...all, { step: "review", profileId: "", instructions: "" }])}>
                <Plus aria-hidden="true" />
                {t("tasks.rolesAddStep")}
              </Button>
            </div>
          ) : null}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="roles-title">{t("tasks.batchName")}</Label>
          <Input id="roles-title" maxLength={120} placeholder={task.title} value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div>
          <Button size="sm" type="submit" disabled={action.busy || !fit.length} data-roles-send>
            <Send aria-hidden="true" />
            {t("tasks.rolesSend", { count: steps.length })}
          </Button>
        </div>
        <ErrorNote error={action.error} />
      </form>
    </SheetContent>
  );
}
