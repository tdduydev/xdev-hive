import { useState } from "react";
import { cn } from "cn";
import { TASK_STATUSES, type Task, type TaskStatus } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Card, CardContent } from "@xdev-hive/ui/components/ui/card";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@xdev-hive/ui/components/ui/table";
import { Badge, Empty, ErrorNote, Notice, OwnerBadge, Page, PageHeader, STATUS_TONE } from "../components/common.tsx";
import { formatTime, useAction, useCan, useHive, useQuery } from "../hooks.ts";
import { useT } from "../i18n/index.tsx";
import { scopeProject } from "../lib/scope.ts";

/** Text colour of the status select, keyed by STATUS_TONE. */
const TONE_TEXT: Record<string, string> = {
  ok: "text-success",
  info: "text-info",
  warn: "text-warning",
  danger: "text-destructive",
};

export function TasksPage() {
  const { client, scope, projects } = useHive();
  const t = useT();
  const allow = useCan();
  const managed = projects.filter((p) => allow(p, "manage"));
  // Tasks always belong to one project: the shared scope has none of its own, so it shows every project's.
  const scoped = scopeProject(scope);
  const [status, setStatus] = useState<TaskStatus | "">("");
  const list = useQuery(
    () => client.call("tasks.list", { project: scoped ?? undefined, status: status || undefined }),
    [client, scoped, status],
  );
  const next = useQuery(() => client.call("tasks.next", { project: scoped ?? undefined, limit: 3 }), [client, scoped, list.data]);

  return (
    <Page>
      <PageHeader title={t("tasks.title")} subtitle={t("tasks.subtitle")} />
      <div className="flex flex-wrap items-center gap-2">
        <NativeSelect value={status} onChange={(e) => setStatus(e.target.value as TaskStatus | "")} aria-label={t("tasks.status")}>
          <NativeSelectOption value="">{t("tasks.anyStatus")}</NativeSelectOption>
          {TASK_STATUSES.map((s) => (
            <NativeSelectOption key={s} value={s}>
              {t(`taskStatus.${s}`)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      {scope.kind === "shared" ? <Notice tone="info">{t("tasks.sharedScope")}</Notice> : null}
      {next.data && list.data?.some((task) => task.status !== "done") ? (
        <Notice tone="info">
          {next.data.length ? (
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-medium">{t("tasks.nextReady")}</span>
              {next.data.map((task) => (
                <span key={task.id} className="min-w-0 wrap-anywhere">
                  <span className="font-mono text-xs">{task.id}</span> {task.title}
                </span>
              ))}
            </span>
          ) : (
            t("tasks.nextNone")
          )}
        </Notice>
      ) : null}
      {managed.length || allow(null, "manage") ? (
        <CreateTask
          key={scoped ?? ""}
          defaultProject={scoped && managed.includes(scoped) ? scoped : ""}
          projects={allow(null, "manage") ? projects : managed}
          onCreated={list.reload}
        />
      ) : null}
      <ErrorNote error={list.error} />
      {list.data?.length === 0 ? <Empty>{t("tasks.none")}</Empty> : null}
      {list.data?.length ? (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>ID</TableHead>
                <TableHead>{t("tasks.colTitle")}</TableHead>
                {scoped === null ? <TableHead>{t("tasks.colProject")}</TableHead> : null}
                <TableHead>{t("tasks.status")}</TableHead>
                <TableHead>{t("tasks.colDeps")}</TableHead>
                <TableHead>{t("tasks.colOwner")}</TableHead>
                <TableHead>{t("tasks.colNote")}</TableHead>
                <TableHead>{t("tasks.colUpdated")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data.map((task) => (
                <TaskRow key={task.id} task={task} showProject={scoped === null} onChanged={list.reload} />
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}
    </Page>
  );
}

function TaskRow({ task, showProject, onChanged }: { task: Task; showProject: boolean; onChanged: () => void }) {
  const { client } = useHive();
  const t = useT();
  const allow = useCan();
  const action = useAction();
  return (
    <TableRow>
      <TableCell className="font-mono text-xs">{task.id}</TableCell>
      <TableCell className="min-w-48 font-medium break-words whitespace-normal">
        {task.title}
        <ErrorNote error={action.error} />
      </TableCell>
      {showProject ? (
        <TableCell>
          <OwnerBadge owner={task.project} />
        </TableCell>
      ) : null}
      <TableCell>
        {!allow(task.project, "contribute") ? (
          <Badge tone={STATUS_TONE[task.status]}>{t(`taskStatus.${task.status}`)}</Badge>
        ) : (
          <NativeSelect
            size="sm"
            className={cn("min-w-32", TONE_TEXT[STATUS_TONE[task.status] ?? ""])}
            value={task.status}
            disabled={action.busy}
            aria-label={t("tasks.statusOf", { id: task.id })}
            onChange={(e) =>
              void action.run(async () => {
                await client.call("tasks.update", { id: task.id, status: e.target.value as TaskStatus });
                onChanged();
              })
            }
          >
            {TASK_STATUSES.map((s) => (
              <NativeSelectOption key={s} value={s}>
                {t(`taskStatus.${s}`)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        )}
      </TableCell>
      <TableCell className="min-w-28 text-xs">
        <Deps task={task} onChanged={onChanged} />
      </TableCell>
      <TableCell className="text-xs">
        {task.owner ?? <span className="text-muted-foreground">—</span>}
        {task.leaseUntil ? <div className="text-xs text-muted-foreground">{t("tasks.leaseUntil", { time: formatTime(task.leaseUntil) })}</div> : null}
      </TableCell>
      <TableCell className="max-w-80 min-w-48 text-xs break-words whitespace-pre-wrap">{task.note ?? <span className="text-muted-foreground">—</span>}</TableCell>
      <TableCell className="text-xs text-muted-foreground">{formatTime(task.updatedAt)}</TableCell>
    </TableRow>
  );
}

/** "T-1, T-2" → ids. */
const parseIds = (text: string) => text.split(/[\s,]+/).filter(Boolean);

function Deps({ task, onChanged }: { task: Task; onChanged: () => void }) {
  const { client } = useHive();
  const t = useT();
  const allow = useCan();
  const action = useAction();
  const [editing, setEditing] = useState(false);
  const deps = task.dependsOn ?? [];
  const [text, setText] = useState(deps.join(", "));
  if (editing) {
    return (
      <form
        className="flex flex-col gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            await client.call("tasks.setDeps", { id: task.id, dependsOn: parseIds(text) });
            setEditing(false);
            onChanged();
          });
        }}
      >
        <Input className="h-7 w-36 font-mono text-xs md:text-xs" placeholder="T-1, T-2" value={text} onChange={(e) => setText(e.target.value)} aria-label={t("tasks.depsOf", { id: task.id })} />
        <div className="flex gap-1">
          <Button size="sm" variant="outline" type="submit" disabled={action.busy}>
            {t("tasks.saveDeps")}
          </Button>
          <Button size="sm" variant="ghost" type="button" onClick={() => (setEditing(false), setText(deps.join(", ")))}>
            {t("common.cancel")}
          </Button>
        </div>
        <ErrorNote error={action.error} />
      </form>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-1">
      {deps.length ? (
        deps.map((d) => {
          const open = (task.waitingOn ?? []).includes(d);
          return (
            <span key={d} title={t(open ? "tasks.depOpen" : "tasks.depDone", { id: d })}>
              <Badge tone={open ? "warn" : "ok"}>{d}</Badge>
            </span>
          );
        })
      ) : (
        <span className="text-muted-foreground">—</span>
      )}
      {allow(task.project, "manage") && task.status !== "done" ? (
        <Button size="sm" variant="ghost" className="h-6 px-1.5 text-xs" onClick={() => setEditing(true)}>
          {t("tasks.editDeps")}
        </Button>
      ) : null}
    </div>
  );
}

function CreateTask({
  defaultProject,
  projects,
  onCreated,
}: {
  defaultProject: string;
  projects: string[];
  onCreated: () => void;
}) {
  const { client } = useHive();
  const t = useT();
  const [id, setId] = useState("");
  // undefined: not typed yet, so it shows the scope's project (prefilled in a project scope).
  const [project, setProject] = useState<string>();
  const [title, setTitle] = useState("");
  const [deps, setDeps] = useState("");
  const action = useAction();
  const effectiveProject = project ?? defaultProject;
  return (
    <Card className="py-4">
      <CardContent className="flex flex-col gap-2 px-4">
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(async () => {
              await client.call("tasks.create", { id: id.trim(), project: effectiveProject.trim(), title: title.trim(), dependsOn: parseIds(deps) });
              setId("");
              setTitle("");
              setDeps("");
              onCreated();
            });
          }}
        >
          <Input className="w-28 font-mono text-xs md:text-xs" placeholder="T-001" value={id} onChange={(e) => setId(e.target.value)} aria-label={t("tasks.newId")} />
          <Input
            className="w-40 min-w-0 flex-1 font-mono text-xs sm:flex-none md:text-xs"
            placeholder={t("tasks.newProject")}
            list="hive-projects"
            value={effectiveProject}
            onChange={(e) => setProject(e.target.value)}
            aria-label={t("tasks.colProject")}
          />
          <datalist id="hive-projects">
            {projects.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
          <Input className="min-w-48 flex-1" placeholder={t("tasks.newTitle")} value={title} onChange={(e) => setTitle(e.target.value)} aria-label={t("tasks.colTitle")} />
          <Input
            className="w-40 font-mono text-xs md:text-xs"
            placeholder={t("tasks.newDeps")}
            value={deps}
            onChange={(e) => setDeps(e.target.value)}
            aria-label={t("tasks.colDeps")}
          />
          <Button variant="outline" type="submit" disabled={!id.trim() || !effectiveProject.trim() || !title.trim() || action.busy}>
            {t("tasks.create")}
          </Button>
        </form>
        <ErrorNote error={action.error} />
      </CardContent>
    </Card>
  );
}
