import { ProjectOnboarding } from "#ui/components/ProjectOnboarding.tsx";
// Systems (roadmap 19b): the projects that make one product, a repository (service) each. Picked in the sidebar,
// the pages show the tasks, runs, merge requests and chat of every project in the system.
import { useMemo, useState } from "react";
import { Boxes, FolderGit2, Search } from "lucide-react";
import { PROJECT_NAME, systemFolders, type HiveSystem, type ProjectSummary, type SystemMemberState, type RepoAccessStatus, type SystemMemberHealth, type SystemMemberMachine } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@xdev-hive/ui/components/ui/card";
import { Checkbox } from "@xdev-hive/ui/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@xdev-hive/ui/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@xdev-hive/ui/components/ui/dropdown-menu";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { Label } from "@xdev-hive/ui/components/ui/label";
import { Badge, Empty, ErrorNote, Notice, Page, PageHeader } from "#ui/components/common.tsx";
import { formatTime, useAction, useCan, useHive, useQuery } from "#ui/hooks.ts";
import { useT, type MessageKey } from "#ui/i18n/index.tsx";
import { nameMatches, outsideSystems, projectScope, systemScope } from "#ui/lib/scope.ts";
import { AgentPolicyCard } from "#ui/pages/admin/AgentPolicy.tsx";
import { canSetUpGroups, SystemGroupPanel } from "#ui/components/SystemGroup.tsx";
import { OpenSystemCli } from "#ui/components/OpenCli.tsx";
import { SdlcGatesCard } from "#ui/pages/admin/SdlcGates.tsx";

