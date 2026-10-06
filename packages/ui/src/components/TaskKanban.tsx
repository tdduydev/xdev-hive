// The tasks of every project the reader sees as columns by status (roadmap 30a, asked 2/10): the Task page and the
// Web Admin. Like the desktop's Board, but for the hub's tasks: a card names its project, and a drag moves it only
// where the reader may work on that project.
import { useEffect, useMemo, useState, type DragEvent } from "react";
import { cn } from "cn";
import { type RunRequest, type Task, type TaskStatus } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { BoardColumns } from "#ui/components/BoardColumns.tsx";
import { ErrorNote, OwnerBadge } from "#ui/components/common.tsx";
import { errorMessage, useCan, useHive } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import { columnOf, ownerLabel, waitingLabels } from "#ui/lib/tasks.ts";
import { canCloseTask } from "#ui/lib/permission-controls.ts";
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
  const list = useMemo(() => tasks.map((task) => (moved[task.id] ? { ...task, status: moved[task.id]!, waitingOn: moved[task.id] === "todo" ? task.waitingOn : [] } : task)), [tasks, moved]);
  const key = (task: Task) => `${task.project}/${task.id}`;

  const move = (task: Task, status: TaskStatus) => {
    const from = task.status;
    if (from === status) return;
    if (status === "done" && !canCloseTask(me, task.project)) {
      setError(t("tasks.doneNeedsReview"));
      return;
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
      <div className="overflow-x-auto pb-1" aria-label={t("board.board")}>
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
                    draggable={allow(task.project, "taskWork")}
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
        "flex cursor-pointer flex-col gap-[7px] rounded-md border bg-surface px-2.5 py-[9px] outline-none hover:border-line-strong focus-visible:focus-ring",
        selected ? "border-line-selected" : "border-line-default",
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5 font-mono text-[11px]/none font-medium text-fg-muted">
        <span className="shrink-0">{task.id}</span>
        {showProject ? <OwnerBadge owner={task.project} className="ml-auto max-w-[60%] truncate" /> : null}
      </div>
      <span className="text-[13px]/[18px] font-medium text-pretty text-fg-strong [overflow-wrap:anywhere]">{task.title}</span>
      {task.note ? <span className="line-clamp-2 text-xs text-fg-secondary [overflow-wrap:anywhere]">{task.note}</span> : null}
      {deps.length || waiting || isNext || owner ? (
        <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11px]/none font-medium">
          {deps.length ? <span className="inline-flex h-[18px] items-center rounded-xs bg-danger-soft px-1.5 font-sans text-danger">{t("board.waitingOn", { tasks: deps.join(", ") })}</span> : null}
          {waiting ? <span className="inline-flex h-[18px] items-center rounded-xs bg-info-soft px-1.5 font-sans text-info">{t("tasks.waitingMachine", { machine: waiting.machine })}</span> : null}
          {isNext ? (
            <span title={t("board.nextTaskHint")} className="inline-flex h-[18px] items-center rounded-xs bg-info-soft px-1.5 font-sans text-info">
              {t("board.nextTask")}
            </span>
          ) : null}
          {owner ? <span className="ml-auto truncate text-fg-secondary">{owner}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
