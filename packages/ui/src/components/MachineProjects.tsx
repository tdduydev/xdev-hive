import { useState } from "react";
import { projectCommandStatus, type MachineProjectCommand, type MachineProjects } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { TableBody, TableCell, TableHead, TableHeader } from "@xdev-hive/ui/components/ui/table";
import { ResponsiveTable, ResponsiveTableRow } from "#ui/components/ResponsiveTable.tsx";
import { ErrorNote, Notice } from "#ui/components/common.tsx";
import { Chip } from "#ui/components/panes.tsx";
import { formatTime, useAction, useHive, useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";

const CONTROL = "min-h-11 md:min-h-7";
const selectClass = "min-h-11 w-full min-w-0 rounded-md border border-line-default bg-surface px-3 text-base text-fg-primary outline-none focus-visible:focus-ring md:text-sm";
type Order = { op: "add" | "remove"; project: string; repo?: string; gitlabProject?: string; cloneUrl?: string };

/**
 * Each machine's project list as its app reports it, for hub admins (ADM-machine-projects): adding or dropping a
 * project goes to the machine as a command, so no one has to quit the app and edit its config.json by hand.
 */
export function MachineProjectsPanel({ poll }: { poll: number }) {
  const { client } = useHive();
  const t = useT();
  const action = useAction();
  const [tick, setTick] = useState(0);
  const machines = useQuery(() => client.call("machines.projects", {}), [client, tick, poll]);
  const known = useQuery(() => client.call("projects.list", {}).catch(() => []), [client, tick]);
  const send = (machineId: string, order: Order) => action.run(async () => {
    await client.call("machines.projectCommand", { machine: machineId, ...order });
    setTick((v) => v + 1);
  });
  const active = (known.data ?? []).filter((p) => !p.state).map((p) => p.project);
  const leftovers = (machines.data ?? []).flatMap((m) => m.repos.filter((r) => r.state === "deleted").map((r) => ({ machine: m, repo: r })));
  return (
    <section className="mt-6 flex flex-col gap-3" data-machine-projects>
      <h2 className="m-0 text-base font-semibold">{t("machineProjects.title")}</h2>
      <p className="m-0 max-w-[760px] text-xs/5 text-fg-muted">{t("machineProjects.hint")}</p>
      <ErrorNote error={machines.error ?? action.error} />
      {leftovers.length ? (
        <Notice tone="warn">
          <div className="flex flex-col gap-2" data-deleted-project-warning>
            {leftovers.map(({ machine: m, repo }) => (
              <div key={`${m.machineId}/${repo.project}`} className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 break-words">{t("machineProjects.deletedWarning", { machine: m.machine, project: repo.project, path: repo.path })}</span>
                {pendingFor(m, repo.project) ? <span role="status" className="text-xs">{t("machineProjects.status.pending")}</span> : (
                  <Button size="sm" variant="outline" className={CONTROL} disabled={action.busy} data-suggest-remove={`${m.machine}/${repo.project}`} onClick={() => void send(m.machineId, { op: "remove", project: repo.project })}>{t("machineProjects.remove")}</Button>
                )}
              </div>
            ))}
          </div>
        </Notice>
      ) : null}
      {machines.data?.map((m) => <MachineProjectsCard key={m.machineId} machine={m} active={active} busy={action.busy} send={(order) => send(m.machineId, order)} />)}
    </section>
  );
}

const pendingFor = (m: MachineProjects, project: string) => m.commands.some((c) => c.project === project && projectCommandStatus(c) === "pending");

function StatusChip({ command }: { command: MachineProjectCommand }) {
  const t = useT();
  const status = projectCommandStatus(command);
  return <Chip small kind={status === "ok" ? "success" : status === "pending" ? "info" : "warning"}>{t(`machineProjects.status.${status}`)}</Chip>;
}

function MachineProjectsCard({ machine: m, active, busy, send }: { machine: MachineProjects; active: string[]; busy: boolean; send: (order: Order) => Promise<unknown> }) {
  const t = useT();
  const [project, setProject] = useState("");
  const [repo, setRepo] = useState("");
  const [cloneUrl, setCloneUrl] = useState("");
  const [gitlabProject, setGitlabProject] = useState("");
  const offered = active.filter((p) => !m.repos.some((r) => r.project === p));
  const add = () => void send({ op: "add", project, repo: repo.trim(), ...(cloneUrl.trim() ? { cloneUrl: cloneUrl.trim() } : {}), ...(gitlabProject.trim() ? { gitlabProject: gitlabProject.trim() } : {}) })
    .then(() => { setProject(""); setRepo(""); setCloneUrl(""); setGitlabProject(""); });
  return (
    <details className="min-w-0 rounded-lg border border-line-default p-3" data-machine-projects-card={m.machine}>
      <summary className="flex min-h-11 cursor-pointer items-center gap-2 text-sm font-medium select-none md:min-h-7">
        <span className="break-all font-mono">{m.machine}</span>
        <span className="text-xs font-normal text-fg-muted">{t("machineProjects.count", { count: m.repos.length })}</span>
      </summary>
      <div className="flex min-w-0 flex-col gap-3 pt-3">
        {!m.supported ? <p className="m-0 text-sm">{t("machineProjects.oldApp")}</p> : <>
          {m.repos.length ? (
            <ResponsiveTable>
              <TableHeader><ResponsiveTableRow>
                <TableHead>{t("machineProjects.project")}</TableHead><TableHead>{t("machineProjects.path")}</TableHead><TableHead>{t("machineProjects.lastCommand")}</TableHead><TableHead />
              </ResponsiveTableRow></TableHeader>
              <TableBody>
                {m.repos.map((r) => {
                  const last = m.commands.find((c) => c.project === r.project);
                  return (
                    <ResponsiveTableRow key={r.project} data-machine-project={r.project}>
                      <TableCell><span className="break-all font-mono text-xs">{r.project}</span>{r.state ? <span className="block text-xs text-warning">{t(`machineProjects.state.${r.state}`)}</span> : null}</TableCell>
                      <TableCell className="whitespace-normal"><span className="break-all font-mono text-xs">{r.path}</span></TableCell>
                      <TableCell>{last ? <StatusChip command={last} /> : null}</TableCell>
                      <TableCell>{pendingFor(m, r.project) ? null : <Button size="sm" variant="outline" className={CONTROL} disabled={busy} data-remove-machine-project={r.project} onClick={() => void send({ op: "remove", project: r.project })}>{t("machineProjects.remove")}</Button>}</TableCell>
                    </ResponsiveTableRow>
                  );
                })}
              </TableBody>
            </ResponsiveTable>
          ) : <p className="m-0 text-sm">{t("machineProjects.none")}</p>}
          <form className="flex flex-col gap-3 rounded-lg border border-dashed border-line-default p-3" data-add-machine-project onSubmit={(e) => { e.preventDefault(); if (project && repo.trim()) add(); }}>
            <p className="m-0 text-sm font-medium">{t("machineProjects.addTitle")}</p>
            <div className="grid gap-3 md:grid-cols-2">
              <label className="flex min-w-0 flex-col gap-1 text-sm">{t("machineProjects.project")}
                <select className={selectClass} value={project} required disabled={busy} onChange={(e) => setProject(e.target.value)} data-add-project>
                  <option value="">{t("machineProjects.pick")}</option>
                  {offered.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </label>
              <label className="flex min-w-0 flex-col gap-1 text-sm">{t("machineProjects.path")}
                <Input value={repo} required disabled={busy} placeholder={t("machineProjects.pathPlaceholder")} onChange={(e) => setRepo(e.target.value)} className="font-mono text-base md:text-sm" data-add-path />
              </label>
              <label className="flex min-w-0 flex-col gap-1 text-sm">{t("machineProjects.cloneUrl")}
                <Input value={cloneUrl} disabled={busy} placeholder="git@gitlab.example.com:group/repo.git" onChange={(e) => setCloneUrl(e.target.value)} className="font-mono text-base md:text-sm" data-add-clone-url />
              </label>
              <label className="flex min-w-0 flex-col gap-1 text-sm">{t("machineProjects.gitlabProject")}
                <Input value={gitlabProject} disabled={busy} placeholder="group/repo" onChange={(e) => setGitlabProject(e.target.value)} className="font-mono text-base md:text-sm" data-add-gitlab />
              </label>
            </div>
            <p className="m-0 text-xs/5 text-fg-muted">{t("machineProjects.addHint")}</p>
            <Button type="submit" size="sm" className={`${CONTROL} self-start`} disabled={busy || !project || !repo.trim()}>{t("machineProjects.add")}</Button>
          </form>
          {m.commands.length ? (
            <div className="flex flex-col gap-1 text-xs/5" data-machine-project-commands>
              <p className="m-0 font-medium">{t("machineProjects.commands")}</p>
              {m.commands.slice(0, 10).map((c) => (
                <p key={c.id} className="m-0 flex flex-wrap items-center gap-2 break-all">
                  <StatusChip command={c} />
                  <span>{formatTime(c.requestedAt)} · {c.requestedBy} · {t(`machineProjects.op.${c.op}`)} {c.project}{c.repo ? ` → ${c.repo}` : ""}</span>
                  {c.error ? <span className="block w-full text-fg-muted">{c.error}</span> : null}
                </p>
              ))}
            </div>
          ) : null}
        </>}
      </div>
    </details>
  );
}
