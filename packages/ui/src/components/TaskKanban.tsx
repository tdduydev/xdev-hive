// The tasks of every project the reader sees as columns by status (roadmap 30a, asked 2/10): the Task page and the
// Web Admin. Like the desktop's Board, but for the hub's tasks: a card names its project, and a drag moves it only
// where the reader may work on that project.
import { useEffect, useMemo, useState, type DragEvent } from "react";
import { cn } from "cn";
import { type RunRequest, type Task, type TaskStatus } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { BoardColumns } from "#ui/components/BoardColumns.tsx";
import { ErrorNote } from "#ui/components/common.tsx";
import { errorMessage, useCan, useHive } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import { columnOf, ownerLabel, waitingLabels } from "#ui/lib/tasks.ts";
import { canCloseTask } from "#ui/lib/permission-controls.ts";
import { confirmTaskClose } from "#ui/lib/task-close.ts";
import { agentLabel } from "#ui/lib/assignment.ts";
import { cosmicAssets } from "#ui/assets/cosmic.ts";
import { useToast } from "#ui/shell/toast.tsx";

/** Done piles up: the newest this many, the rest one click away. */
const DONE_SHOWN = 30;

export function TaskKanban({
  tasks,
  showProject,
  requests,
  nextIds,
  selectedId,
  onOpen,
  onChanged,
}: {
  tasks: Task[];
  showProject: boolean;
  /** Runs queued from the web that no machine took yet: the card says which machine it waits for. */
  requests: RunRequest[];
  /** What tasks.next suggests. */
  nextIds: string[];
  selectedId: string | null;
  onOpen: (id: string) => void;
  onChanged: () => void;
}) {
  const { client, me } = useHive();
  const t = useT();
  const allow = useCan();
  const toast = useToast();
  // Moves made here, shown before the list reloads.
  const [moved, setMoved] = useState<Record<string, TaskStatus>>({});
  useEffect(() => setMoved({}), [tasks]);
  const [drag, setDrag] = useState<Task | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [allDone, setAllDone] = useState(false);
  const [mobile, setMobile] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const update = () => setMobile(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const list = useMemo(() => tasks.map((task) => (moved[task.id] ? { ...task, status: moved[task.id]!, waitingOn: moved[task.id] === "todo" ? task.waitingOn : [] } : task)), [tasks, moved]);
  const key = (task: Task) => `${task.project}/${task.id}`;

  const move = async (task: Task, status: TaskStatus) => {
    const from = task.status;
    if (from === status) return;
    if (status === "done" && !canCloseTask(me, task.project)) {
      setError(t("tasks.doneNeedsReview"));
      return;
    }
    if (status === "done") {
      try {
        if (!await confirmTaskClose(client, task, t)) return;
      } catch (err) {
        setError(errorMessage(err));
        return;
      }
    }
    setMoved((m) => ({ ...m, [task.id]: status }));
    setError(null);
    client.call("tasks.update", { id: task.id, status }).then(
      () => {
        onChanged();
        toast(t("board.moved", { id: task.id, status: t(`taskStatus.${status}`) }), {
          undo: () => void client.call("tasks.update", { id: task.id, status: from }).then(onChanged, (err: unknown) => setError(errorMessage(err))),
        });
      },
      (err: unknown) => {
        setMoved((m) => {
          const rest = { ...m };
          delete rest[task.id];
          return rest;
        });
        setError(errorMessage(err));
      },
    );
  };
  const of = (status: TaskStatus) => list.filter((task) => columnOf(task) === status);

  return (
    <div className="flex flex-col gap-2">
      <ErrorNote error={error} />
      <div className="min-w-0 pb-1" aria-label={t("board.board")}>
        <BoardColumns
          count={(status) => of(status).length}
          dragging={drag !== null}
          onDropTask={(status) => {
            const task = drag;
            setDrag(null);
            if (task && columnOf(task) !== status) move(task, status);
          }}
        >
          {(status) => {
            const all = of(status);
            const column = status === "done" && !allDone ? all.slice(0, DONE_SHOWN) : all;
            return (
              <>
                {column.map((task) => (
                  <KanbanCard
                    key={key(task)}
                    task={task}
                    showProject={showProject}
                    waiting={requests.find((r) => r.taskId === task.id && r.project === task.project && r.status === "pending") ?? null}
                    isNext={nextIds.includes(task.id)}
                    selected={task.id === selectedId}
                    draggable={!mobile && allow(task.project, "taskWork")}
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/plain", task.id);
                      e.dataTransfer.effectAllowed = "move";
                      setDrag(task);
                    }}
                    onDragEnd={() => setDrag(null)}
                    onOpen={() => onOpen(task.id)}
                  />
                ))}
                {all.length > column.length ? (
                  <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setAllDone(true)}>
                    {t("tasks.showOlderDone", { count: all.length - column.length })}
                  </Button>
                ) : null}
              </>
            );
          }}
        </BoardColumns>
      </div>
    </div>
  );
}

