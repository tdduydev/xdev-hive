import { visibleInterval } from "#ui/lib/visible-interval.ts";
// Công cụ và dự án (docs/design/2026-09-redesign, xDev Hive Client): what the runner needs on this machine (the
// agent CLIs, the hive-mcp command) and in each repo, with the install the app can do, and admins' install requests.
import { useEffect, useMemo, useState, type ComponentType } from "react";
import { FileText, GitBranch, ListChecks, Plug, RefreshCw, Sparkles, SquareTerminal, Terminal, Wrench } from "lucide-react";
import { cn } from "cn";
import { EMPTY_POLICY, requiredItemIds, type MachineCommand, type MachineToolView, type SetupItem, type SetupReport, type SetupState } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@xdev-hive/ui/components/ui/card";
import { Empty, ErrorNote, Notice } from "#ui/components/common.tsx";
import { Chip, type ChipKind } from "#ui/components/panes.tsx";
import { formatTime, useAction, useHive, useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import { GitLabCard, GitLabImportCard, ProjectsCard } from "#ui/pages/Projects.tsx";
import { ToolCatalog } from "#ui/pages/Tools.tsx";
import { hasNewer, needsSetup, setupGroups, setupOrder, installSetupSequence } from "#ui/lib/setup.ts";

const TONE: Record<SetupState, ChipKind> = { installed: "success", missing: "warning", outdated: "info", manual: "danger" };

/** The tile icon of a setup item, by what it is (cli:claude, shim, <project>:codegraph-index…). */
function iconOf(id: string): ComponentType<{ className?: string }> {
  if (id.startsWith("cli:")) return Terminal;
  if (id === "shim") return SquareTerminal;
  if (id.endsWith(":agents")) return FileText;
  if (id.endsWith(":codegraph-mcp")) return Plug;
  if (id.endsWith(":codegraph-index")) return GitBranch;
  if (id.endsWith(":superpowers")) return Sparkles;
  if (id.endsWith(":speckit")) return ListChecks;
  return Wrench;
}

export function SetupPage({ section, onChanged }: { section?: "machine" | "projects"; onChanged?: () => void } = {}) {
  const { client, me, systems } = useHive();
  const t = useT();
  const desktop = client.desktop!;
  const status = useQuery(() => desktop.setupStatus(), [desktop]);
  const info = useQuery(() => desktop.appInfo(), [desktop]);
  const settings = useQuery(() => desktop.settings(), [desktop]);
  const [report, setReport] = useState<SetupReport | null>(null);
  const batch = useAction();
  const removal = useAction();
  const [rowBusy, setRowBusy] = useState(false);
  const busy = batch.busy || rowBusy;
  const [progress, setProgress] = useState<string | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  const installAll = (projects?: string[]) => void batch.run(async () => {
    if (!shown) return;
    setRemaining(null);
    try {
      const scope = projects ?? (section === "projects" ? shown.projects.map((p) => p.project) : section === "machine" ? "machine" : undefined);
      const left = await installSetupSequence(shown, scope, desktop, setReport,
        (item, completed, total) => setProgress(t("setup.progress", { label: item.label, completed: completed + 1, total })));
      setRemaining(left.length);
    } finally { setProgress(null); }
  });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    return visibleInterval(15_000, () => setTick((n) => n + 1));
  }, []);
  const checkedAt = useMemo(() => (status.data ? new Date().toISOString() : null), [status.data]);
  const requests = useQuery(() => desktop.hubRequests(), [desktop, tick]);
  // A repo kept here for a project the hub archived or deleted (incident 2026-10-09): its agents' MCP gets nothing
  // from Hive, and nothing on this machine said why. Rechecked with the setup report, not on the 15 s tick.
  const hubProjects = useQuery(async () => (me.mode === "hub" ? client.call("projects.list", {}).catch(() => []) : []), [client, me.mode, status.data]);
  const gone = useMemo(() => new Map((hubProjects.data ?? []).filter((p) => p.state !== null).map((p) => [p.project, p])), [hubProjects.data]);
  const full = report ?? status.data;
  const shown = full && section ? { machine: section === "machine" ? full.machine : [], projects: section === "projects" ? full.projects : [] } : full;
  useEffect(() => { if (full) onChanged?.(); }, [full]);
  const policy = requests.data?.policy ?? null;
  const hubTools = requests.data?.tools ?? [];
  // Tools the catalog marks required count as the policy's items do (roadmap 28b-2).
  const requiredTools = hubTools.map((tool) => ({ id: tool.id, handler: tool.handler, projects: tool.required.map((project) => ({ project, required: true })) }));
  const required = shown ? requiredItemIds(policy ?? EMPTY_POLICY, shown.projects.map((p) => p.project), requiredTools) : new Set<string>();
  const replace = async (_item: SetupItem) => {
    setReport(await desktop.setupStatus());
  };
  const missing = shown ? [...shown.machine, ...shown.projects.flatMap((p) => p.items)].filter(needsSetup).length : 0;
  const platform = info.data?.platform;
  const os = platform === "darwin" || platform === "win32" || platform === "linux" ? t(`setup.platform.${platform}`) : (platform ?? "");

  return (
    <div className="max-md:[&_button]:min-h-11 max-md:[&_summary]:min-h-11 max-md:[&_summary]:py-3 [&_summary]:focus-visible:focus-ring mx-auto flex w-full max-w-[980px] flex-col gap-[18px] px-6 pt-5 pb-8">
      <h1 className="sr-only">{t("nav.setup")}</h1>
      <p className="sr-only">{t("setup.subtitle")}</p>
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="text-xs/none text-fg-muted">{status.loading ? t("setup.checking") : checkedAt ? t("setup.lastChecked", { time: formatTime(checkedAt) }) : ""}</span>
        <Button
          size="sm"
          variant="outline"
          disabled={status.loading || busy}
          onClick={() => {
            setReport(null);
            status.reload();
          }}
        >
          <RefreshCw className={status.loading ? "animate-spin" : undefined} />
          {t("setup.recheck")}
        </Button>
      </div>
      <ErrorNote error={status.error} />
      {!section && requests.data?.commands.length ? (
        <RequestsCard
          commands={requests.data.commands}
          onAnswered={() => {
            setTick((n) => n + 1);
            setReport(null);
            status.reload();
          }}
        />
      ) : null}
      {!section && hubTools.length ? (
        <HubToolsCard
          tools={hubTools}
          onChanged={() => {
            setTick((n) => n + 1);
            // Its tool:<id> item can be checked (or no longer) once allowed.
            setReport(null);
            status.reload();
          }}
        />
      ) : null}
      {!shown && status.loading ? <p className="m-0 text-[13px] text-fg-muted">{t("setup.checkingAll")}</p> : null}
      {shown ? (
        <>
          <Notice tone={missing ? "warn" : "ok"}>
            {missing ? t("setup.notReady", { count: missing }) : t("setup.allReady")}
            {required.size ? ` ${t("setup.policyRequires", { count: required.size })}` : ""}
          </Notice>
          {missing ? <Button data-install-all disabled={busy || !setupOrder(shown).some((i) => i.action)} onClick={() => installAll()}>{t("setup.installMissing")}</Button> : null}
          <div role="status" aria-live="polite">{progress || (remaining !== null ? t(remaining ? "setup.manualRemaining" : "setup.batchDone", { count: remaining }) : null)}</div>
          <ErrorNote error={batch.error} />
          <ErrorNote error={removal.error} />
          {section !== "projects" ? <Group title={t("setup.tools")} sub={[settings.data?.machine, os].filter(Boolean).join(" · ")}>
            <SetupList items={shown.machine.filter(needsSetup)} required={required} onChanged={replace} disabled={busy} onBusy={setRowBusy} />
            {shown.machine.some((i) => !needsSetup(i)) ? <details className="p-4" data-ready-tools>
              <summary className="cursor-pointer text-[13px] text-fg-secondary">{t("setup.readyTools", { tools: shown.machine.filter((i) => !needsSetup(i)).map((i) => `${i.label}${i.version ? ` ${i.version}` : ""}`).join(", ") })}</summary>
              <SetupList items={shown.machine.filter((i) => !needsSetup(i))} required={required} onChanged={replace} disabled={busy} onBusy={setRowBusy} />
            </details> : null}
          </Group> : null}
          {section !== "machine" && shown.projects.length === 0 ? (
            <Empty>{t("setup.noProjectsBelow")}</Empty>
          ) : null}
          {setupGroups(shown.projects, systems).map((group) => (
            <section key={group.name} data-setup-system={group.name} className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-[13px] font-semibold text-fg-strong">{group.name || t("setup.outsideSystems")}</h2>
                {group.name && group.projects.some((p) => p.items.some(needsSetup)) ? <Button size="sm" variant="outline" disabled={busy || !group.projects.some((p) => p.items.some((i) => needsSetup(i) && i.action))} onClick={() => installAll(group.projects.map((p) => p.project))}>{t("setup.installSystem")}</Button> : null}
              </div>
              {group.projects.map((p) => {
                const count = p.items.filter(needsSetup).length;
                const branch = settings.data?.projects.find((project) => project.name === p.project)?.targetBranch ?? "main";
                const closed = gone.get(p.project);
                return <Card key={p.project} data-setup-project={p.project}>
                  <CardContent className="pt-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-semibold text-fg-strong">{p.project}</span>
                      <Chip kind={count ? "warning" : "success"}>{t(count ? "setup.projectMissing" : "setup.projectReady", { count })}</Chip>
                      {count ? <Button size="sm" variant="outline" data-install-project={p.project} disabled={busy || !p.items.some((i) => needsSetup(i) && i.action)} onClick={() => installAll([p.project])}>{t("setup.installAll")}</Button> : null}
                    </div>
                    {closed ? (
                      <Notice tone="warn" className="mt-2" data-project-gone={p.project}>
                        {t(closed.state === "deleted" ? "setup.projectGoneDeleted" : "setup.projectGoneArchived", {
                          project: p.project, by: closed.stateBy ?? "", at: closed.stateAt ? formatTime(closed.stateAt) : "",
                        })}
                        <div className="mt-2">
                          <Button
                            size="sm"
                            variant="outline"
                            data-remove-gone={p.project}
                            disabled={busy || removal.busy}
                            onClick={() => {
                              if (!window.confirm(t("projects.confirmRemove", { project: p.project }))) return;
                              void removal.run(async () => {
                                await desktop.removeProject(p.project);
                                settings.reload();
                                setReport(null);
                                status.reload();
                                onChanged?.();
                              });
                            }}
                          >
                            {t("setup.removeFromMachine")}
                          </Button>
                        </div>
                      </Notice>
                    ) : null}
                    <p className="my-2 truncate font-mono text-xs text-fg-muted" title={p.repo}>{p.repo.replace(/^.*[\\/]([^\\/]+[\\/][^\\/]+)$/, "…/$1")}{branch ? ` · ${branch}` : ""}</p>
                    <details data-project-checks={p.project}>
                      <summary className="cursor-pointer text-[13px] text-fg-secondary">{t("setup.viewItems")}</summary>
                      <SetupList items={[...p.items].sort((a, b) => Number(needsSetup(b)) - Number(needsSetup(a)))} required={required} onChanged={replace} disabled={busy} onBusy={setRowBusy} />
                    </details>
                  </CardContent>
                </Card>;
              })}
            </section>
          ))}
        </>
      ) : null}
      {/* The repos on this machine (add, sync, open a CLI): what the checks above run on (roadmap 35a). */}
      {section !== "machine" && settings.data ? (
        <>
          <ProjectsCard
            settings={settings.data}
            onChanged={() => {
              settings.reload();
              onChanged?.();
              setReport(null);
              status.reload();
            }}
          />
          {settings.data.gitlab.url && settings.data.gitlab.hasToken ? <GitLabImportCard settings={settings.data} onChanged={() => { settings.reload(); setReport(null); status.reload(); onChanged?.(); }} /> : section === "projects" ? <GitLabCard settings={settings.data} onSaved={settings.reload} /> : null}
          {settings.data.github.url && settings.data.github.hasToken ? <GitLabImportCard forge="github" settings={settings.data} onChanged={() => { settings.reload(); setReport(null); status.reload(); onChanged?.(); }} /> : null}
        </>
      ) : null}
      {/*
        Tool của dự án (roadmap 39f): on this machine the catalog lives here instead of a menu entry of its own, and
        without the line about app 28b — nothing here comes from a hub. Connected to one, Tool is on the hub's web.
      */}
      {!section && me.mode !== "hub" ? (
        <section data-project-tools className="flex flex-col gap-[18px]">
          <h2 className="m-0 text-[13px]/[18px] font-semibold text-fg-strong">{t("setup.projectTools")}</h2>
          <ToolCatalog />
        </section>
      ) : null}
    </div>
  );
}

