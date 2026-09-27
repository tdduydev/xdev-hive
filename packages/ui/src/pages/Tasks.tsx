import { useState } from "react";
import { TASK_STATUSES, type Task, type TaskStatus } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Card, CardContent } from "@xdev-hive/ui/components/ui/card";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@xdev-hive/ui/components/ui/table";
import { Badge, Empty, ErrorNote, Page, PageHeader, STATUS_TONE } from "../components/common.tsx";
import { formatTime, useAction, useHive, useProjects, useQuery } from "../hooks.ts";

const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: "Chưa làm",
  doing: "Đang làm",
  review: "Chờ review",
  done: "Xong",
  blocked: "Bị chặn",
};

/** Text colour of the status select, keyed by STATUS_TONE. */
const TONE_TEXT: Record<string, string> = {
  ok: "text-success",
  info: "text-info",
  warn: "text-warning",
  danger: "text-destructive",
};

export function TasksPage() {
  const { client, me } = useHive();
  const projects = useProjects();
  const [project, setProject] = useState("");
  const [status, setStatus] = useState<TaskStatus | "">("");
  const list = useQuery(
    () => client.call("tasks.list", { project: project || undefined, status: status || undefined }),
    [client, project, status],
  );

  return (
    <Page>
      <PageHeader
        title="Task"
        subtitle="Agent nhận task bằng task_claim (có hạn giữ), xong thì task_update sang Chờ review kèm ghi chú bàn giao."
      />
      <div className="flex flex-wrap items-center gap-2">
        <NativeSelect value={project} onChange={(e) => setProject(e.target.value)} aria-label="Dự án">
          <NativeSelectOption value="">Tất cả dự án</NativeSelectOption>
          {projects.map((p) => (
            <NativeSelectOption key={p} value={p}>
              {p}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <NativeSelect value={status} onChange={(e) => setStatus(e.target.value as TaskStatus | "")} aria-label="Trạng thái">
          <NativeSelectOption value="">Mọi trạng thái</NativeSelectOption>
          {TASK_STATUSES.map((s) => (
            <NativeSelectOption key={s} value={s}>
              {STATUS_LABEL[s]}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      {me.role === "admin" ? <CreateTask defaultProject={project} projects={projects} onCreated={list.reload} /> : null}
      <ErrorNote error={list.error} />
      {list.data?.length === 0 ? <Empty>Chưa có task.</Empty> : null}
      {list.data?.length ? (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>ID</TableHead>
                <TableHead>Tiêu đề</TableHead>
                <TableHead>Dự án</TableHead>
                <TableHead>Trạng thái</TableHead>
                <TableHead>Người giữ</TableHead>
                <TableHead>Ghi chú bàn giao</TableHead>
                <TableHead>Cập nhật</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data.map((t) => (
                <TaskRow key={t.id} task={t} onChanged={list.reload} />
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}
    </Page>
  );
}

function TaskRow({ task: t, onChanged }: { task: Task; onChanged: () => void }) {
  const { client, me } = useHive();
  const action = useAction();
  return (
    <TableRow>
      <TableCell className="font-mono text-xs">{t.id}</TableCell>
      <TableCell className="min-w-48 font-medium break-words whitespace-normal">
        {t.title}
        <ErrorNote error={action.error} />
      </TableCell>
      <TableCell className="font-mono text-xs">{t.project}</TableCell>
      <TableCell>
        {me.role === "viewer" ? (
          <Badge tone={STATUS_TONE[t.status]}>{STATUS_LABEL[t.status]}</Badge>
        ) : (
          <NativeSelect
            size="sm"
            className={TONE_TEXT[STATUS_TONE[t.status] ?? ""]}
            value={t.status}
            disabled={action.busy}
            aria-label={`Trạng thái ${t.id}`}
            onChange={(e) =>
              void action.run(async () => {
                await client.call("tasks.update", { id: t.id, status: e.target.value as TaskStatus });
                onChanged();
              })
            }
          >
            {TASK_STATUSES.map((s) => (
              <NativeSelectOption key={s} value={s}>
                {STATUS_LABEL[s]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        )}
      </TableCell>
      <TableCell className="text-xs">
        {t.owner ?? <span className="text-muted-foreground">—</span>}
        {t.leaseUntil ? <div className="text-xs text-muted-foreground">đến {formatTime(t.leaseUntil)}</div> : null}
      </TableCell>
      <TableCell className="max-w-80 min-w-48 text-xs break-words whitespace-pre-wrap">{t.note ?? <span className="text-muted-foreground">—</span>}</TableCell>
      <TableCell className="text-xs text-muted-foreground">{formatTime(t.updatedAt)}</TableCell>
    </TableRow>
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
  const [id, setId] = useState("");
  const [project, setProject] = useState(defaultProject);
  const [title, setTitle] = useState("");
  const action = useAction();
  const effectiveProject = project || defaultProject;
  return (
    <Card className="py-4">
      <CardContent className="flex flex-col gap-2 px-4">
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(async () => {
              await client.call("tasks.create", { id: id.trim(), project: effectiveProject.trim(), title: title.trim() });
              setId("");
              setTitle("");
              onCreated();
            });
          }}
        >
          <Input className="w-28 font-mono text-xs md:text-xs" placeholder="T-001" value={id} onChange={(e) => setId(e.target.value)} aria-label="Mã task" />
          <Input
            className="w-40 min-w-0 flex-1 font-mono text-xs sm:flex-none md:text-xs"
            placeholder="dự án"
            list="hive-projects"
            value={effectiveProject}
            onChange={(e) => setProject(e.target.value)}
            aria-label="Dự án"
          />
          <datalist id="hive-projects">
            {projects.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
          <Input className="min-w-48 flex-1" placeholder="Tiêu đề task" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Tiêu đề" />
          <Button variant="outline" type="submit" disabled={!id.trim() || !effectiveProject.trim() || !title.trim() || action.busy}>
            Tạo task
          </Button>
        </form>
        <ErrorNote error={action.error} />
      </CardContent>
    </Card>
  );
}
