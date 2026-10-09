import { CommonBadge, STATUS_TONE, Table, TableBody, TableCaption, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@xdev-hive/ui";

const RUNS = [
  { id: 1498, task: "R-73a", title: "Runner đẩy ai/* lên remote, hub ghi SHA", profile: "codex-2", status: "running", label: "Đang chạy", time: "12 phút" },
  { id: 1497, task: "R-72n", title: "Ảnh so sánh 1440px cho từng màn hình", profile: "claude-1", status: "succeeded", label: "Xong", time: "39 phút" },
  { id: 1496, task: "BUG-windows-cli", title: "App Windows không chạy được CLI cài bằng npm", profile: "claude-2", status: "failed", label: "Lỗi", time: "4 phút" },
  { id: 1495, task: "R-54c", title: "Chọn model theo độ khó của task", profile: "codex-1", status: "rate_limited", label: "Hết quota", time: "21 phút" },
  { id: 1494, task: "R-38e", title: "Đồng bộ danh mục thuốc từ HIS", profile: "codex-3", status: "succeeded", label: "Xong", time: "17 phút" },
];

export function RunTable() {
  return (
    <div className="p-4">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Lượt</TableHead>
            <TableHead>Task</TableHead>
            <TableHead>Tiêu đề</TableHead>
            <TableHead>Gói</TableHead>
            <TableHead>Kết quả</TableHead>
            <TableHead className="text-right">Thời gian</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {RUNS.map((r) => (
            <TableRow key={r.id}>
              <TableCell className="font-mono text-fg-muted">#{r.id}</TableCell>
              <TableCell className="font-mono">{r.task}</TableCell>
              <TableCell className="font-medium text-fg-strong">{r.title}</TableCell>
              <TableCell className="font-mono">{r.profile}</TableCell>
              <TableCell><CommonBadge tone={STATUS_TONE[r.status]}>{r.label}</CommonBadge></TableCell>
              <TableCell className="text-right">{r.time}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// data-state="selected" tints the open row.
export function SelectedRow() {
  return (
    <div className="max-w-2xl p-4">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Task</TableHead>
            <TableHead>Tiêu đề</TableHead>
            <TableHead>Trạng thái</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell className="font-mono">R-73a</TableCell>
            <TableCell>Runner đẩy ai/* lên remote, hub ghi SHA</TableCell>
            <TableCell><CommonBadge tone={STATUS_TONE.review}>Chờ review</CommonBadge></TableCell>
          </TableRow>
          <TableRow data-state="selected">
            <TableCell className="font-mono">R-72n</TableCell>
            <TableCell>Ảnh so sánh 1440px cho từng màn hình</TableCell>
            <TableCell><CommonBadge tone={STATUS_TONE.doing}>Đang làm</CommonBadge></TableCell>
          </TableRow>
          <TableRow>
            <TableCell className="font-mono">R-71b</TableCell>
            <TableCell>Leader trong phiên CLI của Codex</TableCell>
            <TableCell><CommonBadge tone={STATUS_TONE.todo}>Chưa làm</CommonBadge></TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
  );
}

const MACHINES = [
  { name: "mac-mini-01", version: "0.138.0", runs: 412 },
  { name: "hc-duytd20-linux", version: "0.138.0", runs: 1290 },
  { name: "duy-macbook-pro", version: "0.136.2", runs: 87 },
];

export function WithFooter() {
  return (
    <div className="max-w-xl p-4">
      <Table>
        <TableCaption>Lượt chạy 30 ngày qua, theo máy.</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>Máy</TableHead>
            <TableHead>Phiên bản</TableHead>
            <TableHead className="text-right">Lượt chạy</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {MACHINES.map((m) => (
            <TableRow key={m.name}>
              <TableCell>{m.name}</TableCell>
              <TableCell className="font-mono">{m.version}</TableCell>
              <TableCell className="text-right">{m.runs.toLocaleString("vi-VN")}</TableCell>
            </TableRow>
          ))}
        </TableBody>
        <TableFooter>
          <TableRow>
            <TableCell colSpan={2}>Tổng</TableCell>
            <TableCell className="text-right">{(1789).toLocaleString("vi-VN")}</TableCell>
          </TableRow>
        </TableFooter>
      </Table>
    </div>
  );
}