function Group({ title, sub, mono, icon: Icon, children }: { title: string; sub?: string; mono?: boolean; icon?: ComponentType<{ className?: string }>; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="m-0 flex flex-wrap items-center gap-2 text-[13px]/[18px] font-semibold text-fg-strong">
        {Icon ? <Icon className="size-3.5 text-fg-muted" /> : null}
        <span className={cn(mono && "font-mono")}>{title}</span>
        {sub ? <span className="min-w-0 font-mono text-xs/none font-normal break-all text-fg-muted">{sub}</span> : null}
      </h2>
      <div className="overflow-hidden rounded-[10px] border border-line-default bg-surface">{children}</div>
    </section>
  );
}

function RequestsCard({ commands, onAnswered }: { commands: MachineCommand[]; onAnswered: () => void }) {
  const { client } = useHive();
  const t = useT();
  const action = useAction();
  const [done, setDone] = useState<MachineCommand | null>(null);
  const answer = (c: MachineCommand, approve: boolean) =>
    void action.run(async () => {
      setDone(await client.desktop!.answerCommand(c.id, approve));
      onAnswered();
    });
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("setup.requests")}</CardTitle>
        <CardDescription>{t("setup.requestsHint")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          {commands.map((c) => (
            <div key={c.id} className="flex flex-col gap-2 rounded-md border border-line-default p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 font-medium break-words">{c.label}</span>
                <Button size="sm" variant="outline" disabled={action.busy} onClick={() => answer(c, true)}>
                  {action.busy ? t("setup.installing") : t("setup.approve")}
                </Button>
                <Button size="sm" variant="ghost" disabled={action.busy} onClick={() => answer(c, false)}>
                  {t("setup.decline")}
                </Button>
              </div>
              <div className="text-xs break-words text-fg-muted">
                #{c.id} · {c.requestedBy} · {formatTime(c.requestedAt)} · <span className="font-mono break-all">{c.itemId}</span>
              </div>
            </div>
          ))}
        </div>
        <ErrorNote error={action.error} />
        {done ? (
          <Notice tone={done.status === "done" ? "ok" : done.status === "rejected" ? "info" : "error"}>
            {t("setup.answered", {
              id: done.id,
              label: done.label,
              result: done.status === "done" ? t("setup.resultDone") : done.status === "rejected" ? t("setup.resultDeclined") : t("setup.resultFailed"),
            })}
          </Notice>
        ) : null}
      </CardContent>
    </Card>
  );
}

