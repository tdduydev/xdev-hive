import { useState, type ReactNode } from "react";
import {
  Button,
  CommonBadge,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@xdev-hive/ui";
import { ArrowUpDown, Copy, ExternalLink, Filter, MoreHorizontal, Play, RotateCcw, Send, Trash2, UserRound } from "lucide-react";

// Rendered open (defaultOpen) from a real trigger. The frame has a fixed height so the menu has room below its
// trigger inside the card; content is focused on open (Radix), so it gets outline-hidden to keep the capture clean.
function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 overflow-hidden p-6" style={{ height: "min(100svh, 460px)" }}>
      {children}
    </div>
  );
}

function TaskRow({ id, title, status, tone, action }: { id: string; title: string; status: string; tone: string; action?: ReactNode }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-line-subtle bg-surface px-4 py-2.5">
      <span className="font-mono text-xs text-fg-muted">{id}</span>
      <span className="min-w-0 flex-1 truncate type-body-sm text-fg-strong">{title}</span>
      <CommonBadge tone={tone}>{status}</CommonBadge>
      {action ?? <span className="size-8" />}
    </div>
  );
}

export function RowActions() {
  return (
    <Frame>
      <TaskRow id="R-72i" title="Trang Lượt chạy theo thiết kế cosmic" status="Xong" tone="ok" />
      <TaskRow
        id="R-73a"
        title="Runner đẩy ai/* lên remote, hub ghi SHA"
        status="Chờ review"
        tone="warn"
        action={
          <DropdownMenu defaultOpen>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Thêm thao tác"><MoreHorizontal /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="outline-hidden">
              <DropdownMenuLabel>R-73a</DropdownMenuLabel>
              <DropdownMenuGroup>
                <DropdownMenuItem><Send />Giao cho máy khác</DropdownMenuItem>
                <DropdownMenuItem><RotateCcw />Chạy lại<DropdownMenuShortcut>⌘R</DropdownMenuShortcut></DropdownMenuItem>
                <DropdownMenuItem><Copy />Sao chép link<DropdownMenuShortcut>⌘L</DropdownMenuShortcut></DropdownMenuItem>
                <DropdownMenuItem disabled><ExternalLink />Mở MR</DropdownMenuItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive"><Trash2 />Xoá task</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        }
      />
      <TaskRow id="BUG-windows-cli" title="App Windows không chạy được CLI cài bằng npm" status="Đang làm" tone="running" />
    </Frame>
  );
}

export function FilterAndSort() {
  const [machines, setMachines] = useState({ mac: true, linux: true, win: false });
  const [sort, setSort] = useState("updated");
  return (
    <Frame>
      <div className="flex items-center justify-between">
        <h2 className="type-heading-md text-fg-strong">Lượt chạy</h2>
        <DropdownMenu defaultOpen>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm"><Filter />Lọc &amp; sắp xếp</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56 outline-hidden">
            <DropdownMenuLabel>Máy</DropdownMenuLabel>
            <DropdownMenuCheckboxItem checked={machines.mac} onCheckedChange={(v) => setMachines((m) => ({ ...m, mac: !!v }))}>
              mac-mini-01
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={machines.linux} onCheckedChange={(v) => setMachines((m) => ({ ...m, linux: !!v }))}>
              linux-runner
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={machines.win} onCheckedChange={(v) => setMachines((m) => ({ ...m, win: !!v }))}>
              win-qa-02
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Sắp xếp</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={sort} onValueChange={setSort}>
              <DropdownMenuRadioItem value="updated">Cập nhật gần nhất</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="started">Bắt đầu sớm nhất</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="cost">Chi phí cao nhất</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="h-24 rounded-[24px] bg-card shadow-[var(--ring-glass)]" />
    </Frame>
  );
}

// The submenu is held open with `open`: Radix closes an uncontrolled one as soon as the root content takes focus.
// The trigger sits on the left so the submenu has room to open to the right.
export function WithSubmenu() {
  return (
    <Frame>
      <div className="flex items-center gap-3">
        <DropdownMenu defaultOpen>
          <DropdownMenuTrigger asChild>
            <Button size="sm"><Play />Giao task</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="outline-hidden">
            <DropdownMenuItem><Play />Chạy ngay trên máy này</DropdownMenuItem>
            <DropdownMenuSub open>
              <DropdownMenuSubTrigger><UserRound />Giao cho agent</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem>claude-1 · mac-mini-01</DropdownMenuItem>
                <DropdownMenuItem>codex-2 · linux-runner</DropdownMenuItem>
                <DropdownMenuItem disabled>claude-2 · nghỉ đến 14:30</DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuItem><ArrowUpDown />Đổi ưu tiên</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <h2 className="type-heading-md text-fg-strong">BUG-windows-cli</h2>
      </div>
      <div className="h-24 rounded-[24px] bg-card shadow-[var(--ring-glass)]" />
    </Frame>
  );
}
