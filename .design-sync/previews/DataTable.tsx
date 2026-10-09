import type { ReactNode } from "react";
import { CommonBadge, DataTable, STATUS_TONE, type DataTableColumn } from "@xdev-hive/ui";

const Frame = ({ children }: { children: ReactNode }) => <div className="p-4">{children}</div>;

type Task = { id: string; title: string; project: string; assignee: string; status: string; updated: string; minutes: number };

const STATUS_LABEL: Record<string, string> = { todo: "Chưa làm", doing: "Đang làm", review: "Chờ review", done: "Xong", blocked: "Bị chặn" };

const TASKS: Task[] = [
  { id: "R-73a", title: "Runner đẩy ai/* lên remote, hub ghi SHA", project: "xdev-hive", assignee: "codex-2", status: "review", updated: "09/10 14:32", minutes: 5 },
  { id: "R-72n", title: "Ảnh so sánh 1440px cho từng màn hình", project: "xdev-hive", assignee: "claude-1", status: "doing", updated: "09/10 13:58", minutes: 39 },
  { id: "R-71b", title: "Leader trong phiên CLI của Codex", project: "xdev-hive", assignee: "codex-1", status: "todo", updated: "08/10 17:20", minutes: 1238 },
  { id: "BUG-windows-cli", title: "App Windows không chạy được CLI cài bằng npm", project: "xdev-hive", assignee: "claude-2", status: "blocked", updated: "08/10 09:41", minutes: 1729 },
  { id: "R-38e", title: "Đồng bộ danh mục thuốc từ HIS", project: "ehospital-ai", assignee: "codex-3", status: "done", updated: "07/10 16:05", minutes: 2787 },
  { id: "M-12", title: "Xuất sơ đồ tư duy ra PNG", project: "xdev-mindmap-ai-ios", assignee: "claude-1", status: "review", updated: "07/10 11:12", minutes: 3080 },
  { id: "R-54c", title: "Chọn model theo độ khó của task", project: "xdev-hive", assignee: "codex-2", status: "done", updated: "06/10 19:47", minutes: 3885 },
];

const columns: Array<DataTableColumn<Task>> = [
  { key: "id", label: "Task", width: "128px", mono: true, render: (t) => t.id, sortValue: (t) => t.id },
  { key: "title", label: "Tiêu đề", width: "minmax(240px,1fr)", strong: true, render: (t) => t.title, sub: (t) => `${t.project} · ${t.assignee}`, title: (t) => t.title, sortValue: (t) => t.title },
  { key: "status", label: "Trạng thái", width: "120px", render: (t) => <CommonBadge tone={STATUS_TONE[t.status]}>{STATUS_LABEL[t.status]}</CommonBadge>, sortValue: (t) => t.status },
  { key: "updated", label: "Cập nhật", width: "104px", align: "right", mono: true, render: (t) => t.updated, sortValue: (t) => -t.minutes },
];

export function TaskList() {
  return (
    <Frame>
      <DataTable
        rows={TASKS}
        columns={columns}
        rowKey={(t) => t.id}
        noun="task"
        searchText={(t) => `${t.id} ${t.title} ${t.project} ${t.assignee}`}
        filters={[
          { key: "status", label: "Trạng thái", value: (t) => t.status, options: Object.entries(STATUS_LABEL).map(([value, label]) => ({ value, label })) },
          { key: "project", label: "Dự án", value: (t) => t.project },
        ]}
        selectedKey="R-72n"
        onRowClick={() => {}}
      />
    </Frame>
  );
}

type Machine = { id: string; name: string; os: string; version: string; online: boolean; runs: number; seen: string };

const MACHINES: Machine[] = [
  { id: "m1", name: "mac-mini-01", os: "macOS 27", version: "0.138.0", online: true, runs: 412, seen: "vừa xong" },
  { id: "m2", name: "hc-duytd20-linux", os: "Ubuntu 24.04", version: "0.138.0", online: true, runs: 1290, seen: "vừa xong" },
  { id: "m3", name: "duy-macbook-pro", os: "macOS 27", version: "0.136.2", online: false, runs: 87, seen: "3 giờ trước" },
  { id: "m4", name: "win-qa-02", os: "Windows 11", version: "0.131.0", online: false, runs: 23, seen: "4 ngày trước" },
];

