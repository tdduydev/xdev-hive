// The forms that give work to agents (roadmaps 31a, 31e, 32b): one prompt for one or several agents, and picked tasks
// for several at once. The Task page and the agent map (31b) open them.
import { useState } from "react";
import { Plus, Send } from "lucide-react";
import { WORK_ROLES, type WorkRole, type PreferKind, type Task } from "@xdev-hive/core";
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
import { useT } from "#ui/i18n/index.tsx";
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
