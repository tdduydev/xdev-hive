import { useEffect, useState } from "react";
import { PROJECT_NAME, effectivePolicy } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@xdev-hive/ui/components/ui/card";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { Label } from "@xdev-hive/ui/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/components/ui/native-select";
import { ErrorNote } from "#ui/components/common.tsx";
import { Chip } from "#ui/components/panes.tsx";
import { useAction, useCan, useHive, usePoll, useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import { scopeProject } from "#ui/lib/scope.ts";
import { Effective } from "#ui/pages/admin/AgentPolicy.tsx";
import { projectReadiness } from "#ui/lib/start.ts";

/** Progress comes from the repo, heartbeat, policy and tasks, so returning never resets completed work. */
export function ProjectOnboarding() {
  const { client, me, scope, projects, setScope, bump } = useHive();
  const t = useT();
  const can = useCan();
  const action = useAction();
  const draftKey = `xdev-hive.onboarding:${me.mode}:${me.user?.username ?? me.name}`;
  const [draft] = useState(() => {
    try {
      const value = JSON.parse(sessionStorage.getItem(draftKey) ?? "null");
      if (value && typeof value.project === "string" && typeof value.title === "string" && typeof value.id === "string") return value as { project: string; title: string; id: string };
    } catch { /* The guide still works when browser storage is unavailable. */ }
    return { project: scopeProject(scope) ?? "", title: "", id: "" };
  });
  const [project, setProject] = useState(draft.project);
  const [title, setTitle] = useState(draft.title);
  const [id, setId] = useState(draft.id);
  useEffect(() => {
    try { sessionStorage.setItem(draftKey, JSON.stringify({ project, title, id })); } catch { /* Storage is optional. */ }
  }, [draftKey, project, title, id]);
  const poll = usePoll(15_000);
  const desktop = client.desktop;
  const settings = useQuery(async () => desktop ? desktop.settings() : null, [desktop, poll]);
  const profiles = useQuery(async () => desktop ? desktop.profiles() : [], [desktop, poll]);
  const report = useQuery(async () => desktop ? desktop.setupStatus() : null, [desktop, poll]);
  const machines = useQuery(async () => desktop ? [] : client.call("machines.list", {}), [client, poll]);
  const policy = useQuery(() => client.call("agentPolicy.get", {}), [client, poll]);
  const valid = PROJECT_NAME.test(project);
  const tasks = useQuery(async () => ({ project, items: valid ? await client.call("tasks.list", { project }) : [] }), [client, project, poll]);
  const repo = settings.data?.projects.find((p) => p.name === project);
  const { repo: repoReady, agent: agentReady } = projectReadiness(project, settings.data, report.data, profiles.data ?? [], machines.data ?? [], !!desktop);
  const effective = policy.data ? effectivePolicy(policy.data.hub, policy.data.projects[project] ?? {}) : null;
  const open = (route: string) => { if (valid) setScope({ kind: "project", project }); window.location.hash = route; };
  const state = (ready: boolean) => <Chip kind={ready ? "success" : "warning"}>{t(ready ? "start.done" : "start.todo")}</Chip>;
  const existing = tasks.data?.project === project ? tasks.data.items : [];
  const selectProject = (value: string) => {
    setProject(value); setId(""); action.setError(null);
    if (PROJECT_NAME.test(value)) setScope({ kind: "project", project: value });
  };
  return <Card data-project-onboarding className="max-md:[&_button]:min-h-11 max-md:[&_button]:h-auto max-md:[&_button]:whitespace-normal max-md:[&_input]:text-base max-md:[&_select]:text-base max-md:[&_select]:min-h-11">
    <CardHeader><CardTitle>{t("onboarding.title")}</CardTitle></CardHeader>
    <CardContent className="flex flex-col gap-4">
      <p className="text-sm text-fg-secondary">{t("onboarding.intro")}</p>
      <Button variant="outline" disabled={action.busy} onClick={() => { settings.reload(); profiles.reload(); report.reload(); machines.reload(); policy.reload(); tasks.reload(); }}>{t("setup.recheck")}</Button>
      {tasks.loading || policy.loading ? <p role="status" className="text-sm text-fg-secondary">{t("setup.checking")}</p> : null}
      <div className="flex flex-col gap-2">
        <Label htmlFor="onboarding-project">{t("newTask.project")}</Label>
        {desktop ? <NativeSelect id="onboarding-project" value={project} onChange={(e) => selectProject(e.target.value)}>
          <NativeSelectOption value="">{t("newTask.projectPlaceholder")}</NativeSelectOption>
          {(settings.data?.projects ?? []).map((p) => <NativeSelectOption key={p.name} value={p.name}>{p.name}</NativeSelectOption>)}
        </NativeSelect> : <Input id="onboarding-project" list="onboarding-projects" value={project} aria-invalid={!!project && !valid} onChange={(e) => { setProject(e.target.value.toLowerCase()); setId(""); }} onBlur={() => selectProject(project)} />}
        <datalist id="onboarding-projects">{projects.map((p) => <option key={p} value={p} />)}</datalist>
        <p className="text-xs text-fg-secondary">{t("onboarding.keyHint")}</p>
      </div>
      <ErrorNote error={settings.error || report.error || profiles.error || machines.error || policy.error || tasks.error || action.error} />
      <ol className="flex flex-col gap-4">
        <li className="flex flex-col gap-2" data-onboarding-repo>
          <div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-semibold">{t("onboarding.repo")}</h3>{state(repoReady)}</div>
          <p className="break-all text-sm">{repo?.repo ?? t("onboarding.repoHint")}</p>
          {desktop ? <Button variant="outline" onClick={() => open("#/setup")}>{t("nav.setup")}</Button> : <p className="text-sm text-fg-secondary">{t("onboarding.desktopHint")}</p>}
        </li>
        <li className="flex flex-col gap-2" data-onboarding-agent>
          <div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-semibold">{t("onboarding.agent")}</h3>{state(!!agentReady)}</div>
          <p className="text-sm text-fg-secondary">{t("onboarding.agentHint")}</p>
          <Button variant="outline" onClick={() => open(desktop ? "#/start" : "#/machines")}>{t(desktop ? "start.title" : "nav.machines")}</Button>
        </li>
        <li className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">{t("onboarding.policy")}</h3>
          {effective ? <div data-onboarding-policy><Effective policy={effective} /></div> : null}
          <p className="text-sm text-fg-secondary">{t("onboarding.policyHint")}</p>
          {can(project || null, "projectSettings") ? <Button variant="outline" onClick={() => open(desktop && settings.data?.mode === "local" ? "#/systems" : "#/settings?tab=agent")}>{t("onboarding.openPolicy")}</Button> : null}
        </li>
        <li className="flex flex-col gap-2" data-onboarding-task>
          <div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-semibold">{t("onboarding.firstTask")}</h3>{state(valid && existing.length > 0)}</div>
          {valid && existing.length ? <Button data-onboarding-open-task onClick={() => open(`#/tasks?project=${encodeURIComponent(project)}&task=${encodeURIComponent(existing[0]!.id)}`)}>{t("onboarding.openTask", { id: existing[0]!.id })}</Button> : <form className="flex flex-col gap-3" onSubmit={(e) => {
            e.preventDefault();
            if (!valid || !can(project, "taskManage") || action.busy || tasks.loading || tasks.error) return;
            void action.run(async () => {
              await client.call("tasks.create", { project, id: id.trim(), title: title.trim(), dependsOn: [] });
              setTitle(""); setId("");
              setScope({ kind: "project", project }); bump(); tasks.reload();
            });
          }}>
            <Label htmlFor="onboarding-task-id">{t("newTask.id")}</Label>
            <Input id="onboarding-task-id" required value={id} onChange={(e) => setId(e.target.value)} />
            <Label htmlFor="onboarding-task-title">{t("newTask.name")}</Label>
            <Input id="onboarding-task-title" required maxLength={300} value={title} onChange={(e) => setTitle(e.target.value)} />
            {valid && !can(project, "taskManage") ? <p className="text-sm text-fg-secondary">{t("newWork.noPermission")}</p> : null}
            <p className="text-sm text-fg-secondary">{t("onboarding.createHint")}</p>
            <Button data-onboarding-create disabled={!valid || !can(project, "taskManage") || !id.trim() || !title.trim() || action.busy || tasks.loading || !!tasks.error}>{t("newTask.create")}</Button>
          </form>}
        </li>
      </ol>
    </CardContent>
  </Card>;
}
