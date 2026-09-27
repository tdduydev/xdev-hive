import { useEffect, useMemo, useRef, useState } from "react";
import {
  AGENT_ROLES,
  TASK_STATUSES,
  type AgentProfileStatus,
  type AgentRole,
  type AgentRun,
  type RunStatus,
  type Task,
  type TaskStatus,
} from "@xdev-hive/core";
import { Badge, Empty, ErrorNote, PageHeader, STATUS_TONE } from "../components/ui.tsx";
import { formatTime, useAction, useHive, useProjects, useQuery } from "../hooks.ts";

const COLUMN_LABEL: Record<TaskStatus, string> = {
  todo: "Chưa làm",
  doing: "Đang làm",
  review: "Chờ review",
  done: "Xong",
  blocked: "Bị chặn",
};

export const RUN_LABEL: Record<RunStatus, string> = {
  queued: "Chờ",
  running: "Đang chạy",
  succeeded: "Xong",
  failed: "Lỗi",
  rate_limited: "Hết quota",
  cancelled: "Đã huỷ",
};

export const ROLE_LABEL: Record<AgentRole, string> = { plan: "Lập kế hoạch", implement: "Làm task", review: "Review" };

/** Re-renders every `ms` while `active`, for live run lists and logs. */
function usePulse(active: boolean, ms = 2000): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setN((x) => x + 1), ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return n;
}