/** `policy`: a lead's policy rows at the end; Cài đặt dự án has them on a tab of their own (roadmap 49b). */
export function SystemsPage({ policy = true }: { policy?: boolean } = {}) {
  const { client, systems, setScope, me, projects } = useHive();
  const t = useT();
  // Only a hub hears machines; a hub from before the method answers nothing, and the members show as they used to.
  const health = useQuery(
    async () => (me.mode === "hub" ? await client.call("systems.repoHealth", {}).catch(() => []) : []),
    [client, me.mode, systems],
  );
  const healthOf = useMemo(() => new Map((health.data ?? []).map((h) => [h.project, h])), [health.data]);
  const allow = useCan();
  // The system being edited, "" for a new one.
  const [editing, setEditing] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // A system shows when its name or one of its projects matches: looking for a project finds the system it is in.
  const shown = systems.filter((s) => nameMatches(s.name, query) || s.projects.some((p) => nameMatches(p, query)));
  const outside = useMemo(() => outsideSystems(projects, systems), [projects, systems]);
  const outsideShown = outside.filter((p) => nameMatches(p, query));
  // Setting a system's group up on this machine (GROUP-init-sync): the desktop app only.
  const groups = canSetUpGroups(client.desktop);
  // GROUP-cli: a CLI over every repo of a system, from its card (desktop app only).
  const profiles = useQuery(async () => (client.desktop ? await client.desktop.profiles() : []), [client]);
  const [groupOpen, setGroupOpen] = useState<string | null>(null);

  return (
    <Page>
      <PageHeader
        title={t("nav.systems")}
        subtitle={t("systems.subtitle")}
        actions={
          editing === "" ? null : (
            <Button size="sm" onClick={() => setEditing("")}>
              {t("systems.new")}
            </Button>
          )
        }
      />
      <ProjectOnboarding />
      {systems.length + outside.length > 0 ? (
        <div className="relative max-w-sm">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            className="pl-8"
            type="search"
            data-systems-search
            placeholder={t("systems.search")}
            aria-label={t("systems.search")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      ) : null}
      {editing === "" ? <SystemEditor system={null} onDone={() => setEditing(null)} /> : null}
      {systems.length === 0 && editing !== "" ? <Empty>{t("systems.none")}</Empty> : null}
      {query.trim() && systems.length + outside.length > 0 && shown.length + outsideShown.length === 0 ? (
        <Empty>{t("systems.noMatch", { query: query.trim() })}</Empty>
      ) : null}
      {shown.map((s) =>
        editing === s.name ? (
          <SystemEditor key={s.name} system={s} onDone={() => setEditing(null)} />
        ) : (
          <Card key={s.name} data-system={s.name}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 font-mono">
                <Boxes className="size-4 text-muted-foreground" />
                {s.name}
              </CardTitle>
              <CardDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
                {t("systems.updated", { time: formatTime(s.updatedAt), name: s.updatedBy })}
                {s.source ? (
                  <span data-system-source={s.source.groupPath}>
                    <Badge tone="neutral" className="font-mono">
                      {t("systemGroup.source", { forge: s.source.forge === "github" ? "GitHub" : "GitLab", group: s.source.groupPath })}
                    </Badge>
                  </span>
                ) : null}
              </CardDescription>
              <CardAction className="flex gap-2">
                {groups && (s.source || s.projects.every((p) => allow(p, "projectSettings"))) ? (
                  <Button size="sm" variant="outline" data-system-group-open={s.name} aria-expanded={groupOpen === s.name} onClick={() => setGroupOpen(groupOpen === s.name ? null : s.name)}>
                    {t(s.source ? "systemGroup.initOnMachine" : "systemGroup.link")}
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setScope(systemScope(s.name, s.projects));
                    window.location.hash = "#/overview";
                  }}
                >
                  {t("systems.open")}
                </Button>
                {/* Roadmap 19c: the system's own docs and memory, shared by its services; its scope shows them first. */}
                {(["docs", "memory"] as const).map((page) => (
                  <Button
                    key={page}
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setScope(systemScope(s.name, s.projects));
                      window.location.hash = `#/${page}`;
                    }}
                  >
                    {t(page === "docs" ? "systems.docs" : "systems.memory")}
                  </Button>
                ))}
                {s.projects.every((p) => allow(p, "projectSettings")) ? (
                  <Button size="sm" variant="outline" onClick={() => setEditing(s.name)}>
                    {t("systems.edit")}
                  </Button>
                ) : null}
              </CardAction>
            </CardHeader>
            {groups && groupOpen === s.name ? (
              <CardContent>
                <SystemGroupPanel system={s} />
              </CardContent>
            ) : null}
            {client.desktop ? (
              <CardContent>
                <OpenSystemCli profiles={profiles.data ?? []} system={s.name} />
              </CardContent>
            ) : null}
            {/* The group's tree (his › backend › svc-core) when the system has a source (GROUP-init-sync). */}
            {systemFolders(s).map(({ folder, projects: inFolder }) => (
              <CardContent key={folder.join("/")} className="flex flex-col gap-1" data-system-folder={folder.join("/")}>
                {folder.length ? <span className="font-mono text-xs font-medium text-muted-foreground">{folder.join(" › ")}</span> : null}
                {s.projects.some((p) => healthOf.has(p)) ? (
                  <ul className="flex flex-col divide-y">
                    {inFolder.map((p) => (
                      <MemberHealth key={p} project={p} health={healthOf.get(p)} state={memberState(s, p)} />
                    ))}
                  </ul>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {inFolder.map((p) => (
                      <span key={p} data-system-member={p} data-member-state={memberState(s, p)}>
                        <Badge tone={memberState(s, p) === "active" ? "neutral" : "warn"} className="font-mono">
                          {p}
                          {memberState(s, p) !== "active" ? ` · ${t(`systemGroup.memberState.${memberState(s, p)}`)}` : ""}
                        </Badge>
                      </span>
                    ))}
                  </div>
                )}
              </CardContent>
            ))}
          </Card>
        ),
      )}
      <OutsideProjects all={outside} shown={outsideShown} />
      {/* Archiving and deleting a project (roadmap 47) is a hub admin's; the desktop sends them to the hub's web. */}
      {me.mode === "hub" && me.role === "admin" && !me.access ? <ProjectsCard query={query} /> : null}
      {/* A project manager has no Web Admin: their project's agent policy row lives here, with its other settings. */}
      {policy && me.mode === "hub" && !(me.role === "admin" && !me.access) && projects.some((p) => allow(p, "projectSettings")) ? (
        <>
          <AgentPolicyCard editableOnly />
          <SdlcGatesCard editableOnly />
        </>
      ) : null}
    </Page>
  );
}

/** The fix to suggest for a member nobody reaches: access first, since that one needs a person to act on it. */
function healthHint(h: SystemMemberHealth): MessageKey {
  const statuses = new Set(h.machines.map((m) => m.status));
  if (h.state === "no_machine") return "systems.health.hintNoMachine";
  if (h.state === "unchecked") return "systems.health.hintUnchecked";
  if (statuses.has("no_access") || statuses.has("no_access_or_missing")) return "systems.health.hintAccess";
  if (statuses.has("not_found")) return "systems.health.hintNotFound";
  if (statuses.has("network")) return "systems.health.hintNetwork";
  return "systems.health.hintError";
}