/** The planet is the agent kind's avatar (claude violet, codex green, gemini blue); a profile named otherwise has none. */
function planetOf(profileId: string | null | undefined): string | null {
  const id = (profileId ?? "").toLowerCase();
  return id.includes("claude") ? cosmicAssets.planetViolet : id.includes("codex") ? cosmicAssets.planetGreen : id.includes("gemini") ? cosmicAssets.planetBlue : null;
}

function KanbanCard({
  task,
  showProject,
  waiting,
  isNext,
  selected,
  draggable,
  onDragStart,
  onDragEnd,
  onOpen,
}: {
  task: Task;
  showProject: boolean;
  waiting: RunRequest | null;
  isNext: boolean;
  selected: boolean;
  draggable: boolean;
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
  onOpen: () => void;
}) {
  const t = useT();
  const deps = waitingLabels(task);
  const owner = task.owner ? ownerLabel(task.owner).who : null;
  const planet = planetOf(task.agent?.profileId);
  return (
    <div
      role="button"
      tabIndex={0}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      data-task={task.id}
      className={cn(
        "flex cursor-pointer flex-col gap-2.5 rounded-2xl bg-surface-2 p-3.5 outline-none hover:bg-[var(--surface-3)] hover:shadow-[var(--ring-glass-strong)] focus-visible:focus-ring",
        selected ? "shadow-[inset_0_0_0_1px_var(--border-selected)]" : "shadow-[var(--ring-glass)]",
        task.status === "done" && "opacity-60",
      )}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="shrink-0 font-mono text-[11.5px]/none font-semibold text-fg-muted">{task.id}</span>
        <span className="flex-1" />
        {deps.length ? <span className="inline-flex h-5 items-center whitespace-nowrap rounded-full bg-[var(--pill-danger-bg)] px-2 text-[11px]/4 font-semibold text-[var(--pill-danger-fg)]">{t("board.waitingOn", { tasks: deps.join(", ") })}</span> : null}
        {waiting ? <span className="inline-flex h-5 items-center whitespace-nowrap rounded-full bg-info-soft px-2 text-[11px]/4 font-semibold text-info">{t("tasks.waitingMachine", { machine: waiting.machine })}</span> : null}
        {isNext ? (
          <span title={t("board.nextTaskHint")} className="inline-flex h-5 items-center whitespace-nowrap rounded-full bg-[var(--pill-violet-bg)] px-2 text-[11px]/4 font-semibold text-[var(--pill-violet-fg)]">
            {t("board.nextTask")}
          </span>
        ) : null}
      </div>
      <span className="text-[13.5px]/[19px] font-semibold text-pretty text-fg-strong [overflow-wrap:anywhere]">{task.title}</span>
      {task.platforms.length ? <div className="flex flex-wrap gap-1">{task.platforms.map((p) => <span key={p} className="rounded-chip bg-[var(--chip-bg)] px-2 py-0.5 text-[11px]/4 font-medium text-fg-secondary">{t(`tasks.platform.${p}`)}</span>)}</div> : null}
      {task.note ? <span className="line-clamp-2 text-xs text-fg-secondary [overflow-wrap:anywhere]">{task.note}</span> : null}
      <div className="flex min-w-0 items-center gap-2 text-xs/[18px] font-medium text-fg-muted">
        {showProject ? <span className="max-w-[60%] truncate rounded-chip bg-[var(--chip-bg)] px-2 py-0.5">{task.project}</span> : null}
        <span className="flex-1" />
        {task.agent ? (
          <span data-task-agent title={agentLabel(task.agent, t("assignment.any"))} className="inline-flex min-w-0 items-center gap-1.5">
            {planet ? <span aria-hidden="true" className="inline-block size-4 shrink-0 rounded-full bg-contain bg-center bg-no-repeat" style={{ backgroundImage: `url('${planet}')` }} /> : null}
            <span className="truncate">{task.agent.profileId ?? t("assignment.any")}</span>
          </span>
        ) : owner ? <span className="truncate">{owner}</span> : null}
      </div>
      {/* Hive keeps no progress figure for a task, so this bar only says "being worked on": a lit segment sliding on the track, still under reduced motion. */}
      {task.status === "doing" ? (
        <span data-task-activity aria-hidden="true" className="relative h-1 overflow-hidden rounded-full bg-[var(--chip-bg)]">
          <span className="cosmic-activity absolute inset-y-0 w-2/5 rounded-full bg-[var(--accent-blue)] shadow-[0_0_8px_var(--accent-blue)]" />
        </span>
      ) : null}
    </div>
  );
}
