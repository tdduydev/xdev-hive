import { ProjectOnboarding } from "#ui/components/ProjectOnboarding.tsx";
import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Card, CardContent } from "@xdev-hive/ui/components/ui/card";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { Label } from "@xdev-hive/ui/components/ui/label";
import { ErrorNote } from "#ui/components/common.tsx";
import { Chip } from "#ui/components/panes.tsx";
import { useAction, useHive, usePoll, useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import { remainingSteps, startSteps, type StartStep } from "#ui/lib/start.ts";
import { ConnectionCard, SignInCard } from "#ui/pages/Projects.tsx";
import { SetupPage } from "#ui/pages/Setup.tsx";
import { AgentsPage } from "#ui/pages/Agents.tsx";

export function useStartStatus() {
  const { client } = useHive();
  const desktop = client.desktop;
  const poll = usePoll(desktop ? 15_000 : null);
  const query = useQuery(async () => {
    if (!desktop) return null;
    const [settings, report, profiles] = await Promise.all([desktop.settings(), desktop.setupStatus(), desktop.profiles()]);
    const steps = startSteps(settings, report, profiles);
    return { settings, report, profiles, steps, remaining: remainingSteps(steps) };
  }, [desktop, poll]);
  return query;
}

export function StartReminder() {
  const { client } = useHive();
  const status = useStartStatus();
  const t = useT();
  if (!client.desktop) return null;
  return <div className="border-b border-line-subtle p-3">
    <Button variant="outline" className="h-auto w-full min-h-[var(--control-h-touch)] whitespace-normal text-left" onClick={() => { window.location.hash = "/start"; }}>
      {status.data?.remaining ? t("start.reminder", { count: status.data.remaining }) : t("start.open")}
    </Button>
    <ErrorNote error={status.error} />
  </div>;
}

export function StartPage() {
  const { client } = useHive();
  return client.desktop ? <DesktopStartPage /> : <div className="mx-auto w-full max-w-[980px] p-4 md:p-6"><ProjectOnboarding /></div>;
}

function DesktopStartPage() {
  const { client, bump } = useHive();
  const desktop = client.desktop!;
  const t = useT();
  const status = useStartStatus();
  const action = useAction();
  const [opened, setOpened] = useState<StartStep | null | undefined>(undefined);
  const refresh = () => { status.reload(); bump(); };
  const connectionChanged = () => {
    setOpened("tools");
    refresh();
    // The connection changes the backend and therefore the shell's menu and permissions as well.
    window.dispatchEvent(new Event("xdev-hive:connection-changed"));
  };
  useEffect(() => {
    const focus = () => { void desktop.recheckLogins().then(refresh, () => status.reload()); };
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, [desktop]);
  const data = status.data;
  if (!data) return <div className="p-6"><ErrorNote error={status.error} />{t("setup.checkingAll")}</div>;
  const { settings, profiles, steps } = data;
  const first = settings.mode === "local" && !settings.projects.length && !profiles.length ? "connection" : (Object.keys(steps) as StartStep[]).find((key) => steps[key] === "todo");
  const step = (key: StartStep, body: ReactNode) => <Card key={key} data-start-step={key} data-state={steps[key]}>
    <CardContent className="pt-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="mr-auto text-sm font-semibold">{t(`start.${key}`)}</h2>
        <Chip kind={steps[key] === "done" ? "success" : steps[key] === "todo" ? "warning" : "neutral"}>{t(`start.${steps[key]}`)}</Chip>
        <Button variant="outline" aria-expanded={opened === key || (opened === undefined && first === key)} onClick={() => setOpened(opened === key || (opened === undefined && first === key) ? null : key)}>{t("start.doNow")}</Button>
      </div>
      {(opened === key || (opened === undefined && first === key)) ? <div className="mt-4 flex flex-col gap-3">{body}</div> : null}
    </CardContent>
  </Card>;
  return <div data-start-guide className="mx-auto flex w-full max-w-[980px] flex-col gap-4 p-6 max-md:[&_button]:min-h-[var(--control-h-touch)] max-md:[&_button]:min-w-[var(--control-h-touch)] max-md:[&_button]:h-auto max-md:[&_button]:whitespace-normal max-md:[&_summary]:min-h-[var(--control-h-touch)] [&_summary]:focus-visible:focus-ring">
    <p className="text-sm text-fg-secondary" role="status">{data.remaining ? t("start.intro") : t("start.ready")}</p>
    <ErrorNote error={status.error || action.error} />
    {step("connection", settings.mode === "hub" && settings.hasHubToken ? <ConnectionCard settings={settings} onSaved={connectionChanged} /> : <SignInCard guide settings={settings} changing={false} onDone={connectionChanged} onCancel={() => {}} />)}
    {step("tools", <SetupPage section="machine" onChanged={status.reload} />)}
    {step("projects", <SetupPage section="projects" onChanged={status.reload} />)}
    {step("agents", <>
      {profiles.map((p) => <div key={p.id} className="flex flex-wrap items-center gap-3"><span className="mr-auto text-sm">{p.label || p.id}</span><Chip kind={!p.enabled ? "neutral" : p.login?.loggedIn || p.hasToken ? "success" : "warning"}>{t(!p.enabled ? "start.disabled" : p.login?.loggedIn || p.hasToken ? "start.done" : "start.todo")}</Chip>
        {!p.enabled ? <Button disabled={action.busy} onClick={() => void action.run(async () => { await desktop.saveProfile({ ...p, enabled: true }, p.id); refresh(); })}>{t("agents.enable")}</Button> : !p.login?.loggedIn && !p.hasToken ? <Button disabled={action.busy || !p.cliPath} onClick={() => void action.run(async () => { await desktop.openLogin(p.id); refresh(); })}>{t("agents.login")}</Button> : null}
      </div>)}
      <Button variant="outline" disabled={action.busy} onClick={() => void action.run(async () => { await desktop.recheckLogins(); refresh(); })}>{t("setup.recheck")}</Button>
      <details open={!profiles.length}><summary className="cursor-pointer text-sm focus-visible:focus-ring">{t("start.manageAgents")}</summary><AgentsPage /></details>
    </>)}
    {step("intake", settings.mode === "local" ? <p className="text-sm">{t("agents.recvLocal")}</p> : <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => {
      e.preventDefault();
      const maxParallel = Number(new FormData(e.currentTarget).get("parallel"));
      void action.run(async () => { await desktop.updateSettings({ runner: { acceptHubRuns: true, maxParallel } }); refresh(); });
    }}><div className="flex flex-col gap-2"><Label htmlFor="start-parallel">{t("agents.maxAtOnce")}</Label><Input id="start-parallel" name="parallel" type="number" min={1} max={8} required defaultValue={settings.runner.maxParallel} /></div><Button disabled={action.busy}>{t("start.enableIntake")}</Button></form>)}
    <ProjectOnboarding />
    <Button data-start-today variant="outline" onClick={() => { window.location.hash = "/today"; }}>{t("nav.today")}</Button>
  </div>;
}
