import { Button, Separator } from "@xdev-hive/ui";
import { Bold, Code, Italic, Link, List, ListOrdered, Undo2, Redo2 } from "lucide-react";

// Vertical separators take the parent's height (h-full): the toolbar's content box is 22px.
export function Toolbar() {
  return (
    <div className="p-4">
      <div className="flex h-10 w-fit items-center gap-1 rounded-lg border border-line-subtle bg-surface px-2 py-2">
        <Button variant="ghost" size="icon-sm" aria-label="Hoàn tác"><Undo2 /></Button>
        <Button variant="ghost" size="icon-sm" aria-label="Làm lại"><Redo2 /></Button>
        <Separator orientation="vertical" className="mx-1" />
        <Button variant="ghost" size="icon-sm" aria-label="Đậm"><Bold /></Button>
        <Button variant="ghost" size="icon-sm" aria-label="Nghiêng"><Italic /></Button>
        <Button variant="ghost" size="icon-sm" aria-label="Code"><Code /></Button>
        <Separator orientation="vertical" className="mx-1" />
        <Button variant="ghost" size="icon-sm" aria-label="Danh sách"><List /></Button>
        <Button variant="ghost" size="icon-sm" aria-label="Danh sách số"><ListOrdered /></Button>
        <Button variant="ghost" size="icon-sm" aria-label="Liên kết"><Link /></Button>
      </div>
    </div>
  );
}

export function StatsLine() {
  return (
    <div className="p-4">
      <div className="flex h-5 items-center gap-3 text-sm text-fg-secondary">
        <span>12 task</span>
        <Separator orientation="vertical" />
        <span>3 chờ review</span>
        <Separator orientation="vertical" />
        <span>2 máy trực tuyến</span>
      </div>
    </div>
  );
}

// Horizontal separators between the rows of a list.
export function InList() {
  const items = [
    { name: "claude-1", note: "Claude Code · mac-mini-01" },
    { name: "codex-2", note: "Codex CLI · linux-runner" },
    { name: "claude-4", note: "Claude Code · mac-mini-01" },
  ];
  return (
    <div className="max-w-sm p-4">
      <div className="flex flex-col rounded-lg border border-line-subtle bg-surface">
        {items.map((it, i) => (
          <div key={it.name}>
            {i > 0 ? <Separator /> : null}
            <div className="flex flex-col px-4 py-3">
              <span className="font-mono text-sm text-fg-strong">{it.name}</span>
              <span className="text-xs text-fg-muted">{it.note}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