function duration(run: AgentRun): string {
  if (!run.startedAt) return "";
  const end = run.finishedAt ? new Date(run.finishedAt) : new Date();
  const s = Math.max(0, Math.round((end.getTime() - new Date(run.startedAt).getTime()) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}`;
}

export function BoardPage() {
  const { client } = useHive();
  const desktop = client.desktop!;
  const projects = useProjects();
  const settings = useQuery(() => desktop.settings(), [desktop]);
  const localProjects = settings.data?.projects.map((p) => p.name) ?? [];
  const [project, setProject] = useState("");
  const current = project || localProjects[0] || projects[0] || "";

  const [tick, setTick] = useState(0);
  const runs = useQuery(() => desktop.runs({ project: current || undefined, limit: 60 }), [desktop, current, tick]);
  const active = (runs.data ?? []).some((r) => r.status === "queued" || r.status === "running");
  const pulse = usePulse(active);
  useEffect(() => setTick((t) => t + 1), [pulse]);

  const tasks = useQuery(
    () => (current ? client.call("tasks.list", { project: current }) : Promise.resolve([] as Task[])),
    [client, current, tick],
  );
  const profiles = useQuery(() => desktop.profiles(), [desktop, tick]);
  const [selected, setSelected] = useState<string | null>(null);

  const latestRun = useMemo(() => {
    const map = new Map<string, AgentRun>();
    for (const r of runs.data ?? []) if (!map.has(r.taskId)) map.set(r.taskId, r);
    return map;
  }, [runs.data]);

  const counts = {
    running: (runs.data ?? []).filter((r) => r.status === "running").length,
    queued: (runs.data ?? []).filter((r) => r.status === "queued").length,
  };
  const refresh = () => setTick((t) => t + 1);
  const isLocalProject = localProjects.includes(current);
  const gitlabReady = !!settings.data?.gitlab.url && !!settings.data?.gitlab.hasToken;

  return (
    <div className="page page-wide">
      <PageHeader
        title="Board"
        subtitle="Giao task cho agent. Mỗi task chạy trong worktree riêng (branch ai/<task>). Hết quota thì tự chuyển sang gói sub khác."
        actions={
          <div className="row gap-s">
            <Badge tone="info">{counts.running} đang chạy</Badge>
            <Badge tone="neutral">{counts.queued} chờ</Badge>
            <a className="btn btn-small" href="#/agents">
              Gói sub
            </a>
          </div>
        }
      />
      <div className="toolbar">
        <select className="input" value={current} onChange={(e) => setProject(e.target.value)} aria-label="Dự án">
          {[...new Set([...localProjects, ...projects])].map((p) => (
            <option key={p} value={p}>
              {p}
              {localProjects.includes(p) ? "" : " (chưa nối repo trên máy này)"}
            </option>
          ))}
        </select>
        <ProfileStrip profiles={profiles.data ?? []} />
      </div>
      {!current ? <Empty>Thêm dự án ở trang Dự án &amp; cài đặt trước.</Empty> : null}
      {current && !isLocalProject ? (
        <div className="note note-warn">Dự án này chưa có repo trên máy này nên không chạy agent được. Thêm repo ở trang Dự án &amp; cài đặt.</div>
      ) : null}
      <ErrorNote error={tasks.error ?? runs.error} />

      <div className="kanban">
        {TASK_STATUSES.map((status) => {
          const column = (tasks.data ?? []).filter((t) => t.status === status);
          return (
            <section key={status} className="kanban-col" aria-label={COLUMN_LABEL[status]}>
              <header className="kanban-head">
                <span>{COLUMN_LABEL[status]}</span>
                <span className="muted small">{column.length}</span>
              </header>
              {column.map((t) => (
                <TaskCard
                  key={t.id}
                  task={t}
                  run={latestRun.get(t.id) ?? null}
                  profiles={profiles.data ?? []}
                  canRun={isLocalProject}
                  onStarted={(r) => {
                    setSelected(r.id);
                    refresh();
                  }}
                  onOpenRun={setSelected}
                />
              ))}
            </section>
          );
        })}
      </div>

      <RunsPanel runs={runs.data ?? []} selected={selected} onSelect={setSelected} onChanged={refresh} gitlabReady={gitlabReady} />
    </div>
  );
}

function ProfileStrip({ profiles }: { profiles: AgentProfileStatus[] }) {
  if (!profiles.length) return null;
  return (
    <div className="row gap-s wrap profile-strip" aria-label="Trạng thái gói sub">
      {profiles.map((p) => {
        const resting = p.cooldownUntil !== null;
        const tone = !p.enabled ? "neutral" : resting ? "warn" : p.running ? "info" : "ok";
        const text = !p.enabled ? "tắt" : resting ? `nghỉ đến ${formatTime(p.cooldownUntil)}` : p.running ? `chạy ${p.running}/${p.maxConcurrent}` : "sẵn sàng";
        return (
          <span key={p.id} className="profile-chip" title={p.cooldownReason ?? p.label}>
            <span className={`dot dot-${tone}`} />
            <span className="mono small">{p.id}</span>
            <span className="muted small">{text}</span>
          </span>
        );
      })}
    </div>
  );
}

function TaskCard({
  task,
  run,
  profiles,
  canRun,
  onStarted,
  onOpenRun,
}: {
  task: Task;
  run: AgentRun | null;
  profiles: AgentProfileStatus[];
  canRun: boolean;
  onStarted: (run: AgentRun) => void;
  onOpenRun: (id: string) => void;
}) {
  const { client, me } = useHive();
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<AgentRole>(task.status === "review" ? "review" : "implement");
  const [profileId, setProfileId] = useState("");
  const [instructions, setInstructions] = useState("");
  const [reviewAfter, setReviewAfter] = useState(true);
  const action = useAction();
  const busy = run?.status === "queued" || run?.status === "running";
  const allowed = me.role !== "viewer" && canRun && task.status !== "done";

  return (
    <article className="task-card">
      <div className="row gap-s wrap">
        <span className="mono small nowrap">{task.id}</span>
        {run ? (
          <button className="linkish" onClick={() => onOpenRun(run.id)} title={run.error ?? ""}>
            <Badge tone={STATUS_TONE[run.status] ?? "neutral"}>
              {RUN_LABEL[run.status]}
              {run.profileId ? ` · ${run.profileId}` : ""}
            </Badge>
          </button>
        ) : null}
        {run ? <MrLink run={run} /> : null}
      </div>
      <div className="task-title">{task.title}</div>
      {task.owner ? <div className="muted small">Giữ bởi {task.owner}</div> : null}
      {allowed && !busy && !open ? (
        <button className="btn btn-small" onClick={() => setOpen(true)}>
          Chạy agent…
        </button>
      ) : null}
      {open ? (
        <form
          className="dispatch"
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(async () => {
              const started = await client.desktop!.startRun({
                project: task.project,
                taskId: task.id,
                role,
                profileId: profileId || null,
                instructions,
                reviewAfter: role !== "review" && reviewAfter,
              });
              setOpen(false);
              setInstructions("");
              onStarted(started);
            });
          }}
        >
          <label className="label" htmlFor={`role-${task.id}`}>
            Việc
          </label>
          <select id={`role-${task.id}`} className="input input-small" value={role} onChange={(e) => setRole(e.target.value as AgentRole)}>
            {AGENT_ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
          <label className="label" htmlFor={`profile-${task.id}`}>
            Gói sub
          </label>
          <select id={`profile-${task.id}`} className="input input-small" value={profileId} onChange={(e) => setProfileId(e.target.value)}>
            <option value="">Tự xoay vòng theo quota</option>
            {profiles
              .filter((p) => p.enabled && p.roles.includes(role))
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                  {p.cooldownUntil ? " (đang nghỉ)" : ""}
                </option>
              ))}
          </select>
          <textarea
            className="textarea textarea-small"
            placeholder="Chỉ dẫn thêm cho agent (tuỳ chọn)"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            aria-label="Chỉ dẫn thêm"
          />
          {role !== "review" ? (
            <label className="check small">
              <input type="checkbox" checked={reviewAfter} onChange={(e) => setReviewAfter(e.target.checked)} />
              Xong thì review chéo bằng vendor khác
            </label>
          ) : null}
          <div className="row gap-s">
            <button className="btn btn-small btn-primary" type="submit" disabled={action.busy}>
              Chạy
            </button>
            <button className="btn btn-small btn-ghost" type="button" onClick={() => setOpen(false)}>
              Thôi
            </button>
          </div>
          <ErrorNote error={action.error} />
        </form>
      ) : null}
    </article>
  );
}

function RunsPanel({
  runs,
  selected,
  onSelect,
  onChanged,
  gitlabReady,
}: {
  runs: AgentRun[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  onChanged: () => void;
  gitlabReady: boolean;
}) {
  const run = runs.find((r) => r.id === selected) ?? null;
  return (
    <section className="runs">
      <h2>Lượt chạy</h2>
      {runs.length === 0 ? <Empty>Chưa có lượt chạy nào.</Empty> : null}
      <div className="runs-split">
        {runs.length ? (
          <div className="table-wrap">
            <table className="table table-click">
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Task</th>
                  <th>Việc</th>
                  <th>Gói sub</th>
                  <th>Trạng thái</th>
                  <th>Thời gian</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} className={r.id === selected ? "selected" : ""} onClick={() => onSelect(r.id)}>
                    <td className="mono small">
                      {r.id}
                      {r.attempt > 1 ? <span className="muted"> · lần {r.attempt}</span> : null}
                    </td>
                    <td>
                      <div className="mono small">{r.taskId}</div>
                      <div className="small ellipsis runs-title">{r.taskTitle}</div>
                    </td>
                    <td className="small">{ROLE_LABEL[r.role]}</td>
                    <td className="mono small">{r.profileId ?? r.preferredProfile ?? "tự chọn"}</td>
                    <td>
                      <Badge tone={STATUS_TONE[r.status] ?? "neutral"}>{RUN_LABEL[r.status]}</Badge>
                      {r.error ? <div className="muted small runs-error">{r.error}</div> : null}
                    </td>
                    <td className="small muted">
                      {formatTime(r.createdAt)}
                      <div>{duration(r)}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {run ? <RunDetail key={run.id} run={run} onClose={() => onSelect(null)} onChanged={onChanged} gitlabReady={gitlabReady} /> : null}
      </div>
    </section>
  );
}

function MrLink({ run }: { run: AgentRun }) {
  if (!run.mrUrl) return null;
  return (
    <a className="mr-link" href={run.mrUrl} target="_blank" rel="noreferrer" title={run.mrNote ?? run.mrUrl}>
      <Badge tone={run.mrDraft ? "warn" : "accent"}>
        MR !{run.mrIid}
        {run.mrDraft ? " draft" : ""}
      </Badge>
    </a>
  );
}

function RunDetail({ run, onClose, onChanged, gitlabReady }: { run: AgentRun; onClose: () => void; onChanged: () => void; gitlabReady: boolean }) {
  const { client } = useHive();
  const desktop = client.desktop!;
  const live = run.status === "running" || run.status === "queued";
  const pulse = usePulse(live, 1500);
  const log = useQuery(() => desktop.runLog(run.id), [desktop, run.id, pulse, run.status]);
  const [diff, setDiff] = useState<string | null>(null);
  const action = useAction();
  const pre = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const el = pre.current;
    if (el && live) el.scrollTop = el.scrollHeight;
  }, [log.data, live]);

  return (
    <aside className="card run-detail" aria-label={`Run ${run.id}`}>
      <div className="row gap-s wrap">
        <b className="mono">{run.id}</b>
        <Badge tone={STATUS_TONE[run.status] ?? "neutral"}>{RUN_LABEL[run.status]}</Badge>
        <span className="muted small grow">
          {run.taskId} · {ROLE_LABEL[run.role]} · {run.profileId ?? "chờ chọn gói"} · lần {run.attempt}/{run.maxAttempts}
        </span>
        <button className="btn btn-small btn-ghost" onClick={onClose} aria-label="Đóng">
          ✕
        </button>
      </div>
      {run.branch ? (
        <div className="muted small mono">
          {run.branch} · {run.commits} commit{run.headSha ? ` · ${run.headSha}` : ""}
        </div>
      ) : null}
      {run.error ? <div className={`note ${run.status === "queued" ? "" : "note-warn"}`}>{run.error}</div> : null}
      {run.mrUrl || run.mrState ? (
        <div className="row gap-s wrap">
          <MrLink run={run} />
          {run.mrState ? <span className="muted small">MR {run.mrState}</span> : null}
          {run.mrNote ? <span className={`small ${run.mrState === "failed" ? "tone-danger" : "muted"}`}>{run.mrNote}</span> : null}
        </div>
      ) : null}
      <div className="row gap-s wrap">
        {live ? (
          <button
            className="btn btn-small btn-danger"
            disabled={action.busy}
            onClick={() => void action.run(async () => (await desktop.cancelRun(run.id), onChanged()))}
          >
            Huỷ
          </button>
        ) : null}
        {gitlabReady && run.status === "succeeded" && run.role !== "plan" && run.commits > 0 ? (
          <button
            className="btn btn-small"
            disabled={action.busy}
            onClick={() => void action.run(async () => (await desktop.createMergeRequest(run.id), onChanged()))}
          >
            {run.mrUrl ? "Cập nhật MR" : "Tạo MR"}
          </button>
        ) : null}
        {run.worktree ? (
          <>
            <button className="btn btn-small" onClick={() => void action.run(async () => setDiff(await desktop.runDiff(run.id)))}>
              Xem thay đổi
            </button>
            <button className="btn btn-small" onClick={() => void action.run(() => desktop.showInFolder(run.worktree!))}>
              Mở worktree
            </button>
            {!live ? (
              <button
                className="btn btn-small btn-ghost"
                onClick={() => {
                  if (window.confirm("Xoá worktree? Branch và commit vẫn giữ nguyên trong repo.")) {
                    void action.run(async () => (await desktop.removeWorktree(run.id), onChanged()));
                  }
                }}
              >
                Xoá worktree
              </button>
            ) : null}
          </>
        ) : null}
      </div>
      <ErrorNote error={action.error} />
      {diff !== null ? <pre className="log log-diff">{diff}</pre> : null}
      <pre className="log" ref={pre} aria-label="Log">
        {log.data || (live ? "Đang chờ output…" : "(không có log)")}
      </pre>
    </aside>
  );
}
