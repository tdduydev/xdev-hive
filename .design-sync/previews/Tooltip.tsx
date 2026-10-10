import type { ReactNode } from "react";
import { Button, StatusDot, Tooltip, TooltipContent, TooltipTrigger } from "@xdev-hive/ui";
import { Copy, GitMerge, RotateCcw, Square, Terminal } from "lucide-react";

// Tooltips are hover/focus-only, so each story forces one open (`open`); the frame leaves room for it in the card.
function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 overflow-hidden px-6 pb-6" style={{ height: "min(100svh, 240px)", paddingTop: 56 }}>
      {children}
    </div>
  );
}

function Tip({ label, open, children, side }: { label: string; open?: boolean; children: ReactNode; side?: "top" | "right" | "bottom" | "left" }) {
  return (
    <Tooltip open={open}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  );
}

export function IconToolbar() {
  return (
    <Frame>
      <div className="flex items-center gap-3">
        <span className="font-mono text-xs text-fg-muted">#1482</span>
        <span className="type-body-sm text-fg-strong">R-73a · codex-2</span>
        <div className="ml-auto flex items-center gap-1">
          <Tip label="Chạy lại trên cùng máy" open>
            <Button variant="ghost" size="icon-sm" aria-label="Chạy lại"><RotateCcw /></Button>
          </Tip>
          <Tip label="Mở log của máy">
            <Button variant="ghost" size="icon-sm" aria-label="Log"><Terminal /></Button>
          </Tip>
          <Tip label="Merge">
            <Button variant="ghost" size="icon-sm" aria-label="Merge"><GitMerge /></Button>
          </Tip>
          <Tip label="Dừng run">
            <Button variant="ghost" size="icon-sm" aria-label="Dừng run"><Square /></Button>
          </Tip>
        </div>
      </div>
    </Frame>
  );
}

// Long text wraps at the 240px max width (text-balance), never truncates.
export function LongHint() {
  return (
    <Frame>
      <div className="flex items-center gap-2 type-body-sm text-fg-primary">
        <Tip label="Máy dừng agent ở heartbeat sau (khoảng 30 giây). Commit đã đẩy lên branch vẫn được giữ." open side="right">
          <Button variant="danger-outline" size="sm">Huỷ run</Button>
        </Tip>
      </div>
    </Frame>
  );
}

// Names a truncated value: the full SHA and branch behind a short label.
export function TruncatedValue() {
  return (
    <Frame>
      <div className="flex items-center gap-2 type-body-sm text-fg-primary">
        <StatusDot tone="ok" />
        <span>linux-runner</span>
        <Tip label="ai/R-73a · e3d28d63a1f04b7c" open side="bottom">
          <button type="button" className="inline-flex items-center gap-1 rounded-sm px-1 font-mono text-xs text-fg-secondary">
            e3d28d6<Copy className="size-3" />
          </button>
        </Tip>
      </div>
    </Frame>
  );
}
