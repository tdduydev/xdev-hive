import { useEffect, useState } from "react";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@xdev-hive/ui/components/ui/dialog";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { Textarea } from "@xdev-hive/ui/components/ui/textarea";
import { Label } from "@xdev-hive/ui/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/components/ui/native-select";
import { ErrorNote } from "#ui/components/common.tsx";
import { takesRunsOf } from "#ui/components/MachinePicker.tsx";
import { useAction, useCan, useHive, useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import { scopeProject } from "#ui/lib/scope.ts";
import { nextTaskId } from "#ui/lib/tasks.ts";

type Path = "ask" | "quick" | "feature";
// This is only a navigation key; LAN HTTP pages also need to open fresh drafts.
let draftSequence = 0;
const draftKey = () => `${Date.now()}-${++draftSequence}`;
export function NewWorkDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { client, projects, scope, setScope, bump } = useHive();
  const allow = useCan();
  const t = useT();
  const action = useAction();
  const [path, setPath] = useState<Path | null>(null);
  const [project, setProject] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [done, setDone] = useState("");
  const [agent, setAgent] = useState("");
  const [profile, setProfile] = useState("");
  const [run, setRun] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const eligible = (kind: Path) => projects.filter((p) => kind === "ask" ? allow(p, "chatUse") : allow(p, "taskManage") && (kind !== "feature" || allow(p, "runDispatch")));
  const writable = path ? eligible(path) : [];
  const machines = useQuery(() => open ? client.call("machines.list", {}) : Promise.resolve([]), [client, open]);
  const fit = (machines.data ?? []).filter((m) => takesRunsOf(m, project));
  const choose = (kind: Path) => {
    const list = eligible(kind);
    const scoped = scopeProject(scope);
    setPath(kind);
    setProject(scoped && list.includes(scoped) ? scoped : list[0] ?? "");
    setAgent(""); setProfile("");
    action.setError(null);
  };
  useEffect(() => {
    if (open) {
      setPath(null); setTitle(""); setDescription(""); setDone(""); setAgent(""); setProfile(""); setRun(false); setCreated(null); action.setError(null);
    }
  }, [open]);
  const navigate = (route: string) => {
    setScope({ kind: "project", project });
    onOpenChange(false);
    window.location.hash = route;
  };
  const submit = () => void action.run(async () => {
    if (!path || !writable.includes(project)) return;
    if (path === "ask") {
      sessionStorage.setItem("hive-new-work-question", title.trim());
      navigate(`#/chat?thread=new&newWork=${draftKey()}`);
      return;
    }
    if (path === "feature") { navigate(`#/specs?feature=new&newWork=${draftKey()}`); return; }
    let id = created;
    if (!id) {
      // Task ids are global, even when the suggested prefix comes from this project's tasks.
      const tasks = await client.call("tasks.list", {});
      id = nextTaskId(tasks.filter((task) => task.project === project));
      while (tasks.some((task) => task.id === id)) id = nextTaskId([...tasks, { id }]);
      const task = await client.call("tasks.create", { id, project, title: title.trim(), note: [description.trim(), done.trim() ? `${t("newWork.done")}\n${done.trim()}` : ""].filter(Boolean).join("\n\n"), dependsOn: [] });
      id = task.id;
      setCreated(id);
      bump();
    }

    if (run && allow(project, "runDispatch")) {
      if (agent) {
        await client.call("tasks.assign", { id, machineId: agent, profileId: profile || null });
      } else {
        // Let the hub account for capacity, pending requests and profile cooldowns when choosing a free machine.
        await client.call("runs.dispatchMany", { project, items: [{ taskId: id, machineId: null }], maxParallel: 1 });
      }
    }
    bump();
    navigate(`#/tasks?task=${encodeURIComponent(id)}`);
  });
  const ready = !!project && writable.includes(project) && (path === "feature" || !!title.trim()) && !action.busy;
  return <Dialog open={open} onOpenChange={(v) => { if (!action.busy) onOpenChange(v); }}>
    <DialogContent data-new-work className="md:max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-[560px] max-md:[&_button]:min-h-11 max-md:[&_button[data-slot=button]]:min-h-11 max-md:[&_input]:min-h-11 max-md:[&_select]:min-h-11 max-md:[&_button[data-slot=dialog-close]]:size-11">
      <DialogHeader><DialogTitle>{t("newWork.title")}</DialogTitle><DialogDescription>{t("newWork.hint")}</DialogDescription></DialogHeader>
      <div className="flex flex-col gap-2">
        {(["ask", "quick", "feature"] as const).filter((kind) => eligible(kind).length).map((kind) => <Button key={kind} data-new-work-path={kind} type="button" variant={path === kind ? "secondary" : "outline"} aria-pressed={path === kind} disabled={!!created || action.busy} className="h-auto min-h-11 flex-col items-start whitespace-normal px-3 py-2 text-left" onClick={() => choose(kind)}>
          <span>{t(`newWork.${kind}`)}</span><span className="text-xs font-normal text-fg-secondary">{t(`newWork.${kind}Hint`)}</span>
        </Button>)}
        {!projects.some((p) => allow(p, "chatUse") || allow(p, "taskManage")) ? <p>{t("newWork.noPermission")}</p> : null}
      </div>
      {path ? <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); if (ready) submit(); }}>
        <div className="flex flex-col gap-1.5"><Label htmlFor="new-work-project">{t("newTask.project")}</Label><NativeSelect id="new-work-project" value={project} disabled={!!created || action.busy} onChange={(e) => { setProject(e.target.value); setAgent(""); setProfile(""); setRun(false); }}>
          {writable.map((p) => <NativeSelectOption key={p} value={p}>{p}</NativeSelectOption>)}
        </NativeSelect></div>
        {path !== "feature" ? <div className="flex flex-col gap-1.5"><Label htmlFor="new-work-title">{t(path === "ask" ? "newWork.question" : "newTask.name")}</Label><Input id="new-work-title" maxLength={path === "ask" ? 8000 : 300} value={title} disabled={!!created || action.busy} onChange={(e) => setTitle(e.target.value)} required /></div> : null}
        {path === "quick" ? <>
          <div className="flex flex-col gap-1.5"><Label htmlFor="new-work-description">{t("newWork.description")}</Label><Textarea id="new-work-description" maxLength={1000} value={description} disabled={!!created || action.busy} onChange={(e) => setDescription(e.target.value)} /></div>
          <div className="flex flex-col gap-1.5"><Label htmlFor="new-work-done">{t("newWork.done")}</Label><Textarea id="new-work-done" maxLength={900} value={done} disabled={!!created || action.busy} onChange={(e) => setDone(e.target.value)} /></div>
          {allow(project, "runDispatch") ? <>
            <div className="flex flex-col gap-1.5"><Label htmlFor="new-work-run">{t("newWork.afterCreate")}</Label><NativeSelect id="new-work-run" value={run ? "run" : "create"} disabled={action.busy} onChange={(e) => setRun(e.target.value === "run")}><NativeSelectOption value="create">{t("newWork.createOnly")}</NativeSelectOption><NativeSelectOption value="run">{t("newWork.createRun")}</NativeSelectOption></NativeSelect></div>
            {run ? <div className="flex flex-col gap-1.5"><Label htmlFor="new-work-agent">{t("newWork.agent")}</Label><NativeSelect id="new-work-agent" value={agent} disabled={action.busy} onChange={(e) => { setAgent(e.target.value); setProfile(""); }}><NativeSelectOption value="">{t("newWork.autoAgent")}</NativeSelectOption>{fit.map((m) => <NativeSelectOption key={m.id} value={m.id}>{m.machine}</NativeSelectOption>)}</NativeSelect>{agent ? <><Label htmlFor="new-work-profile">{t("board.profile")}</Label><NativeSelect id="new-work-profile" value={profile} disabled={action.busy} onChange={(e) => setProfile(e.target.value)}><NativeSelectOption value="">{t("board.rotate")}</NativeSelectOption>{fit.find((m) => m.id === agent)?.profiles.filter((p) => p.enabled).map((p) => <NativeSelectOption key={p.id} value={p.id}>{p.label}</NativeSelectOption>)}</NativeSelect></> : null}<p className="text-xs text-fg-secondary">{t(fit.length ? "newWork.agentHint" : "newWork.noMachine")}</p></div> : null}
          </> : null}
          {created ? <p role="status" className="text-sm">{t("newWork.partial", { id: created })} <a href={`#/tasks?task=${encodeURIComponent(created)}`} onClick={() => onOpenChange(false)} className="underline">{t("tasks.title")}</a></p> : null}
        </> : null}
        <ErrorNote error={action.error} />
        <div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="outline" disabled={action.busy} onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button><Button data-new-work-submit type="submit" disabled={!ready}>{action.busy ? t("common.loading") : t(path === "ask" ? "newWork.openChat" : path === "feature" ? "newWork.openFeature" : run ? "newWork.createRun" : "newWork.createOnly")}</Button></div>
      </form> : null}
    </DialogContent>
  </Dialog>;
}
