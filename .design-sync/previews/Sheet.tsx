import type { ReactNode } from "react";
import {
  Button,
  Checkbox,
  CommonBadge,
  Label,
  NativeSelect,
  NativeSelectOption,
  Separator,
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@xdev-hive/ui";
import { ExternalLink, RotateCcw } from "lucide-react";

// Rendered open over a page that fills the card (capped so a grid cell stays bounded): the scrim darkens app content.
// Auto-focus is suppressed so the capture shows no focus ring on the first control.
const noAutoFocus = (e: Event) => e.preventDefault();

function Behind({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-4 overflow-hidden p-6" style={{ height: "min(100svh, 640px)" }}>
      <div className="flex items-center justify-between">
        <h1 className="type-display-md text-fg-strong">{title}</h1>
        {children}
      </div>
      <div className="h-24 rounded-[24px] bg-card shadow-[var(--ring-glass)]" />
      <div className="h-40 rounded-[24px] bg-card shadow-[var(--ring-glass)]" />
    </div>
  );
}

const DETAILS: Array<[string, string]> = [
  ["Task", "R-73a"],
  ["Máy", "hc-duytd20-linux"],
  ["Agent", "codex-2"],
  ["Bắt đầu", "09/10 14:05"],
  ["Thời gian", "18 phút 42 giây"],
  ["Branch", "ai/R-73a"],
  ["SHA", "e3d28d63"],
];

export function RunDetails() {
  return (
    <Sheet defaultOpen>
      <Behind title="Lượt chạy">
        <SheetTrigger asChild>
          <Button variant="outline" size="sm">Chi tiết</Button>
        </SheetTrigger>
      </Behind>
      <SheetContent onOpenAutoFocus={noAutoFocus}>
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">Lượt chạy #1482 <CommonBadge tone="ok">Xong</CommonBadge></SheetTitle>
          <SheetDescription>R-73a · Runner đẩy ai/* lên remote, hub ghi SHA</SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-4 px-4">
          <dl className="grid grid-cols-[120px_minmax(0,1fr)] gap-x-4 gap-y-2 type-body-sm">
            {DETAILS.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-fg-muted">{k}</dt>
                <dd className="m-0 font-mono text-xs/5 text-fg-strong">{v}</dd>
              </div>
            ))}
          </dl>
          <Separator />
          <p className="type-body-sm text-fg-secondary">
            Đã làm: runner đẩy branch lên remote sau mỗi commit. Chưa làm: dọn worktree tạm. Kiểm tra: npm test -w @xdev-hive/core.
          </p>
        </div>
        <SheetFooter>
          <Button variant="outline" size="sm"><ExternalLink />Mở MR</Button>
          <Button size="sm"><RotateCcw />Chạy lại</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

export function FiltersLeft() {
  return (
    <Sheet defaultOpen>
      <Behind title="Bảng task">
        <SheetTrigger asChild>
          <Button variant="outline" size="sm">Bộ lọc</Button>
        </SheetTrigger>
      </Behind>
      <SheetContent side="left" onOpenAutoFocus={noAutoFocus}>
        <SheetHeader>
          <SheetTitle>Lọc task</SheetTitle>
          <SheetDescription>Bộ lọc giữ trên URL để chia sẻ được.</SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-4 px-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="sf-project">Service</Label>
            <NativeSelect id="sf-project" defaultValue="xdev-hive">
              <NativeSelectOption value="xdev-hive">xdev-hive</NativeSelectOption>
              <NativeSelectOption value="ehospital-ai">ehospital-ai</NativeSelectOption>
            </NativeSelect>
          </div>
          <div className="flex flex-col gap-2">
            <span className="type-label text-fg-strong">Trạng thái</span>
            {[
              ["Chưa làm", true],
              ["Đang làm", true],
              ["Chờ review", true],
              ["Xong", false],
            ].map(([label, on]) => (
              <label key={String(label)} className="flex items-center gap-2 type-body-sm text-fg-primary">
                <Checkbox defaultChecked={!!on} />{label}
              </label>
            ))}
          </div>
        </div>
        <SheetFooter>
          <SheetClose asChild>
            <Button variant="ghost" size="sm">Xóa bộ lọc</Button>
          </SheetClose>
          <Button size="sm">Áp dụng</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

export function BottomNotice() {
  return (
    <Sheet defaultOpen>
      <Behind title="Hôm nay">
        <SheetTrigger asChild>
          <Button variant="outline" size="sm">Cập nhật</Button>
        </SheetTrigger>
      </Behind>
      <SheetContent side="bottom" onOpenAutoFocus={noAutoFocus}>
        <SheetHeader>
          <SheetTitle>Có bản app 0.140.0</SheetTitle>
          <SheetDescription>Máy này đang chạy 0.138.0. App khởi động lại sau khi tải xong.</SheetDescription>
        </SheetHeader>
        <ul className="flex flex-col gap-1 px-4 type-body-sm text-fg-secondary">
          <li>Runner đẩy ai/* lên remote, hub ghi SHA cuối (R-73a)</li>
          <li>Hub giao task theo nền tảng của máy (R-73b)</li>
          <li>Worktree tạm, dọn sau mỗi lượt chạy (R-73c)</li>
        </ul>
        <SheetFooter>
          <SheetClose asChild>
            <Button variant="outline" size="sm">Để sau</Button>
          </SheetClose>
          <Button size="sm">Cập nhật và khởi động lại</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
