import { QueryClientProvider, useMutation, useQuery } from "@tanstack/react-query";
import {
  LogBuffer,
  mergeEvents,
  type Run,
  type RunEventView,
  type TaskStatus,
  TERMINAL_RUN_STATES,
  waitingReason,
} from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Pill } from "@xdev-hive/ui/pill";
import { Table, TableBody, TableHeader, TableRow, Td, Th } from "@xdev-hive/ui/table";
import { ArrowLeftIcon, ExternalLinkIcon, PlayIcon } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { api, queryClient } from "@/lib/hub-query.tsx";
import { hub } from "@/lib/hub-rpc.ts";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import { screenParam } from "@/lib/nav.ts";
import { ACTIVE, RUN_STATE_TEXT, stateTone } from "@/lib/run-state.ts";
import { errorText, invoke } from "@/lib/tauri.ts";

const text: Dict<{
  lead: string;
  tasks: string;
  runs: string;
  loading: string;
  noTasks: string;
  noRuns: string;
  colTask: string;
  colState: string;
  colMachine: string;
  colWhen: string;
  start: string;
  starting: string;
  startLabel: (key: string) => string;
  openRun: (key: string) => string;
  back: string;
  onWeb: string;
  waiting: string;
  noLog: string;
  log: string;
  feedError: string;
  taskStates: Record<TaskStatus, string>;
}> = {
  vi: {
    lead: "Task bạn tạo hoặc đã giao cho agent, và các lượt chạy bạn giao. Run của bạn chỉ chạy trên máy của bạn hoặc máy dùng chung của đội.",
    tasks: "Task của tôi",
    runs: "Lượt chạy của tôi",
    loading: "Đang tải…",
    noTasks: "Chưa có task nào của bạn. Tạo task ở bảng việc trên web của hub.",
    noRuns: "Bạn chưa giao run nào.",
    colTask: "Task",
    colState: "Trạng thái",
    colMachine: "Máy",
    colWhen: "Lúc giao",
    start: "Giao cho agent",
    starting: "Đang giao…",
    startLabel: (key) => `Giao ${key} cho agent`,
    openRun: (key) => `Xem lượt chạy ${key}`,
    back: "Việc của tôi",
    onWeb: "Mở trên web",
    waiting: "Đang chờ máy",
    noLog: "Chưa có log.",
    log: "Log",
    feedError: "Không đọc được log mới, sẽ thử lại.",
    taskStates: {
      todo: "Cần làm",
      queued: "Chờ máy",
      running: "Đang chạy",
      awaiting_plan: "Chờ duyệt kế hoạch",
      review: "Cần xem",
      done: "Xong",
      cancelled: "Đã huỷ",
    },
  },
  en: {
    lead: "Tasks you created or handed to an agent, and the runs you started. Your runs only run on your machine or a team shared machine.",
    tasks: "My tasks",
    runs: "My runs",
    loading: "Loading…",
    noTasks: "No tasks of yours yet. Create one on the hub web task board.",
    noRuns: "You have not started any runs.",
    colTask: "Task",
    colState: "State",
    colMachine: "Machine",
    colWhen: "Started",
    start: "Hand to agent",
    starting: "Starting…",
    startLabel: (key) => `Hand ${key} to an agent`,
    openRun: (key) => `Open run ${key}`,
    back: "My work",
    onWeb: "Open on the web",
    waiting: "Waiting for a machine",
    noLog: "No log yet.",
    log: "Log",
    feedError: "Could not read new log lines, retrying.",
    taskStates: {
      todo: "To do",
      queued: "Queued",
      running: "Running",
      awaiting_plan: "Plan awaiting approval",
      review: "Needs review",
      done: "Done",
      cancelled: "Cancelled",
    },
  },
};

// Task đang có run chưa xong thì không giao thêm; task đã huỷ thì thôi. Hub vẫn kiểm lại khi giao.
const STARTABLE: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["todo", "review", "done"]);
const TASK_TONE: Record<TaskStatus, "neutral" | "ok" | "warn" | "sel"> = {
  todo: "neutral",
  queued: "sel",
  running: "sel",
  awaiting_plan: "warn",
  review: "warn",
  done: "ok",
  cancelled: "neutral",
};

/** Hỏi lại hub chừng này một lần khi run chưa xong; app không mở được SSE của hub vì token nằm ở Rust. */
export const POLL_MS = 2000;