const TRUST_TONE: Record<MachineToolView["trust"], ChipKind> = { app: "success", trusted: "success", new: "warning", changed: "warning" };

/**
 * The hub's tools this machine's projects use (roadmap 28b): the commands a run would start here, for the user to
 * allow, version by version. The app's own entries (codegraph, superpowers, Spec Kit as before) need nothing.
 */
function HubToolsCard({ tools, onChanged }: { tools: MachineToolView[]; onChanged: () => void }) {
  const { client } = useHive();
  const t = useT();
  const action = useAction();
  const [shown, setShown] = useState(tools);
  useEffect(() => setShown(tools), [tools]);
  const trust = (tool: MachineToolView, allow: boolean) =>
    void action.run(async () => {
      setShown(await client.desktop!.toolTrust(tool.id, allow ? tool.hash : null));
      onChanged();
    });
  return (
    <Card data-hub-tools>
      <CardHeader>
        <CardTitle>{t("setup.hubTools")}</CardTitle>
        <CardDescription>{t("setup.hubToolsHint")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {shown.map((tool) => (
          <div key={tool.id} className="flex flex-col gap-2 rounded-md border border-line-default p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 font-medium break-words">
                {tool.name} <span className="font-mono text-xs text-fg-muted">{tool.id}</span>
              </span>
              <Chip kind={TRUST_TONE[tool.trust]}>{t(`setup.toolTrust.${tool.trust}`)}</Chip>
              {tool.trust === "new" || tool.trust === "changed" ? (
                <Button size="sm" variant="outline" disabled={action.busy} onClick={() => trust(tool, true)}>
                  {t("setup.toolAllow")}
                </Button>
              ) : null}
              {tool.trust === "trusted" || tool.trust === "changed" ? (
                <Button size="sm" variant="ghost" disabled={action.busy} onClick={() => trust(tool, false)}>
                  {t("setup.toolRevoke")}
                </Button>
              ) : null}
            </div>
            <div className="text-xs break-words text-fg-muted">
              {t("setup.toolProjects", { projects: tool.projects.join(", ") })} · {t("setup.toolLicense", { license: tool.license })}
              {tool.homepage ? (
                <>
                  {" · "}
                  <a href={tool.homepage} target="_blank" rel="noreferrer" className="text-fg-link underline underline-offset-2">
                    {tool.homepage}
                  </a>
                </>
              ) : null}
            </div>
            {tool.commands.length ? (
              <pre className="m-0 overflow-x-auto rounded-md border border-line-subtle bg-code p-2 font-mono text-xs text-code-fg">
                {tool.commands.map((c) => `${c.field}: ${c.argv.join(" ")}`).join("\n")}
              </pre>
            ) : null}
            {Object.keys(tool.env).length ? (
              <div className="text-xs break-all text-fg-muted">
                {t("setup.toolEnv")}: <span className="font-mono">{Object.entries(tool.env).map(([k, v]) => `${k}=${v}`).join(" ")}</span>
              </div>
            ) : null}
            {tool.secretEnv.length ? <div className="text-xs break-words text-fg-muted">{t("setup.toolSecretEnv", { names: tool.secretEnv.join(", ") })}</div> : null}
          </div>
        ))}
        <ErrorNote error={action.error} />
      </CardContent>
    </Card>
  );
}

function SetupList({ items, required, onChanged, disabled, onBusy }: { items: SetupItem[]; required: Set<string>; onChanged: (item: SetupItem) => Promise<void>; disabled?: boolean; onBusy?: (busy: boolean) => void }) {
  return (
    <>
      {items.map((item) => (
        <SetupRow key={item.id} item={item} required={required.has(item.id)} onChanged={onChanged} disabled={disabled} onBusy={onBusy} />
      ))}
    </>
  );
}

function SetupRow({ item, required, onChanged, disabled, onBusy }: { item: SetupItem; required: boolean; onChanged: (item: SetupItem) => Promise<void>; disabled?: boolean; onBusy?: (busy: boolean) => void }) {
  const { client } = useHive();
  const t = useT();
  const action = useAction();
  const [output, setOutput] = useState<string | null>(null);
  const Icon = iconOf(item.id);
  return (
    <div data-setup-item={item.id} className="flex flex-col gap-2 border-b border-line-subtle px-4 py-[11px] last:border-b-0">
      <div className="flex flex-wrap items-center gap-3">
        <span className="grid size-[30px] shrink-0 place-items-center rounded-[7px] bg-sunken text-fg-secondary">
          <Icon aria-hidden className="size-[15px]" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[13px]/[18px] font-semibold text-fg-strong">{item.label}</span>
        </span>
        {required ? <Chip kind="info">{t("setup.required")}</Chip> : null}
        {hasNewer(item) ? <Chip kind="warning">{t("setup.newVersion", { version: item.latest! })}</Chip> : null}
        <span className="inline-flex h-[22px] items-center rounded-full px-2">
          <Chip kind={TONE[item.state]}>{t(`setupState.${item.state}`)}</Chip>
        </span>
        {item.action ? (
          <Button
            size="sm"
            variant="outline"
            className="min-w-[84px]"
            disabled={action.busy || disabled}
            onClick={() =>
              void action.run(async () => {
                onBusy?.(true);
                try {
                  const r = await client.desktop!.installSetup(item.id);
                  setOutput(r.output || null);
                  await onChanged(r.item);
                } finally { onBusy?.(false); }
              })
            }
          >
            {action.busy ? t("setup.installing") : item.action}
          </Button>
        ) : null}
      </div>
      <details className="pl-[42px]">
        <summary className="cursor-pointer text-xs text-fg-muted">{t("setup.details")}</summary>
        <p className="font-mono text-xs break-all text-fg-muted">{item.detail}</p>
      </details>
      <ErrorNote error={action.error} />
      {output ? (
        <details className="pl-[42px]">
          <summary className="cursor-pointer text-xs text-fg-muted select-none hover:text-fg-strong">{t("setup.output")}</summary>
          <pre className="mt-2 max-h-80 overflow-auto rounded-md border border-line-subtle bg-code p-3 font-mono text-xs text-code-fg">{output}</pre>
        </details>
      ) : null}
    </div>
  );
}