/**
 * One member of a system and whether its repo answers: reachable on some machine, not reachable on the ones that
 * checked (with why, and what to do), or on no machine at all (incident 2026-10-09: nobody knew until a clone failed).
 */
/** A member's state in the system's group: archived or gone ones stay in the system, marked. */
const memberState = (s: HiveSystem, project: string): SystemMemberState => s.source?.members.find((m) => m.project === project)?.state ?? "active";

function MemberHealth({ project, health, state = "active" }: { project: string; health: SystemMemberHealth | undefined; state?: SystemMemberState }) {
  const t = useT();
  const checked = (health?.machines ?? []).filter((m): m is SystemMemberMachine & { status: RepoAccessStatus } => m.status !== null);
  const reached = checked.filter((m) => m.status === "ok");
  const failed = checked.filter((m) => m.status !== "ok");
  const names = (ms: typeof checked) => ms.map((m) => m.machine).join(", ");
  const badge = !health
    ? null
    : health.state === "reachable"
      ? { tone: "ok", text: failed.length ? t("systems.health.reachableOn", { machines: names(reached) }) : t("systems.health.reachable") }
      : health.state === "unreachable"
        ? { tone: "danger", text: t("systems.health.unreachable", { machines: names(failed) }) }
        : health.state === "no_machine"
          ? { tone: "warn", text: t("systems.health.noMachine") }
          : { tone: "neutral", text: t("systems.health.unchecked") };
  return (
    <li data-system-member={project} data-repo-state={health?.state ?? "unknown"} className="flex flex-col gap-1 py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <FolderGit2 className="size-4 text-muted-foreground" aria-hidden />
        <span className="font-mono text-sm">{project}</span>
        {state !== "active" ? <span data-member-state={state}><Badge tone="warn">{t(`systemGroup.memberState.${state}`)}</Badge></span> : null}
        {badge ? <Badge tone={badge.tone}>{badge.text}</Badge> : null}
      </div>
      {health && health.state !== "reachable" ? <p className="text-xs text-muted-foreground">{t(healthHint(health))}</p> : null}
      {/* Each failing machine's reason, so its owner knows the fix is theirs; a reachable member needs no more. */}
      {failed.length ? (
        <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
          {failed.map((m) => (
            <li key={m.machineId} data-repo-machine={m.machine} data-repo-status={m.status} title={m.detail ?? undefined}>
              {t("systems.health.machine", { machine: m.machine, status: t(`systems.health.status.${m.status}`), time: formatTime(m.checkedAt ?? "") })}
              {m.detail ? <span className="ml-1 font-mono break-all">— {m.detail}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** The projects no system has (roadmap 36c), one line each with its open tasks, to open or add to a system. */
function OutsideProjects({ all, shown }: { all: string[]; shown: string[] }) {
  const { client, systems, bump, scope, setScope } = useHive();
  const t = useT();
  const allow = useCan();
  const action = useAction();
  // At most 200 projects per call (the method's limit); past that the count is left out rather than guessed.
  const asked = all.slice(0, 200);
  const tasks = useQuery(async () => (asked.length ? client.call("tasks.list", { projects: asked }) : []), [client, asked.join(",")]);
  const open = useMemo(() => {
    const n = new Map<string, number>();
    for (const task of tasks.data ?? []) if (task.status !== "done") n.set(task.project, (n.get(task.project) ?? 0) + 1);
    return n;
  }, [tasks.data]);
  // systems.save needs the project's settings and every project the system already has, as the editor does.
  const targets = systems.filter((s) => s.projects.every((p) => allow(p, "projectSettings")));
  // Hidden while a search matches none of them; the page says so when nothing at all matches.
  if (shown.length === 0) return null;

  const add = (project: string, name: string) =>
    void action.run(async () => {
      const before = systems.find((s) => s.name === name)?.projects ?? [];
      const saved = await client.call("systems.save", { name, projects: [...new Set([...before, project])] });
      if (scope.kind === "system" && scope.system === saved.name) setScope(systemScope(saved.name, saved.projects));
      bump();
    });

  return (
    <Card data-systems-outside>
      <CardHeader>
        <CardTitle>{t("systems.outside")}</CardTitle>
        <CardDescription>{t("systems.outsideHint")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <ErrorNote error={action.error} />
        <ul className="flex flex-col divide-y">
          {shown.map((p) => (
            <li key={p} data-outside-project={p} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2">
              <FolderGit2 className="size-4 text-muted-foreground" aria-hidden />
              <span className="font-mono text-sm">{p}</span>
              {tasks.data && asked.includes(p) ? (
                <span className="text-xs text-muted-foreground">{t("systems.openTasks", { count: open.get(p) ?? 0 })}</span>
              ) : null}
              <span className="flex-1" />
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setScope(projectScope(p));
                  window.location.hash = "#/overview";
                }}
              >
                {t("systems.open")}
              </Button>
              {allow(p, "projectSettings") && targets.length ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="sm" variant="ghost" data-outside-add={p} disabled={action.busy}>
                      {t("systems.addTo")}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {targets.map((s) => (
                      <DropdownMenuItem key={s.name} className="font-mono" onSelect={() => add(p, s.name)}>
                        {s.name}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/**
 * Every project the hub knows (roadmap 47), with what it holds, and the buttons to archive one, bring it back, or
 * delete it for good. A hub admin's table: archiving hides a project from everyone, deleting cannot be undone.
 */
function ProjectsCard({ query }: { query: string }) {
  const { client, bump } = useHive();
  const t = useT();
  const action = useAction();
  const [tick, setTick] = useState(0);
  const [deleting, setDeleting] = useState<ProjectSummary | null>(null);
  // A hub from before this method has none of it: the card stays empty instead of showing an error.
  const list = useQuery(() => client.call("projects.list", {}).catch(() => []), [client, tick]);
  const rows = (list.data ?? []).filter((p) => nameMatches(p.project, query));
  const refresh = () => {
    setTick((n) => n + 1);
    bump();
  };

  if (!rows.length) return null;
  return (
    <Card data-projects-admin>
      <CardHeader>
        <CardTitle>{t("projectAdmin.title")}</CardTitle>
        <CardDescription>{t("projectAdmin.hint")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <ErrorNote error={action.error} />
        <ul className="flex flex-col divide-y">
          {rows.map((p) => (
            <li key={p.project} data-project-row={p.project} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2">
              <FolderGit2 className="size-4 text-muted-foreground" aria-hidden />
              <span className="font-mono text-sm">{p.project}</span>
              {p.state ? (
                <Badge tone={p.state === "deleted" ? "danger" : "warn"}>{t(p.state === "deleted" ? "projectAdmin.deleted" : "projectAdmin.archived")}</Badge>
              ) : null}
              <span className="text-xs text-muted-foreground">
                {t("projectAdmin.counts", { tasks: p.tasks, open: p.openTasks, docs: p.docs, memory: p.memory, runs: p.runs })}
              </span>
              {p.machines.length ? <span className="text-xs text-muted-foreground">{t("projectAdmin.onMachines", { machines: p.machines.join(", ") })}</span> : null}
              {p.systems.length ? <span className="text-xs text-muted-foreground">{t("projectAdmin.inSystems", { systems: p.systems.join(", ") })}</span> : null}
              <span className="flex-1" />
              {p.state === null ? (
                <Button
                  size="sm"
                  variant="outline"
                  data-project-archive={p.project}
                  disabled={action.busy}
                  onClick={() => void action.run(async () => (await client.call("projects.archive", { project: p.project }), refresh()))}
                >
                  {t("projectAdmin.archive")}
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  data-project-restore={p.project}
                  disabled={action.busy}
                  onClick={() => void action.run(async () => (await client.call("projects.restore", { project: p.project }), refresh()))}
                >
                  {t(p.state === "deleted" ? "projectAdmin.restoreName" : "projectAdmin.restore")}
                </Button>
              )}
              {p.state === "archived" ? (
                <Button size="sm" variant="destructive" data-project-delete={p.project} disabled={action.busy} onClick={() => setDeleting(p)}>
                  {t("projectAdmin.delete")}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      </CardContent>
      {deleting ? (
        <DeleteProjectDialog
          project={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null);
            refresh();
          }}
        />
      ) : null}
    </Card>
  );
}

/** What is about to be lost, spelled out, and the project's name to type: a deletion nobody can undo asks twice. */
function DeleteProjectDialog({ project, onClose, onDeleted }: { project: ProjectSummary; onClose: () => void; onDeleted: () => void }) {
  const { client } = useHive();
  const t = useT();
  const [typed, setTyped] = useState("");
  const action = useAction();

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("projectAdmin.deleteTitle", { project: project.project })}</DialogTitle>
          <DialogDescription>{t("projectAdmin.deleteWhat", { tasks: project.tasks, docs: project.docs, memory: project.memory, runs: project.runs })}</DialogDescription>
        </DialogHeader>
        <Notice tone="warn" title={t("projectAdmin.deleteBackup")}>
          {t("projectAdmin.deleteForever")}
        </Notice>
        <ErrorNote error={action.error} />
        <Label htmlFor="delete-project-name">{t("projectAdmin.deleteConfirmLabel", { project: project.project })}</Label>
        <Input
          id="delete-project-name"
          data-project-delete-name
          className="font-mono"
          autoComplete="off"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
        />
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={action.busy}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="destructive"
            data-project-delete-confirm
            disabled={action.busy || typed !== project.project}
            onClick={() => void action.run(async () => (await client.call("projects.delete", { project: project.project, confirm: typed }), onDeleted()))}
          >
            {t("projectAdmin.delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A new system (its name and projects), or the projects of one there is. */
function SystemEditor({ system, onDone }: { system: HiveSystem | null; onDone: () => void }) {
  const { client, projects, bump, scope, setScope } = useHive();
  const t = useT();
  const allow = useCan();
  const [name, setName] = useState(system?.name ?? "");
  const [picked, setPicked] = useState<Set<string>>(() => new Set(system?.projects ?? []));
  const [confirming, setConfirming] = useState(false);
  const action = useAction();
  const choices = [...new Set([...projects, ...(system?.projects ?? [])])].sort();
  const nameOk = PROJECT_NAME.test(name);
  const toggle = (p: string, on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(p);
      else next.delete(p);
      return next;
    });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{system ? system.name : t("systems.new")}</CardTitle>
        <CardDescription>{t("systems.editHint")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(async () => {
              const saved = await client.call("systems.save", { name, projects: [...picked] });
              // Looking at it: the sidebar follows its new projects.
              if (scope.kind === "system" && scope.system === saved.name) setScope(systemScope(saved.name, saved.projects));
              bump();
              onDone();
            });
          }}
        >
          {system ? null : (
            <div className="flex max-w-xs flex-col gap-1.5">
              <Label htmlFor="system-name">{t("systems.name")}</Label>
              <Input
                id="system-name"
                className="font-mono"
                placeholder="ehealth"
                value={name}
                aria-invalid={name !== "" && !nameOk}
                onChange={(e) => setName(e.target.value.toLowerCase())}
              />
            </div>
          )}
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-medium">{t("systems.projects")}</legend>
            {choices.length === 0 ? <p className="text-sm text-muted-foreground">{t("scope.noProjects")}</p> : null}
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {choices.map((p) => {
                const id = `system-project-${p}`;
                return (
                  <div key={p} className="flex items-center gap-2">
                    <Checkbox id={id} checked={picked.has(p)} disabled={!allow(p, "projectSettings")} onCheckedChange={(v) => toggle(p, v === true)} />
                    <Label htmlFor={id} className="font-mono text-sm font-normal">
                      {p}
                    </Label>
                  </div>
                );
              })}
            </div>
          </fieldset>
          <ErrorNote error={action.error} />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={!nameOk || picked.size === 0 || action.busy}>
              {t("systems.save")}
            </Button>
            <Button type="button" variant="ghost" onClick={onDone}>
              {t("systems.cancel")}
            </Button>
            {system ? (
              confirming ? (
                <Button
                  type="button"
                  variant="destructive"
                  className="ml-auto"
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(async () => {
                      await client.call("systems.remove", { name: system.name });
                      bump();
                      onDone();
                    })
                  }
                >
                  {t("systems.removeConfirm")}
                </Button>
              ) : (
                <Button type="button" variant="ghost" className="ml-auto text-destructive" onClick={() => setConfirming(true)}>
                  {t("systems.remove")}
                </Button>
              )
            ) : null}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
