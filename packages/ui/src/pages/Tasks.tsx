import { useState } from "react";
import { TASK_STATUSES, type Task, type TaskStatus } from "@xdev-hive/core";
import { Badge, Empty, ErrorNote, PageHeader, STATUS_TONE } from "../components/ui.tsx";
import { formatTime, useAction, useHive, useProjects, useQuery } from "../hooks.ts";

const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: "Chưa làm",
  doing: "Đang làm",
  review: "Chờ review",
  done: "Xong",
  blocked: "Bị chặn",
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
    <div className="page">
      <PageHeader
        title="Task"
        subtitle="Agent nhận task bằng task_claim (có hạn giữ), xong thì task_update sang Chờ review kèm ghi chú bàn giao."
      />
      <div className="toolbar">
        <select className="input" value={project} onChange={(e) => setProject(e.target.value)} aria-label="Dự án">
          <option value="">Tất cả dự án</option>
          {projects.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <select className="input" value={status} onChange={(e) => setStatus(e.target.value as TaskStatus | "")} aria-label="Trạng thái">
          <option value="">Mọi trạng thái</option>
          {TASK_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </div>
      {me.role === "admin" ? <CreateTask defaultProject={project} projects={projects} onCreated={list.reload} /> : null}
      <ErrorNote error={list.error} />
      {list.data?.length === 0 ? <Empty>Chưa có task.</Empty> : null}
      {list.data?.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Tiêu đề</th>
                <th>Dự án</th>
                <th>Trạng thái</th>
                <th>Người giữ</th>
                <th>Ghi chú bàn giao</th>
                <th>Cập nhật</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((t) => (
                <TaskRow key={t.id} task={t} onChanged={list.reload} />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

function TaskRow({ task: t, onChanged }: { task: Task; onChanged: () => void }) {
  const { client, me } = useHive();
  const action = useAction();
  return (
    <tr>
      <td className="mono">{t.id}</td>
      <td>
        {t.title}
        <ErrorNote error={action.error} />
      </td>
      <td className="mono small">{t.project}</td>
      <td>
        {me.role === "viewer" ? (
          <Badge tone={STATUS_TONE[t.status]}>{STATUS_LABEL[t.status]}</Badge>
        ) : (
          <select
            className={`input input-small tone-${STATUS_TONE[t.status]}`}
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
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        )}
      </td>
      <td className="small">
        {t.owner ?? <span className="muted">—</span>}
        {t.leaseUntil ? <div className="muted small">đến {formatTime(t.leaseUntil)}</div> : null}
      </td>
      <td className="small note-cell">{t.note ?? <span className="muted">—</span>}</td>
      <td className="small muted">{formatTime(t.updatedAt)}</td>
    </tr>
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
    <form
      className="card card-compact row gap-s wrap"
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
      <input className="input mono" style={{ width: 110 }} placeholder="T-001" value={id} onChange={(e) => setId(e.target.value)} aria-label="Mã task" />
      <input
        className="input mono"
        style={{ width: 160 }}
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
      <input className="input grow" placeholder="Tiêu đề task" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Tiêu đề" />
      <button className="btn" type="submit" disabled={!id.trim() || !effectiveProject.trim() || !title.trim() || action.busy}>
        Tạo task
      </button>
      <ErrorNote error={action.error} />
    </form>
  );
}
