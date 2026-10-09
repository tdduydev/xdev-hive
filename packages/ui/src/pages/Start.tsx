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

export function StartReminder({ className = "border-b border-line-subtle p-3" }: { className?: string }) {
  const { client } = useHive();
  const status = useStartStatus();
  const t = useT();
  if (!client.desktop) return null;
  return <div className={className}>
    <Button variant="outline" className="h-auto w-full min-h-[var(--control-h-touch)] whitespace-normal text-left" onClick={() => { window.location.hash = "/start"; }}>
      {status.data?.remaining ? t("start.reminder", { count: status.data.remaining }) : t("start.open")}
    </Button>
    <ErrorNote error={status.error} />
  </div>;
}

const hubHost = (url: string) => { try { return new URL(url).host; } catch { return url; } };

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
  const appInfo = useQuery(() => desktop.appInfo(), [desktop]);
  const app = appInfo.data;
  const data = status.data;
  if (!data) return <div className="p-6"><ErrorNote error={status.error} />{t("setup.checkingAll")}</div>;
  const { settings, profiles, steps } = data;
  const first = settings.mode === "local" && !settings.projects.length && !profiles.length ? "connection" : (Object.keys(steps) as StartStep[]).find((key) => steps[key] === "todo");
  const keys = Object.keys(steps) as StartStep[];
  const doneCount = keys.filter((key) => steps[key] === "done").length;
  const pct = Math.round(doneCount / keys.length * 100);
  const step = (key: StartStep, body: ReactNode) => {
    const open = opened === key || (opened === undefined && first === key);
    const state = steps[key];
    // Mark colors follow state: done green, the step to do next violet, the rest neutral glass.
    const mark = state === "done" ? "bg-[color-mix(in_srgb,var(--accent-green)_16%,transparent)] text-[var(--accent-green)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--accent-green)_40%,transparent)]"
      : first === key ? "bg-[color-mix(in_srgb,var(--accent-violet)_18%,transparent)] text-[var(--text-brand)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--accent-violet)_50%,transparent)]"
      : "bg-[var(--glass-bg)] text-[var(--text-muted)] shadow-[var(--ring-glass)]";
    return <div key={key} data-start-step={key} data-state={state} className="shadow-[inset_0_-1px_0_var(--border-subtle)] last:shadow-none">
      <div className="grid grid-cols-[32px_minmax(0,1fr)_auto] items-start gap-[14px] px-[22px] py-4">
        <span className={`flex size-7 items-center justify-center rounded-full text-[12px]/none font-bold ${mark}`}>{state === "done" ? "✓" : keys.indexOf(key) + 1}</span>
        <span className="flex min-w-0 flex-col gap-[3px]">
          <h2 className={`text-[14px]/5 font-semibold ${state === "done" ? "text-[var(--text-secondary)]" : "text-[var(--text-strong)]"}`}>{t(`start.${key}`)}</h2>
          <span className="text-[13px]/5 text-[var(--text-muted)] text-pretty">{t(`start.hint.${key}`)}</span>
        </span>
        <span className="flex items-center gap-2">
          {state === "done" ? <span className="text-[12px]/7 font-semibold text-[var(--accent-green)]">{t("start.done")}</span> : null}
          <Button size="sm" variant={state === "todo" ? "solid" : "ghost"} aria-expanded={open} onClick={() => setOpened(open ? null : key)}>{t(state === "todo" ? "start.doNow" : "start.view")}</Button>
        </span>
      </div>
      {open ? <div className="flex flex-col gap-3 px-[22px] pb-4 pl-[68px] max-md:pl-[22px]">{body}</div> : null}
    </div>;
  };
  return <div data-start-guide className="flex w-full flex-col gap-4 p-6 max-md:p-4 max-md:[&_button]:min-h-[var(--control-h-touch)] max-md:[&_button]:min-w-[var(--control-h-touch)] max-md:[&_button]:h-auto max-md:[&_button]:whitespace-normal max-md:[&_summary]:min-h-[var(--control-h-touch)] [&_summary]:focus-visible:focus-ring">
    <p className="sr-only" role="status">{data.remaining ? t("start.intro") : t("start.ready")}</p>
    <ErrorNote error={status.error || action.error} />
    <div className="flex flex-wrap items-start gap-4">
    <div className="flex min-w-0 flex-[999_1_520px] flex-col overflow-hidden rounded-[24px] bg-[var(--surface-1)] shadow-[var(--ring-glass)]">
      <div className="flex items-center gap-[14px] px-[22px] py-[18px] shadow-[inset_0_-1px_0_var(--border-subtle)]"><div className="flex flex-1 flex-col gap-2"><span className="text-[15px]/[22px] font-semibold">{t("start.progress", { done: doneCount, total: keys.length })}</span><div className="h-1.5 overflow-hidden rounded-full bg-[var(--glass-bg)]"><div className="h-full rounded-full bg-[var(--accent-violet)] shadow-[0_0_12px_var(--accent-violet)]" style={{ width: `${pct}%` }} /></div></div></div>
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
    </div>
    <aside className="flex min-w-0 max-w-full flex-1 basis-[280px] flex-col gap-[14px] rounded-[24px] bg-[var(--surface-1)] p-[22px] shadow-[var(--ring-glass)]">
      <h2 className="text-[15px]/[22px] font-semibold">{t("start.machineTitle")}</h2>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-[14px] gap-y-2 text-[13px]/5">
        <dt className="text-[var(--text-muted)]">{t("start.machineName")}</dt><dd>{settings.machine}</dd>
        <dt className="text-[var(--text-muted)]">{t("start.machineMode")}</dt><dd>{settings.mode === "hub" ? `Hub · ${hubHost(settings.hubUrl)}` : t("start.modeLocal")}</dd>
        {app ? <><dt className="text-[var(--text-muted)]">{t("start.machineApp")}</dt><dd>{app.version}</dd></> : null}
        {settings.projects.length ? <><dt className="text-[var(--text-muted)]">{t("start.machineDirs")}</dt><dd className="font-mono text-[12.5px] [overflow-wrap:anywhere]">{settings.projects.map((p) => p.repo).join(", ")}</dd></> : null}
      </dl>
      <span className="text-[12px]/4 text-[var(--text-muted)] text-pretty">{t("start.reopen")}</span>
    </aside>
    </div>
    <ProjectOnboarding />
    <Button data-start-today variant="outline" onClick={() => { window.location.hash = "/today"; }}>{t("nav.today")}</Button>
  </div>;
}
