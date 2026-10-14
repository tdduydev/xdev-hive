import type { Run, Task } from "@xdev-hive/contracts";
import { formatAgo, formatDuration, formatUsd } from "@/lib/format.ts";
import { isTerminal, RUN_STATE_LABEL, runStateTone, type Tone } from "@/lib/run-view.ts";

/** Nhóm lọc trên bảng việc, theo thiết kế Tasks.dc.html. */
export type BoardFilter = "all" | "running" | "plan" | "review" | "failed" | "done";

export const BOARD_FILTERS: readonly { key: BoardFilter; label: string }[] = [
  { key: "all", label: "Tất cả" },
  { key: "running", label: "Đang chạy" },
  { key: "plan", label: "Chờ duyệt kế hoạch" },
  { key: "review", label: "Chờ review và merge" },
  { key: "failed", label: "Lỗi" },
  { key: "done", label: "Xong" },
];

export const isBoardFilter = (v: unknown): v is BoardFilter => BOARD_FILTERS.some((f) => f.key === v);

export interface TaskBadge {
  label: string;
  tone: Tone;
  /** Nhóm lọc của việc; null là chỉ hiện ở "Tất cả" (chưa giao, đã huỷ). */
  group: Exclude<BoardFilter, "all"> | null;
}

/**
 * Trạng thái hiện trên bảng việc, ghép trạng thái task với run gần nhất: task `todo` có thể vừa có run lỗi (hub trả
 * task về todo khi run lỗi) hoặc chưa giao lần nào, hai trường hợp người xem cần phân biệt.
 */
export function taskBadge(task: Task, run: Run | null): TaskBadge {
  switch (task.status) {
    case "cancelled":
      return { label: "Đã huỷ", tone: "neutral", group: null };
    case "done":
      return { label: run?.prUrl ? "Đã merge" : "Xong", tone: "ok", group: "done" };
    case "review":
      return run?.state === "needs_review"
        ? { label: "Cần người xem", tone: "warn", group: "review" }
        : { label: "Chờ review PR", tone: "warn", group: "review" };
    case "queued":
    case "running":
      if (run && !isTerminal(run.state)) {
        return { label: RUN_STATE_LABEL[run.state], tone: runStateTone(run.state), group: "running" };
      }
      return task.status === "queued"
        ? { label: "Chờ máy", tone: "neutral", group: "running" }
        : { label: "Đang chạy", tone: "sel", group: "running" };
    case "awaiting_plan":
      // Nhóm riêng để người duyệt lọc ra việc đang đợi mình; màu "chờ" như mọi trạng thái đợi người.
      return { label: "Chờ duyệt kế hoạch", tone: "warn", group: "plan" };
    case "todo":
      if (!run) return { label: "Chưa giao", tone: "neutral", group: null };
      if (run.state === "failed" || run.state === "lost") return { label: "Lỗi", tone: "bad", group: "failed" };
      if (!isTerminal(run.state)) {
        return { label: RUN_STATE_LABEL[run.state], tone: runStateTone(run.state), group: "running" };
      }
      if (run.state === "no_changes") return { label: "Không có thay đổi", tone: "neutral", group: null };
      return { label: "Chưa giao", tone: "neutral", group: null };
  }
}

/** Run gần nhất nói gì về thời gian: đang chạy bao lâu, xong khi nào, xếp hàng bao lâu. */
export function runActivity(run: Run | null, now: number): string {
  if (!run) return "Chưa chạy";
  const tries = run.attempt > 1 ? ` · thử ${run.attempt}/${run.maxAttempts}` : "";
  if (run.finishedAt) return `xong ${formatAgo(run.finishedAt, now, "vi")}${tries}`;
  if (run.state === "queued") return `xếp hàng ${formatDuration(now - Date.parse(run.createdAt))}${tries}`;
  if (run.startedAt) return `chạy được ${formatDuration(now - Date.parse(run.startedAt))}${tries}`;
  return `${RUN_STATE_LABEL[run.state].toLowerCase()}${tries}`;
}

export interface BoardRow {
  task: Task;
  run: Run | null;
  badge: TaskBadge;
}

/** Ghép task với run code mới nhất của nó (runs.latest), việc mới tạo lên đầu. */
export function boardRows(tasks: Task[], runs: Run[]): BoardRow[] {
  const byTask = new Map(runs.map((r) => [r.taskId, r]));
  return tasks
    .map((task) => {
      const run = byTask.get(task.id) ?? null;
      return { task, run, badge: taskBadge(task, run) };
    })
    .sort((a, b) => b.task.createdAt.localeCompare(a.task.createdAt));
}

/** Lọc theo nhóm và ô tìm (mã hoặc tiêu đề, không phân biệt hoa thường và dấu). */
export function filterRows(rows: BoardRow[], filter: BoardFilter, query: string): BoardRow[] {
  const q = fold(query.trim());
  return rows.filter(
    (r) =>
      (filter === "all" || r.badge.group === filter) &&
      (!q || fold(r.task.key).includes(q) || fold(r.task.title).includes(q)),
  );
}

/** Số việc của từng nhóm lọc, cho con số cạnh nút lọc. */
export function filterCounts(rows: BoardRow[]): Record<BoardFilter, number> {
  const counts: Record<BoardFilter, number> = {
    all: rows.length,
    running: 0,
    plan: 0,
    review: 0,
    failed: 0,
    done: 0,
  };
  for (const r of rows) if (r.badge.group) counts[r.badge.group] += 1;
  return counts;
}

export interface BoardStat {
  label: string;
  value: string;
  hint: string;
}

const DAY_MS = 24 * 3600 * 1000;

/** Bốn ô số liệu đầu bảng việc, tính từ chính các dòng đang có (task và run gần nhất của nó). */
export function boardStats(rows: BoardRow[], now: number): BoardStat[] {
  const running = rows.filter((r) => r.badge.group === "running");
  const machines = new Set(running.flatMap((r) => (r.run?.machineId ? [r.run.machineId] : [])));
  const review = rows.filter((r) => r.badge.group === "review");
  const withPr = review.filter((r) => r.run?.prUrl).length;
  const failed = rows.filter(
    (r) => r.badge.group === "failed" && r.run?.finishedAt && now - Date.parse(r.run.finishedAt) < DAY_MS,
  );
  const runs = rows.flatMap((r) => (r.run ? [r.run] : []));
  const total = runs.reduce((sum, r) => sum + (r.cost.costUsd ?? 0), 0);
  const unpriced = runs.filter((r) => r.cost.costUsd === null).length;

  return [
    {
      label: "Đang chạy",
      value: String(running.length),
      hint:
        machines.size > 0 ? `trên ${machines.size} máy` : running.length > 0 ? "chưa có máy nhận" : "không có việc nào",
    },
    {
      label: "Chờ review và merge",
      value: String(review.length),
      hint: withPr > 0 ? `${withPr} việc đã có PR` : "chưa có PR nào",
    },
    {
      label: "Lỗi trong 24 giờ",
      value: String(failed.length),
      hint: failed.length > 0 ? failed.map((r) => r.task.key).join(", ") : "không có run lỗi",
    },
    {
      label: "Chi phí run gần nhất",
      value: formatUsd(total),
      hint: unpriced > 0 ? `${unpriced} run không báo USD` : `tổng của ${runs.length} run`,
    },
  ];
}

/** Chữ thường, bỏ dấu tiếng Việt, để tìm "hoa don" ra "Hoá đơn". */
function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "d")
    .toLowerCase();
}
