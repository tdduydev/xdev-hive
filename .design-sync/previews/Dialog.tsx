import type { ReactNode } from "react";
import {
  Button,
  CommonBadge,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Input,
  Label,
  NativeSelect,
  NativeSelectOption,
  Textarea,
} from "@xdev-hive/ui";

// Rendered open (defaultOpen): the card is a single 900px-wide story so the centred dialog fits (<768px it goes full screen).
// The page behind fills the viewport so the scrim darkens app content, not the card's white frame. Auto-focus is
// suppressed only so the static capture shows no text selection or focus ring.
const noAutoFocus = (e: Event) => e.preventDefault();

function Behind({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <h1 className="type-display-md text-fg-strong">{title}</h1>
        {children}
      </div>
      <div className="h-24 rounded-[24px] bg-card shadow-[var(--ring-glass)]" />
      <div className="h-40 rounded-[24px] bg-card shadow-[var(--ring-glass)]" />
    </div>
  );
}
export function NewTask() {
  return (
    <Dialog defaultOpen>
      <Behind title="Bảng task">
        <DialogTrigger asChild>
          <Button size="sm">Tạo task</Button>
        </DialogTrigger>
      </Behind>
      <DialogContent onOpenAutoFocus={noAutoFocus}>
        <DialogHeader>
          <DialogTitle>Tạo task mới</DialogTitle>
          <DialogDescription>Task vào cột Chưa làm của xdev-hive. Agent chỉ nhận khi bạn giao cho một máy.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="task-title">Tiêu đề</Label>
            <Input id="task-title" defaultValue="Thêm bộ lọc theo máy cho trang Lượt chạy" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="task-body">Mô tả</Label>
            <Textarea
              id="task-body"
              rows={3}
              defaultValue="Danh sách lượt chạy cần lọc được theo máy (mac-mini-01, linux-runner). Giữ bộ lọc trên URL để chia sẻ được."
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="task-priority">Ưu tiên</Label>
            <NativeSelect id="task-priority" defaultValue="normal">
              <NativeSelectOption value="high">Cao</NativeSelectOption>
              <NativeSelectOption value="normal">Bình thường</NativeSelectOption>
              <NativeSelectOption value="low">Thấp</NativeSelectOption>
            </NativeSelect>
          </div>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" size="sm">Huỷ</Button>
          </DialogClose>
          <Button size="sm">Tạo task</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const DETAILS: Array<[string, string]> = [
  ["Task", "R-73a"],
  ["Máy", "linux-runner"],
  ["Agent", "codex-2"],
  ["Bắt đầu", "09/10 14:05"],
  ["Thời gian", "18 phút 42 giây"],
  ["Branch", "ai/R-73a"],
];

export function RunDetails() {
  return (
    <Dialog defaultOpen>
      <Behind title="Lượt chạy">
        <DialogTrigger asChild>
          <Button variant="outline" size="sm">Xem lượt chạy</Button>
        </DialogTrigger>
      </Behind>
      <DialogContent onOpenAutoFocus={noAutoFocus}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Lượt chạy #1482 <CommonBadge tone="ok">Xong</CommonBadge>
          </DialogTitle>
          <DialogDescription>Runner đẩy branch lên remote, hub ghi lại SHA cuối.</DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[120px_minmax(0,1fr)] gap-x-4 gap-y-2 type-body-sm">
          {DETAILS.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-fg-muted">{k}</dt>
              <dd className="m-0 font-mono text-xs/5 text-fg-strong">{v}</dd>
            </div>
          ))}
        </dl>
        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  );
}
