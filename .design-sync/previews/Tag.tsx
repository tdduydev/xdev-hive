import { Tag } from "@xdev-hive/ui";
import { GitBranch, Monitor, Tag as TagIcon } from "lucide-react";

// active fills the selected chip violet. The tone prop only writes data-tone (no CSS), so it is not shown here.
export function FilterChips() {
  return (
    <div className="flex flex-wrap items-center gap-2 p-4">
      <Tag active>Tất cả</Tag>
      <Tag>Đang chạy</Tag>
      <Tag>Xong</Tag>
      <Tag>Lỗi</Tag>
      <Tag>Hết quota</Tag>
    </div>
  );
}

export function WithIcons() {
  return (
    <div className="flex flex-wrap items-center gap-2 p-4">
      <Tag active><Monitor className="size-3.5" />mac-mini-01</Tag>
      <Tag><Monitor className="size-3.5" />hc-duytd20-linux</Tag>
      <Tag><GitBranch className="size-3.5" />ai/R-73a</Tag>
    </div>
  );
}

export function TaskLabels() {
  return (
    <div className="flex flex-col gap-2 p-4">
      <span className="type-body-sm text-fg-strong">R-72n · Ảnh so sánh 1440px cho từng màn hình</span>
      <div className="flex flex-wrap items-center gap-2">
        <Tag><TagIcon className="size-3.5" />giao diện</Tag>
        <Tag>desktop</Tag>
        <Tag>roadmap 72</Tag>
      </div>
    </div>
  );
}