const go = (runId?: string) => {
  location.hash = runId ? `#/work/${encodeURIComponent(runId)}` : "#/work";
};

function subscribe(listener: () => void) {
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
}

const when = (iso: string, lang: "vi" | "en") =>
  new Date(iso).toLocaleString(lang === "vi" ? "vi-VN" : "en-GB", { dateStyle: "short", timeStyle: "short" });

const openOnWeb = (runId: string) => invoke("open_hub_page", { path: `/runs/${runId}` });

/**
 * Màn Việc của tôi (spec 008 US10, FR-023): task của tôi (`tasks.list` với `mine`), giao task cho agent
 * (`runs.start`, chủ run là mình nên chỉ máy mình hoặc máy dùng chung nhận, ADR 0017) và run của tôi (`runs.search`
 * với `mine`). `#/work/<run>` theo dõi một run: trạng thái, lý do đang chờ máy, log trực tiếp.
 */
export function WorkScreen() {
  const runId = useSyncExternalStore(subscribe, () => screenParam(location.hash));
  return (
    <QueryClientProvider client={queryClient}>
      {runId ? <RunView key={runId} runId={runId} /> : <WorkLists />}
    </QueryClientProvider>
  );
}

function WorkLists() {
  const t = useT(text);
  const lang = useLang();
  const tasks = useQuery({ ...api.tasks.list.queryOptions({ input: { mine: true } }), refetchInterval: 15_000 });
  const runs = useQuery({
    ...api.runs.search.queryOptions({ input: { mine: true, limit: 50 } }),
    refetchInterval: 15_000,
  });
  const start = useMutation({
    mutationFn: (taskId: string) => hub.runs.start({ taskId }),
    onSuccess: (run) => {
      void queryClient.invalidateQueries();
      go(run.id);
    },
  });
  const error = tasks.error ?? runs.error ?? start.error;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-5">
      <p className="text-[13px] text-muted-foreground">{t.lead}</p>
      {error && <Alert variant="destructive">{errorText(error)}</Alert>}

      <section aria-labelledby="work-tasks" className="flex flex-col gap-2">
        <h2 id="work-tasks" className="text-sm font-semibold">
          {t.tasks}
        </h2>
        <div className="overflow-hidden rounded-xl border bg-card text-card-foreground">
          {!tasks.data ? (
            <p className="px-4 py-3 text-[13px] text-muted-foreground">{t.loading}</p>
          ) : tasks.data.length === 0 ? (
            <p className="px-4 py-3 text-[13px] text-muted-foreground">{t.noTasks}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <Th>{t.colTask}</Th>
                  <Th>{t.colState}</Th>
                  <Th className="text-right" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {tasks.data.map((task) => (
                  <TableRow key={task.id}>
                    <Td className="max-w-96">
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate font-mono text-[13px] font-medium">{task.key}</span>
                        <span className="truncate text-xs text-muted-foreground">{task.title}</span>
                      </span>
                    </Td>
                    <Td>
                      <Pill tone={TASK_TONE[task.status]}>{t.taskStates[task.status]}</Pill>
                    </Td>
                    <Td className="text-right">
                      {STARTABLE.has(task.status) && (
                        <Button
                          size="sm"
                          variant="outline"
                          aria-label={t.startLabel(task.key)}
                          disabled={start.isPending}
                          onClick={() => start.mutate(task.id)}
                        >
                          <PlayIcon aria-hidden="true" />
                          {start.isPending && start.variables === task.id ? t.starting : t.start}
                        </Button>
                      )}
                    </Td>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </section>

      <section aria-labelledby="work-runs" className="flex flex-col gap-2">
        <h2 id="work-runs" className="text-sm font-semibold">
          {t.runs}
        </h2>
        <div className="overflow-hidden rounded-xl border bg-card text-card-foreground">
          {!runs.data ? (
            <p className="px-4 py-3 text-[13px] text-muted-foreground">{t.loading}</p>
          ) : runs.data.items.length === 0 ? (
            <p className="px-4 py-3 text-[13px] text-muted-foreground">{t.noRuns}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <Th>{t.colTask}</Th>
                  <Th>{t.colState}</Th>
                  <Th>{t.colMachine}</Th>
                  <Th>{t.colWhen}</Th>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.data.items.map((run) => (
                  <TableRow key={run.id}>
                    <Td className="max-w-96">
                      <button
                        type="button"
                        aria-label={t.openRun(run.taskKey)}
                        className="flex w-full min-w-0 cursor-pointer flex-col text-left"
                        onClick={() => go(run.id)}
                      >
                        <span className="truncate font-mono text-[13px] font-medium">{run.taskKey}</span>
                        <span className="truncate text-xs text-muted-foreground">{run.taskTitle}</span>
                      </button>
                    </Td>
                    <Td>
                      <Pill tone={stateTone(run.state)} dot={ACTIVE.has(run.state)}>
                        {RUN_STATE_TEXT[lang][run.state]}
                      </Pill>
                    </Td>
                    <Td className="font-mono text-xs whitespace-nowrap">{run.machineName ?? "—"}</Td>
                    <Td className="text-xs whitespace-nowrap text-muted-foreground">{when(run.createdAt, lang)}</Td>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </section>
    </div>
  );
}

interface Feed {
  run: Run | null;
  events: RunEventView[];
  log: string;
  error: unknown;
}

/**
 * Run, sự kiện và log của một run, hỏi lại hub theo con trỏ `after` cho tới khi run xong (rồi hỏi thêm một lần để lấy
 * phần log cuối). Lỗi mạng giữa chừng không dừng việc hỏi lại.
 */
export function useRunFeed(runId: string): Feed {
  const [feed, setFeed] = useState<Feed>({ run: null, events: [], log: "", error: null });
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const buffer = new LogBuffer();
    let events: RunEventView[] = [];
    let afterEvent = 0;
    let afterLog = 0;
    const tick = async () => {
      let done = false;
      try {
        const run = await hub.runs.get({ id: runId });
        done = TERMINAL_RUN_STATES.includes(run.state);
        const [newEvents, chunks] = await Promise.all([
          hub.runs.events({ id: runId, after: afterEvent, limit: 500 }),
          hub.runs.logs({ id: runId, after: afterLog, limit: 500 }),
        ]);
        events = mergeEvents(events, newEvents);
        afterEvent = events.at(-1)?.id ?? afterEvent;
        buffer.append(chunks);
        afterLog = chunks.at(-1)?.id ?? afterLog;
        // Trang log đầy thì còn nữa: hỏi tiếp ngay thay vì chờ, kể cả khi run đã xong.
        if (newEvents.length === 500 || chunks.length === 500) done = false;
        if (!stopped) setFeed({ run, events, log: buffer.toString(), error: null });
      } catch (error) {
        if (!stopped) setFeed((f) => ({ ...f, error }));
      }
      if (!stopped && !done) timer = setTimeout(() => void tick(), POLL_MS);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [runId]);
  return feed;
}

function RunView({ runId }: { runId: string }) {
  const t = useT(text);
  const lang = useLang();
  const { run, events, log, error } = useRunFeed(runId);
  const [openError, setOpenError] = useState<string | null>(null);
  const reason = run ? waitingReason(run.state, events) : null;
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={() => go()}>
          <ArrowLeftIcon aria-hidden="true" />
          {t.back}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void openOnWeb(runId).catch((e) => setOpenError(errorText(e)))}
        >
          <ExternalLinkIcon aria-hidden="true" />
          {t.onWeb}
        </Button>
      </div>
      {openError && <Alert variant="destructive">{openError}</Alert>}
      {!run ? (
        error ? (
          <Alert variant="destructive">{errorText(error)}</Alert>
        ) : (
          <p className="text-[13px] text-muted-foreground">{t.loading}</p>
        )
      ) : (
        <>
          <header className="flex flex-wrap items-center gap-3">
            <h2 className="font-mono text-base font-semibold">{run.branch}</h2>
            <Pill tone={stateTone(run.state)} dot={ACTIVE.has(run.state)}>
              {RUN_STATE_TEXT[lang][run.state]}
            </Pill>
            <span className="font-mono text-xs text-muted-foreground">{run.machineName ?? "—"}</span>
            <span className="text-xs text-muted-foreground">{when(run.createdAt, lang)}</span>
          </header>
          {reason && (
            <Alert>
              <p>
                <strong className="font-semibold">{t.waiting}.</strong> {reason}
              </p>
            </Alert>
          )}
          {error ? <p className="text-xs text-muted-foreground">{t.feedError}</p> : null}
          <section aria-label={t.log} className="rounded-xl border bg-card">
            <pre className="max-h-[60svh] overflow-auto p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
              {log || t.noLog}
            </pre>
          </section>
        </>
      )}
    </div>
  );
}
