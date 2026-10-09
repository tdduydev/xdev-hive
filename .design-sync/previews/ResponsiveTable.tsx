import {
  Button,
  CommonBadge,
  ResponsiveGridRow,
  ResponsiveTable,
  ResponsiveTableFrame,
  ResponsiveTableRow,
  STATUS_TONE,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@xdev-hive/ui";

const RUNS = [
  { id: 1498, task: "R-73a", title: "Runner đẩy ai/* lên remote, hub ghi SHA", profile: "codex-2", machine: "linux-runner", status: "running", label: "Đang chạy", time: "12 phút" },
  { id: 1497, task: "R-72n", title: "Ảnh so sánh 1440px cho từng màn hình", profile: "claude-1", machine: "mac-mini-01", status: "succeeded", label: "Xong", time: "39 phút" },
  { id: 1496, task: "BUG-windows-cli", title: "App Windows không chạy được CLI cài bằng npm", profile: "claude-2", machine: "win-qa-02", status: "failed", label: "Lỗi", time: "4 phút" },
  { id: 1495, task: "R-54c", title: "Chọn model theo độ khó của task", profile: "codex-1", machine: "linux-runner", status: "rate_limited", label: "Hết quota", time: "21 phút" },
];

// Desktop width: a plain table. Below 768px each row turns into a card labelled by the TableHeads.
// The last TableHead is empty, so that column counts as the row's actions.
export function RunList() {
  return (
    <div className="p-4">
      <ResponsiveTable>
        <TableHeader>
          <TableRow>
            <TableHead>Task</TableHead>
            <TableHead>Tiêu đề</TableHead>
            <TableHead>Gói</TableHead>
            <TableHead>Kết quả</TableHead>
            <TableHead className="text-right">Thời gian</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {RUNS.map((r) => (
            <ResponsiveTableRow key={r.id} data-state={r.task === "R-72n" ? "selected" : undefined}>
              <TableCell className="font-mono">{r.task}</TableCell>
              <TableCell className="whitespace-normal font-medium text-fg-strong">{r.title}</TableCell>
              <TableCell>
                <p className="m-0 font-mono">{r.profile}</p>
                <p className="m-0 text-xs text-fg-muted">{r.machine}</p>
              </TableCell>
              <TableCell><CommonBadge tone={STATUS_TONE[r.status]}>{r.label}</CommonBadge></TableCell>
              <TableCell className="text-right">{r.time}</TableCell>
              <TableCell className="text-right">
                <Button variant="outline" size="xs">{r.status === "failed" ? "Chạy lại" : "Mở"}</Button>
              </TableCell>
            </ResponsiveTableRow>
          ))}
        </TableBody>
      </ResponsiveTable>
    </div>
  );
}

const BUDGETS = [
  { scope: "Dự án xdev-hive", period: "Theo tháng", used: 184.2, limit: 300 },
  { scope: "Gói codex-2", period: "Theo tuần", used: 41.6, limit: 50 },
  { scope: "Dự án customer-ai", period: "Theo tháng", used: 120, limit: 120 },
];

// CSS-grid lists: ResponsiveTableFrame around ResponsiveGridRows; labels[i] names cell i, a null label marks the actions.
export function GridRows() {
  return (
    <div className="p-4">
      <ResponsiveTableFrame className="flex min-w-0 flex-col gap-3 rounded-lg border border-line-default bg-surface p-4">
        <div className="flex flex-wrap items-baseline gap-2">
          <h2 className="m-0 text-sm/5 font-semibold text-fg-strong">Ngân sách</h2>
          <span className="text-xs text-fg-muted">Dừng giao task khi chạm hạn mức.</span>
          <Button className="ml-auto" size="xs" variant="outline">Thêm ngân sách</Button>
        </div>
        {BUDGETS.map((b) => {
          const ratio = Math.min(1, b.used / b.limit);
          return (
            <ResponsiveGridRow
              key={b.scope}
              labels={["Phạm vi", "Đã dùng", null]}
              className="grid grid-cols-[minmax(140px,1fr)_minmax(200px,2fr)_auto] items-center gap-3 border-b border-line-default pb-2.5 last:border-b-0 last:pb-0"
            >
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-[13px] font-medium text-fg-strong">{b.scope}</span>
                <span className="text-xs text-fg-muted">{b.period}</span>
              </div>
              <div className="flex flex-col gap-1">
                <div className="h-1.5 overflow-hidden rounded-full bg-sunken">
                  <div className={ratio >= 1 ? "h-full bg-danger-solid" : ratio >= 0.8 ? "h-full bg-warning-solid" : "h-full bg-info-solid"} style={{ width: `${ratio * 100}%` }} />
                </div>
                <span className="text-xs text-fg-secondary">${b.used.toFixed(2)} / ${b.limit.toFixed(2)}</span>
                {ratio >= 1 ? <span className="text-xs text-danger">Đã chạm hạn mức</span> : null}
              </div>
              <div className="flex gap-1.5">
                <Button size="xs" variant="outline">Sửa</Button>
                <Button size="xs" variant="outline">Gỡ</Button>
              </div>
            </ResponsiveGridRow>
          );
        })}
      </ResponsiveTableFrame>
    </div>
  );
}