const machineColumns: Array<DataTableColumn<Machine>> = [
  { key: "name", label: "Máy", width: "minmax(200px,1fr)", strong: true, render: (m) => m.name, sub: (m) => m.os, sortValue: (m) => m.name },
  { key: "state", label: "Trạng thái", width: "120px", render: (m) => <CommonBadge tone={m.online ? "ok" : "neutral"}>{m.online ? "Trực tuyến" : "Ngoại tuyến"}</CommonBadge> },
  { key: "version", label: "Phiên bản", width: "96px", mono: true, render: (m) => m.version, sortValue: (m) => m.version },
  { key: "runs", label: "Lượt chạy", width: "96px", align: "right", render: (m) => m.runs.toLocaleString("vi-VN"), sortValue: (m) => m.runs },
  { key: "seen", label: "Lần cuối", width: "112px", align: "right", render: (m) => m.seen },
];

// Bulk actions add the checkbox column; offline machines are dimmed.
export function MachinesWithBulk() {
  return (
    <Frame>
      <DataTable
        rows={MACHINES}
        columns={machineColumns}
        rowKey={(m) => m.id}
        noun="máy"
        searchText={(m) => `${m.name} ${m.os} ${m.version}`}
        filters={[{ key: "state", label: "Trạng thái", value: (m) => (m.online ? "online" : "offline"), options: [{ value: "online", label: "Trực tuyến" }, { value: "offline", label: "Ngoại tuyến" }] }]}
        bulk={[{ id: "remove", label: "Gỡ máy", danger: true }]}
        onBulk={() => {}}
        dim={(m) => !m.online}
        minWidth={680}
      />
    </Frame>
  );
}

type Run = { id: number; task: string; machine: string; status: string; duration: string };

const RUN_STATUS: Record<string, string> = { succeeded: "Xong", failed: "Lỗi", running: "Đang chạy", rate_limited: "Hết quota", cancelled: "Đã huỷ" };
const STATES = ["succeeded", "succeeded", "failed", "succeeded", "running", "rate_limited", "succeeded", "cancelled"];
const BOXES = ["mac-mini-01", "hc-duytd20-linux", "duy-macbook-pro"];
const RUNS: Run[] = Array.from({ length: 128 }, (_, i) => ({
  id: 1500 - i,
  task: ["R-73a", "R-72n", "R-71b", "R-54c", "BUG-windows-cli"][i % 5],
  machine: BOXES[i % 3],
  status: STATES[i % STATES.length],
  duration: `${(i * 7) % 43 + 2} phút`,
}));

const runColumns: Array<DataTableColumn<Run>> = [
  { key: "id", label: "Lượt", width: "72px", mono: true, render: (r) => `#${r.id}`, sortValue: (r) => r.id },
  { key: "task", label: "Task", width: "minmax(140px,1fr)", mono: true, render: (r) => r.task },
  { key: "machine", label: "Máy", width: "minmax(150px,1fr)", render: (r) => r.machine },
  { key: "status", label: "Kết quả", width: "112px", render: (r) => <CommonBadge tone={STATUS_TONE[r.status]}>{RUN_STATUS[r.status]}</CommonBadge> },
  { key: "duration", label: "Thời gian", width: "88px", align: "right", render: (r) => r.duration },
];

// More rows than one page: the footer shows the range, page size and page buttons.
export function Paginated() {
  return (
    <Frame>
      <DataTable rows={RUNS} columns={runColumns} rowKey={(r) => String(r.id)} noun="lượt chạy" maxHeight="260px" />
    </Frame>
  );
}

export function NoMatches() {
  return (
    <Frame>
      <DataTable
        rows={[] as Task[]}
        columns={columns}
        rowKey={(t) => t.id}
        noun="task"
        searchText={(t) => t.title}
        filters={[{ key: "status", label: "Trạng thái", value: (t) => t.status, options: Object.entries(STATUS_LABEL).map(([value, label]) => ({ value, label })) }]}
      />
    </Frame>
  );
}
