import { CommonBadge, STATUS_TONE } from "@xdev-hive/ui";

export function Tones() {
  return (
    <div className="flex flex-wrap items-center gap-2 p-4">
      <CommonBadge tone="ok">Xong</CommonBadge>
      <CommonBadge tone="running">Đang chạy</CommonBadge>
      <CommonBadge tone="warn">Chờ review</CommonBadge>
      <CommonBadge tone="danger">Lỗi</CommonBadge>
      <CommonBadge tone="info">Agent</CommonBadge>
      <CommonBadge tone="accent">Admin</CommonBadge>
      <CommonBadge tone="neutral">Đã huỷ</CommonBadge>
    </div>
  );
}

// Labels from i18n runStatus; tones from STATUS_TONE, the same mapping the Runs page uses.
const RUN_STATUS: Array<[string, string]> = [
  ["queued", "Chờ"],
  ["running", "Đang chạy"],
  ["succeeded", "Xong"],
  ["failed", "Lỗi"],
  ["rate_limited", "Hết quota"],
  ["cancelled", "Đã huỷ"],
];

export function RunStatuses() {
  return (
    <div className="flex flex-wrap items-center gap-2 p-4">
      {RUN_STATUS.map(([status, label]) => (
        <CommonBadge key={status} tone={STATUS_TONE[status]}>{label}</CommonBadge>
      ))}
    </div>
  );
}

const TASK_STATUS: Array<[string, string]> = [
  ["todo", "Chưa làm"],
  ["doing", "Đang làm"],
  ["review", "Chờ review"],
  ["done", "Xong"],
  ["blocked", "Bị chặn"],
];

export function TaskStatuses() {
  return (
    <div className="flex flex-wrap items-center gap-2 p-4">
      {TASK_STATUS.map(([status, label]) => (
        <CommonBadge key={status} tone={STATUS_TONE[status]}>{label}</CommonBadge>
      ))}
    </div>
  );
}

const RUNS = [
  { id: 1498, task: "R-73a", profile: "codex-2", status: "running", label: "Đang chạy", time: "12 phút" },
  { id: 1497, task: "R-72n", profile: "claude-1", status: "succeeded", label: "Xong", time: "39 phút" },
  { id: 1496, task: "BUG-windows-cli", profile: "claude-2", status: "failed", label: "Lỗi", time: "4 phút" },
];

export function InRunList() {
  return (
    <div className="flex max-w-xl flex-col gap-2 p-4">
      {RUNS.map((r) => (
        <div key={r.id} className="flex items-center gap-3 rounded-md border border-line-subtle bg-surface px-3 py-2 type-body-sm">
          <span className="font-mono text-xs text-fg-muted">#{r.id}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-fg-strong">{r.task}</span>
          <span className="w-20 font-mono text-xs text-fg-secondary">{r.profile}</span>
          <span className="w-24"><CommonBadge tone={STATUS_TONE[r.status]}>{r.label}</CommonBadge></span>
          <span className="w-16 text-right text-xs text-fg-muted">{r.time}</span>
        </div>
      ))}
    </div>
  );
}
