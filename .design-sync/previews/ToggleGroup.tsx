import { ToggleGroup, ToggleGroupItem } from "@xdev-hive/ui";
import { AlertTriangle, CheckCircle2, Columns3, List, Loader2 } from "lucide-react";

// variant="outline" is the DS segmented control (Agents token window, Members filter).
export function Segmented() {
  return (
    <div className="flex flex-col items-start gap-3 p-4">
      <ToggleGroup type="single" variant="outline" size="sm" defaultValue="d7" aria-label="Khoảng thời gian">
        <ToggleGroupItem value="d1" className="px-2.5 text-xs">24 giờ</ToggleGroupItem>
        <ToggleGroupItem value="d7" className="px-2.5 text-xs">7 ngày</ToggleGroupItem>
        <ToggleGroupItem value="d30" className="px-2.5 text-xs">30 ngày</ToggleGroupItem>
      </ToggleGroup>
      <ToggleGroup type="single" variant="outline" defaultValue="granted" aria-label="Thành viên">
        <ToggleGroupItem value="granted">Đã cấp quyền</ToggleGroupItem>
        <ToggleGroupItem value="all">Tất cả</ToggleGroupItem>
      </ToggleGroup>
    </div>
  );
}

export function ViewSwitch() {
  return (
    <div className="p-4">
      <ToggleGroup type="single" variant="outline" defaultValue="board" aria-label="Kiểu xem">
        <ToggleGroupItem value="board"><Columns3 />Bảng</ToggleGroupItem>
        <ToggleGroupItem value="list"><List />Danh sách</ToggleGroupItem>
      </ToggleGroup>
    </div>
  );
}

// type="multiple" with the default variant: joined buttons, several can be on. variant="default" is passed
// explicitly because the joined-edge rules key on data-variant, which is only set when the prop is given.
export function MultipleFilters() {
  return (
    <div className="p-4">
      <ToggleGroup type="multiple" variant="default" defaultValue={["running", "failed"]} aria-label="Lọc theo trạng thái run">
        <ToggleGroupItem value="running"><Loader2 />Đang chạy</ToggleGroupItem>
        <ToggleGroupItem value="failed"><AlertTriangle />Thất bại</ToggleGroupItem>
        <ToggleGroupItem value="done"><CheckCircle2 />Xong</ToggleGroupItem>
      </ToggleGroup>
    </div>
  );
}

export function SpacedAndDisabled() {
  return (
    <div className="p-4">
      <ToggleGroup type="single" spacing={1} size="sm" defaultValue="xdev-hive" aria-label="Dự án">
        <ToggleGroupItem value="xdev-hive">xdev-hive</ToggleGroupItem>
        <ToggleGroupItem value="ehospital-ai">ehospital-ai</ToggleGroupItem>
        <ToggleGroupItem value="mindmap" disabled>xdev-mindmap-ai-ios</ToggleGroupItem>
      </ToggleGroup>
    </div>
  );
}
