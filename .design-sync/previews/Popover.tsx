import type { ReactNode } from "react";
import {
  Button,
  Checkbox,
  Label,
  NativeSelect,
  NativeSelectOption,
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
  StatusDot,
} from "@xdev-hive/ui";
import { Gauge, Info, SlidersHorizontal } from "lucide-react";

// Rendered open (defaultOpen) under its trigger, in a fixed-height frame so the panel stays inside the card.
// Auto-focus is suppressed: Radix would focus the first field and the capture would show a focus ring.
const noAutoFocus = (e: Event) => e.preventDefault();

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 overflow-hidden p-6" style={{ height: "min(100svh, 420px)" }}>
      {children}
    </div>
  );
}

function Bar({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex justify-between type-caption text-fg-secondary">
        <span>{label}</span>
        <span className="font-mono text-fg-strong">{value}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-sunken">
        <div className={tone} style={{ width: `${value}%`, height: "100%" }} />
      </div>
    </div>
  );
}

export function QuotaDetails() {
  return (
    <Frame>
      <div className="flex items-center gap-3">
        <h2 className="type-heading-md text-fg-strong">Agent và quota</h2>
        <Popover defaultOpen>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm"><Gauge />claude-1</Button>
          </PopoverTrigger>
          <PopoverContent align="start" onOpenAutoFocus={noAutoFocus}>
            <div className="flex flex-col gap-3">
              <PopoverHeader>
                <PopoverTitle className="flex items-center gap-2"><StatusDot tone="ok" />claude-1 · mac-mini-01</PopoverTitle>
                <PopoverDescription>Phiên hồi lúc 16:00 · tuần hồi thứ Hai</PopoverDescription>
              </PopoverHeader>
              <Bar label="Phiên 5 giờ" value={62} tone="bg-warning-solid" />
              <Bar label="Tuần" value={35} tone="bg-success-solid" />
            </div>
          </PopoverContent>
        </Popover>
      </div>
      <div className="h-24 rounded-[24px] bg-card shadow-[var(--ring-glass)]" />
    </Frame>
  );
}

export function QuickFilter() {
  return (
    <Frame>
      <div className="flex items-center justify-between">
        <h2 className="type-heading-md text-fg-strong">Bảng task</h2>
        <Popover defaultOpen>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm"><SlidersHorizontal />Bộ lọc · 2</Button>
          </PopoverTrigger>
          <PopoverContent align="end" onOpenAutoFocus={noAutoFocus}>
            <div className="flex flex-col gap-4">
              <PopoverHeader>
                <PopoverTitle>Lọc task</PopoverTitle>
                <PopoverDescription>Bộ lọc giữ trên URL để chia sẻ được.</PopoverDescription>
              </PopoverHeader>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="pf-machine">Máy</Label>
                <NativeSelect id="pf-machine" defaultValue="linux">
                  <NativeSelectOption value="all">Mọi máy</NativeSelectOption>
                  <NativeSelectOption value="mac">mac-mini-01</NativeSelectOption>
                  <NativeSelectOption value="linux">hc-duytd20-linux</NativeSelectOption>
                </NativeSelect>
              </div>
              <label className="flex items-center gap-2 type-body-sm text-fg-primary">
                <Checkbox defaultChecked />Chỉ task của tôi
              </label>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm">Xóa bộ lọc</Button>
                <Button size="sm">Áp dụng</Button>
              </div>
            </div>
          </PopoverContent>
        </Popover>
      </div>
      <div className="h-24 rounded-[24px] bg-card shadow-[var(--ring-glass)]" />
    </Frame>
  );
}

// side="right": a short explanation beside an inline hint icon.
export function SideRight() {
  return (
    <Frame>
      <div className="flex items-center gap-2 type-body-sm text-fg-secondary">
        <span>Tự dọn worktree</span>
        <Popover defaultOpen>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon-xs" aria-label="Giải thích"><Info /></Button>
          </PopoverTrigger>
          <PopoverContent side="right" align="start" className="w-64" onOpenAutoFocus={noAutoFocus}>
            <PopoverHeader>
              <PopoverTitle>Khi nào worktree được dọn?</PopoverTitle>
              <PopoverDescription>
                Chỉ task done, không có run và không còn thay đổi chưa commit. Khi ổ thiếu chỗ, dọn từ cũ nhất.
              </PopoverDescription>
            </PopoverHeader>
          </PopoverContent>
        </Popover>
      </div>
    </Frame>
  );
}
