import { Input, Toggle } from "@xdev-hive/ui";
import { Bell, Filter, Pin, Search, User } from "lucide-react";

export function Variants() {
  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <Toggle defaultPressed>Chỉ task của tôi</Toggle>
        <Toggle>Ẩn task đã xong</Toggle>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Toggle variant="outline" defaultPressed>Chỉ task của tôi</Toggle>
        <Toggle variant="outline">Ẩn task đã xong</Toggle>
      </div>
    </div>
  );
}

// Every Toggle has the 44px touch min-height (cosmic.css), so it lines up with a md Input in a filter bar.
export function FilterBar() {
  return (
    <div className="flex flex-wrap items-center gap-2 p-4">
      <Input
        aria-label="Tìm task"
        placeholder="Tìm task trong xdev-hive…"
        icon={<Search className="size-4 shrink-0 text-fg-muted" />}
        style={{ width: 280 }}
      />
      <Toggle variant="outline" defaultPressed><User />Của tôi</Toggle>
      <Toggle variant="outline">Ẩn task đã xong</Toggle>
    </div>
  );
}

// Icon-only toggles use size="lg": the height is fixed at 44px, so size only widens them (min-w-10) to a near square.
export function WithIcons() {
  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Toggle variant="outline" defaultPressed><Filter />Có lỗi</Toggle>
        <Toggle variant="outline"><Pin />Đã ghim</Toggle>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Toggle size="lg" aria-label="Ghim task" defaultPressed><Pin /></Toggle>
        <Toggle size="lg" aria-label="Báo khi run xong"><Bell /></Toggle>
        <Toggle size="lg" aria-label="Ghim task (đã khoá)" disabled><Pin /></Toggle>
      </div>
    </div>
  );
}

export function Disabled() {
  return (
    <div className="flex flex-wrap items-center gap-3 p-4">
      <Toggle variant="outline" disabled>Chỉ máy của tôi</Toggle>
      <Toggle variant="outline" defaultPressed disabled>Gồm máy ngoại tuyến</Toggle>
    </div>
  );
}
