import { CommonBadge, Tabs, TabsContent, TabsList, TabsTrigger } from "@xdev-hive/ui";
import { FileDiff, KanbanSquare, List, NotebookText, Play } from "lucide-react";

// line = underline tabs over a panel (task detail); default = the sunken segmented track (a view switch).
export function LineTabs() {
  return (
    <div className="p-6">
      <Tabs defaultValue="notes">
        <TabsList variant="line">
          <TabsTrigger value="notes"><NotebookText />Ghi chú</TabsTrigger>
          <TabsTrigger value="runs"><Play />Lượt chạy</TabsTrigger>
          <TabsTrigger value="diff"><FileDiff />Thay đổi · 12</TabsTrigger>
        </TabsList>
        <TabsContent value="notes" className="flex flex-col gap-2 pt-3 type-body-sm text-fg-secondary">
          <p className="text-fg-strong">Đã làm: runner đẩy branch ai/R-73a lên remote, hub ghi lại SHA cuối của lượt chạy.</p>
          <p>Chưa làm: dọn worktree tạm sau khi đẩy xong. Kiểm tra bằng npm test -w @xdev-hive/core.</p>
        </TabsContent>
      </Tabs>
    </div>
  );
}

export function Segmented() {
  return (
    <div className="p-6">
      <Tabs defaultValue="board">
        <div className="flex items-center justify-between gap-4">
          <h2 className="type-heading-md text-fg-strong">Task của xdev-hive</h2>
          <TabsList>
            <TabsTrigger value="board"><KanbanSquare />Bảng</TabsTrigger>
            <TabsTrigger value="list"><List />Danh sách</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="board" className="pt-2 type-body-sm text-fg-secondary">
          4 cột: Chưa làm, Đang làm, Chờ review, Xong.
        </TabsContent>
      </Tabs>
    </div>
  );
}

export function Vertical() {
  return (
    <div className="p-6">
      <Tabs defaultValue="agent" orientation="vertical" className="gap-6">
        <TabsList variant="line" className="w-44 shrink-0 border-0">
          <TabsTrigger value="policy">Quy trình</TabsTrigger>
          <TabsTrigger value="agent">Agent</TabsTrigger>
          <TabsTrigger value="tools">Tool</TabsTrigger>
          <TabsTrigger value="members">Thành viên</TabsTrigger>
        </TabsList>
        <TabsContent value="agent" className="flex flex-col gap-2 type-body-sm">
          <p className="type-heading-sm text-fg-strong">Agent của service</p>
          <p className="text-fg-secondary">Gói được giao task theo thứ tự ưu tiên; gói hết quota tự nghỉ đến lúc hồi.</p>
          <div className="flex gap-2">
            <CommonBadge tone="ok">claude-1</CommonBadge>
            <CommonBadge tone="running">codex-2</CommonBadge>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

export function WithDisabled() {
  return (
    <div className="p-6">
      <Tabs defaultValue="summary">
        <TabsList variant="line">
          <TabsTrigger value="summary">Tóm tắt</TabsTrigger>
          <TabsTrigger value="log">Log</TabsTrigger>
          <TabsTrigger value="diff" disabled>Thay đổi · 0</TabsTrigger>
        </TabsList>
        <TabsContent value="summary" className="pt-3 type-body-sm text-fg-secondary">
          Lượt chạy #1482 xong sau 18 phút 42 giây trên linux-runner. Chưa có thay đổi nào để xem.
        </TabsContent>
      </Tabs>
    </div>
  );
}
