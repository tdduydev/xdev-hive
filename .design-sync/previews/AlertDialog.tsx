import type { ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  AlertDialogTrigger,
  Button,
  Notice,
} from "@xdev-hive/ui";
import { CircleStop, Rocket, Trash2 } from "lucide-react";

// Rendered open over a page, like Dialog: the page fills the card (capped so a grid cell stays bounded) and the scrim
// darkens app content, not the card's white frame. Auto-focus is suppressed so the capture shows no focus ring on Huỷ.
const noAutoFocus = (e: Event) => e.preventDefault();

function Behind({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-4 overflow-hidden p-6" style={{ height: "min(100svh, 560px)" }}>
      <div className="flex items-center justify-between">
        <h1 className="type-display-md text-fg-strong">{title}</h1>
        {children}
      </div>
      <div className="h-24 rounded-[24px] bg-card shadow-[var(--ring-glass)]" />
      <div className="h-40 rounded-[24px] bg-card shadow-[var(--ring-glass)]" />
    </div>
  );
}

export function CancelRun() {
  return (
    <AlertDialog defaultOpen>
      <Behind title="Agent đang chạy">
        <AlertDialogTrigger asChild>
          <Button variant="danger-outline" size="sm">Huỷ run</Button>
        </AlertDialogTrigger>
      </Behind>
      <AlertDialogContent onOpenAutoFocus={noAutoFocus}>
        <AlertDialogHeader>
          <AlertDialogMedia><CircleStop /></AlertDialogMedia>
          <AlertDialogTitle>Huỷ run R-72j?</AlertDialogTitle>
          <AlertDialogDescription>
            Máy linux-runner dừng codex-2 ở heartbeat sau (khoảng 30 giây). Commit đã đẩy lên ai/R-72j vẫn được giữ.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Để run chạy tiếp</AlertDialogCancel>
          <AlertDialogAction variant="destructive">Huỷ run</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function RemoveWorktrees() {
  return (
    <AlertDialog defaultOpen>
      <Behind title="Worktree">
        <AlertDialogTrigger asChild>
          <Button variant="destructive" size="sm">Xoá đã chọn (3)</Button>
        </AlertDialogTrigger>
      </Behind>
      <AlertDialogContent onOpenAutoFocus={noAutoFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>Xoá 3 worktree?</AlertDialogTitle>
          <AlertDialogDescription>Các thư mục và file bên trong sẽ bị xoá. Branch vẫn được giữ lại.</AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="flex flex-col gap-1 font-mono text-xs/5 text-fg-secondary">
          <li>xdev-hive/R-71b · ai/R-71b</li>
          <li>xdev-hive/BUG-windows-cli · ai/BUG-windows-cli</li>
          <li>customer-ai/R-38g · ai/R-38g</li>
        </ul>
        <Notice tone="warn">Có thay đổi chưa commit ở ai/R-38g. Xoá sẽ mất các file chưa commit; commit còn trên branch.</Notice>
        <AlertDialogFooter>
          <AlertDialogCancel>Huỷ</AlertDialogCancel>
          <AlertDialogAction variant="destructive"><Trash2 />Xoá</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// size="sm": a narrow confirm with the two actions side by side, centred header.
export function ConfirmRelease() {
  return (
    <AlertDialog defaultOpen>
      <Behind title="Nghiệm thu & phát hành">
        <AlertDialogTrigger asChild>
          <Button size="sm">Phát hành</Button>
        </AlertDialogTrigger>
      </Behind>
      <AlertDialogContent size="sm" onOpenAutoFocus={noAutoFocus}>
        <AlertDialogHeader>
          <AlertDialogMedia className="bg-selected text-fg-brand"><Rocket /></AlertDialogMedia>
          <AlertDialogTitle>Phát hành 0.140.0?</AlertDialogTitle>
          <AlertDialogDescription>App desktop cho mọi nền tảng, từ bản sạch của origin/main.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Để sau</AlertDialogCancel>
          <AlertDialogAction>Phát hành</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
